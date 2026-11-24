/**
 * The in-page side of the engine benchmark, driven by scripts/bench/run.ts through
 * playwright-core. Files arrive through the file input, so the test process never
 * reads the 2 GiB fixture. Every measurement goes through the typed engine client
 * as the app does, timed with an in-page performance.now() around the request a
 * user would make.
 */
import type { NodeSummary } from "@quipu/contracts/engine";

import { createEngineClient, type EngineTransport } from "../src/engine/client";

const logElement = document.getElementById("log") as HTMLPreElement;
const log = (line: string) => {
  logElement.textContent += `${line}\n`;
};
(document.getElementById("isolated") as HTMLSpanElement).textContent = String(crossOriginIsolated);

interface Opened {
  readonly client: EngineTransport;
  readonly documentId: number;
  readonly size: number;
  /** Client created, file handed over, root on the tape (region 0 merged). */
  readonly firstPaintMs: number;
  /** Client created to the `done` progress event. */
  readonly indexMs: number;
  readonly tokens: number;
  readonly regions: number;
  readonly crossOriginIsolated: boolean;
  readonly workers: number;
}

const opened = new Map<number, Opened>();

const selectedFile = (name: string) => {
  const input = document.getElementById("files") as HTMLInputElement;
  for (const file of input.files ?? []) if (file.name === name) return file;
  throw new Error(`file ${name} was not selected`);
};

const open = async (name: string) => {
  const file = selectedFile(name);
  const t0 = performance.now();
  const client = createEngineClient();
  let indexMs = -1;
  let tokens = 0;
  let regions = 0;
  const done = new Promise<void>((resolve) => {
    client.onProgress((progress) => {
      if (progress.done) {
        indexMs = performance.now() - t0;
        tokens = progress.tokens;
        regions = progress.regions;
        resolve();
      }
    });
  });
  const capabilities = await client.request("capabilities", {});
  const info = await client.request("open", { source: file, name });
  await client.request("root", { documentId: info.documentId });
  const firstPaintMs = performance.now() - t0;
  await done;
  const result: Opened = {
    client,
    documentId: info.documentId,
    size: info.size,
    firstPaintMs,
    indexMs,
    tokens,
    regions,
    crossOriginIsolated: capabilities.crossOriginIsolated,
    workers: capabilities.workers,
  };
  opened.set(info.documentId, result);
  log(
    `${name}: first paint ${firstPaintMs.toFixed(0)} ms, indexed ${indexMs.toFixed(0)} ms, ${tokens} tokens, ${regions} regions`,
  );
  const { client: _client, ...report } = result;
  return report;
};

const document_ = (documentId: number) => {
  const doc = opened.get(documentId);
  if (!doc) throw new Error(`document ${documentId} is not open`);
  return doc;
};

const search = async (documentId: number, needle: string) => {
  const { client } = document_(documentId);
  const t0 = performance.now();
  const result = await client.request("search", {
    documentId,
    query: { mode: "literal", text: needle, caseSensitive: true },
  });
  const ms = performance.now() - t0;
  log(`search "${needle}": ${result.count} hits in ${ms.toFixed(0)} ms`);
  void client.request("searchClose", { documentId, searchId: result.searchId });
  return { ms, count: result.count };
};

/** The biggest string's first screen: 64 KiB of its base64 decoded, in hand on the main thread. */
const bodyHead = async (documentId: number, decodedBytes: number) => {
  const { client } = document_(documentId);
  const [largest] = await client.request("largestStrings", { documentId, limit: 1 });
  if (!largest) throw new Error("no big strings on the tape");
  const t0 = performance.now();
  const head = await client.request("decodeBase64Head", { ref: largest.ref, decodedBytes });
  const ms = performance.now() - t0;
  const chars = largest.range.end - largest.range.start - 2;
  log(`body head: ${head.byteLength} bytes of a ${chars}-char body in ${ms.toFixed(0)} ms`);
  return { ms, bytes: head.byteLength, bodyChars: chars };
};

/** The largest string at most `maxBytes` long whose content starts with { or [. */
const pickNested = async (client: EngineTransport, documentId: number, maxBytes: number) => {
  const candidates = await client.request("largestStrings", { documentId, limit: 64 });
  for (const node of candidates) {
    if (node.range.end - node.range.start - 2 > maxBytes) continue;
    const head = await client.request("stringHead", { ref: node.ref, bytes: 1 });
    if (head[0] === 0x7b || head[0] === 0x5b) return node;
  }
  throw new Error("no nested JSON body among the big strings");
};

