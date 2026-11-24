/**
 * What the views read from an edited document: the node under a byte offset,
 * the Source view's colors, path queries, the edit state and a journal replay.
 * An edited document is held to a fresh open of its own bytes: the two must
 * answer the same.
 */
import {
  CHILDREN_PAGE_LIMIT,
  EditRefusedError,
  type EditState,
  type NodePath,
  type NodeSummary,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost } from "./document.ts";
import { Journal } from "./journal.ts";
import { memoryJournalStore, type JournalStore } from "./journalStore.ts";
import { createLocalPool } from "./localPool.ts";

const utf8 = new TextEncoder();
const isRefusal = Schema.is(EditRefusedError);
const decoder = new TextDecoder();
const KEY = "blob:views";

const platform = (journalStore?: JournalStore) => ({
  workers: 2,
  crossOriginIsolated: true,
  createPool: createLocalPool,
  journalStore,
  // jq that answers with the bytes it was handed: what a program reads is what is compared.
  runJq: (input: Uint8Array) =>
    Promise.resolve({
      status: "ok" as const,
      output: decoder.decode(input),
      truncated: false,
      message: "",
    }),
});

const open = async (host: EngineHost, text: string | Uint8Array, journalKey?: string) => {
  const bytes = typeof text === "string" ? utf8.encode(text) : text;
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    name: "doc.json",
    ...(journalKey === undefined ? {} : { journalKey }),
  });
  const root = await host.handle({ _tag: "root", documentId: info.documentId });
  return { ...info, root: await host.handle({ _tag: "node", ref: root.ref }) };
};

const SAVED_KEY = "blob:views-saved";

/** A save sink that keeps what it is given. */
const collector = () => {
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      _tag: "writable" as const,
      stream: new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) }),
    },
    bytes: () => {
      const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
      }
      return out;
    },
  };
};

/** The first member's value and the document's size, edits applied. */
const firstValue = async (host: EngineHost, root: NodeSummary) => {
  const [first] = await children(host, root);
  const { text } = await host.handle({ _tag: "text", ref: (first as NodeSummary).ref, limit: 64 });
  const { size } = await host.handle({ _tag: "editState", documentId: root.ref.documentId });
  return { text, size };
};

const children = async (host: EngineHost, node: NodeSummary) =>
  (await host.handle({ _tag: "children", ref: node.ref, from: 0, count: CHILDREN_PAGE_LIMIT }))
    .nodes;

const walk = async (host: EngineHost, node: NodeSummary, out: NodeSummary[] = []) => {
  out.push(node);
  if (node.kind === "object" || node.kind === "array")
    for (const child of await children(host, node)) await walk(host, child, out);
  return out;
};

/** Each container's text and the bytes jq reads for it, in document order. */
const containerTexts = async (host: EngineHost, documentId: number) => {
  const out: Array<{ text: string; jq: string }> = [];
  for (const node of await walk(host, await rootOf(host, documentId))) {
    if (node.kind !== "object" && node.kind !== "array") continue;
    const { text } = await host.handle({ _tag: "text", ref: node.ref, limit: 1 << 20 });
    const jq = await host.handle({ _tag: "jq", ref: node.ref, program: ".", timeoutMs: 1000 });
    out.push({ text, jq: jq.output });
  }
  return out;
};

const rootOf = (host: EngineHost, documentId: number) =>
  host.handle({ _tag: "node", ref: { documentId, tapeId: 0, token: 0 } });

/** The edited document's bytes, as a save would write them. */
const bytesOf = async (host: EngineHost, documentId: number) => {
  const size = (await rootOf(host, documentId)).span.end;
  return host.handle({
    _tag: "logicalSlice",
    documentId,
    tapeId: 0,
    range: { start: 0, end: size },
  });
};

/** A path as the views compare it: what each step is and where it sits, not which tape holds it. */
const shape = (path: NodePath) =>
  path.path.map((step) => ({
    kind: step.node.kind,
    span: step.node.span,
    keyed: step.node.key !== null,
    childCount: step.node.childCount,
    index: step.index,
  }));

