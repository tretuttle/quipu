// JSON.parse, the yaml and smol-toml parsers and csv-parse are the reference parsers here, independent of
// the readers and writers under test (the exemption to no-whole-document-materialization is for tests).
import {
  CHILDREN_PAGE_LIMIT,
  ConvertError,
  type ConvertFormat,
  type ConvertSettings,
  type DocumentInfo,
  EDITABLE_FORMATS,
  InvalidEditError,
  type NodeSummary,
  STRUCTURED_FORMATS,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import { EngineHost, type FormatPlatform } from "@quipu/core/document";
import { createLocalPool } from "@quipu/core/localPool";
import { parse as parseCsv } from "csv-parse/sync";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { createEngineFormats, memoryScratch } from "./engineFormats.ts";
import { createLocalFormatPool } from "./localPool.ts";

const utf8 = new TextEncoder();
const text = new TextDecoder();

const isConvertError = Schema.is(ConvertError);
const isInvalidEdit = Schema.is(InvalidEditError);

const DEFAULTS: ConvertSettings = { indent: 2, columns: "first", nested: "json" };

const hostWith = (
  formats: FormatPlatform | null = createEngineFormats({
    createPool: () => createLocalFormatPool(2),
    scratch: memoryScratch,
  }),
) =>
  new EngineHost({
    workers: 2,
    crossOriginIsolated: true,
    createPool: createLocalPool,
    ...(formats === null ? {} : { formats }),
  });

const open = (host: EngineHost, name: string, contents: string) =>
  host.handle({ _tag: "open", source: new Blob([contents]), name });

/** The document's value, read node by node through the engine (keys, scalars, children). */
const valueOf = async (host: EngineHost, node: NodeSummary): Promise<unknown> => {
  if (node.kind === "object" || node.kind === "array") {
    const page = await host.handle({
      _tag: "rows",
      ref: node.ref,
      from: 0,
      count: Math.max(1, Math.min(CHILDREN_PAGE_LIMIT, node.childCount)),
      previewBytes: 4096,
    });
    const rows = node.childCount === 0 ? [] : page.rows;
    if (node.kind === "array") return Promise.all(rows.map((row) => valueOf(host, row.node)));
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key as string] = await valueOf(host, row.node);
    return out;
  }
  const value = await host.handle({ _tag: "text", ref: node.ref, limit: 1 << 20 });
  if (node.kind === "string") return value.text;
  return JSON.parse(value.text) as unknown;
};

const rootValue = async (host: EngineHost, info: DocumentInfo) =>
  valueOf(host, await host.handle({ _tag: "root", documentId: info.documentId }));

/** A WritableStream that keeps what it is given. */
const collector = () => {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk.slice());
    },
  });
  const bytes = () => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  return { sink: { _tag: "writable" as const, stream }, bytes };
};

const exported = async (
  host: EngineHost,
  documentId: number,
  to: ConvertFormat,
  settings: ConvertSettings = DEFAULTS,
) => {
  const out = collector();
  const result = await host.handle({ _tag: "convert", documentId, to, settings, sink: out.sink });
  const bytes = out.bytes();
  expect(result.bytes).toBe(bytes.length);
  return text.decode(bytes);
};

const SAMPLE = {
  service: "quipu",
  replicas: 3,
  ratio: 0.5,
  enabled: true,
  tags: ["a", "b"],
  owner: { name: "khipu", "with space": "x" },
};

