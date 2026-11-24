import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { decodeUtf8 } from "./boundedSlice.ts";
import { ndjsonToArray, splitLines } from "./ndjson.ts";

const utf8 = new TextEncoder();
const rows = Arbitrary.schema(
  Schema.Array(
    Schema.Union([
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
      ),
      Schema.Array(Schema.Finite),
    ]),
  ),
);

describe("NDJSON bodies", () => {
  it.prop(
    "become the array of their lines, whatever the line endings and blank lines",
    [rows],
    ([input]) => {
      const lines = input.map((row) => JSON.stringify(row));
      for (const body of [
        `${lines.join("\n")}\n`,
        lines.join("\r\n"),
        `\n${lines.join("\n\n")}\n\n`,
      ]) {
        const out = ndjsonToArray(utf8.encode(body));
        expect(out.lines).toBe(input.length);
        expect(JSON.parse(decodeUtf8(out.bytes))).toEqual(JSON.parse(JSON.stringify(input)));
      }
    },
    { arbitrary: { runs: 200 } },
  );

  it("carries a line that is not JSON as a string, so the document still indexes", () => {
    const out = ndjsonToArray(utf8.encode('{"a":1}\nnot json "quoted"\n{"b":2}\n'));
    expect(JSON.parse(decodeUtf8(out.bytes))).toEqual([{ a: 1 }, 'not json "quoted"', { b: 2 }]);
  });

  it("lists only the first lines it is asked for and counts the rest", () => {
    const body = utf8.encode(Array.from({ length: 1000 }, (_, i) => `{"i":${i}}`).join("\n"));
    const { lines, total } = splitLines(body, 10);
    expect(lines.length).toBe(10);
    expect(total).toBe(1000);
  });
});