const nodeAt = (host: EngineHost, documentId: number, offset: number) =>
  host.handle({ _tag: "nodeAt", documentId, offset });

const sourceRows = async (host: EngineHost, documentId: number) =>
  (
    await host.handle({
      _tag: "sourceRows",
      documentId,
      offset: 0,
      before: 0,
      rows: 256,
      wrapBytes: 4096,
    })
  ).rows.map((row) => ({ start: row.start, text: row.text, spans: row.spans }));

const pathQuery = async (host: EngineHost, documentId: number, path: string) => {
  const result = await host.handle({ _tag: "pathQuery", documentId, path, limit: 10_000 });
  return {
    total: result.total,
    complete: result.complete,
    results: result.results.map((match) => ({
      label: match.label,
      preview: match.preview,
      kind: match.node.kind,
      span: match.node.span,
    })),
  };
};

const PATHS = [
  "$",
  "$.*",
  "$..*",
  "$.a",
  "$..k",
  "$..renamed",
  "$.list[0]",
  "$.list[-1]",
  "$.list[1:]",
  "$.list[::2]",
  "$.list[::-1]",
  "$.nested.s",
  "$['nested']['k']",
];

describe("views over an edited document", () => {
  it("a byte of the edited document finds the node that is there now", async () => {
    const host = new EngineHost(platform());
    const text = `{"a":"x","b":[1,2,3],"c":{"d":true}}`;
    const { documentId, root } = await open(host, text);
    const [a] = await children(host, root);
    await host.handle({
      _tag: "setValue",
      ref: (a as NodeSummary).ref,
      json: `"a much longer string than before"`,
    });
    const edited = decoder.decode(await bytesOf(host, documentId));
    const found = await nodeAt(host, documentId, edited.indexOf("true"));
    const innermost = found.path[found.path.length - 1] as (typeof found.path)[number];
    expect(innermost.node.kind).toBe("true");
    expect(await host.handle({ _tag: "keyText", ref: innermost.node.ref })).toBe("d");
    expect(found.path.map((step) => step.node.kind)).toEqual(["object", "object", "true"]);
    await host.handle({ _tag: "close", documentId });
  });

  it("a search hit after an edit leads to the node that holds it", async () => {
    const host = new EngineHost(platform());
    const { documentId, root } = await open(host, `{"a":1,"b":{"needle":"here"}}`);
    const [a] = await children(host, root);
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: `[10,20,30,40]` });
    const summary = await host.handle({
      _tag: "search",
      documentId,
      query: { mode: "literal", text: "here", caseSensitive: true },
    });
    const hit = await host.handle({
      _tag: "searchHit",
      documentId,
      searchId: summary.searchId,
      index: 0,
    });
    const found = await nodeAt(host, documentId, (hit as NonNullable<typeof hit>).range.start);
    const innermost = found.path[found.path.length - 1] as (typeof found.path)[number];
    expect(innermost.node.kind).toBe("string");
    expect((await host.handle({ _tag: "text", ref: innermost.node.ref, limit: 64 })).text).toBe(
      "here",
    );
    await host.handle({ _tag: "close", documentId });
  });

  it("a path query reads the renamed key, not the one in the file", async () => {
    const host = new EngineHost(platform());
    const { documentId, root } = await open(host, `{"a":1,"b":[1,2,3]}`);
    const [, b] = await children(host, root);
    await host.handle({ _tag: "setKey", ref: (b as NodeSummary).ref, key: "renamed" });
    expect((await pathQuery(host, documentId, "$.b")).total).toBe(0);
    const renamed = await pathQuery(host, documentId, "$.renamed[1]");
    expect(renamed.results.map((r) => [r.label, r.preview])).toEqual([["[1]", "2"]]);
    await host.handle({ _tag: "close", documentId });
  });

  it("the Source view colors an edited document", async () => {
    const host = new EngineHost(platform());
    const { documentId, root } = await open(host, `{"a":1,"b":"two"}`);
    const [a] = await children(host, root);
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: `{"x":[true]}` });
    const rows = await sourceRows(host, documentId);
    expect(rows[0]?.text).toBe(`{"a":{"x":[true]},"b":"two"}`);
    expect(rows[0]?.spans.map((span) => span.kind)).toContain("literal");
    const fresh = new EngineHost(platform());
    const clean = await open(fresh, await bytesOf(host, documentId));
    expect(rows).toEqual(await sourceRows(fresh, clean.documentId));
    await host.handle({ _tag: "close", documentId });
    await fresh.handle({ _tag: "close", documentId: clean.documentId });
  });

  it("an edit inside a nested document keeps the parent's offsets and colors right", async () => {
    const host = new EngineHost(platform());
    const text = JSON.stringify({ body: JSON.stringify({ note: "hi", n: [1] }), after: 7 });
    const { documentId, root } = await open(host, text);
    const [body] = await children(host, root);
    const nested = await host.handle({ _tag: "expandNested", ref: (body as NodeSummary).ref });
    const [note] = await children(host, nested.root);
    await host.handle({
      _tag: "setValue",
      ref: (note as NodeSummary).ref,
      json: `"a note that is a good deal longer"`,
    });
    const bytes = await bytesOf(host, documentId);
    const edited = decoder.decode(bytes);
    const fresh = new EngineHost(platform());
    const clean = await open(fresh, bytes);
    const at = edited.indexOf("7");
    expect(shape(await nodeAt(host, documentId, at))).toEqual(
      shape(await nodeAt(fresh, clean.documentId, at)),
    );
    expect(await sourceRows(host, documentId)).toEqual(await sourceRows(fresh, clean.documentId));
    await host.handle({ _tag: "close", documentId });
    await fresh.handle({ _tag: "close", documentId: clean.documentId });
  });
});

