// What a user sees of a file's format, of a broken file, of an export's choices, and of the
// history across a save. JSON.parse is not needed here: every check reads the engine's answers.
import type {
  ConvertSettings,
  DocumentInfo,
  EngineResult,
  NodeSummary,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import { EngineHost } from "@quipu/core/document";
import { createLocalPool } from "@quipu/core/localPool";

import { createEngineFormats, memoryScratch } from "./engineFormats.ts";
import { createLocalFormatPool } from "./localPool.ts";

const host = () =>
  new EngineHost({
    workers: 2,
    crossOriginIsolated: true,
    createPool: createLocalPool,
    formats: createEngineFormats({
      createPool: () => createLocalFormatPool(2),
      scratch: memoryScratch,
    }),
  });

const open = (engine: EngineHost, name: string, contents: string | Blob, asFormat?: "jsonc") =>
  engine.handle({
    _tag: "open",
    source: typeof contents === "string" ? new Blob([contents]) : contents,
    name,
    ...(asFormat === undefined ? {} : { asFormat }),
  });

const keysOf = async (engine: EngineHost, node: NodeSummary) => {
  if (node.childCount === 0) return [];
  const page = await engine.handle({
    _tag: "rows",
    ref: node.ref,
    from: 0,
    count: Math.min(1024, node.childCount),
    previewBytes: 64,
  });
  return page.rows.map((row) => row.key);
};

const saved = async (engine: EngineHost, documentId: number) => {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk.slice());
    },
  });
  await engine.handle({
    _tag: "save",
    documentId,
    sink: { _tag: "writable", stream },
    indent: null,
  });
  return new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
};

const NOTES = "Meeting notes\nAttendees: Ana, Bo\nAction items:\n- send the draft\n- book a room\n";

describe("the format a file opens as", () => {
  it("is text for a plain-text extension, whatever its lines look like", async () => {
    const info = await open(host(), "notes.txt", NOTES);
    expect(info).toMatchObject({ format: "text", structure: "none", note: null });
  });

  it("is text, without a complaint, for a file with no data extension that only looked like YAML", async () => {
    const engine = host();
    const broken = "Attendees: Ana, Bo\nAction items:\n  plan: one\n Next week: two\n";
    expect(await open(engine, "Pasted text", broken)).toMatchObject({ format: "text", note: null });
    // A real YAML file with no extension still opens as YAML.
    expect(await open(engine, "config", "service: quipu\nreplicas: 3\n")).toMatchObject({
      format: "yaml",
      structure: "converted",
    });
  });

  it("is the named format for a broken file, which says what is wrong in words", async () => {
    const info = await open(host(), "broken.yaml", "a: 1\nb: [unclosed\nc: 3\n");
    expect(info.format).toBe("yaml");
    expect(info.structure).toBe("none");
    expect(info.note).toMatch(
      /^This (YAML file has .+ at line \d+|file could not be read as YAML near line \d+), so it opens as text\.$/,
    );
    expect(info.note).not.toMatch(/[Ff]low sequence|[Ii]mplicit/);
  });

  it("is JSON for a .json file with a trailing comma, which is reported and offered as JSONC", async () => {
    const engine = host();
    const text = '{\n  "a": 1,\n  "b": [1, 2,],\n}\n';
    const info = await open(engine, "data.json", text);
    expect(info).toMatchObject({ format: "json", structure: "native", editable: true });
    const problem = (await engine.handle({
      _tag: "problem",
      documentId: info.documentId,
    })) as EngineResult["problem"];
    expect(problem).toMatchObject({ line: 3, readsAsJsonc: true });
    expect(problem?.message).toMatch(
      /^Not valid JSON: a comma before the end of a list or object at line 3/,
    );
    const asJsonc = await open(engine, "data.json", text, "jsonc");
    expect(asJsonc).toMatchObject({ format: "jsonc", structure: "native" });
    expect(await engine.handle({ _tag: "problem", documentId: asJsonc.documentId })).toBeNull();
  });
});

