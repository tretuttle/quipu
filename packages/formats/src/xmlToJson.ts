// @effect-diagnostics preferSchemaOverJson:off - JSON.stringify of one string is its JSON text; no document round-trips through it.
/**
 * XML bytes to JSON bytes, streaming. saxes reads the text (its events are
 * strings, so a single text node is bounded by the string cap, which
 * boundedSlice's limit keeps well inside), and this writes the mapping
 * `xmlEmit.ts` reads back:
 *
 * - the document is `{"<root>": <element>}`;
 * - an element with no attributes and no child elements is its text, a string;
 * - otherwise an object: attributes first as `"@name"`, then child elements in
 *   document order, with a run of same-named siblings written as one array, and
 *   `"#text"` for the text of an element that has no child elements;
 * - an element with child elements and non-white-space text, and a name that
 *   comes back after a different sibling, are not objects: they are errors.
 *
 * Output is written as elements close. The first element of a run waits for its
 * next sibling to learn whether the run is an array; later elements of a run
 * stream straight through, so a million-row table never sits in memory.
 */
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { SaxesParser } from "saxes";

import { ByteWriter } from "./byteWriter.ts";
import { FormatSyntaxError, UnrepresentableError } from "./errors.ts";
import type { UnrepresentableReason } from "./errors.ts";

const FLUSH = 1 << 20;

interface Frame {
  readonly name: string;
  readonly attrs: Array<readonly [string, string]>;
  readonly text: string[];
  hasNonWs: boolean;
  children: number;
  readonly seen: Set<string>;
  lastName: string | undefined;
  runCount: number;
  held: Uint8Array | undefined;
  started: boolean;
  members: number;
  readonly buf: ByteWriter;
  /** Streams to the sink as it fills: every ancestor's output before it is already written. */
  attached: boolean;
}

const isWhitespace = (s: string) => /^[ \t\r\n]*$/.test(s);

export class XmlToJson {
  private readonly parser = new SaxesParser();
  private readonly onOutput: (chunk: Uint8Array) => void;
  private readonly stack: Frame[] = [];
  private tail: Uint8Array = new Uint8Array(0);
  private failure: Error | undefined;
  private wrote = false;
  private readonly runIndex: number[] = [];

  constructor(onOutput: (chunk: Uint8Array) => void) {
    this.onOutput = onOutput;
    const p = this.parser;
    p.on("opentag", (tag) =>
      this.guard(() => this.open(tag.name, tag.attributes as Record<string, string>)),
    );
    p.on("text", (t) => this.guard(() => this.addText(t)));
    p.on("cdata", (t) => this.guard(() => this.addText(t)));
    p.on("closetag", () => this.guard(() => this.close()));
    p.on("error", (e) => {
      this.failure ??= new FormatSyntaxError({ format: "xml", offset: -1, detail: e.message });
    });
  }

  private guard(f: () => void) {
    if (this.failure) return;
    try {
      f();
    } catch (error) {
      this.failure = error as Error;
    }
  }

  private fail(reason: UnrepresentableReason, detail: string): never {
    throw new UnrepresentableError({
      from: "xml",
      to: "json",
      reason,
      pointer: this.pointerOf(),
      detail,
    });
  }