describe("renaming a key", () => {
  /** The member named `key` among a container's children. */
  const memberNamed = async (host: EngineHost, parent: NodeSummary, key: string) => {
    for (const child of await children(host, parent)) {
      if ((await host.handle({ _tag: "keyText", ref: child.ref })) === key) return child;
    }
    throw new Error(`no member named ${key}`);
  };
  const rename = (host: EngineHost, member: NodeSummary, key: string) =>
    host.handle({ _tag: "setKey", ref: member.ref, key }).then(
      () => "renamed",
      (error: unknown) => (isRefusal(error) ? error.message : String(error)),
    );

  it("to a key the object already has is refused with the reason, wherever the object is", async () => {
    const text = JSON.stringify({
      top: { a: 1, b: 2, inner: { q: 1 } },
      body: JSON.stringify({ x: 1, y: 2 }),
      list: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `n${i}` })),
      wide: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
    }).replace('"a":1', '"\\u0061":1');
    // Tiny regions and token budget: `list` is cut, its elements come from buckets.
    const host = new EngineHost(platform(), { regionBytes: 64, tokenBudget: 4 });
    const { documentId, root } = await open(host, text);
    const before = decoder.decode(await bytesOf(host, documentId));
    const top = await memberNamed(host, root, "top");
    const refused =
      'This object already has a key named "a". Rename that one first, or pick another name.';
    // The key is compared as it reads, not as it is written (`"\u0061"` is "a").
    expect(await rename(host, await memberNamed(host, top, "b"), "a")).toBe(refused);

    // In an object an earlier edit re-indexed.
    await host.handle({
      _tag: "setValue",
      ref: (await memberNamed(host, top, "a")).ref,
      json: "10",
    });
    const topAgain = await memberNamed(host, await rootOf(host, documentId), "top");
    expect(await rename(host, await memberNamed(host, topAgain, "b"), "a")).toBe(refused);
    // A member whose value an edit re-indexed: it is the root of that edit's tape.
    await host.handle({
      _tag: "setValue",
      ref: (await memberNamed(host, topAgain, "inner")).ref,
      json: `{"q": 2}`,
    });
    const topThird = await memberNamed(host, await rootOf(host, documentId), "top");
    expect(await rename(host, await memberNamed(host, topThird, "inner"), "a")).toBe(refused);

    // A member of an object the index cut (here the root): it is the root of a bucket tape.
    expect((await rootOf(host, documentId)).childrenIndexed).toBe(false);
    const wide = await memberNamed(host, await rootOf(host, documentId), "wide");
    expect(await rename(host, wide, "list")).toBe(
      'This object already has a key named "list". Rename that one first, or pick another name.',
    );

    // In an element of a cut array.
    const list = await memberNamed(host, await rootOf(host, documentId), "list");
    const [, element] = await children(host, list);
    expect(await rename(host, await memberNamed(host, element as NodeSummary, "name"), "id")).toBe(
      'This object already has a key named "id". Rename that one first, or pick another name.',
    );

    // In a nested document.
    const body = await memberNamed(host, await rootOf(host, documentId), "body");
    const nested = await host.handle({ _tag: "expandNested", ref: body.ref });
    expect(await rename(host, await memberNamed(host, nested.root, "y"), "x")).toBe(
      'This object already has a key named "x". Rename that one first, or pick another name.',
    );

    // Only the value edits landed; a free name and the key's own name are fine.
    expect((await host.handle({ _tag: "editState", documentId })).undoDepth).toBe(2);
    expect(decoder.decode(await bytesOf(host, documentId))).toBe(
      before.replace('"\\u0061":1', '"\\u0061":10').replace('{"q":1}', '{"q": 2}'),
    );
    expect(await rename(host, await memberNamed(host, topThird, "b"), "c")).toBe("renamed");
    const topLast = await memberNamed(host, await rootOf(host, documentId), "top");
    expect(await rename(host, await memberNamed(host, topLast, "c"), "c")).toBe("renamed");
    await host.handle({ _tag: "close", documentId });
  });
});

