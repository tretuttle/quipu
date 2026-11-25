import { describe, expect, it } from "@effect/vitest";

import { EngineHost } from "./document.ts";
import { type JournalStore, memoryJournalStore } from "./journalStore.ts";
import { createLocalPool } from "./localPool.ts";
import {
  memoryScratchBlob,
  mirrorSourceToSpillBlob,
  openSpillScratch,
  teeSink,
} from "./spillReadable.ts";

const utf8 = new TextEncoder();

/** A journal store without `.blob` (matches desktop `portJournalStore`). */
const portLikeJournalStore = (): JournalStore => {
  const inner = memoryJournalStore();
  return {
    size: inner.size,
    read: inner.read,
    append: inner.append,
    truncate: inner.truncate,
    replace: inner.replace,
    remove: inner.remove,
    list: inner.list,
    close: inner.close,
  };
};

const platform = (journalStore?: JournalStore) => ({
  workers: 2,
  crossOriginIsolated: true,
  createPool: createLocalPool,
  journalStore,
});

const openJson = async (host: EngineHost, text: string, journalKey?: string) => {
  const bytes = utf8.encode(text);
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes]),
    name: "doc.json",
    ...(journalKey === undefined ? {} : { journalKey }),
  });
  const root = await host.handle({ _tag: "root", documentId: info.documentId });
  return { documentId: info.documentId, rootRef: root.ref };
};

const searchAll = async (host: EngineHost, documentId: number, query: string) => {
  const summary = await host.handle({
    _tag: "search",
    documentId,
    query: { mode: "literal", text: query, caseSensitive: true },
  });
  const matches: string[] = [];
  for (let i = 0; i < summary.count; i++) {
    const hit = await host.handle({
      _tag: "searchHit",
      documentId,
      searchId: summary.searchId,
      index: i,
    });
    if (!hit) continue;
    const rows = await host.handle({
      _tag: "sourceRows",
      documentId,
      offset: hit.range.start,
      before: 0,
      rows: 1,
      wrapBytes: 256,
    });
    matches.push(rows.rows[0]?.text ?? "");
  }
  await host.handle({ _tag: "searchClose", documentId, searchId: summary.searchId });
  return { count: summary.count, matches };
};

describe("spillReadable", () => {
  it("falls back to an in-memory Blob when OPFS is unavailable", async () => {
    const scratch = await openSpillScratch({ directory: async () => null });
    await scratch.sink.write(utf8.encode("hello "));
    await scratch.sink.write(utf8.encode("world"));
    await scratch.sink.close();
    const blob = await scratch.finish();
    expect(await blob.text()).toBe("hello world");
    await scratch.release();
  });

  it("tees chunks into both journal and scratch sinks", async () => {
    const a = memoryScratchBlob();
    const b = memoryScratchBlob();
    const tee = teeSink(a.sink, b.sink);
    await tee.write(utf8.encode('{"k":'));
    await tee.write(utf8.encode("1}"));
    await tee.close();
    expect(await (await a.finish()).text()).toBe('{"k":1}');
    expect(await (await b.finish()).text()).toBe('{"k":1}');
  });

  it("mirrors a ByteSource into a Blob across chunk boundaries", async () => {
    const raw = utf8.encode("0123456789abcdef");
    const mirrored = await mirrorSourceToSpillBlob(
      { read: async (start, end) => raw.subarray(start, end) },
      raw.length,
    );
    expect(await mirrored.blob.text()).toBe("0123456789abcdef");
    await mirrored.release();
  });
});

describe("post-transform search without saving", () => {
  it("searches after sortKeys, sortArray, format, and minify with a port-like journal store", async () => {
    const host = new EngineHost(platform(portLikeJournalStore()));
    const input =
      '{"z":{"tag":"findme_z"},"a":{"tag":"findme_a"},"items":[{"id":2,"name":"findme_2"},{"id":1,"name":"findme_1"}]}';
    const { documentId, rootRef } = await openJson(host, input, "port:post-transform");

    // 1. sortKeys -> search without saving
    await host.handle({
      _tag: "transform",
      ref: rootRef,
      transform: { _tag: "sortKeys", descending: false },
    });
    const afterSortKeys = await searchAll(host, documentId, "findme_");
    expect(afterSortKeys.count).toBe(4);
    expect(afterSortKeys.matches[0]).toContain("findme_a");

    // 2. sortArray on items -> search without saving
    const rootChildren = await host.handle({ _tag: "children", ref: rootRef, from: 0, count: 10 });
    const itemsNode = rootChildren.nodes[1]!;
    await host.handle({
      _tag: "transform",
      ref: itemsNode.ref,
      transform: { _tag: "sortArray", field: "id", descending: false },
    });
    const afterSortArray = await searchAll(host, documentId, "findme_");
    expect(afterSortArray.count).toBe(4);
    expect(afterSortArray.matches[1]).toContain("findme_1");
    expect(afterSortArray.matches[2]).toContain("findme_2");

    // 3. format -> search without saving (and hit ranges reflect formatted newlines)
    await host.handle({
      _tag: "transform",
      ref: { documentId, tapeId: 0, token: 0 },
      transform: { _tag: "format", indent: 2 },
    });
    const afterFormat = await searchAll(host, documentId, "findme_1");
    expect(afterFormat.count).toBe(1);
    expect(afterFormat.matches[0]).toBe('      "name": "findme_1"');

    // 4. minify -> search without saving
    await host.handle({
      _tag: "transform",
      ref: { documentId, tapeId: 0, token: 0 },
      transform: { _tag: "minify" },
    });
    const afterMinify = await searchAll(host, documentId, "findme_z");
    expect(afterMinify.count).toBe(1);
    expect(afterMinify.matches[0]).toContain('"z":{"tag":"findme_z"}');

    await host.handle({ _tag: "close", documentId });
  });

  it("searches after replaying a recovered transform spill from a port-like journal", async () => {
    const store = portLikeJournalStore();
    const input = '{"b":"target_b","a":"target_a"}';
    const host1 = new EngineHost(platform(store));
    const { documentId: id1, rootRef } = await openJson(host1, input, "port:replay");
    await host1.handle({
      _tag: "transform",
      ref: rootRef,
      transform: { _tag: "sortKeys", descending: false },
    });
    await host1.handle({ _tag: "close", documentId: id1 });

    const host2 = new EngineHost(platform(store));
    const { documentId: id2 } = await openJson(host2, input, "port:replay");
    const result = await searchAll(host2, id2, "target_");
    expect(result.count).toBe(2);
    expect(result.matches[0]).toContain('"a":"target_a"');
    await host2.handle({ _tag: "close", documentId: id2 });
  });

  it("searches after sort and format when no journal store is configured", async () => {
    const host = new EngineHost(platform(undefined));
    const { documentId, rootRef } = await openJson(host, '{"b":"needle_1","a":"needle_2"}');
    await host.handle({
      _tag: "transform",
      ref: rootRef,
      transform: { _tag: "sortKeys", descending: false },
    });
    const formatted = await host.handle({
      _tag: "transform",
      ref: { documentId, tapeId: 0, token: 0 },
      transform: { _tag: "format", indent: 2 },
    });
    expect(formatted.dirty).toBe(true);
    const result = await searchAll(host, documentId, "needle_2");
    expect(result.count).toBe(1);
    expect(result.matches[0]).toBe('  "a": "needle_2",');
    await host.handle({ _tag: "close", documentId });
  });
});
