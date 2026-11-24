import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { escapeBytes, escapedLength, rawBytesFitting } from "./escape.ts";
import {
  ByteWriter,
  formatBytes,
  formatChunk,
  INITIAL_FORMAT_STATE,
  MAX_INDENT_DEPTH,
} from "./format.ts";
import { stringBytes } from "./decode.ts";

const utf8 = new TextEncoder();
const WellFormedString = Schema.String.check(
  Schema.makeFilter((s: string) => s.isWellFormed(), { expected: "a well-formed string" }),
);
const JsonValue: Schema.Codec<unknown> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  WellFormedString,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record(
    WellFormedString,
    Schema.suspend(() => JsonValue),
  ),
]);
const value = Arbitrary.schema(JsonValue);
const chunk = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 })));
const layout = Arbitrary.schema(Schema.Literals([0, 1, 2]));
const options = { arbitrary: { runs: 300 } };

const render = (v: unknown, kind: number) =>
  kind === 0
    ? JSON.stringify(v)
    : kind === 1
      ? JSON.stringify(v, null, 2)
      : JSON.stringify(v, null, "\t\r\n ");

/** Formats `bytes` in chunks of `size`, carrying the state, like the parallel save does. */
const formatInChunks = (bytes: Uint8Array, size: number, indent: number) => {
  const out = new ByteWriter(16);
  let state = INITIAL_FORMAT_STATE;
  for (let at = 0; at < bytes.byteLength; at += size) {
    state = formatChunk(
      bytes.subarray(at, Math.min(bytes.byteLength, at + size)),
      state,
      { indent },
      out,
    );
  }
  return out.take();
};

describe("the streaming formatter", () => {
  it.prop(
    "pretty output equals JSON.stringify(value, null, 2) whatever the input layout and chunking",
    [value, layout, chunk],
    ([v, kind, size]) => {
      const input = utf8.encode(render(v, kind));
      const expected = utf8.encode(JSON.stringify(v, null, 2));
      expect(Array.from(formatInChunks(input, size, 2))).toEqual(Array.from(expected));
      expect(Array.from(formatBytes(input, { indent: 2 }))).toEqual(Array.from(expected));
    },
    options,
  );

  it.prop(
    "minified output equals JSON.stringify(value)",
    [value, layout, chunk],
    ([v, kind, size]) => {
      const input = utf8.encode(render(v, kind));
      expect(Array.from(formatInChunks(input, size, 0))).toEqual(
        Array.from(utf8.encode(JSON.stringify(v))),
      );
    },
    options,
  );

  it("caps the indentation instead of printing 10^10 bytes for a deep document", () => {
    const depth = 400;
    const input = utf8.encode("[".repeat(depth) + "]".repeat(depth));
    const out = formatBytes(input, { indent: 2 });
    const lines = new TextDecoder().decode(out).split("\n");
    const widest = Math.max(...lines.map((l) => l.length - l.trimStart().length));
    expect(widest).toBe(MAX_INDENT_DEPTH * 2);
    expect(lines.length).toBe(depth * 2 - 1);
  });
});

describe("the escaper", () => {
  it.prop(
    "matches JSON.stringify and round-trips through the unescaper",
    [WellFormedString],
    ([s]) => {
      const raw = utf8.encode(s);
      const escaped = escapeBytes(raw);
      expect(Array.from(escaped)).toEqual(Array.from(utf8.encode(JSON.stringify(s).slice(1, -1))));
      expect(escapedLength(raw)).toBe(escaped.byteLength);
      const quoted = new Uint8Array(escaped.byteLength + 2);
      quoted[0] = 0x22;
      quoted.set(escaped, 1);
      quoted[quoted.byteLength - 1] = 0x22;
      expect(Array.from(stringBytes(quoted, 0, quoted.byteLength))).toEqual(Array.from(raw));
    },
    options,
  );

  it("cuts raw input at an escaped-byte budget without splitting an escape", () => {
    const raw = utf8.encode('a"b\nc\u0001d');
    // a=1, "=2, b=1, \n=2, c=1, \u0001=6, d=1
    expect(rawBytesFitting(raw, 0, raw.byteLength, 3)).toEqual({ raw: 2, escaped: 3 });
    expect(rawBytesFitting(raw, 0, raw.byteLength, 7)).toEqual({ raw: 5, escaped: 7 });
    expect(rawBytesFitting(raw, 0, raw.byteLength, 12)).toEqual({ raw: 5, escaped: 7 });
    expect(rawBytesFitting(raw, 0, raw.byteLength, 13)).toEqual({ raw: 6, escaped: 13 });
  });
});
