// @effect-diagnostics nodeBuiltinImport:off - drives Chromium against the dev server from Node, outside any Effect runtime.
import { chromium, type Browser } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startDevServer } from "../testing/devServer.ts";
import type { createEngineClient } from "./client.ts";

// The typed client against the real coordinator and scan workers, in Chromium
// on the dev server: what a view gets back when it opens a file. The page
// imports the client module itself, so the test crosses the same worker
// boundary the app does.

/** Loaded by the page itself, through the dev server, so the worker URLs resolve as in the app. */
const CLIENT_MODULE = "/src/engine/client.ts";

type ClientModule = { createEngineClient: typeof createEngineClient };
type Client = ReturnType<ClientModule["createEngineClient"]>;

interface InPageResult {
  readonly capabilities: Awaited<ReturnType<Client["request"]>> & {
    crossOriginIsolated: boolean;
    workers: number;
  };
  readonly size: number;
  readonly rootKind: string;
  readonly version: { text: string; truncated: boolean; bytes: number };
  readonly entryCount: number;
  readonly pageTotal: number;
  readonly pageLength: number;
  readonly lastUrl: string;
  readonly level1Kind: string;
  readonly note: string;
  readonly head: number[];
  readonly search: { count: number; first: number[] };
  readonly notJson: string;
  readonly progress: boolean[];
  readonly edited: {
    readonly text: string;
    readonly size: number;
    readonly span: { start: number; end: number };
    readonly logical: string;
    readonly savedAsIs: string;
    readonly savedPretty: string;
    readonly undoneAsIs: string;
    readonly undoDepth: number;
    readonly redoDepth: number;
  };
}

/** Runs in the page against the real client, workers and all; reads its inputs from `window.__engineTest`. */
const IN_PAGE = `(async () => {
  const { text, nestedIndex, imageIndex, modulePath } = window.__engineTest;
  const { createEngineClient } = await import(modulePath);
  const client = createEngineClient();
  const progress = [];
  client.onProgress((p) => progress.push(p.done));
  const capabilities = await client.request("capabilities", {});
  const info = await client.request("open", { source: new File([text], "sample.har"), name: "sample.har" });
  const root = await client.request("root", { documentId: info.documentId });
  const member = async (ref, key) => {
    const page = await client.request("children", { ref, from: 0, count: 1024 });
    for (const child of page.nodes) {
      if ((await client.request("keyText", { ref: child.ref })) === key) return child;
    }
    throw new Error("no member " + key);
  };
  const log = await member(root.ref, "log");
  const version = await client.request("text", { ref: (await member(log.ref, "version")).ref, limit: 100 });
  const entries = await member(log.ref, "entries");
  const page2 = await client.request("children", { ref: entries.ref, from: 2048, count: 1024 });
  const lastEntry = page2.nodes[page2.nodes.length - 1];
  const lastUrl = await client.request("text", { ref: (await member((await member(lastEntry.ref, "request")).ref, "url")).ref, limit: 1000 });
  const nestedEntry = (await client.request("children", { ref: entries.ref, from: nestedIndex, count: 1 })).nodes[0];
  const nestedBody = await member((await member((await member(nestedEntry.ref, "response")).ref, "content")).ref, "text");
  const level1 = await client.request("expandNested", { ref: nestedBody.ref });
  const payload = await member(level1.root.ref, "payload");
  const level2 = await client.request("expandNested", { ref: payload.ref });
  const level3 = await client.request("expandNested", { ref: (await member(level2.root.ref, "leaf")).ref });
  const note = await client.request("text", { ref: (await member(level3.root.ref, "note")).ref, limit: 100 });
  const imageEntry = (await client.request("children", { ref: entries.ref, from: imageIndex, count: 1 })).nodes[0];
  const imageBody = await member((await member((await member(imageEntry.ref, "response")).ref, "content")).ref, "text");
  const head = await client.request("decodeBase64Head", { ref: imageBody.ref, decodedBytes: 11 });
  const searched = await client.request("search", {
    documentId: info.documentId,
    query: { mode: "literal", text: "application/json", caseSensitive: true },
  });
  const firstHits = await client.request("searchHits", {
    documentId: info.documentId,
    searchId: searched.searchId,
    from: 0,
    to: info.size,
    limit: 2,
  });
  const search = { count: searched.count, first: firstHits.ranges.map((range) => range.start) };
  let notJson = "";
  try {
    await client.request("expandNested", { ref: (await member(log.ref, "version")).ref });
  } catch (error) {
    notJson = error._tag;
  }
  // Edit through the workers, read the edited document back, and save it into OPFS: the
  // File System Access writable a picked file gives, read back from the file itself.
  const versionNode = await member(log.ref, "version");
  const result = await client.request("setValue", { ref: versionNode.ref, json: JSON.stringify("1.3-knot") });
  const editedText = await client.request("text", { ref: result.node.ref, limit: 100 });
  const logical = await client.request("logicalSlice", { documentId: info.documentId, tapeId: 0, range: { start: 0, end: result.size } });
  const directory = await navigator.storage.getDirectory();
  const save = async (indent) => {
    const handle = await directory.getFileHandle("engine-test-save.json", { create: true });
    const saved = await client.request("save", { documentId: info.documentId, sink: { _tag: "fileHandle", handle }, indent });
    const file = await handle.getFile();
    if (file.size !== saved.bytes) throw new Error("saved " + saved.bytes + " bytes but the file has " + file.size);
    const text = await file.text();
    await directory.removeEntry("engine-test-save.json");
    return text;
  };
  const savedAsIs = await save(null);
  const savedPretty = await save(2);
  const undone = await client.request("undo", { documentId: info.documentId });
  const undoneAsIs = await save(null);
  await client.request("close", { documentId: info.documentId });
  client.terminate();
  return {
    capabilities,
    size: info.size,
    rootKind: root.kind,
    version,
    entryCount: entries.childCount,
    pageTotal: page2.total,
    pageLength: page2.nodes.length,
    lastUrl: lastUrl.text,
    level1Kind: level1.root.kind,
    note: note.text,
    head: Array.from(head),
    search,
    notJson,
    progress,
    edited: {
      text: editedText.text,
      size: result.size,
      span: result.node.span,
      logical: new TextDecoder().decode(logical),
      savedAsIs,
      savedPretty,
      undoneAsIs,
      undoDepth: undone.undoDepth,
      redoDepth: undone.redoDepth,
    },
  };
})()`;

