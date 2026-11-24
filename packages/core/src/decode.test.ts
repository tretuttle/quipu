import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { parseJsonSlice } from "./boundedSlice.ts";
import { PIECE_LOOKBEHIND, PIECE_TAIL, unescapeBytes, unescapePiece } from "./decode.ts";

const utf8 = new TextEncoder();

/** Pieces of every size, concatenated, against the whole string's JSON.parse. */
const checkPieces = (content: string) => {
  const json = `"${content}"`;
  const expected = utf8.encode(parseJsonSlice(utf8.encode(json)) as string);
  const bytes = utf8.encode(json);
  const contentStart = 1;
  const contentEnd = bytes.length - 1;
  const whole = new Uint8Array(bytes.length);
  const n = unescapeBytes(bytes, contentStart, contentEnd, whole, 0);
  expect(Array.from(whole.subarray(0, n))).toEqual(Array.from(expected));
  let splits = 0;
  for (let piece = 1; piece <= Math.max(1, contentEnd - contentStart); piece++) {
    const parts: Uint8Array[] = [];
    for (let start = contentStart; start < contentEnd; start += piece) {
      const end = Math.min(contentEnd, start + piece);
      const from = Math.max(contentStart, start - PIECE_LOOKBEHIND);
      const tailEnd = Math.min(contentEnd, end + PIECE_TAIL);
      parts.push(unescapePiece(bytes.subarray(from, tailEnd), from, start, end));
    }
    const joined = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    expect(Array.from(joined), `piece size ${piece} of ${json}`).toEqual(Array.from(expected));
    splits++;
  }
  return splits;
};

describe("parallel unescape", () => {
  it("composes over every split of strings dense with every escape kind", () => {
    const cases = [
      String.raw`a\"b\\c\/d\b\f\n\r\te\u0001f😀g\\\\h\\\"i`,
      String.raw`\\\\\\\\\\\\\\\"kind\\\\\\\\\\\\\\\":\\\\\\\\\\\\\\\"leaf\\\\\\\"`,
      String.raw`😀😀xx😀é中`,
      String.raw`😀 pair 😀😀 end`,
      String.raw`\ud83d\ude00\\\ud83d\ude00/\\\n\ud83d\ude00`,
      String.raw`x\ud83d\ude00\ud83d\ude00\"\ud83d\ude00`,
      "plain text with no escapes at all, long enough to split many ways",
      String.raw`\\`,
      String.raw`\"`,
      String.raw`A`,
      "",
    ];
    let splits = 0;
    for (const content of cases) splits += checkPieces(content);
    expect(splits).toBeGreaterThan(150);
  });

  const stringified = Arbitrary.schema(
    Schema.Array(Schema.String).check(Schema.isMaxLength(6)),
  ).pipe(
    Arbitrary.map((parts) => {
      // Stack stringification so backslash runs of 1, 3, 7 and 15 appear, as in a HAR body.
      let text = parts.filter((p) => p.isWellFormed()).join("\\");
      for (let level = 0; level < 1 + (parts.length % 4); level++) text = JSON.stringify(text);
      return text.slice(1, -1);
    }),
  );

  it.prop(
    "composes for any stacked-stringified string",
    [stringified],
    ([content]) => {
      checkPieces(content);
    },
    { arbitrary: { runs: 150 } },
  );
});
