import { describe, expect, it } from "@effect/vitest";
import { decodeUtf8, parseJsonSlice } from "@quipu/core/boundedSlice";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";

import { indexLineDocument } from "./indexLines.ts";
import { createLocalFormatPool } from "./localPool.ts";
import { children, csvRowsAt, jsonValueAt } from "./testing/tapeValue.ts";

const encoder = new TextEncoder();
const enc = (s: string) => encoder.encode(s);
const memory = (bytes: Uint8Array) => ({
  spec: {
    kind: "memory" as const,
    buffer: bytes.buffer,
    byteOffset: bytes.byteOffset,
    byteLength: bytes.byteLength,
  },
  size: bytes.byteLength,
});

const index = async (bytes: Uint8Array, options: Parameters<typeof indexLineDocument>[2]) => {
  const pool = createLocalFormatPool(3);
  try {
    return await indexLineDocument(pool, memory(bytes), options);
  } finally {
    await pool.terminate();
  }
};

describe("NDJSON on the tape", () => {
  const lines = ['{"a":1,"b":[1,2,{"c":"é\\n"}]}', "", "[true,null]", '"s"', '  {"x":{}}  ', "42"];
  const text = `${lines.join("\n")}\n`;
  const expected = lines.filter((l) => l.trim() !== "").map((l) => parseJsonSlice(enc(l)));

  it("is an array of the line documents, whatever the region size", async () => {
    const bytes = enc(text.replace(/\n/g, "\r\n"));
    for (const regionBytes of [1, 2, 3, 5, 8, 13, 1 << 20]) {
      const { tape, rows, depth } = await index(bytes, { kind: "ndjson", regionBytes });
      expect(rows).toBe(expected.length);
      expect(depth).toBeGreaterThan(8);
      const got = children(tape, 0).map((c) => jsonValueAt(tape, bytes, c));
      expect(got).toEqual(expected);
      expect(tape.childCount(0)).toBe(expected.length);
    }
  });

  it("keeps a malformed line from corrupting its neighbors", async () => {
    const bytes = enc('{"a":1}\n{"b":[}\n{"c":2}\n');
    const { tape } = await index(bytes, { kind: "ndjson", regionBytes: 1 << 20 });
    const values = children(tape, 0).map((c) => jsonValueAt(tape, bytes, c));
    expect(values[0]).toEqual({ a: 1 });
    expect(values.at(-1)).toEqual({ c: 2 });
  });

  it("keeps only the root and row anchors when the token budget is tiny", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => `{"i":${i}}`);
    const bytes = enc(`${rows.join("\n")}\n`);
    const {
      tape,
      anchors,
      depth,
      rows: counted,
    } = await index(bytes, {
      kind: "ndjson",
      regionBytes: 4096,
      tokenBudget: 10,
    });
    expect(depth).toBe(-1);
    expect(counted).toBe(2500);
    expect(tape.count).toBe(1);
    expect(tape.childCount(0)).toBe(2500);
    for (let a = 0; a < anchors.length; a += 2) {
      const row = anchors[a] as number;
      const offset = anchors[a + 1] as number;
      expect(decodeUtf8(bytes.subarray(offset, offset + 12))).toContain(`"i":${row}}`.slice(0, 5));
    }
    expect(anchors.length / 2).toBeGreaterThanOrEqual(3);
  });
});

describe("CSV on the tape", () => {
  const table =
    'id,name,note\r\n1,"Ana ""A""",hello\r\n\r\n2,"two\nlines",\r\n3,,"x,y"\r\n4,short\r\n5,a,b,c\r\n';

  it("is an array of row objects with byte ranges per field", async () => {
    const bytes = enc(table);
    for (const regionBytes of [1, 2, 3, 7, 16, 1 << 20]) {
      const { tape, rows, header } = await index(bytes, { kind: "csv", regionBytes });
      expect(rows).toBe(5);
      expect(header?.fieldStarts.length).toBe(3);
      const got = csvRowsAt(tape, bytes, 0x2c);
      expect(got).toEqual([
        { id: "1", name: 'Ana "A"', note: "hello" },
        { id: "2", name: "two\nlines", note: "" },
        { id: "3", name: "", note: "x,y" },
        { id: "4", name: "short" },
        { id: "5", name: "a", note: "b", _3: "c" },
      ]);
      // A field's token is its bytes in the file, quotes included.
      const firstRow = children(tape, 0)[0] as number;
      const nameField = children(tape, firstRow)[1] as number;
      expect(decodeUtf8(bytes.subarray(tape.start(nameField), tape.end(nameField)))).toBe(
        '"Ana ""A"""',
      );
    }
  });

  it("reads TSV and skips a byte-order mark", async () => {
    const body = enc('a\tb\n1\t"x\ty"\n');
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);
    const { tape } = await index(bytes, { kind: "csv", delimiter: 0x09, regionBytes: 5 });
    expect(csvRowsAt(tape, bytes, 0x09)).toEqual([{ a: "1", b: "x\ty" }]);
  });

  it.effect.prop(
    "matches csv-parse record for record",
    [
      Arbitrary.schema(
        Schema.Array(Schema.Array(Schema.String).check(Schema.isBetweenLength(3, 3))).check(
          Schema.isBetweenLength(1, 8),
        ),
      ),
      Arbitrary.schema(Schema.Literals([1, 2, 5, 11, 64])),
    ],
    ([rows, regionBytes]) =>
      Effect.promise(async () => {
        const clean = rows.map((r) => r.map((c) => c.replaceAll("\0", "")));
        const text = stringifyCsv([["h1", "h2", "h3"], ...clean]);
        const bytes = enc(text);
        const expected = parseCsv(text, {
          columns: true,
          skip_empty_lines: true,
          relax_column_count: true,
        }) as Array<Record<string, string>>;
        const { tape } = await index(bytes, { kind: "csv", regionBytes });
        expect(csvRowsAt(tape, bytes, 0x2c)).toEqual(expected);
      }),
    { arbitrary: { runs: 120 } },
  );
});
