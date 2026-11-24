import { describe, expect, it } from "@effect/vitest";

import { EngineHost } from "./document.ts";
import { memoryJournalStore } from "./journalStore.ts";
import { createLocalPool } from "./localPool.ts";

const collector = () => {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk.slice());
    },
  });
  return {
    sink: { _tag: "writable" as const, stream },
    text: () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c]))),
  };
};

/** A host journaling to memory, with a document open under `key` and one edit made. */
const editedDocument = async (key: string) => {
  const store = memoryJournalStore();
  const host = new EngineHost({
    workers: 2,
    crossOriginIsolated: true,
    createPool: createLocalPool,
    journalStore: store,
  });
  const info = await host.handle({
    _tag: "open",
    source: new Blob(['{"a":1}']),
    name: "a.json",
    journalKey: key,
  });
  const root = await host.handle({ _tag: "root", documentId: info.documentId });
  const a = await host.handle({ _tag: "children", ref: root.ref, from: 0, count: 1 });
  await host.handle({ _tag: "setValue", ref: a.nodes[0]!.ref, json: "2" });
  const under = (path: string) => [...store.files.keys()].filter((name) => name.includes(path));
  return { host, store, documentId: info.documentId, under };
};

describe("a saved document's journal", () => {
  it("is gone once the saved document closes, so its next open restores nothing", async () => {
    const { host, documentId, under } = await editedDocument("blob:saved");
    expect(under("saved").length).toBeGreaterThan(0);
    const out = collector();
    await host.handle({ _tag: "save", documentId, sink: out.sink, indent: null });
    expect(out.text()).toBe('{"a":2}');
    await host.handle({ _tag: "close", documentId });
    expect(under("saved")).toEqual([]);
  });

  it("stays when the document closes with unsaved edits, for the next open to offer", async () => {
    const { host, store, documentId, under } = await editedDocument("blob:unsaved");
    await host.handle({ _tag: "close", documentId });
    expect(under("unsaved").length).toBeGreaterThan(0);
    const again = new EngineHost({
      workers: 2,
      crossOriginIsolated: true,
      createPool: createLocalPool,
      journalStore: store,
    });
    const info = await again.handle({
      _tag: "open",
      source: new Blob(['{"a":1}']),
      name: "a.json",
      journalKey: "blob:unsaved",
    });
    expect(info.recovered).toBe(1);
  });
});