describe("an object or an array as a value", () => {
  it("reads as edited, inside and in a nested document under it, for the editor and for jq", async () => {
    const host = new EngineHost(platform());
    const text = JSON.stringify({ outer: { body: JSON.stringify({ x: 1 }), n: 2 }, tail: [1] });
    const { documentId, root } = await open(host, text);
    const [outer] = await children(host, root);
    const [body, n] = await children(host, outer as NodeSummary);
    await host.handle({ _tag: "setValue", ref: (n as NodeSummary).ref, json: "3" });
    const nested = await host.handle({ _tag: "expandNested", ref: (body as NodeSummary).ref });
    const [x] = await children(host, nested.root);
    await host.handle({ _tag: "setValue", ref: (x as NodeSummary).ref, json: "5" });
    const expected = JSON.stringify({ body: JSON.stringify({ x: 5 }), n: 3 });
    const outerRef = (outer as NodeSummary).ref;
    expect(await host.handle({ _tag: "text", ref: outerRef, limit: 1 << 20 })).toEqual({
      text: expected,
      truncated: false,
      bytes: expected.length,
    });
    const jq = await host.handle({ _tag: "jq", ref: outerRef, program: ".", timeoutMs: 1000 });
    expect(jq.output).toBe(expected);
    expect(jq.inputBytes).toBe(expected.length);
    // A cut read stops on a character, and says how much there is.
    expect(await host.handle({ _tag: "text", ref: outerRef, limit: 4 })).toEqual({
      text: expected.slice(0, 4),
      truncated: true,
      bytes: expected.length,
    });

    // The editor writes the object back whole.
    await host.handle({ _tag: "setValue", ref: outerRef, json: `{"y": [1, 2]}` });
    const [outerAgain] = await children(host, await rootOf(host, documentId));
    const replaced = await host.handle({
      _tag: "text",
      ref: (outerAgain as NodeSummary).ref,
      limit: 1 << 20,
    });
    expect(replaced.text).toBe(`{"y": [1, 2]}`);
    await host.handle({ _tag: "undo", documentId });
    expect(decoder.decode(await bytesOf(host, documentId))).toBe(
      `{"outer":${expected},"tail":[1]}`,
    );
    await host.handle({ _tag: "close", documentId });
  });
});

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
const Step = Schema.Struct({
  pick: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  action: Schema.Literals(["value", "key", "sortKeys", "format", "undo"]),
  value: JsonValue,
});
const Script = Schema.Struct({
  document: Schema.Struct({
    a: JsonValue,
    list: Schema.Array(JsonValue),
    nested: Schema.Struct({ k: JsonValue, s: WellFormedString }),
  }),
  pretty: Schema.Boolean,
  /** Index in tiny regions with a tiny token budget, so containers are cut and served from buckets. */
  cut: Schema.Boolean,
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
});