describe("opening the formats the engine reads through JSON", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly contents: string;
    readonly format: DocumentInfo["format"];
    readonly value: unknown;
  }> = [
    {
      name: "service.yaml",
      contents:
        "service: quipu\nreplicas: 3\nratio: 0.5\nenabled: true\ntags:\n  - a\n  - b\nowner:\n  name: khipu\n  with space: x\n",
      format: "yaml",
      value: SAMPLE,
    },
    {
      name: "service.toml",
      contents:
        'service = "quipu"\nreplicas = 3\nratio = 0.5\nenabled = true\ntags = ["a", "b"]\n\n[owner]\nname = "khipu"\n"with space" = "x"\n',
      format: "toml",
      value: SAMPLE,
    },
    {
      name: "rows.csv",
      contents: 'name,size\nquipu,2\n"khipu, the knot",3\n',
      format: "csv",
      value: [
        { name: "quipu", size: "2" },
        { name: "khipu, the knot", size: "3" },
      ],
    },
    {
      name: "rows.tsv",
      contents: "name\tsize\nquipu\t2\nkhipu\t3\n",
      format: "tsv",
      value: [
        { name: "quipu", size: "2" },
        { name: "khipu", size: "3" },
      ],
    },
    {
      name: "lines.ndjson",
      contents: '{"n":1}\n{"n":2,"s":"two"}\n',
      format: "ndjson",
      value: [{ n: 1 }, { n: 2, s: "two" }],
    },
    {
      name: "feed.xml",
      contents:
        '<?xml version="1.0"?>\n<feed lang="en"><title>Knots</title><item>a</item><item>b</item></feed>\n',
      format: "xml",
      value: { feed: { "@lang": "en", title: "Knots", item: ["a", "b"] } },
    },
  ];

  it.each(cases)(
    "shows $format as a read-only tree with the file as its source",
    async (sample) => {
      const host = hostWith();
      const info = await open(host, sample.name, sample.contents);
      expect(info.format).toBe(sample.format);
      expect(info.structure).toBe("converted");
      expect(info.editable).toBe(false);
      expect(info.note).toMatch(/read-only/);
      expect(info.size).toBe(utf8.encode(sample.contents).length);
      expect(await rootValue(host, info)).toEqual(sample.value);
      // The Source view reads the file, not the JSON the tree is over.
      const head = await host.handle({
        _tag: "headText",
        documentId: info.documentId,
        bytes: 1 << 20,
      });
      expect(head.text).toBe(sample.contents);
      const rows = await host.handle({
        _tag: "sourceRows",
        documentId: info.documentId,
        offset: 0,
        before: 0,
        rows: 64,
        wrapBytes: 4096,
      });
      expect(rows.rows.map((row) => row.text).join("\n")).toBe(sample.contents.replace(/\n$/, ""));
      expect(rows.rows.every((row) => row.spans.length === 0)).toBe(true);
    },
  );

  it("shows JSONC natively: the index's offsets are the file's, so its rows are painted", async () => {
    const host = hostWith();
    const contents =
      '{\n  // the service\n  "service": "quipu", /* inline */\n  "tags": ["a", "b",],\n}\n';
    const info = await open(host, "settings.jsonc", contents);
    expect(info).toMatchObject({ format: "jsonc", structure: "native", editable: false });
    expect(await rootValue(host, info)).toEqual({ service: "quipu", tags: ["a", "b"] });
    const root = await host.handle({ _tag: "root", documentId: info.documentId });
    const service = (
      await host.handle({ _tag: "rows", ref: root.ref, from: 0, count: 2, previewBytes: 64 })
    ).rows[0] as { node: NodeSummary };
    // The node's range is where "quipu" is in the file itself.
    const at = contents.indexOf('"quipu"');
    expect(service.node.range).toEqual({ start: at, end: at + '"quipu"'.length });
    const rows = await host.handle({
      _tag: "sourceRows",
      documentId: info.documentId,
      offset: 0,
      before: 0,
      rows: 8,
      wrapBytes: 4096,
    });
    expect(rows.rows[1]?.text).toBe("  // the service");
    expect(rows.rows[2]?.spans.some((span) => span.kind === "key")).toBe(true);
  });

  it("opens a file whose syntax is broken as text, naming the line", async () => {
    const host = hostWith();
    const info = await open(host, "broken.yaml", "a: 1\nb: [unclosed\nc: 3\n");
    expect(info).toMatchObject({ format: "yaml", structure: "none", editable: false });
    expect(info.note).toBe(
      "This YAML file has a list in [ ] that is not closed or not indented enough at line 3, so it opens as text.",
    );
  });

  it("opens a file whose JSON form is past the limit as text, saying so", async () => {
    const host = hostWith(
      createEngineFormats({
        createPool: () => createLocalFormatPool(1),
        scratch: memoryScratch,
        maxJsonBytes: 16,
      }),
    );
    const info = await open(host, "rows.csv", "name,size\nquipu,2\nkhipu,3\n");
    expect(info).toMatchObject({ format: "csv", structure: "none" });
    expect(info.note).toBe("This CSV file is too large to show as a tree, so it opens as text.");
  });

  it("refuses an edit to a read-only document, and leaves JSON editable", async () => {
    const host = hostWith();
    const yaml = await open(host, "a.yaml", "a: 1\nb: 2\n");
    const root = await host.handle({ _tag: "root", documentId: yaml.documentId });
    await expect(host.handle({ _tag: "setValue", ref: root.ref, json: "{}" })).rejects.toSatisfy(
      isInvalidEdit,
    );
    const json = await open(host, "a.json", '{"a":1}');
    expect(json).toMatchObject({ format: "json", structure: "native", editable: true, note: null });
  });

  it("opens every structured format with a structure, and accepts edits for the editable ones only", async () => {
    const host = hostWith();
    const samples: Record<string, string> = {
      "a.json": '{"a":1}',
      "a.jsonc": '{\n  // a note\n  "a": 1\n}',
      "a.har": '{"log":{"version":"1.2","entries":[]}}',
      "a.ndjson": '{"a":1}\n{"a":2}\n',
      "a.yaml": "a: 1\n",
      "a.toml": "a = 1\n",
      "a.xml": "<a>1</a>",
      "a.csv": "a,b\n1,2\n",
      "a.tsv": "a\tb\n1\t2\n",
    };
    const seen = new Set<string>();
    for (const [name, contents] of Object.entries(samples)) {
      const info = await open(host, name, contents);
      seen.add(info.format);
      expect(info.structure, name).not.toBe("none");
      expect(info.editable, name).toBe(EDITABLE_FORMATS.includes(info.format));
    }
    // The lists the app words its messages from name exactly these formats.
    expect([...seen].toSorted()).toEqual([...STRUCTURED_FORMATS].toSorted());
  });

  it("without a format platform, the engine keeps to JSON, HAR and text", async () => {
    const host = hostWith(null);
    expect(await open(host, "a.yaml", "a: 1\n")).toMatchObject({
      format: "text",
      structure: "none",
    });
    expect(await open(host, "a.ndjson", '{"a":1}\n')).toMatchObject({ format: "json" });
  });
});

