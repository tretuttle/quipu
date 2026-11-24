import * as NodeServices from "@effect/platform-node/NodeServices";
import { Journal } from "@quipu/core/journal";
import type { JournalStore } from "@quipu/core/journalStore";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "@effect/vitest";

import { makeDesktopJournalStore } from "./DesktopJournalStore.ts";

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

/** A journal store over a fresh state directory, handed to a promise-based test body (the store's API is promises). */
const withStore = (body: (store: JournalStore) => Promise<void>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = yield* fileSystem.makeTempDirectory({ prefix: "quipu-journal-" });
    const store: JournalStore = yield* makeDesktopJournalStore(stateDir);
    yield* Effect.promise(() => body(store));
  }).pipe(Effect.provide(NodeServices.layer));

describe("the desktop journal store", () => {
  it.effect(
    "appends, truncates, replaces and lists under the state directory, and the journal recovers through it",
    () =>
      withStore(async (store) => {
        const opened = await Journal.open(store, "path:deadbeef");
        expect(opened.records).toEqual([]);
        await opened.journal.commit({ op: "edit", path: [], at: 2, del: 1, off: 0, len: 5 }, [
          utf8.encode("hello"),
        ]);
        await opened.journal.commit({ op: "undo" });
        expect((await store.list("journals/path/deadbeef")).sort()).toEqual([
          "append.bin",
          "journal.ndjson",
          "meta.json",
        ]);
        // Power loss after the bytes of a third commit but before its record: recovery drops them.
        await store.append("journals/path/deadbeef/append.bin", utf8.encode("tail"));
        const again = await Journal.open(store, "path:deadbeef");
        expect(again.records).toEqual([
          { op: "edit", path: [], at: 2, del: 1, off: 0, len: 5 },
          { op: "undo" },
        ]);
        expect(decoder.decode(await again.journal.inserted(again.records[0] as never))).toBe(
          "hello",
        );
        expect(await store.size("journals/path/deadbeef/append.bin")).toBe(5);
        await again.journal.reset();
        expect(await store.size("journals/path/deadbeef/journal.ndjson")).toBe(0);
        await store.remove("journals/path/deadbeef");
        expect(await store.list("journals/path/deadbeef")).toEqual([]);
        expect(await store.size("journals/path/deadbeef/meta.json")).toBe(-1);
      }),
  );

  it.effect(
    "starts over a journal that never recorded anything, and copies one to another key",
    () =>
      withStore(async (store) => {
        // A document saved before its first edit: its logs were never written.
        const fresh = await Journal.open(store, "path:fresh");
        await fresh.journal.reset();
        expect((await Journal.open(store, "path:fresh")).records).toEqual([]);

        await fresh.journal.commit({ op: "edit", path: [], at: 0, del: 0, off: 0, len: 2 }, [
          utf8.encode("hi"),
        ]);
        const moved = await fresh.journal.copyTo("path:saved");
        const read = await Journal.open(store, "path:saved");
        expect(read.records).toEqual([{ op: "edit", path: [], at: 0, del: 0, off: 0, len: 2 }]);
        expect(decoder.decode(await read.journal.inserted(read.records[0] as never))).toBe("hi");
        await moved.close();
      }),
  );

  it.effect("refuses a path that leaves the state directory", () =>
    withStore(async (store) => {
      await expect(store.size("../outside")).rejects.toThrow(/leaves the state directory/);
      await expect(store.append("journals/../../x", utf8.encode("a"))).rejects.toThrow(/leaves/);
    }),
  );
});