/** Applies one scripted step; a step that does not apply to the node it picked is skipped. */
const apply = async (host: EngineHost, documentId: number, step: typeof Step.Type) => {
  if (step.action === "undo") {
    await host.handle({ _tag: "undo", documentId }).catch(() => null);
    return;
  }
  // The root stays an object: a document that is one scalar opens as text, with no index to compare.
  const all = await walk(host, await rootOf(host, documentId));
  const nodes = step.action === "value" ? all.slice(1) : all;
  const node = nodes[
    Math.min(nodes.length - 1, Math.floor(step.pick * nodes.length))
  ] as NodeSummary;
  switch (step.action) {
    case "value":
      await host.handle({ _tag: "setValue", ref: node.ref, json: JSON.stringify(step.value) });
      return;
    case "key":
      if (node.key !== null) await host.handle({ _tag: "setKey", ref: node.ref, key: "renamed" });
      return;
    case "sortKeys":
      if (node.kind === "object")
        await host.handle({
          _tag: "transform",
          ref: node.ref,
          transform: { _tag: "sortKeys", descending: true },
        });
      return;
    case "format":
      await host.handle({
        _tag: "transform",
        ref: node.ref,
        transform: { _tag: "format", indent: 2 },
      });
  }
};

describe("an edited document answers like a fresh open of its bytes", () => {
  it.live.prop(
    "nodeAt at every byte, the Source view's rows and colors, path queries, and containers' text and jq input",
    [Arbitrary.schema(Script)],
    ([{ document, pretty, cut, steps }]) =>
      Effect.promise(async () => {
        const hostOptions = cut ? { regionBytes: 64, tokenBudget: 4 } : {};
        const host = new EngineHost(platform(), hostOptions);
        const text = JSON.stringify(document, null, pretty ? 2 : undefined);
        const { documentId } = await open(host, text);
        for (const step of steps) await apply(host, documentId, step);
        const bytes = await bytesOf(host, documentId);
        const fresh = new EngineHost(platform(), hostOptions);
        const clean = await open(fresh, bytes);
        const stride = Math.max(1, Math.floor(bytes.byteLength / 600));
        for (let at = 0; at < bytes.byteLength; at += stride) {
          expect(shape(await nodeAt(host, documentId, at)), `nodeAt ${at}`).toEqual(
            shape(await nodeAt(fresh, clean.documentId, at)),
          );
        }
        expect(await sourceRows(host, documentId)).toEqual(
          await sourceRows(fresh, clean.documentId),
        );
        for (const path of PATHS) {
          expect(await pathQuery(host, documentId, path), path).toEqual(
            await pathQuery(fresh, clean.documentId, path),
          );
        }
        expect(await containerTexts(host, documentId)).toEqual(
          await containerTexts(fresh, clean.documentId),
        );
        await host.handle({ _tag: "close", documentId });
        await fresh.handle({ _tag: "close", documentId: clean.documentId });
      }),
    { arbitrary: { runs: 60 } },
  );
});

