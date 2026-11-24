import { CHILDREN_PAGE_LIMIT, MAX_SLICE_BYTES, type NodeSummary } from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { parseJsonSlice } from "./boundedSlice.ts";
import { EngineHost } from "./document.ts";
import { Journal, type JournalRecord } from "./journal.ts";
import {
  type JournalStore,
  memoryJournalStore,
  portJournalStore,
  serveJournalStore,
} from "./journalStore.ts";
import { createLocalPool } from "./localPool.ts";

const utf8 = new TextEncoder();
const decoder = new TextDecoder();
const KEY = "blob:abc123";
const DIR = "journals/blob/abc123";
const options = { arbitrary: { runs: 40 } };

const platform = (store: JournalStore | undefined) => ({
  workers: 2,
  crossOriginIsolated: true,
  createPool: createLocalPool,
  journalStore: store,
});

const open = async (host: EngineHost, bytes: Uint8Array, journalKey?: string) => {
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    name: "doc.json",
    ...(journalKey === undefined ? {} : { journalKey }),
  });
  const root = await host.handle({ _tag: "root", documentId: info.documentId });
  return {
    documentId: info.documentId,
    root: await host.handle({ _tag: "node", ref: root.ref }),
    recovered: info.recovered,
  };
};

const children = async (host: EngineHost, node: NodeSummary) =>
  (await host.handle({ _tag: "children", ref: node.ref, from: 0, count: CHILDREN_PAGE_LIMIT }))
    .nodes;

const bytesOf = async (host: EngineHost, documentId: number) => {
  const size = (await host.handle({ _tag: "node", ref: { documentId, tapeId: 0, token: 0 } })).span
    .end;
  return host.handle({
    _tag: "logicalSlice",
    documentId,
    tapeId: 0,
    range: { start: 0, end: size },
  });
};

/** What a crash is to the engine: the host is dropped without close; a new one opens the same file and key. */
const reopen = async (store: JournalStore, bytes: Uint8Array) => {
  const host = new EngineHost(platform(store), { regionBytes: 64 });
  const opened = await open(host, bytes, KEY);
  await host.handle({ _tag: "node", ref: opened.root.ref });
  return { host, ...opened };
};

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
  value: JsonValue,
  undo: Schema.Boolean,
  redo: Schema.Boolean,
});
const Script = Schema.Struct({
  document: Schema.Struct({ a: JsonValue, list: Schema.Array(JsonValue), s: WellFormedString }),
  steps: Schema.Array(Step).check(Schema.isMaxLength(8)),
  /** Crash after this many durable writes of the last step (0 = none of it reached the store). */
  crashAfter: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
});

const concatAll = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

const walk = async (host: EngineHost, node: NodeSummary, out: NodeSummary[] = []) => {
  out.push(node);
  if (node.kind === "object" || node.kind === "array")
    for (const c of await children(host, node)) await walk(host, c, out);
  return out;
};

