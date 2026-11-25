import { describe, expect, it } from "@effect/vitest";
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { EngineHost } from "@quipu/core/document";
import { createLocalPool } from "@quipu/core/localPool";
import { parse as parseYaml } from "yaml";

import { convert } from "./convert.ts";
import { createEngineFormats, memoryScratch } from "./engineFormats.ts";
import { indexLineDocument } from "./indexLines.ts";
import { createLocalFormatPool } from "./localPool.ts";
import { children, csvRowsAt, jsonValueAt } from "./testing/tapeValue.ts";
import { textValueAt } from "./testing/textValue.ts";
import { convertText } from "./testing/convertRun.ts";
import { indexYaml } from "./yamlTape.ts";

const utf8 = new TextEncoder();
const enc = (s: string) => utf8.encode(s);

const openViaFormats = async (name: string, contents: string) => {
  const host = new EngineHost({
    workers: 2,
    crossOriginIsolated: true,
    createPool: createLocalPool,
    formats: createEngineFormats({
      createPool: () => createLocalFormatPool(2),
      scratch: memoryScratch,
    }),
  });
  const bytes = enc(contents);
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes]),
    name,
  });
  const rootRef = await host.handle({ _tag: "root", documentId: info.documentId });
  const root = await host.handle({ _tag: "node", ref: rootRef.ref });
  return { host, info, root };
};

describe("format edge cases", () => {
  describe("YAML multi-document streams, anchors, and merge keys", () => {
    const mergeYaml = [
      "defaults: &base",
      "  host: localhost",
      "  port: 8080",
      "override: &over",
      "  port: 9090",
      "  tls: true",
      "service:",
      "  <<: [*base, *over]",
      "  port: 3000",
      "  name: api",
      "",
    ].join("\n");

    it("resolves anchors and merge keys (<<) with own-key and merge precedence in YAML tape and JSON conversion", async () => {
      const bytes = enc(mergeYaml);
      const expected = parseYaml(mergeYaml, { merge: true });
      const index = indexYaml(bytes);
      expect(textValueAt("yaml", bytes, index)).toEqual(expected);

      const converted = JSON.parse(await convertText("yaml", "json", mergeYaml)) as unknown;
      expect(converted).toEqual(expected);
      expect((converted as { service: Record<string, unknown> }).service).toEqual({
        host: "localhost",
        port: 3000,
        tls: true,
        name: "api",
      });
    });

    it("opens and converts multi-document YAML streams (---) with per-document anchors", async () => {
      const stream = [
        "---",
        "base: &a { x: 1, y: 2 }",
        "item:",
        "  <<: *a",
        "  y: 9",
        "---",
        "base: &a { z: 3 }",
        "second: *a",
        "",
      ].join("\n");

      const index = indexYaml(enc(stream));
      expect(index.documents).toBe(2);
      expect(textValueAt("yaml", enc(stream), index)).toEqual([
        { base: { x: 1, y: 2 }, item: { x: 1, y: 9 } },
        { base: { z: 3 }, second: { z: 3 } },
      ]);

      const converted = JSON.parse(await convertText("yaml", "json", stream)) as unknown;
      expect(converted).toEqual([
        { base: { x: 1, y: 2 }, item: { x: 1, y: 9 } },
        { base: { z: 3 }, second: { z: 3 } },
      ]);

      const { host, info, root } = await openViaFormats("stream.yaml", stream);
      expect(info.format).toBe("yaml");
      expect(info.structure).toBe("converted");
      expect(root.childCount).toBe(2);
      await host.handle({ _tag: "close", documentId: info.documentId });
    });
  });

  describe("NDJSON malformed line recovery", () => {
    const brokenNdjson = '{"ok":1}\n{bad json\nnot-json\n{"ok":2}\n';

    it("keeps valid lines parsed while turning malformed lines into string nodes", async () => {
      const converted = JSON.parse(await convertText("ndjson", "json", brokenNdjson)) as unknown;
      expect(converted).toEqual([{ ok: 1 }, "{bad json", "not-json", { ok: 2 }]);

      const { host, info, root } = await openViaFormats("events.ndjson", brokenNdjson);
      expect(info.format).toBe("ndjson");
      expect(info.structure).toBe("converted");
      expect(root.childCount).toBe(4);
      const rows = await host.handle({ _tag: "children", ref: root.ref, from: 0, count: 10 });
      expect(rows.nodes.map((n) => n.kind)).toEqual(["object", "string", "string", "object"]);
      await host.handle({ _tag: "close", documentId: info.documentId });
    });

    it("preserves neighbor lines in lineTape indexing", async () => {
      const pool = createLocalFormatPool(2);
      try {
        const bytes = enc(brokenNdjson);
        const { tape } = await indexLineDocument(
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
          { kind: "ndjson", regionBytes: 16 },
        );
        const top = children(tape, 0);
        expect(top.length).toBeGreaterThanOrEqual(3);
        expect(jsonValueAt(tape, bytes, top[0]!)).toEqual({ ok: 1 });
        expect(jsonValueAt(tape, bytes, top.at(-1)!)).toEqual({ ok: 2 });
      } finally {
        await pool.terminate();
      }
    });
  });

  describe("CSV ragged rows", () => {
    const raggedCsv = "id,name,note\n1,alice,ok\n2,bob\n3,carol,hi,extra1,extra2\n";

    it("handles short and long ragged rows consistently across conversion, engine open, and lineTape", async () => {
      const converted = JSON.parse(await convertText("csv", "json", raggedCsv)) as unknown;
      expect(converted).toEqual([
        { id: "1", name: "alice", note: "ok" },
        { id: "2", name: "bob" },
        { id: "3", name: "carol", note: "hi", _3: "extra1", _4: "extra2" },
      ]);

      const pool = createLocalFormatPool(2);
      try {
        const bytes = enc(raggedCsv);
        const { tape } = await indexLineDocument(
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
          { kind: "csv", delimiter: 0x2c, regionBytes: 10 },
        );
        expect(csvRowsAt(tape, bytes, 0x2c)).toEqual(converted);
        const row2 = children(tape, 0)[1]!;
        expect(children(tape, row2).length).toBe(2);
        const row3 = children(tape, 0)[2]!;
        expect(children(tape, row3).length).toBe(5);
        expect(decodeUtf8(bytes.subarray(tape.start(row3), tape.end(row3)))).toBe(
          "3,carol,hi,extra1,extra2",
        );
      } finally {
        await pool.terminate();
      }

      const { host, info, root } = await openViaFormats("ragged.csv", raggedCsv);
      expect(info.format).toBe("csv");
      expect(info.structure).toBe("converted");
      expect(root.childCount).toBe(3);
      await host.handle({ _tag: "close", documentId: info.documentId });
    });

    it("refuses duplicate header names cleanly", async () => {
      const bytes = enc("a,a\n1,2\n");
      const pool = createLocalFormatPool(1);
      try {
        await expect(
          convert(
            "csv",
            "json",
            {
              spec: {
                kind: "memory",
                buffer: bytes.buffer,
                byteOffset: bytes.byteOffset,
                byteLength: bytes.byteLength,
              },
              size: bytes.byteLength,
            },
            { pool, sink: { write: async () => {} } },
          ),
        ).rejects.toThrow();
      } finally {
        await pool.terminate();
      }
    });
  });
});