  private pointerOf() {
    let out = "";
    this.stack.forEach((f, i) => {
      out += `/${f.name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      const run = this.runIndex[i];
      if (run !== undefined && run > 0) out += `/${run}`;
    });
    return out;
  }

  private newFrame(
    name: string,
    attrs: Array<readonly [string, string]>,
    attached: boolean,
  ): Frame {
    return {
      name,
      attrs,
      text: [],
      hasNonWs: false,
      children: 0,
      seen: new Set(),
      lastName: undefined,
      runCount: 0,
      held: undefined,
      started: false,
      members: 0,
      buf: new ByteWriter(1 << 12),
      attached,
    };
  }

  private flush(frame: Frame, force = false) {
    if (!frame.attached) return;
    if (frame.buf.length > 0 && (force || frame.buf.length >= FLUSH))
      this.onOutput(frame.buf.take());
  }

  private open(name: string, attributes: Record<string, string>) {
    const attrs = Object.entries(attributes).map(([k, v]) => [k, v] as const);
    const parent = this.stack[this.stack.length - 1];
    if (!parent) {
      // The document wrapper is written at once; the root element streams.
      const frame = this.newFrame(name, attrs, true);
      frame.buf.text(`{${JSON.stringify(name)}:`);
      this.stack.push(frame);
      this.runIndex.push(0);
      this.wrote = true;
      return;
    }
    if (parent.hasNonWs) this.fail("mixed-content", "child elements beside text");
    parent.text.length = 0;
    this.ensureStarted(parent);
    parent.children++;
    // A name that returns after a different sibling cannot be a key of the same object.
    if (parent.lastName !== name) {
      this.finishRun(parent);
      if (parent.seen.has(name)) {
        this.stack.push(this.newFrame(name, attrs, false));
        this.runIndex.push(0);
        this.fail("duplicate-key", `<${name}> returns after a different sibling`);
      }
      parent.seen.add(name);
      parent.lastName = name;
      parent.runCount = 0;
      this.stack.push(this.newFrame(name, attrs, false));
      this.runIndex.push(0);
      return;
    }
    // Same name as the sibling before: the run is an array from now on.
    if (parent.runCount === 1 && parent.held) {
      this.separator(parent);
      parent.buf.text(`${JSON.stringify(name)}:[`);
      parent.buf.bytes(parent.held, 0, parent.held.length);
      parent.held = undefined;
      parent.members++;
    }
    parent.buf.byte(0x2c);
    this.flush(parent, true);
    const attached = parent.attached;
    this.stack.push(this.newFrame(name, attrs, attached));
    this.runIndex.push(parent.runCount);
  }

  private separator(frame: Frame) {
    if (frame.members > 0) frame.buf.byte(0x2c);
  }

  /** Writes `{` and the attributes of an element that turned out to be an object. */
  private ensureStarted(frame: Frame) {
    if (frame.started) return;
    frame.started = true;
    const b = frame.buf;
    b.byte(0x7b);
    frame.attrs.forEach(([k, v], i) => {
      if (i > 0) b.byte(0x2c);
      b.text(`${JSON.stringify(`@${k}`)}:${JSON.stringify(v)}`);
      frame.members++;
    });
  }

  private finishRun(frame: Frame) {
    if (frame.lastName === undefined) return;
    if (frame.runCount === 1 && frame.held) {
      this.separator(frame);
      frame.buf.text(`${JSON.stringify(frame.lastName)}:`);
      frame.buf.bytes(frame.held, 0, frame.held.length);
      frame.held = undefined;
      frame.members++;
    } else if (frame.runCount > 1) {
      frame.buf.byte(0x5d);
    }
    this.flush(frame);
  }

  private addText(text: string) {
    const frame = this.stack[this.stack.length - 1];
    if (!frame || text.length === 0) return;
    const blank = isWhitespace(text);
    if (frame.children > 0) {
      if (!blank) this.fail("mixed-content", "text beside child elements");
      return;
    }
    if (!blank) frame.hasNonWs = true;
    frame.text.push(text);
  }

  private close() {
    const frame = this.stack.pop() as Frame;
    this.runIndex.pop();
    const parent = this.stack[this.stack.length - 1];
    const text = frame.text.join("");
    if (!frame.started && frame.attrs.length === 0) {
      frame.buf.text(JSON.stringify(text));
    } else {
      this.ensureStarted(frame);
      if (frame.children === 0 && text.length > 0) {
        this.separator(frame);
        frame.buf.text(`"#text":${JSON.stringify(text)}`);
        frame.members++;
      }
      this.finishRun(frame);
      frame.buf.byte(0x7d);
    }
    if (!parent) {
      // The root: close the wrapper.
      frame.buf.byte(0x7d);
      this.flush(frame, true);
      if (!frame.attached) this.onOutput(frame.buf.take());
      return;
    }
    if (frame.attached) {
      // It streamed: nothing to hand to the parent but the count.
      this.flush(frame, true);
      parent.runCount++;
      return;
    }
    const rendered = frame.buf.take();
    parent.runCount++;
    if (parent.runCount === 1) parent.held = rendered;
    else {
      parent.buf.bytes(rendered, 0, rendered.length);
      this.flush(parent);
    }
  }

  push(chunk: Uint8Array) {
    if (this.failure) throw this.failure;
    let data = chunk;
    if (this.tail.length > 0) {
      data = new Uint8Array(this.tail.length + chunk.length);
      data.set(this.tail);
      data.set(chunk, this.tail.length);
    }
    // Hold back an incomplete UTF-8 sequence at the end.
    let cut = data.length;
    for (let back = 1; back <= 3 && back <= data.length; back++) {
      const b = data[data.length - back] as number;
      if ((b & 0xc0) === 0x80) continue;
      if (b >= 0xc0) {
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
        if (need > back) cut = data.length - back;
      }
      break;
    }
    this.tail = data.slice(cut);
    if (cut > 0) this.parser.write(decodeUtf8(data.subarray(0, cut)));
    if (this.failure) throw this.failure;
  }

  end() {
    if (this.tail.length > 0) {
      this.parser.write(decodeUtf8(this.tail));
      this.tail = new Uint8Array(0);
    }
    this.parser.close();
    if (this.failure) throw this.failure;
    if (!this.wrote) {
      throw new FormatSyntaxError({ format: "xml", offset: -1, detail: "no root element" });
    }
  }
}