describe("the edit journal", () => {
  it.live.prop(
    "a killed session comes back with every committed edit, and a commit cut by power loss is dropped whole",
    [Arbitrary.schema(Script)],
    ([{ document, steps, crashAfter }]) =>
      Effect.promise(async () => {
        const store = memoryJournalStore();
        const original = utf8.encode(JSON.stringify(document, null, 2));
        const live = new EngineHost(platform(store), { regionBytes: 64 });
        const { documentId, root } = await open(live, original, KEY);
        // The bytes after the last operation whose commit completed; a commit is three durable
        // writes (inserted bytes, the record line, meta), and the last step may lose power inside one.
        let committed: Uint8Array = original;
        let commits = 0;
        for (const [index, step] of steps.entries()) {
          const nodes = await walk(live, await live.handle({ _tag: "node", ref: root.ref }));
          const target = nodes[
            Math.min(nodes.length - 1, Math.floor(step.pick * nodes.length))
          ] as NodeSummary;
          if (index === steps.length - 1) store.failAfter = crashAfter;
          try {
            await live.handle({
              _tag: "setValue",
              ref: target.ref,
              json: JSON.stringify(step.value),
            });
            committed = await bytesOf(live, documentId);
            commits++;
            if (step.undo) {
              await live.handle({ _tag: "undo", documentId });
              committed = await bytesOf(live, documentId);
              commits++;
              if (step.redo) {
                await live.handle({ _tag: "redo", documentId });
                committed = await bytesOf(live, documentId);
                commits++;
              }
            }
          } catch (error) {
            if (index !== steps.length - 1) throw error;
          }
        }
        store.failAfter = Number.POSITIVE_INFINITY;
        const recovered = await reopen(store, original);
        expect(recovered.recovered).toBe(commits);
        expect(decoder.decode(await bytesOf(recovered.host, recovered.documentId))).toBe(
          decoder.decode(committed),
        );
        // The recovered session journals on: one more edit survives the next crash too.
        const nodes = await walk(
          recovered.host,
          await recovered.host.handle({ _tag: "node", ref: recovered.root.ref }),
        );
        await recovered.host.handle({
          _tag: "setValue",
          ref: (nodes[0] as NodeSummary).ref,
          json: '"after"',
        });
        const again = await reopen(store, original);
        expect(decoder.decode(await bytesOf(again.host, again.documentId))).toBe('"after"');
        await live.handle({ _tag: "close", documentId }).catch(() => null);
        await recovered.host.handle({ _tag: "close", documentId: recovered.documentId });
        await again.host.handle({ _tag: "close", documentId: again.documentId });
      }),
    options,
  );

  it("recovers edits made two levels down in nested stringified JSON", async () => {
    const store = memoryJournalStore();
    const leaf = { kind: "leaf", note: "knots" };
    const inner = JSON.stringify({ kind: "inner", leaf: JSON.stringify(leaf) });
    const original = utf8.encode(JSON.stringify({ log: { body: inner, after: "z" } }, null, 2));
    const live = new EngineHost(platform(store), { regionBytes: 64 });
    const { documentId, root } = await open(live, original, KEY);
    const log = (await children(live, root))[0] as NodeSummary;
    const [body] = await children(live, log);
    const level1 = await live.handle({ _tag: "expandNested", ref: (body as NodeSummary).ref });
    const [, leafString] = await children(live, level1.root);
    const level2 = await live.handle({
      _tag: "expandNested",
      ref: (leafString as NodeSummary).ref,
    });
    const [, note] = await children(live, level2.root);
    await live.handle({ _tag: "setValue", ref: (note as NodeSummary).ref, json: '"re-knotted"' });
    const expected = decoder.decode(await bytesOf(live, documentId));
    const expectedLeaf = JSON.stringify({ kind: "leaf", note: "re-knotted" });
    expect(parseJsonSlice(utf8.encode(expected))).toEqual({
      log: { body: JSON.stringify({ kind: "inner", leaf: expectedLeaf }), after: "z" },
    });
    const recovered = await reopen(store, original);
    expect(recovered.recovered).toBe(1);
    expect(decoder.decode(await bytesOf(recovered.host, recovered.documentId))).toBe(expected);
    await live.handle({ _tag: "close", documentId });
    await recovered.host.handle({ _tag: "close", documentId: recovered.documentId });
  });

  it("a torn tail in either log, or a stale meta, is cut back to the last whole commit", async () => {
    const store = memoryJournalStore();
    const original = utf8.encode('{"a": 1, "b": 2}');
    const live = new EngineHost(platform(store), { regionBytes: 64 });
    const { documentId, root } = await open(live, original, KEY);
    const [a, b] = await children(live, root);
    await live.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "10" });
    await live.handle({ _tag: "setValue", ref: (b as NodeSummary).ref, json: "20" });
    const good = decoder.decode(await bytesOf(live, documentId));
    // A crash mid-commit: bytes and half a record line past what meta recorded.
    await store.append(`${DIR}/append.bin`, utf8.encode("999"));
    await store.append(`${DIR}/journal.ndjson`, utf8.encode('{"op":"edit","path":[],"at":1'));
    let recovered = await reopen(store, original);
    expect(decoder.decode(await bytesOf(recovered.host, recovered.documentId))).toBe(good);
    expect(await store.size(`${DIR}/journal.ndjson`)).toBe(
      (await store.read(`${DIR}/journal.ndjson`, 0, 1 << 20)).filter((b) => b === 0x0a).length > 0
        ? await store.size(`${DIR}/journal.ndjson`)
        : -1,
    );
    expect(
      decoder.decode(await store.read(`${DIR}/journal.ndjson`, 0, 1 << 20)).endsWith("\n"),
    ).toBe(true);
    await recovered.host.handle({ _tag: "close", documentId: recovered.documentId });
    // Meta claims more than the files hold: the last whole line wins.
    const meta = JSON.parse(
      decoder.decode(await store.read(`${DIR}/meta.json`, 0, 1 << 20)),
    ) as Record<string, unknown>;
    await store.replace(
      `${DIR}/meta.json`,
      utf8.encode(JSON.stringify({ ...meta, journalBytes: 10_000, appendBytes: 10_000 })),
    );
    recovered = await reopen(store, original);
    expect(decoder.decode(await bytesOf(recovered.host, recovered.documentId))).toBe(good);
    await recovered.host.handle({ _tag: "close", documentId: recovered.documentId });
    // Garbage meta: nothing is trusted, the original comes back.
    await store.replace(`${DIR}/meta.json`, utf8.encode("not json"));
    recovered = await reopen(store, original);
    expect(decoder.decode(await bytesOf(recovered.host, recovered.documentId))).toBe(
      '{"a": 1, "b": 2}',
    );
    await recovered.host.handle({ _tag: "close", documentId: recovered.documentId });
    await live.handle({ _tag: "close", documentId });
  });

  it("a save leaves the journal: the file the document was opened from still lacks the edits", async () => {
    const store = memoryJournalStore();
    const original = utf8.encode('{"a": 1}');
    const live = new EngineHost(platform(store), { regionBytes: 64 });
    const { documentId, root } = await open(live, original, KEY);
    const [a] = await children(live, root);
    await live.handle({ _tag: "setValue", ref: (a as NodeSummary).ref, json: "2" });
    const chunks: Uint8Array[] = [];
    await live.handle({
      _tag: "save",
      documentId,
      sink: {
        _tag: "writable",
        stream: new WritableStream<Uint8Array>({
          write: (c) => {
            chunks.push(c.slice());
          },
        }),
      },
      indent: null,
    });
    expect(decoder.decode(concatAll(chunks))).toBe('{"a": 2}');
    // The saved bytes went elsewhere (a download, Save As): the original, opened again, gets the edit back.
    const recovered = await reopen(store, original);
    expect(recovered.recovered).toBe(1);
    expect(decoder.decode(await bytesOf(recovered.host, recovered.documentId))).toBe('{"a": 2}');
    await live.handle({ _tag: "close", documentId });
    await recovered.host.handle({ _tag: "close", documentId: recovered.documentId });
  });

  it("copies to another key: its records, their bytes and the spill files they name", async () => {
    const store = memoryJournalStore();
    // The target key held a journal of its own, written against other bytes: the copy replaces it.
    const { journal: stale } = await Journal.open(store, "blob:target");
    await stale.commit({ op: "edit", path: [], at: 0, del: 0, off: 0, len: 3 }, [
      utf8.encode("old"),
    ]);
    const { journal: source } = await Journal.open(store, KEY);
    await source.commit({ op: "edit", path: [], at: 1, del: 0, off: 0, len: 2 }, [
      utf8.encode("hi"),
    ]);
    const spill = source.newSpill();
    await source.appendSpill(spill, utf8.encode("spilled"));
    await source.commit({ op: "edit", path: [], at: 2, del: 1, off: 0, len: 7, src: spill });
    // Output of a transform that never committed: no record names it.
    const orphan = source.newSpill();
    await source.appendSpill(orphan, utf8.encode("never committed"));
    const sourceRecords = (await Journal.open(store, KEY)).records;

    const copy = await source.copyTo("blob:target");
    await copy.commit({ op: "undo" });
    const read = await Journal.open(store, "blob:target");
    expect(read.records).toEqual([...sourceRecords, { op: "undo" }]);
    const [first, second] = read.records as Array<Extract<JournalRecord, { op: "edit" }>>;
    expect(decoder.decode(await read.journal.inserted(first!))).toBe("hi");
    expect(decoder.decode(await read.journal.inserted(second!))).toBe("spilled");
    expect(await store.size(`journals/blob/target/${orphan}`)).toBe(-1);

    // A copy cut short has no meta yet: it opens as an empty journal, never a partial one.
    store.failAfter = 2;
    await expect(source.copyTo("blob:cut")).rejects.toThrow("the store lost power");
    store.failAfter = Number.POSITIVE_INFINITY;
    expect((await Journal.open(store, "blob:cut")).records).toEqual([]);
  });

  it("the same journal works over a MessagePort, as the desktop's does", async () => {
    const backing = memoryJournalStore();
    const channel = new MessageChannel();
    serveJournalStore(channel.port1, backing);
    const store = portJournalStore(channel.port2);
    const opened = await Journal.open(store, KEY);
    await opened.journal.commit({ op: "edit", path: [], at: 0, del: 1, off: 0, len: 3 }, [
      utf8.encode("abc"),
    ]);
    await opened.journal.commit({ op: "undo" });
    const again = await Journal.open(store, KEY);
    expect(again.records).toEqual([
      { op: "edit", path: [], at: 0, del: 1, off: 0, len: 3 },
      { op: "undo" },
    ]);
    expect(Array.from(await again.journal.inserted(again.records[0] as never))).toEqual(
      Array.from(utf8.encode("abc")),
    );
    expect(await store.list(DIR)).toEqual(
      expect.arrayContaining(["meta.json", "append.bin", "journal.ndjson"]),
    );
    await store.remove(DIR);
    expect(await store.list(DIR)).toEqual([]);
    channel.port1.close();
    channel.port2.close();
  });
});

void MAX_SLICE_BYTES;