describe("a broken JSON file's tree", () => {
  it("shows nothing past the first problem", async () => {
    const engine = host();
    const quotes = await open(engine, "quotes.json", "{'single': 'quotes', unquoted: true}");
    await engine.handle({ _tag: "problem", documentId: quotes.documentId });
    const root = await engine.handle({ _tag: "root", documentId: quotes.documentId });
    expect(root.childCount).toBe(0);
    expect(await keysOf(engine, root)).toEqual([]);

    const nested = await open(engine, "nested.json", '{"a":1,"b":{"c":2,,"d":3},"e":4}');
    await engine.handle({ _tag: "problem", documentId: nested.documentId });
    const top = await engine.handle({ _tag: "root", documentId: nested.documentId });
    expect(await keysOf(engine, top)).toEqual(["a", "b"]);
    const b = (await engine.handle({ _tag: "children", ref: top.ref, from: 1, count: 1 }))
      .nodes[0] as NodeSummary;
    expect(await keysOf(engine, b)).toEqual(["c"]);
  });
});

describe("the export list", () => {
  const targets = async (engine: EngineHost, info: DocumentInfo) =>
    Object.fromEntries(
      (await engine.handle({ _tag: "exportTargets", documentId: info.documentId })).map((t) => [
        t.format,
        t,
      ]),
    );

  it("says up front that TOML cannot hold a null, and where it is", async () => {
    const engine = host();
    const info = await open(engine, "a.json", '{"kept":1,"gone":{"deleted":null}}');
    expect((await targets(engine, info)).toml).toMatchObject({
      available: false,
      reason: "TOML has no null, and the value at $.gone.deleted is null.",
    });
  });

  it("advises reading CSV columns from every row when a key first appears late", async () => {
    const engine = host();
    const rows = Array.from({ length: 1100 }, (_, i) =>
      i === 1050 ? { id: i, late: true } : { id: i },
    );
    const info = await open(engine, "rows.json", JSON.stringify(rows));
    const all = await targets(engine, info);
    expect(all.csv).toMatchObject({ available: true, reason: null });
    expect(all.csv?.advice).toMatch(/such as "late": read the columns from every row\.$/);
    // Read that way, the export holds it.
    const settings: ConvertSettings = { indent: 2, columns: "full", nested: "json" };
    const chunks: Uint8Array[] = [];
    await engine.handle({
      _tag: "convert",
      documentId: info.documentId,
      to: "csv",
      settings,
      sink: {
        _tag: "writable",
        stream: new WritableStream({ write: (c) => void chunks.push(c.slice()) }),
      },
    });
    expect(new TextDecoder().decode(chunks[0]).split("\n")[0]).toBe("id,late");
  });
});

/** A file the browser can no longer read once it has been written over, as a picked file is. */
class ReplacedFile extends Blob {
  replaced = false;
  override slice(start?: number, end?: number, type?: string): Blob {
    if (this.replaced)
      throw new DOMException("The file changed after it was read.", "NotReadableError");
    return super.slice(start, end, type);
  }
}

describe("saving in place", () => {
  it("keeps the history: after the file is written over, undo still works and makes the document unsaved", async () => {
    const engine = host();
    const file = new ReplacedFile(['{"count":1,"name":"quipu"}']);
    const info = await open(engine, "a.json", file);
    const root = await engine.handle({ _tag: "root", documentId: info.documentId });
    const count = (await engine.handle({ _tag: "children", ref: root.ref, from: 0, count: 1 }))
      .nodes[0] as NodeSummary;
    await engine.handle({ _tag: "setValue", ref: count.ref, json: "42" });
    await engine.handle({ _tag: "detach", documentId: info.documentId });
    file.replaced = true;
    expect(await saved(engine, info.documentId)).toBe('{"count":42,"name":"quipu"}');
    expect((await engine.handle({ _tag: "editState", documentId: info.documentId })).dirty).toBe(
      false,
    );
    const undone = await engine.handle({ _tag: "undo", documentId: info.documentId });
    expect(undone.dirty).toBe(true);
    expect(await saved(engine, info.documentId)).toBe('{"count":1,"name":"quipu"}');
    const redone = await engine.handle({ _tag: "redo", documentId: info.documentId });
    expect(redone.undoDepth).toBe(1);
    expect(await saved(engine, info.documentId)).toBe('{"count":42,"name":"quipu"}');
  });
});