const expandNested = async (documentId: number, maxBytes: number) => {
  const { client } = document_(documentId);
  const body: NodeSummary = await pickNested(client, documentId, maxBytes);
  const t0 = performance.now();
  const nested = await client.request("expandNested", { ref: body.ref });
  const ms = performance.now() - t0;
  const escapedBytes = body.range.end - body.range.start - 2;
  log(
    `expand nested: ${escapedBytes} escaped bytes → ${nested.bytes} raw, root ${nested.root.kind} with ${nested.root.childCount} children in ${ms.toFixed(0)} ms`,
  );
  return {
    ms,
    escapedBytes,
    rawBytes: nested.bytes,
    rootKind: nested.root.kind,
    rootChildren: nested.root.childCount,
  };
};

/** The member of an object node named `key`. */
const member = async (client: EngineTransport, node: NodeSummary, key: string) => {
  const page = await client.request("children", { ref: node.ref, from: 0, count: 1024 });
  for (const child of page.nodes) {
    if ((await client.request("keyText", { ref: child.ref })) === key) return child;
  }
  throw new Error(`no member ${key}`);
};

/**
 * Edit latency in the engine: replace one value and wait until the re-indexed tape
 * answers it (the node and its text read back through the engine). Repainting the
 * views is not included.
 */
const edit = async (documentId: number, path: ReadonlyArray<string>, json: string) => {
  const { client } = document_(documentId);
  const root = await client.request("root", { documentId });
  let node = root;
  for (const key of path) node = await member(client, node, key);
  const t0 = performance.now();
  const result = await client.request("setValue", { ref: node.ref, json });
  const text = await client.request("text", { ref: result.node.ref, limit: 1 << 16 });
  const ms = performance.now() - t0;
  log(
    `edit ${path.join(".")}: ${result.node.kind} re-indexed in ${ms.toFixed(1)} ms, size ${result.size}`,
  );
  return {
    ms,
    text: text.text,
    kind: result.node.kind,
    size: result.size,
    undoDepth: result.undoDepth,
  };
};

/**
 * Edit latency after a transform: sort the root's keys (one whole-document edit), then
 * replace one value and wait until the re-indexed tape answers it. The edit must
 * re-index only the value's region on the sorted root's side tape, never the file.
 */
const editAfterTransform = async (
  documentId: number,
  path: ReadonlyArray<string>,
  json: string,
) => {
  const { client } = document_(documentId);
  const root = await client.request("root", { documentId });
  const sortT0 = performance.now();
  const sorted = await client.request("transform", {
    ref: root.ref,
    transform: { _tag: "sortKeys", descending: false },
  });
  const sortMs = performance.now() - sortT0;
  let node = sorted.node;
  for (const key of path) node = await member(client, node, key);
  const t0 = performance.now();
  const result = await client.request("setValue", { ref: node.ref, json });
  const text = await client.request("text", { ref: result.node.ref, limit: 1 << 16 });
  const ms = performance.now() - t0;
  log(
    `sortKeys root in ${sortMs.toFixed(0)} ms, then edit ${path.join(".")}: ${result.node.kind} re-indexed in ${ms.toFixed(1)} ms, size ${result.size}`,
  );
  return {
    ms,
    sortMs,
    text: text.text,
    kind: result.node.kind,
    size: result.size,
    undoDepth: result.undoDepth,
  };
};

/**
 * Save throughput: stream the document, pretty-printed or as-is, into an OPFS file (the
 * File System Access writable a picked file would give), then read the size and
 * 16 bytes at each end back from the file.
 */
const save = async (documentId: number, indent: number | null, fileName: string) => {
  const { client } = document_(documentId);
  const directory = await navigator.storage.getDirectory();
  await directory.removeEntry(fileName).catch(() => {});
  const handle = await directory.getFileHandle(fileName, { create: true });
  const t0 = performance.now();
  const result = await client.request("save", {
    documentId,
    sink: { _tag: "fileHandle", handle },
    indent,
  });
  const ms = performance.now() - t0;
  const file = await handle.getFile();
  const head = Array.from(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  const tail = Array.from(
    new Uint8Array(await file.slice(Math.max(0, file.size - 16)).arrayBuffer()),
  );
  await directory.removeEntry(fileName);
  const mibPerSecond = file.size / (1024 * 1024) / (ms / 1000);
  log(
    `save indent=${indent}: ${file.size} bytes in ${ms.toFixed(0)} ms, ${mibPerSecond.toFixed(0)} MiB/s`,
  );
  return { ms, bytes: result.bytes, fileBytes: file.size, head, tail, mibPerSecond };
};

const close = async (documentId: number) => {
  const doc = document_(documentId);
  await doc.client.request("close", { documentId });
  doc.client.terminate();
  opened.delete(documentId);
  return null;
};

(window as unknown as { quipuBench: unknown }).quipuBench = {
  open,
  search,
  bodyHead,
  expandNested,
  edit,
  editAfterTransform,
  save,
  close,
};
log("ready");