describe("saving", () => {
  it("writes the edited bytes, and the edit state is clean after it until the next change", async () => {
    const host = hostWith();
    const info = await open(host, "a.json", '{"a":1,"b":[true]}');
    const root = await host.handle({ _tag: "root", documentId: info.documentId });
    const a = (await host.handle({ _tag: "children", ref: root.ref, from: 0, count: 1 })).nodes[0];
    const edit = await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
    expect(edit.dirty).toBe(true);
    const out = collector();
    const saved = await host.handle({
      _tag: "save",
      documentId: info.documentId,
      sink: out.sink,
      indent: null,
    });
    expect(text.decode(out.bytes())).toBe('{"a":2,"b":[true]}');
    expect(saved.bytes).toBe(out.bytes().length);
    const state = () => host.handle({ _tag: "editState", documentId: info.documentId });
    expect(await state()).toMatchObject({ dirty: false, undoDepth: 1, redoDepth: 0 });
    expect((await host.handle({ _tag: "undo", documentId: info.documentId })).dirty).toBe(true);
    expect((await host.handle({ _tag: "redo", documentId: info.documentId })).dirty).toBe(false);
    // Undo past the save point, then a new edit: the saved state can no longer come back.
    await host.handle({ _tag: "undo", documentId: info.documentId });
    const fresh = await host.handle({ _tag: "root", documentId: info.documentId });
    await host.handle({ _tag: "setValue", ref: fresh.ref, json: "[]" });
    await host.handle({ _tag: "undo", documentId: info.documentId });
    expect((await state()).dirty).toBe(true);
  });

  it("saves a converted document as the file it came from", async () => {
    const host = hostWith();
    const contents = "# keep this comment\na: 1\n";
    const info = await open(host, "a.yaml", contents);
    const out = collector();
    await host.handle({ _tag: "save", documentId: info.documentId, sink: out.sink, indent: null });
    expect(text.decode(out.bytes())).toBe(contents);
  });
});