describe("the edit state", () => {
  /** Saves through a writable stream that keeps nothing. */
  const save = (host: EngineHost, documentId: number) =>
    host.handle({
      _tag: "save",
      documentId,
      sink: { _tag: "writable", stream: new WritableStream<Uint8Array>() },
      indent: null,
    });

  it("is dirty while the history differs from what was opened or saved, and is pushed on every change", async () => {
    const host = new EngineHost(platform());
    const events: EditState[] = [];
    host.onEvent = (event) => {
      if (event._tag === "editState") events.push(event.state);
    };
    const { documentId, root } = await open(host, `{"a":1}`);
    const state = () => host.handle({ _tag: "editState", documentId });
    expect(await state()).toMatchObject({ dirty: false, undoDepth: 0, redoDepth: 0, revision: 0 });
    const [a] = await children(host, root);
    const edit = await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
    expect(edit.dirty).toBe(true);
    expect(await state()).toMatchObject({ dirty: true, undoDepth: 1, size: 7 });
    expect((await host.handle({ _tag: "undo", documentId })).dirty).toBe(false);
    expect((await host.handle({ _tag: "redo", documentId })).dirty).toBe(true);
    await save(host, documentId);
    expect(await state()).toMatchObject({ dirty: false, undoDepth: 1 });
    // Undoing past the save point leaves something to save again.
    expect((await host.handle({ _tag: "undo", documentId })).dirty).toBe(true);
    expect((await host.handle({ _tag: "redo", documentId })).dirty).toBe(false);
    expect(events.map((e) => [e.dirty, e.revision])).toEqual([
      [true, 1],
      [false, 2],
      [true, 3],
      [false, 3],
      [true, 4],
      [false, 5],
    ]);
    await host.handle({ _tag: "close", documentId });
  });
});