const leaf = JSON.stringify({ kind: "leaf", note: "knots é 🧵", values: [1, 2.5, -3e-7] });
const inner = JSON.stringify({ kind: "inner", leaf });
const document = {
  log: {
    version: "1.2",
    entries: Array.from({ length: 2500 }, (_, i) => ({
      request: {
        url: `https://quipu.example/${i}`,
        headers: [{ name: "accept", value: "application/json" }],
      },
      response: {
        status: i % 7 === 0 ? 404 : 200,
        content:
          i === 42
            ? {
                mimeType: "application/json",
                text: JSON.stringify({ kind: "envelope", payload: inner }),
              }
            : i === 7
              ? { mimeType: "image/png", encoding: "base64", text: "aGVsbG8gcXVpcHU=" }
              : { mimeType: "text/plain", text: `entry ${i} "quoted" \\ back` },
      },
    })),
  },
};
const json = JSON.stringify(document);
const hits = json.split("application/json").length - 1;

/**
 * Journal recovery: edits in one worker, the worker terminated right
 * after a commit resolves (and once in the middle of a burst), a new worker
 * opening the same bytes with the same key, and the recovered document read
 * back and saved from OPFS. The second session must find exactly what the first
 * one committed.
 */
const JOURNAL_IN_PAGE = `(async () => {
  const { text, modulePath, key } = window.__engineTest;
  const { createEngineClient } = await import(modulePath);
  const member = async (client, ref, name) => {
    const page = await client.request("children", { ref, from: 0, count: 1024 });
    for (const child of page.nodes) {
      if ((await client.request("keyText", { ref: child.ref })) === name) return child;
    }
    throw new Error("no member " + name);
  };
  const file = new File([text], "sample.har");
  const open = async (client) => {
    const info = await client.request("open", { source: file, name: "sample.har", journalKey: key });
    const root = await client.request("root", { documentId: info.documentId });
    await client.request("node", { ref: root.ref });
    return { info, root };
  };
  const logical = async (client, documentId) => {
    const root = await client.request("node", { ref: { documentId, tapeId: 0, token: 0 } });
    const bytes = await client.request("logicalSlice", { documentId, tapeId: 0, range: { start: 0, end: root.span.end } });
    return new TextDecoder().decode(bytes);
  };
  // Session 1: two committed edits, then the worker dies without closing anything.
  const first = createEngineClient();
  const a = await open(first);
  const log = await member(first, a.root.ref, "log");
  const version = await member(first, log.ref, "version");
  await first.request("setValue", { ref: version.ref, json: JSON.stringify("1.3-knot") });
  const entries = await member(first, log.ref, "entries");
  const entry0 = (await first.request("children", { ref: entries.ref, from: 0, count: 1 })).nodes[0];
  const url = await member(first, (await member(first, entry0.ref, "request")).ref, "url");
  await first.request("setValue", { ref: url.ref, json: JSON.stringify("https://quipu.example/recovered") });
  // A third edit is in flight when the worker is killed: it may or may not have committed.
  const racing = first.request("setValue", { ref: version.ref, json: JSON.stringify("1.4-cut") }).catch(() => null);
  first.terminate();
  await racing;
  // Session 2: the same file and key come back with what was committed.
  const second = createEngineClient();
  const b = await open(second);
  const recoveredText = await logical(second, b.info.documentId);
  const recoveredLog = await member(second, b.root.ref, "log");
  const recoveredVersion = await second.request("text", { ref: (await member(second, recoveredLog.ref, "version")).ref, limit: 100 });
  // An undo in the recovered session is journaled too, and survives another kill.
  const undone = await second.request("undo", { documentId: b.info.documentId });
  const afterUndo = await logical(second, b.info.documentId);
  second.terminate();
  const third = createEngineClient();
  const c = await open(third);
  const thirdText = await logical(third, c.info.documentId);
  // A save in place starts the journal over under the saved file's key: a fourth session of the
  // file as it was finds nothing to replay.
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle("engine-test-journal-save.json", { create: true });
  await third.request("save", { documentId: c.info.documentId, sink: { _tag: "fileHandle", handle }, indent: null, inPlace: true });
  await third.request("rekeyJournal", { documentId: c.info.documentId, journalKey: "blob:engine-test-saved" });
  const savedText = await (await handle.getFile()).text();
  await directory.removeEntry("engine-test-journal-save.json");
  third.terminate();
  const fourth = createEngineClient();
  const d = await open(fourth);
  const fourthText = await logical(fourth, d.info.documentId);
  await fourth.request("close", { documentId: d.info.documentId });
  fourth.terminate();
  await directory.removeEntry("journals", { recursive: true }).catch(() => {});
  return {
    recovered: b.info.recovered,
    recoveredText,
    recoveredVersion: recoveredVersion.text,
    undoDepth: undone.undoDepth,
    afterUndo,
    thirdRecovered: c.info.recovered,
    thirdText,
    savedText,
    fourthRecovered: d.info.recovered,
    fourthText,
  };
})()`;