describe("exporting", () => {
  const records = [
    { id: 1, name: "quipu", tags: ["a"], ok: true },
    { id: 2, name: "khipu, knot", tags: [], ok: false },
  ];

  it("writes every target a list of records allows, and each reads back as the same data", async () => {
    const host = hostWith();
    const info = await open(host, "records.json", JSON.stringify(records));
    expect(JSON.parse(await exported(host, info.documentId, "json"))).toEqual(records);
    expect(await exported(host, info.documentId, "json", { ...DEFAULTS, indent: 0 })).toBe(
      JSON.stringify(records),
    );
    expect(parseYaml(await exported(host, info.documentId, "yaml"))).toEqual(records);
    const ndjson = await exported(host, info.documentId, "ndjson");
    expect(
      ndjson
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(records);
    // CSV has no types and writes nested values as JSON text.
    const csv = parseCsv(await exported(host, info.documentId, "csv"), { columns: true });
    expect(csv).toEqual(
      records.map((r) => ({
        id: `${r.id}`,
        name: r.name,
        tags: JSON.stringify(r.tags),
        ok: `${r.ok}`,
      })),
    );
    const tsv = parseCsv(await exported(host, info.documentId, "tsv"), {
      columns: true,
      delimiter: "\t",
    });
    expect(tsv).toEqual(csv);
  });

  it("converts a document opened through JSON to another format", async () => {
    const host = hostWith();
    const info = await open(host, "service.yaml", "service: quipu\nlimits:\n  cpu: 2\n");
    expect(parseToml(await exported(host, info.documentId, "toml"))).toEqual({
      service: "quipu",
      limits: { cpu: 2 },
    });
    const xml = await open(host, "doc.json", '{"doc":{"@v":"1","title":"Knots"}}');
    expect(await exported(host, xml.documentId, "xml")).toContain(
      '<doc v="1"><title>Knots</title></doc>',
    );
  });

  it("exports the edited document, not the file", async () => {
    const host = hostWith();
    const info = await open(host, "a.json", '{"a":1}');
    const root = await host.handle({ _tag: "root", documentId: info.documentId });
    const a = (await host.handle({ _tag: "children", ref: root.ref, from: 0, count: 1 })).nodes[0];
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: '"two"' });
    expect(parseYaml(await exported(host, info.documentId, "yaml"))).toEqual({ a: "two" });
    // An export is not a save.
    expect((await host.handle({ _tag: "editState", documentId: info.documentId })).dirty).toBe(
      true,
    );
  });

  it("lists the targets the document's shape allows, with the reason for the rest", async () => {
    const host = hostWith();
    const list = await open(host, "list.json", JSON.stringify(records));
    const targets = await host.handle({ _tag: "exportTargets", documentId: list.documentId });
    const reasons = Object.fromEntries(targets.map((t) => [t.format, t.reason]));
    expect(reasons).toEqual({
      json: null,
      yaml: null,
      toml: "TOML needs an object at the top level.",
      xml: "XML needs exactly one member at the top level: the root element.",
      csv: null,
      tsv: null,
      ndjson: null,
    });
    const object = await open(host, "obj.json", '{"a":{"b":1}}');
    const byFormat = Object.fromEntries(
      (await host.handle({ _tag: "exportTargets", documentId: object.documentId })).map((t) => [
        t.format,
        t.available,
      ]),
    );
    expect(byFormat).toEqual({
      json: true,
      yaml: true,
      toml: true,
      xml: true,
      csv: false,
      tsv: false,
      ndjson: false,
    });
  });

  it.effect("refuses what a target cannot hold, naming the node", () =>
    Effect.promise(async () => {
      const host = hostWith();
      const info = await open(host, "nulls.json", '{"a":{"b":[1,null]}}');
      const error = await host
        .handle({
          _tag: "convert",
          documentId: info.documentId,
          to: "toml",
          settings: DEFAULTS,
          sink: collector().sink,
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isConvertError(error)).toBe(true);
      const refused = error as ConvertError;
      expect(refused.pointer).toBe("/a/b/1");
      expect(refused.reason).toBe("null-value");
      expect(refused.message).toMatch(/^TOML cannot hold the value at \/a\/b\/1/);
    }),
  );

  it("refuses nested values in CSV when asked to", async () => {
    const host = hostWith();
    const info = await open(host, "records.json", JSON.stringify(records));
    await expect(
      exported(host, info.documentId, "csv", { ...DEFAULTS, nested: "error" }),
    ).rejects.toMatchObject({ _tag: "ConvertError", pointer: "/0/tags" });
  });
});
