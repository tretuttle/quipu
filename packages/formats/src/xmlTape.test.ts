import { describe, expect, it } from "@effect/vitest";
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { firstChild, KIND_OBJECT, type Tape } from "@quipu/core/tape";
import { SaxesParser } from "saxes";

import { indexXmlDocument } from "./indexXml.ts";
import { createLocalFormatPool } from "./localPool.ts";
import { decodeXmlName, attributeBytes, textBytes } from "./xmlDecode.ts";
import { TEXT_KEY } from "./xmlTape.ts";

const encoder = new TextEncoder();
const enc = (s: string) => encoder.encode(s);

type Node = { name: string; attrs: Array<[string, string]>; content: Array<Node | string> };

/** The tape as the canonical tree: attributes in order, text runs merged, white-space-only text dropped. */
const treeOf = (tape: Tape, bytes: Uint8Array): Node | undefined => {
  const build = (i: number): Node => {
    const at = tape.keyStart(i);
    const node: Node = { name: decodeXmlName(bytes, at + 1), attrs: [], content: [] };
    for (let c = firstChild(tape, i); c >= 0; c = tape.next(c)) {
      const key = tape.keyStart(c);
      if (tape.kind(c) === KIND_OBJECT) node.content.push(build(c));
      else if (key === TEXT_KEY) {
        const text = decodeUtf8(textBytes(bytes, tape.start(c), tape.end(c)));
        const last = node.content[node.content.length - 1];
        if (typeof last === "string") node.content[node.content.length - 1] = last + text;
        else node.content.push(text);
      } else {
        node.attrs.push([
          decodeXmlName(bytes, key),
          decodeUtf8(attributeBytes(bytes, tape.start(c), tape.end(c))),
        ]);
      }
    }
    node.content = node.content.filter((x) => typeof x !== "string" || x.trim() !== "");
    return node;
  };
  const root = firstChild(tape, 0);
  return root < 0 ? undefined : build(root);
};

/** The same tree from saxes, an independent parser. */
const saxTree = (text: string): Node | undefined => {
  const parser = new SaxesParser();
  const stack: Node[] = [];
  let root: Node | undefined;
  parser.on("opentag", (tag) => {
    const node: Node = {
      name: tag.name,
      attrs: Object.entries(tag.attributes).map(([k, v]) => [k, v as string]),
      content: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.content.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on("closetag", () => {
    const node = stack.pop();
    if (node) node.content = node.content.filter((x) => typeof x !== "string" || x.trim() !== "");
  });
  const add = (t: string) => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    const last = parent.content[parent.content.length - 1];
    if (typeof last === "string") parent.content[parent.content.length - 1] = last + t;
    else parent.content.push(t);
  };
  parser.on("text", add);
  parser.on("cdata", add);
  parser.write(text).close();
  return root;
};

const index = async (
  bytes: Uint8Array,
  options: { regionBytes?: number; tokenBudget?: number } = {},
) => {
  const pool = createLocalFormatPool(3);
  try {
    return await indexXmlDocument(
      pool,
      {
        spec: {
          kind: "memory",
          buffer: bytes.buffer,
          byteOffset: bytes.byteOffset,
          byteLength: bytes.byteLength,
        },
        size: bytes.byteLength,
      },
      options,
    );
  } finally {
    await pool.terminate();
  }
};

const SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<!-- lead comment with <tags> and > signs -->",
  '<!DOCTYPE catalog [ <!ENTITY co "Quipu > Co"> <!-- c --> ]>',
  '<catalog xmlns:x="urn:x" id=\'c-1\' note="a &amp; b &#x41;&#66;">',
  "  <book id=\"b1\" x:lang='en'>",
  "    <title>Knots &lt;&amp;&gt; Cords</title>",
  "    <note><![CDATA[raw <b>markup</b> & ]]> tail</note>",
  '    <empty/><also-empty a="1" />',
  "    <?pi target data?>",
  "    <desc>mixed <b>bold</b> text</desc>",
  "  </book>",
  '  <book id="b2"><title>é 北京 🙂</title></book>',
  "</catalog>",
  "",
].join("\n");

describe("XML on the tape", () => {
  it("matches saxes element for element, whatever the region size", async () => {
    const bytes = enc(SAMPLE);
    const expected = saxTree(SAMPLE);
    expect(expected?.name).toBe("catalog");
    for (const regionBytes of [1, 2, 3, 5, 7, 11, 19, 64, 1 << 20]) {
      const { tape } = await index(bytes, { regionBytes });
      expect(treeOf(tape, bytes), `regionBytes=${regionBytes}`).toEqual(expected);
    }
  });

  it("keeps child counts and byte ranges: an element spans its start tag to its end tag", async () => {
    const bytes = enc(SAMPLE);
    const { tape } = await index(bytes, { regionBytes: 13 });
    const root = firstChild(tape, 0);
    expect(decodeUtf8(bytes.subarray(tape.start(root), tape.start(root) + 8))).toBe("<catalog");
    expect(decodeUtf8(bytes.subarray(tape.end(root) - 10, tape.end(root)))).toBe("</catalog>");
    // Three attributes and two books; the text between them is white space only.
    expect(tape.childCount(root)).toBe(5);
  });

  it("puts only the top levels on the tape when the budget is tiny, with counts intact", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `<row n="${i}"><v>${i}</v></row>`).join("");
    const bytes = enc(`<table>${rows}</table>`);
    const { tape, maxLevel } = await index(bytes, { regionBytes: 257, tokenBudget: 50 });
    expect(maxLevel).toBeLessThanOrEqual(1);
    const root = firstChild(tape, 0);
    expect(tape.childCount(root)).toBe(300);
  });
});