interface JournalResult {
  readonly recovered: number;
  readonly recoveredText: string;
  readonly recoveredVersion: string;
  readonly undoDepth: number;
  readonly afterUndo: string;
  readonly thirdRecovered: number;
  readonly thirdText: string;
  readonly savedText: string;
  readonly fourthRecovered: number;
  readonly fourthText: string;
}

describe("the engine client in Chromium", () => {
  let browser: Browser;
  let server: ViteDevServer;
  let origin: string;
  // The hook bundles the app's dependencies when this file's cache is cold.
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chromium", headless: true });
    ({ server, origin } = await startDevServer("engine-client"));
  }, 60_000);
  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("opens a file through the workers and answers what the views need", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      // The in-page script is a string: Vitest would otherwise rewrite the dynamic
      // import of the client module for its own module runner.
      await page.evaluate(
        (args) => {
          (window as unknown as { __engineTest: unknown }).__engineTest = args;
        },
        { text: json, nestedIndex: 42, imageIndex: 7, modulePath: CLIENT_MODULE },
      );
      const result = (await page.evaluate(IN_PAGE)) as InPageResult;
      expect(errors).toEqual([]);
      expect(result.capabilities.crossOriginIsolated).toBe(true);
      expect(result.capabilities.workers).toBeGreaterThanOrEqual(1);
      expect(result.size).toBe(new TextEncoder().encode(json).byteLength);
      expect(result.rootKind).toBe("object");
      expect(result.version).toEqual({ text: "1.2", truncated: false, bytes: 3 });
      expect(result.entryCount).toBe(2500);
      expect(result.pageTotal).toBe(2500);
      expect(result.pageLength).toBe(452);
      expect(result.lastUrl).toBe("https://quipu.example/2499");
      expect(result.level1Kind).toBe("object");
      expect(result.note).toBe("knots é 🧵");
      expect(result.head).toEqual(Array.from(new TextEncoder().encode("hello quipu")));
      expect(result.search.count).toBe(hits);
      expect(result.search.first.length).toBe(2);
      expect(result.notJson).toBe("NotNestedJsonError");
      expect(result.progress.length).toBeGreaterThan(0);
      expect(result.progress[result.progress.length - 1]).toBe(true);
      // The edit replaced exactly the bytes of `"1.2"` after `"version":` and nothing else.
      const at = json.indexOf('"1.2"');
      const editedJson = `${json.slice(0, at)}"1.3-knot"${json.slice(at + 5)}`;
      expect(result.edited.text).toBe("1.3-knot");
      expect(result.edited.size).toBe(new TextEncoder().encode(editedJson).byteLength);
      expect(result.edited.span).toEqual({ start: at, end: at + '"1.3-knot"'.length });
      expect(result.edited.logical).toBe(editedJson);
      expect(result.edited.savedAsIs).toBe(editedJson);
      expect(result.edited.savedPretty).toBe(JSON.stringify(JSON.parse(editedJson), null, 2));
      expect(result.edited.undoneAsIs).toBe(json);
      expect(result.edited.undoDepth).toBe(0);
      expect(result.edited.redoDepth).toBe(1);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("recovers committed edits from the OPFS journal after the worker is killed", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.evaluate(
        (args) => {
          (window as unknown as { __engineTest: unknown }).__engineTest = args;
        },
        { text: json, modulePath: CLIENT_MODULE, key: "blob:engine-test" },
      );
      const result = (await page.evaluate(JOURNAL_IN_PAGE)) as JournalResult;
      expect(errors).toEqual([]);
      const versionAt = json.indexOf('"1.2"');
      const withVersion = `${json.slice(0, versionAt)}"1.3-knot"${json.slice(versionAt + 5)}`;
      const urlAt = withVersion.indexOf('"https://quipu.example/0"');
      const twoEdits = `${withVersion.slice(0, urlAt)}"https://quipu.example/recovered"${withVersion.slice(urlAt + '"https://quipu.example/0"'.length)}`;
      const threeEdits = twoEdits.replace('"1.3-knot"', '"1.4-cut"');
      // The third edit raced the kill: either it committed whole or not at all.
      expect([2, 3]).toContain(result.recovered);
      expect(result.recoveredText).toBe(result.recovered === 3 ? threeEdits : twoEdits);
      expect(result.recoveredVersion).toBe(result.recovered === 3 ? "1.4-cut" : "1.3-knot");
      expect(result.undoDepth).toBe(result.recovered - 1);
      expect(result.afterUndo).toBe(result.recovered === 3 ? twoEdits : withVersion);
      expect(result.thirdRecovered).toBe(result.recovered + 1);
      expect(result.thirdText).toBe(result.afterUndo);
      expect(result.savedText).toBe(result.afterUndo);
      expect(result.fourthRecovered).toBe(0);
      expect(result.fourthText).toBe(json);
    } finally {
      await page.close();
    }
  }, 120_000);
});
