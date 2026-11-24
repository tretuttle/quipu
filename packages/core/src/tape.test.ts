import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { indexBytes, indexBytesSegmented } from "./indexBuffer.ts";
import { FULL_DEPTH } from "./scan.ts";
import { type Tape } from "./tape.ts";
import { walkAgainst } from "./testing/walk.ts";
import { readJson } from "./testing/readJson.ts";

/** JSON values: finite numbers and well-formed strings, nested through suspend. */
// Lone surrogates have no UTF-8 form, so JSON text that holds them cannot round-trip through bytes.
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

const whitespace = ["", " ", "\n", "\t", "\r\n", "  \n  "];
const layout = Arbitrary.schema(Schema.Literals([0, 1, 2, 3]));
const chunk = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })));
const depth = Arbitrary.schema(Schema.Literals([0, 1, 2, FULL_DEPTH]));
const utf8 = new TextEncoder();

/** `JSON.stringify` with the layout's whitespace between tokens, outside strings. */
const render = (value: unknown, kind: number): string => {
  if (kind === 0) return JSON.stringify(value);
  if (kind === 1) return JSON.stringify(value, null, 2);
  const compact = JSON.stringify(value);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < compact.length; i++) {
    const c = compact[i] as string;
    out += c;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === ":" || c === "," || c === "{" || c === "[" || c === "}" || c === "]") {
      out += whitespace[(i + kind) % whitespace.length];
    }
  }
  return `${whitespace[kind]}${out}${whitespace[(kind + 2) % whitespace.length]}`;
};

const sameTape = (a: Tape, b: Tape) => {
  expect(b.count).toBe(a.count);
  for (let i = 0; i < a.count; i++) {
    expect([
      b.kind(i),
      b.start(i),
      b.end(i),
      b.parent(i),
      b.next(i),
      b.childCount(i),
      b.keyStart(i),
    ]).toEqual([
      a.kind(i),
      a.start(i),
      a.end(i),
      a.parent(i),
      a.next(i),
      a.childCount(i),
      a.keyStart(i),
    ]);
  }
};

describe("the structural tape", () => {
  it.prop(
    "indexes any JSON value the way a JSON reader reads it, at every chunk size and eager depth",
    [JsonValue, layout, chunk, depth],
    ([value, kind, chunkBytes, maxDepth]) => {
      const text = render(value, kind);
      const bytes = utf8.encode(text);
      const expected = readJson(bytes);
      const contiguous = indexBytes(bytes, 0, { maxDepth, chunkBytes }).tape;
      const stats = walkAgainst(contiguous, bytes, expected, {
        maxDepth,
        chunkBytes,
        nested: true,
      });
      expect(stats.nodes).toBeGreaterThan(0);
      const segmented = indexBytesSegmented(bytes, 0, { maxDepth, chunkBytes }).tape;
      sameTape(contiguous, segmented);
      expect(segmented.segmentCount).toBe(Math.max(1, Math.ceil(bytes.length / chunkBytes)));
    },
    { arbitrary: { runs: 400 } },
  );

  it("keeps the root's byte range and child count across every chunk boundary of a key", () => {
    const text = '{"a key with spaces":{"nested":[1,2,3]},"b":"x"}';
    const bytes = utf8.encode(text);
    for (let chunkBytes = 1; chunkBytes <= bytes.length; chunkBytes++) {
      const tape = indexBytes(bytes, 0, { maxDepth: FULL_DEPTH, chunkBytes }).tape;
      expect([tape.start(0), tape.end(0), tape.childCount(0)]).toEqual([0, bytes.length, 2]);
      walkAgainst(tape, bytes, readJson(bytes), {
        maxDepth: FULL_DEPTH,
        chunkBytes,
        nested: false,
      });
    }
  });
});
