// Named exemption to no-whole-document-materialization: JSON.parse is the reference parser for
// these differential and round-trip tests, and every input is a sample of a few KiB.
import { describe, expect, it } from "@effect/vitest";
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse as parseCsv } from "csv-parse/sync";
import { parse as parseYaml } from "yaml";

import { JsonPump } from "./convertRegion.ts";
import { indexLineDocument } from "./indexLines.ts";
import { createLocalFormatPool } from "./localPool.ts";
import { convertBytes } from "./testing/run.ts";
import { csvRowsAt } from "./testing/tapeValue.ts";

const encoder = new TextEncoder();
const enc = (s: string) => encoder.encode(s);

const pumped = (bytes: Uint8Array, chunk: number) => {
  const out: Uint8Array[] = [];
  const pump = new JsonPump({ kind: "yaml" }, (c) => void out.push(c));
  for (let at = 0; at < bytes.length; at += chunk) pump.push(bytes.subarray(at, at + chunk));
  pump.end();
  const all = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of out) {
    all.set(c, o);
    o += c.length;
  }
  return decodeUtf8(all);
};

describe("a sequential pump and the region pipeline write the same bytes", () => {
  it("for a document with strings far longer than the plain-scalar limit", async () => {
    const big = "x".repeat(1_500_000);
    const medium = "y z".repeat(10_000);
    const text = JSON.stringify({ big, list: [medium, "short", big], nested: { k: "v" } });
    const bytes = enc(text);
    const whole = decodeUtf8(await convertBytes(bytes, "yaml", { regionBytes: 1 << 24 }));
    expect(parseYaml(whole)).toEqual(JSON.parse(text));
    // The long strings are quoted whatever the split; the short ones stay plain.
    expect(whole).toContain("nested:\n  k: v\n");
    for (const regionBytes of [100_000, 777_777, 2_000_000]) {
      expect(
        decodeUtf8(await convertBytes(bytes, "yaml", { regionBytes })),
        `regions of ${regionBytes}`,
      ).toBe(whole);
    }
    for (const chunk of [1_000_000, 65_536, 3_000_000]) {
      expect(pumped(bytes, chunk), `chunks of ${chunk}`).toBe(whole);
    }
  });

  it.effect.prop(
    "for any JSON value and any chunking",
    [Arbitrary.schema(Schema.Json), Arbitrary.schema(Schema.Literals([1, 2, 3, 5, 13, 64]))],
    ([value, chunk]) =>
      Effect.promise(async () => {
        const bytes = enc(JSON.stringify(value));
        const whole = decodeUtf8(await convertBytes(bytes, "yaml", { regionBytes: 1 << 20 }));
        expect(pumped(bytes, chunk)).toBe(whole);
      }),
    { arbitrary: { runs: 150 } },
  );
});

describe("CSV regions are independent of which worker read a region first", () => {
  it("indexes a table of several hundred rows over many tiny regions on two workers", async () => {
    const rows = Array.from(
      { length: 400 },
      (_, i) => `${i},"name ${i}, ""q""",${i % 7 === 0 ? '"two\nlines"' : "plain"}`,
    );
    const text = `id,name,note\n${rows.join("\n")}\n`;
    const bytes = enc(text);
    const pool = createLocalFormatPool(2);
    try {
      const { tape, rows: count } = await indexLineDocument(
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
        { kind: "csv", regionBytes: 61 },
      );
      expect(count).toBe(400);
      const expected = parseCsv(text, { columns: true }) as Array<Record<string, string>>;
      expect(csvRowsAt(tape, bytes, 0x2c)).toEqual(expected);
    } finally {
      await pool.terminate();
    }
  });
});
