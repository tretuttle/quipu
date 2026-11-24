/**
 * Byte offset to JSON Pointer. Workers find an offending node by offset because
 * a region does not know the path to where it starts; this reads the source from
 * the top once, on the failure path only, and names the node.
 */
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { COLON } from "@quipu/core/bytes";
import { MAX_KEY_BYTES, unescapeBytes } from "@quipu/core/decode";
import type { ByteSource } from "@quipu/core/source";

import { OffendingNode } from "./abort.ts";
import { JsonPump } from "./convertRegion.ts";
import { type JsonHandler, KIND_ARRAY, KIND_OBJECT, type ScanState } from "./jsonScan.ts";

class Found {
  readonly pointer: string;
  constructor(pointer: string) {
    this.pointer = pointer;
  }
}

const escapePointer = (segment: string) => segment.replaceAll("~", "~0").replaceAll("/", "~1");

class PathTracker implements JsonHandler {
  private readonly st: ScanState;
  private readonly target: number;
  /** Absolute offset of the first byte of the window the pump is handing us. */
  private readonly base: () => number;
  private index: number[] = [];
  private keys: Uint8Array[] = [];

  constructor(st: ScanState, target: number, base: () => number) {
    this.st = st;
    this.target = target;
    this.base = base;
  }

  private ensure(level: number) {
    while (this.index.length <= level) {
      this.index.push(-1);
      this.keys.push(new Uint8Array(0));
    }
  }

  /** A value begins at window index `at`: count it, and name it when it is the target. */
  private arrive(at: number) {
    const start = this.base() + at;
    const level = this.st.depth - 1;
    if (level < 0) {
      if (start >= this.target) throw new Found("");
      return;
    }
    this.ensure(level);
    if (this.st.kinds[level] === KIND_ARRAY) this.index[level] = (this.index[level] as number) + 1;
    if (start < this.target) return;
    throw new Found(this.pointerTo(level));
  }

  private pointerTo(level: number) {
    let out = "";
    for (let l = 0; l <= level; l++) {
      if (this.st.kinds[l] === KIND_ARRAY) out += `/${this.index[l] as number}`;
      else out += `/${escapePointer(decodeUtf8(this.keys[l] as Uint8Array, MAX_KEY_BYTES))}`;
    }
    return out;
  }

  open(_kind: number, pos: number) {
    this.arrive(pos);
    // Entering the container: its children start counting from -1.
    this.ensure(this.st.depth);
    this.index[this.st.depth] = -1;
  }

  close() {}

  key(bytes: Uint8Array, start: number, end: number) {
    const level = this.st.depth - 1;
    this.ensure(level);
    const out = new Uint8Array(end - start);
    const n = unescapeBytes(bytes, start + 1, end - 1, out, 0);
    this.keys[level] = out.slice(0, n);
    // The member the key names is the node; point at it when the key is the target.
    if (this.base() + start >= this.target) throw new Found(this.pointerTo(level));
  }

  string(_bytes: Uint8Array, start: number) {
    this.arrive(start);
  }

  scalar(_bytes: Uint8Array, start: number) {
    this.arrive(start);
  }

  /** A string longer than the pump's window: only where it starts matters, not its bytes. */
  partialString(_bytes: Uint8Array, start: number) {
    const st = this.st;
    const level = st.depth - 1;
    if (level >= 0 && st.kinds[level] === KIND_OBJECT && st.prevSig !== COLON) {
      throw new OffendingNode(
        this.base() + start,
        "key-too-long",
        "an object key longer than 1 MiB",
      );
    }
    this.arrive(start);
  }

  continueString() {}
}

/**
 * The JSON Pointer of the node that starts at `offset` in a stream of JSON bytes.
 * `feed` pushes the stream chunk by chunk and may stop early when `push` returns
 * true (the offset is behind it). Nothing is held but the path to the node.
 */
export const locatePointerFrom = async (
  offset: number,
  feed: (push: (chunk: Uint8Array) => boolean) => Promise<void>,
): Promise<string> => {
  const slack = 4 * 1024 * 1024;
  const pump: JsonPump = new JsonPump(
    (st) => new PathTracker(st, offset, () => pump.windowOffset),
    () => {},
    { hold: 1 << 20 },
  );
  try {
    await feed((chunk) => {
      pump.push(chunk);
      return pump.consumed > offset + slack;
    });
    pump.end();
  } catch (error) {
    if (error instanceof Found) return error.pointer;
    throw error;
  }
  return "";
};

/** The JSON Pointer of the node that starts at `offset` in a JSON source. */
export const locatePointer = (source: ByteSource, offset: number): Promise<string> =>
  locatePointerFrom(offset, async (push) => {
    const step = 4 * 1024 * 1024;
    for (let at = 0; at < source.size; at += step) {
      if (push(await source.read(at, Math.min(source.size, at + step)))) break;
    }
  });