describe("a recovered journal", () => {
  /** A document big enough that the index takes many regions, with one member edited up front. */
  const big = `{"a":1,"filler":[${Array.from({ length: 60_000 }, (_, i) => i).join(",")}]}`;

  const recordEdit = async (store: JournalStore) => {
    const host = new EngineHost(platform(store));
    const { root } = await open(host, big, KEY);
    const [a] = await children(host, root);
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: `"edited"` });
    // The session is dropped without a save, as a closed tab is.
  };

  it("is replayed before anything is read from the index prefix", async () => {
    const store = memoryJournalStore();
    await recordEdit(store);
    const host = new EngineHost(platform(store), { regionBytes: 4096 });
    const info = await host.handle({
      _tag: "open",
      source: new Blob([utf8.encode(big)]),
      name: "doc.json",
      journalKey: KEY,
    });
    expect(info.recovered).toBe(1);
    // Straight after open, while regions are still merging: what the views ask first.
    const root = await host.handle({ _tag: "root", documentId: info.documentId });
    const page = await host.handle({
      _tag: "rows",
      ref: root.ref,
      from: 0,
      count: 1,
      previewBytes: 64,
    });
    expect(page.rows[0]?.preview?.text).toBe("edited");
    expect(await host.handle({ _tag: "editState", documentId: info.documentId })).toMatchObject({
      dirty: true,
      undoDepth: 1,
      replaying: false,
    });
    await host.handle({ _tag: "close", documentId: info.documentId });
  });

  it("that cannot be replayed never keeps the file from opening: it opens as it is, and the journal is dropped", async () => {
    const store = memoryJournalStore();
    // An undo with no edit before it: what a session left when a save cleared the edits it undid.
    const { journal } = await Journal.open(store, KEY);
    await journal.commit({ op: "undo" });
    const host = new EngineHost(platform(store));
    const opened = await open(host, big, KEY);
    expect(opened.recovered).toBe(1);
    expect(await host.handle({ _tag: "editState", documentId: opened.documentId })).toMatchObject({
      dirty: false,
      undoDepth: 0,
      restoreFailed: true,
    });
    const [a] = await children(host, opened.root);
    expect((await host.handle({ _tag: "text", ref: (a as NodeSummary).ref, limit: 16 })).text).toBe(
      "1",
    );
    await host.handle({ _tag: "close", documentId: opened.documentId });
    expect((await open(new EngineHost(platform(store)), big, KEY)).recovered).toBe(0);
  });

  it("is rolled back whole when a later record fails: nothing of it stays applied", async () => {
    const store = memoryJournalStore();
    await recordEdit(store);
    const { journal } = await Journal.open(store, KEY);
    await journal.commit({ op: "undo" });
    await journal.commit({ op: "undo" });
    const host = new EngineHost(platform(store));
    const opened = await open(host, big, KEY);
    expect(await host.handle({ _tag: "editState", documentId: opened.documentId })).toMatchObject({
      restoreFailed: true,
      undoDepth: 0,
      redoDepth: 0,
    });
    expect(Array.from(await bytesOf(host, opened.documentId))).toEqual(
      Array.from(utf8.encode(big)),
    );
  });

  it("outlives a save: a save elsewhere leaves the file as it was, so its edits come back", async () => {
    const store = memoryJournalStore();
    const host = new EngineHost(platform(store));
    const { documentId, root } = await open(host, big, KEY);
    const [a] = await children(host, root);
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
    await host.handle({
      _tag: "save",
      documentId,
      sink: { _tag: "writable", stream: new WritableStream<Uint8Array>() },
      indent: null,
    });
    await host.handle({ _tag: "undo", documentId });
    // The undo is journaled after the save, against the history it undoes.
    const again = await open(new EngineHost(platform(store)), big, KEY);
    expect(again.recovered).toBe(2);
    const reopened = new EngineHost(platform(store));
    const third = await open(reopened, big, KEY);
    expect(
      await reopened.handle({ _tag: "editState", documentId: third.documentId }),
    ).toMatchObject({
      restoreFailed: false,
      dirty: false,
      redoDepth: 1,
    });
  });

  it("moves to the saved file on a save in place: only the edits made after it come back there", async () => {
    const store = memoryJournalStore();
    const host = new EngineHost(platform(store));
    const { documentId, root } = await open(host, big, KEY);
    const [a] = await children(host, root);
    const ref = (a as NodeSummary).ref;
    await host.handle({ _tag: "setValue", ref, json: "2" });
    const saved = collector();
    await host.handle({ _tag: "save", documentId, sink: saved.sink, indent: null, inPlace: true });
    // Made before the page has told the engine the saved file's key: it moves there with the journal.
    await host.handle({ _tag: "setValue", ref, json: "3" });
    await host.handle({ _tag: "rekeyJournal", documentId, journalKey: SAVED_KEY });

    const onSaved = new EngineHost(platform(store));
    const reopened = await open(onSaved, saved.bytes(), SAVED_KEY);
    expect(reopened.recovered).toBe(1);
    expect(await firstValue(onSaved, reopened.root)).toEqual({ text: "3", size: big.length });
    // The file as it was before the save has nothing left to replay.
    expect((await open(new EngineHost(platform(store)), big, KEY)).recovered).toBe(0);
  });

  it("is emptied by an undo past a save in place, and records again once Redo is back there", async () => {
    const store = memoryJournalStore();
    const host = new EngineHost(platform(store));
    const { documentId, root } = await open(host, big, KEY);
    const [a] = await children(host, root);
    const ref = (a as NodeSummary).ref;
    await host.handle({ _tag: "setValue", ref, json: "2" });
    const saved = collector();
    await host.handle({ _tag: "save", documentId, sink: saved.sink, indent: null, inPlace: true });
    await host.handle({ _tag: "rekeyJournal", documentId, journalKey: SAVED_KEY });

    // Below the save point no record can say what the saved file should become.
    await host.handle({ _tag: "undo", documentId });
    const afterUndo = new EngineHost(platform(store));
    const first = await open(afterUndo, saved.bytes(), SAVED_KEY);
    expect(first.recovered).toBe(0);
    expect(await firstValue(afterUndo, first.root)).toEqual({ text: "2", size: big.length });
    await afterUndo.handle({ _tag: "close", documentId: first.documentId });

    await host.handle({ _tag: "redo", documentId });
    await host.handle({ _tag: "setValue", ref, json: "5" });
    const afterRedo = new EngineHost(platform(store));
    const second = await open(afterRedo, saved.bytes(), SAVED_KEY);
    expect(second.recovered).toBe(1);
    expect(await firstValue(afterRedo, second.root)).toEqual({ text: "5", size: big.length });
  });

  /** A memory store whose journals are held one context at a time, logging when each is taken, read and let go. */
  const lockingStore = () => {
    const base = memoryJournalStore();
    const events: string[] = [];
    const queue = new Map<string, Promise<void>>();
    const releases = new Map<string, () => void>();
    const store: JournalStore = {
      ...base,
      list: (path) => {
        events.push("read");
        return base.list(path);
      },
      acquire: async (path) => {
        const before = queue.get(path) ?? Promise.resolve();
        let release = () => {};
        const mine = new Promise<void>((resolve) => {
          release = resolve;
        });
        queue.set(
          path,
          before.then(() => mine),
        );
        await before;
        releases.set(path, release);
        events.push("take");
      },
      release: (path) => {
        const release = releases.get(path);
        if (release === undefined) return;
        releases.delete(path);
        events.push("let go");
        release();
      },
    };
    return { store, events };
  };

  it("is held by one document at a time: a second open of it waits until the first lets go", async () => {
    const { store, events } = lockingStore();
    const host = new EngineHost(platform(store));
    const first = await open(host, big, KEY);
    const [a] = await children(host, first.root);
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
    // A reload's own reopen and a click on the recent: the second open comes while the first is open.
    const second = open(host, big, KEY);
    await host.handle({ _tag: "close", documentId: first.documentId });
    expect((await second).recovered).toBe(1);
    expect(events).toEqual(["take", "read", "let go", "take", "read"]);
  });

  it("that cannot be opened never keeps the file from opening, and says whether it is busy elsewhere", async () => {
    const failing = (name: string) => {
      const base = memoryJournalStore();
      const store: JournalStore =
        name === "TimeoutError"
          ? { ...base, acquire: () => Promise.reject(new DOMException("held", name)) }
          : { ...base, list: () => Promise.reject(new DOMException("gone", name)) };
      return { base, store };
    };
    for (const [name, expected] of [
      ["TimeoutError", "busy"],
      ["NoModificationAllowedError", "busy"],
      ["NotFoundError", "unreadable"],
    ] as const) {
      const { base, store } = failing(name);
      const host = new EngineHost(platform(store));
      const opened = await open(host, big, KEY);
      expect(opened, name).toMatchObject({ recovered: 0, journalUnavailable: expected });
      // The file as it is, editable, and nothing written where the journal would be.
      const [a] = await children(host, opened.root);
      expect(
        (await host.handle({ _tag: "text", ref: (a as NodeSummary).ref, limit: 16 })).text,
      ).toBe("1");
      await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
      expect(
        [...base.files.keys()].filter((path) => !path.endsWith("meta.json")),
        name,
      ).toEqual([]);
      await host.handle({ _tag: "close", documentId: opened.documentId });
    }
    const fine = await open(new EngineHost(platform(memoryJournalStore())), big, KEY);
    expect(fine.journalUnavailable).toBeNull();
  });

  it("is forgotten when the user discards the edits", async () => {
    const store = memoryJournalStore();
    const host = new EngineHost(platform(store));
    const { documentId, root } = await open(host, big, KEY);
    const [a] = await children(host, root);
    await host.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
    await host.handle({ _tag: "dropJournal", documentId });
    expect((await open(new EngineHost(platform(store)), big, KEY)).recovered).toBe(0);
  });

  it("can be discarded: the original opens and the journal starts over", async () => {
    const store = memoryJournalStore();
    await recordEdit(store);
    const host = new EngineHost(platform(store));
    const info = await host.handle({
      _tag: "open",
      source: new Blob([utf8.encode(big)]),
      name: "doc.json",
      journalKey: KEY,
      discardJournal: true,
    });
    expect(info.recovered).toBe(0);
    const root = await host.handle({ _tag: "root", documentId: info.documentId });
    const [a] = await children(host, root);
    expect((await host.handle({ _tag: "text", ref: (a as NodeSummary).ref, limit: 16 })).text).toBe(
      "1",
    );
    expect((await host.handle({ _tag: "editState", documentId: info.documentId })).dirty).toBe(
      false,
    );
    await host.handle({ _tag: "close", documentId: info.documentId });
    const again = await open(new EngineHost(platform(store)), big, KEY);
    expect(again.recovered).toBe(0);
  });
});
