import {
  CHILDREN_PAGE_LIMIT,
  DocumentNotOpenError,
  EngineResult,
  type IndexProgress,
  MAX_SLICE_BYTES,
  type NodeRef,
  type NodeSummary,
  NodeNotFoundError,
  NotNestedJsonError,
  SliceTooLargeError,
} from "@quipu/contracts/engine";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeUtf8, parseJsonSlice } from "./boundedSlice.ts";
import { MAX_KEY_BYTES } from "./decode.ts";
import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { createPrng, decodeBase64Text, harSample, wideSample } from "./testing/samples.ts";

const utf8 = new TextEncoder();
const platform = (workers: number) => ({
  workers,
  crossOriginIsolated: true,
  createPool: createLocalPool,
});

/** The member of an object node named `key`, by decoding each child's key. */
const member = async (host: EngineHost, node: NodeSummary, key: string) => {
  const page = await host.handle({
    _tag: "children",
    ref: node.ref,
    from: 0,
    count: CHILDREN_PAGE_LIMIT,
  });
  for (const child of page.nodes) {
    if ((await host.handle({ _tag: "keyText", ref: child.ref })) === key) return child;
  }
  throw new Error(`no member ${key}`);
};

const keysOf = async (host: EngineHost, node: NodeSummary) => {
  const page = await host.handle({
    _tag: "children",
    ref: node.ref,
    from: 0,
    count: CHILDREN_PAGE_LIMIT,
  });
  return Promise.all(page.nodes.map((child) => host.handle({ _tag: "keyText", ref: child.ref })));
};

const text = (host: EngineHost, ref: NodeRef, limit = MAX_SLICE_BYTES) =>
  host.handle({ _tag: "text", ref, limit });

describe("the engine host over a HAR", () => {
  const bytes = harSample(createPrng(11), {
    targetBytes: 300 * 1024,
    nestedBodyBytes: [40 * 1024],
    bigBodyChars: 300 * 1024,
  });
  interface HarEntry {
    readonly request: { readonly url: string; readonly method: string };
    readonly response: {
      readonly status: number;
      readonly content: {
        readonly text?: string;
        readonly encoding?: string;
        readonly mimeType: string;
      };
    };
    readonly time: number;
  }
  const parsed = parseJsonSlice(bytes) as { log: { entries: HarEntry[] } };
  const host = new EngineHost(platform(4), { regionBytes: 32 * 1024 });
  const progress: IndexProgress[] = [];
  host.onEvent = (event) => {
    if (event._tag === "indexProgress") progress.push(event.progress);
  };
  const opened = host.handle({ _tag: "open", source: new Blob([bytes]), name: "sample.har" });
  afterAll(async () => {
    await host.handle({ _tag: "close", documentId: (await opened).documentId }).catch(() => null);
  });

  it("reports capabilities", async () => {
    expect(await host.handle({ _tag: "capabilities" })).toEqual({
      crossOriginIsolated: true,
      workers: 4,
    });
  });

  it("opens, indexes in regions and reports progress until done", async () => {
    const info = await opened;
    expect(info).toEqual({
      documentId: 1,
      name: "sample.har",
      size: bytes.byteLength,
      format: "har",
      structure: "native",
      editable: true,
      note: null,
      recovered: 0,
      journalUnavailable: null,
    });
    const root = await host.handle({ _tag: "root", documentId: info.documentId });
    expect(root.kind).toBe("object");
    expect(root.key).toBeNull();
    await host.handle({ _tag: "node", ref: root.ref });
    const last = progress[progress.length - 1];
    expect(last?.done).toBe(true);
    expect(last?.regionsMerged).toBe(last?.regions);
    expect(last?.regions).toBe(Math.ceil(bytes.byteLength / (32 * 1024)));
    expect(last?.tokens).toBeGreaterThan(1000);
  });

  it("walks the structure the user sees: keys, kinds, values and paging", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    expect(await keysOf(host, root)).toEqual(["log"]);
    const log = await member(host, root, "log");
    expect(await keysOf(host, log)).toEqual(["version", "creator", "pages", "entries"]);
    expect(await text(host, (await member(host, log, "version")).ref)).toEqual({
      text: "1.2",
      truncated: false,
      bytes: 3,
    });
    const entries = await member(host, log, "entries");
    expect(entries.kind).toBe("array");
    expect(entries.childCount).toBe(parsed.log.entries.length);
    expect(entries.childrenIndexed).toBe(true);
    const all = await host.handle({
      _tag: "children",
      ref: entries.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
    });
    expect(all.total).toBe(entries.childCount);
    expect(all.nodes.length).toBe(Math.min(CHILDREN_PAGE_LIMIT, entries.childCount));
    const page = await host.handle({ _tag: "children", ref: entries.ref, from: 5, count: 3 });
    expect(page.nodes.map((n) => n.ref)).toEqual(all.nodes.slice(5, 8).map((n) => n.ref));
    expect(page.nodes.every((n) => n.key === null && n.kind === "object")).toBe(true);
    const first = all.nodes[0] as NodeSummary;
    const request = await member(host, first, "request");
    const url = await member(host, request, "url");
    const expectedUrl = (parsed.log.entries[0] as HarEntry).request.url;
    expect(await text(host, url.ref)).toEqual({
      text: expectedUrl,
      truncated: false,
      bytes: utf8.encode(expectedUrl).byteLength,
    });
    const headers = await member(host, request, "headers");
    const firstHeader = (
      await host.handle({ _tag: "children", ref: headers.ref, from: 0, count: 1 })
    ).nodes[0] as NodeSummary;
    expect(await keysOf(host, firstHeader)).toEqual(["name", "value"]);
    const time = await member(host, first, "time");
    expect(time.kind).toBe("number");
    expect(Number((await text(host, time.ref)).text)).toBe(
      (parsed.log.entries[0] as HarEntry).time,
    );
  });

  it("serves a node's rows with keys and previews in one request, like the tree and map show them", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const log = await member(host, root, "log");
    const page = await host.handle({
      _tag: "rows",
      ref: log.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
      previewBytes: 160,
    });
    expect(page.total).toBe(4);
    expect(page.rows.map((row) => row.key)).toEqual(["version", "creator", "pages", "entries"]);
    expect(page.rows[0]?.preview).toEqual({ text: "1.2", truncated: false, bytes: 3 });
    expect(page.rows[1]?.preview).toBeNull();
    expect(page.rows[1]?.node.kind).toBe("object");

    // Entries are array elements: no key, no preview, and the page honors `from`.
    const entries = await member(host, log, "entries");
    const slice = await host.handle({
      _tag: "rows",
      ref: entries.ref,
      from: 3,
      count: 2,
      previewBytes: 160,
    });
    expect(slice.from).toBe(3);
    expect(slice.rows.length).toBe(2);
    expect(slice.rows.every((row) => row.key === null && row.preview === null)).toBe(true);

    // A long string row is cut at the preview limit and says so; the window
    // covers the first rows, the body sits past it.
    const first = slice.rows[0]?.node as NodeSummary;
    const expectedEntry = parsed.log.entries[3] as HarEntry;
    const entry = await host.handle({
      _tag: "rows",
      ref: first.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
      previewBytes: 8,
    });
    const request = entry.rows.find((row) => row.key === "request");
    expect(request?.node.kind).toBe("object");
    const requestRows = await host.handle({
      _tag: "rows",
      ref: (request as { node: NodeSummary }).node.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
      previewBytes: 8,
    });
    const url = requestRows.rows.find((row) => row.key === "url");
    expect(url?.preview).toEqual({
      text: expectedEntry.request.url.slice(0, 8),
      truncated: true,
      bytes: utf8.encode(expectedEntry.request.url).byteLength,
    });
    const pageref = entry.rows.find((row) => row.key === "pageref");
    expect(pageref?.preview).toEqual({
      text: "page_1".slice(0, 8),
      truncated: false,
      bytes: 6,
    });
  });

  it("groups the capture for the map: every entry with its host and page", async () => {
    const { documentId } = await opened;
    const total = parsed.log.entries.length;
    const first = await host.handle({ _tag: "harEntries", documentId, from: 0, count: 7 });
    expect(first.total).toBe(total);
    expect(first.entries).not.toBeNull();
    expect(first.pages).toEqual([
      expect.objectContaining({ id: "page_1", title: "https://quipu.example/" }),
    ]);
    expect(first.items.length).toBe(Math.min(7, total));
    const rest = await host.handle({
      _tag: "harEntries",
      documentId,
      from: 7,
      count: CHILDREN_PAGE_LIMIT,
    });
    const items = [...first.items, ...rest.items];
    expect(items.length).toBe(total);
    // The host as written in the file (not punycoded), which is what a user reads.
    expect(items.map((item) => item.host)).toEqual(
      parsed.log.entries.map((entry) => /^https:\/\/([^/]+)\//.exec(entry.request.url)?.[1]),
    );
    expect(new Set(items.map((item) => item.pageref))).toEqual(new Set(["page_1"]));
    expect(items.map((item) => item.method)).toEqual(
      parsed.log.entries.map((entry) => entry.request.method),
    );
    expect(items.map((item) => item.url)).toEqual(
      parsed.log.entries.map((entry) => entry.request.url),
    );
    expect(items.map((item) => item.status)).toEqual(
      parsed.log.entries.map((entry) => entry.response.status),
    );
    // Each item points at the entry object itself, so selecting a grouped entry selects the node.
    const entryNode = await host.handle({ _tag: "node", ref: items[0]!.ref });
    expect(entryNode.kind).toBe("object");
    expect(await keysOf(host, entryNode)).toContain("request");
  });

  it("truncates long values at the limit without cutting an escape", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const entries = await member(host, await member(host, root, "log"), "entries");
    const page = await host.handle({
      _tag: "children",
      ref: entries.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
    });
    const index = parsed.log.entries.findIndex(
      (e) =>
        e.response.content.mimeType === "application/json" &&
        (e.response.content.text?.length ?? 0) > 500,
    );
    const content = await member(
      host,
      await member(host, page.nodes[index] as NodeSummary, "response"),
      "content",
    );
    const body = await member(host, content, "text");
    const full = (parsed.log.entries[index] as HarEntry).response.content.text as string;
    const value = await text(host, body.ref, 200);
    expect(value.truncated).toBe(true);
    expect(full.startsWith(value.text)).toBe(true);
    expect(utf8.encode(value.text).byteLength).toBeGreaterThanOrEqual(150);
    expect(await text(host, body.ref)).toEqual({
      text: full,
      truncated: false,
      bytes: value.bytes,
    });
    const head = await host.handle({ _tag: "stringHead", ref: body.ref, bytes: 10 });
    expect(Array.from(head)).toEqual(Array.from(utf8.encode(full).subarray(0, 10)));
  });

  it("counts literal hits like a byte scan and serves their ranges", async () => {
    const { documentId } = await opened;
    const needle = "application/json";
    const summary = await host.handle({
      _tag: "search",
      documentId,
      query: { mode: "literal", text: needle, caseSensitive: true },
    });
    const haystack = new TextDecoder().decode(bytes);
    const expected: Array<{ start: number; end: number }> = [];
    for (
      let at = haystack.indexOf(needle);
      at >= 0;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      const start = utf8.encode(haystack.slice(0, at)).byteLength;
      expected.push({ start, end: start + needle.length });
    }
    expect(summary.count).toBe(expected.length);
    expect(summary.status).toBe("complete");
    const page = await host.handle({
      _tag: "searchHits",
      documentId,
      searchId: summary.searchId,
      from: 0,
      to: bytes.byteLength,
      limit: 4,
    });
    expect(page.ranges).toEqual(expected.slice(0, 4));
    const second = await host.handle({
      _tag: "searchHit",
      documentId,
      searchId: summary.searchId,
      index: 1,
    });
    expect(second).toEqual({ index: 1, range: expected[1] });
  });

  it("expands a stringified body three levels deep, on demand", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const entries = await member(host, await member(host, root, "log"), "entries");
    const page = await host.handle({
      _tag: "children",
      ref: entries.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
    });
    const index = parsed.log.entries.findIndex((e) =>
      e.response.content.text?.startsWith('{"kind":"envelope"'),
    );
    const content = await member(
      host,
      await member(host, page.nodes[index] as NodeSummary, "response"),
      "content",
    );
    const body = await member(host, content, "text");
    expect(body.kind).toBe("string");
    const level1 = await host.handle({ _tag: "expandNested", ref: body.ref });
    expect(level1.root.kind).toBe("object");
    expect(level1.root.ref.tapeId).toBeGreaterThan(0);
    expect(await keysOf(host, level1.root)).toEqual(["kind", "payload", "receivedAt"]);
    const payload = await member(host, level1.root, "payload");
    const level2 = await host.handle({ _tag: "expandNested", ref: payload.ref });
    expect(await keysOf(host, level2.root)).toEqual(["kind", "inner", "body"]);
    const level3 = await host.handle({
      _tag: "expandNested",
      ref: (await member(host, level2.root, "inner")).ref,
    });
    expect(await keysOf(host, level3.root)).toEqual(["kind", "leaf", "items"]);
    const level4 = await host.handle({
      _tag: "expandNested",
      ref: (await member(host, level3.root, "leaf")).ref,
    });
    expect(await keysOf(host, level4.root)).toEqual(["kind", "values", "note"]);
    const leaf = parseJsonSlice(
      utf8.encode(
        JSON.parse(
          JSON.parse(
            JSON.parse((parsed.log.entries[index] as HarEntry).response.content.text as string)
              .payload,
          ).inner,
        ).leaf,
      ),
    ) as { note: string };
    // `bytes` counts the source bytes between the quotes, escapes included.
    const escapedBytes = utf8.encode(JSON.stringify(leaf.note).slice(1, -1)).byteLength;
    expect(await text(host, (await member(host, level4.root, "note")).ref)).toEqual({
      text: leaf.note,
      truncated: false,
      bytes: escapedBytes,
    });
    await expect(
      host.handle({ _tag: "expandNested", ref: (await member(host, level1.root, "kind")).ref }),
    ).rejects.toBeInstanceOf(NotNestedJsonError);
    await expect(
      host.handle({ _tag: "expandNested", ref: level1.root.ref }),
    ).rejects.toBeInstanceOf(NotNestedJsonError);
  });

  it("decodes the first screen of a base64 body without reading the rest", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const entries = await member(host, await member(host, root, "log"), "entries");
    const page = await host.handle({
      _tag: "children",
      ref: entries.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
    });
    const index = parsed.log.entries.findIndex((e) => e.response.content.mimeType === "video/mp4");
    const content = await member(
      host,
      await member(host, page.nodes[index] as NodeSummary, "response"),
      "content",
    );
    const body = await member(host, content, "text");
    const head = await host.handle({ _tag: "decodeBase64Head", ref: body.ref, decodedBytes: 300 });
    const bodyText = (parsed.log.entries[index] as HarEntry).response.content.text as string;
    const expected = decodeBase64Text(bodyText.slice(0, 400)).subarray(0, 300);
    expect(Array.from(head)).toEqual(Array.from(expected));
    const slice = await host.handle({ _tag: "slice", documentId, tapeId: 0, range: body.range });
    expect(slice.byteLength).toBe(body.range.end - body.range.start);
    expect(slice[0]).toBe(0x22);
  });

  it("finds the biggest strings without scanning: the base64 body first", async () => {
    const { documentId } = await opened;
    const largest = await host.handle({ _tag: "largestStrings", documentId, limit: 4 });
    expect(largest.length).toBeGreaterThanOrEqual(1);
    expect(largest[0]?.kind).toBe("string");
    expect(largest[0]!.range.end - largest[0]!.range.start).toBe(300 * 1024 + 2);
    const sizes = largest.map((n) => n.range.end - n.range.start);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(await host.handle({ _tag: "keyText", ref: largest[0]!.ref })).toBe("text");
  });

  it("refuses what it was never asked to hold, and reads a container as its text", async () => {
    const { documentId } = await opened;
    await expect(host.handle({ _tag: "root", documentId: 99 })).rejects.toBeInstanceOf(
      DocumentNotOpenError,
    );
    await expect(
      host.handle({ _tag: "node", ref: { documentId, tapeId: 0, token: 1e9 } }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    await expect(
      host.handle({ _tag: "node", ref: { documentId, tapeId: 77, token: 0 } }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    const root = await host.handle({ _tag: "root", documentId });
    // A container's text is its JSON, cut at the limit; a root has no key.
    expect(await host.handle({ _tag: "text", ref: root.ref, limit: 10 })).toEqual({
      text: '{"log":{"v',
      truncated: true,
      bytes: root.span.end - root.span.start,
    });
    await expect(host.handle({ _tag: "keyText", ref: root.ref })).rejects.toBeInstanceOf(
      NodeNotFoundError,
    );
  });

  it("closes a document and forgets it", async () => {
    const other = new EngineHost(platform(2));
    const info = await other.handle({
      _tag: "open",
      source: new Blob([utf8.encode('{"a":1}')]),
      name: "a.json",
    });
    expect((await other.handle({ _tag: "root", documentId: info.documentId })).childCount).toBe(1);
    await other.handle({ _tag: "close", documentId: info.documentId });
    await expect(
      other.handle({ _tag: "root", documentId: info.documentId }),
    ).rejects.toBeInstanceOf(DocumentNotOpenError);
  });
});

/** Equal byte for byte; `toEqual` over tens of MiB is far slower. */
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};

describe("the engine host at the slice limit", () => {
  // `exact` holds nested JSON whose escaped content is exactly MAX_SLICE_BYTES, `over`
  // is one byte longer, and `b64` is a plain base64 body ("ABC" repeated) past the limit.
  const exactValue = `["${"a".repeat(MAX_SLICE_BYTES - 6)}"]`;
  const exact = utf8.encode(`[\\"${"a".repeat(MAX_SLICE_BYTES - 6)}\\"]`);
  const over = utf8.encode(`[\\"${"a".repeat(MAX_SLICE_BYTES - 5)}\\"]`);
  const b64 = utf8.encode("QUJD".repeat(Math.ceil(MAX_SLICE_BYTES / 3) + 1));
  const host = new EngineHost(platform(4));
  const opened = host.handle({
    _tag: "open",
    source: new Blob(['{"exact":"', exact, '","over":"', over, '","b64":"', b64, '"}']),
    name: "limits.json",
  });
  const node = async (key: string) => {
    const { documentId } = await opened;
    return member(host, await host.handle({ _tag: "root", documentId }), key);
  };
  afterAll(async () => {
    await host.handle({ _tag: "close", documentId: (await opened).documentId });
  });

  it("decodes a string of exactly the limit whole, and a longer one as a prefix", async () => {
    expect([exact.byteLength, over.byteLength]).toEqual([MAX_SLICE_BYTES, MAX_SLICE_BYTES + 1]);
    const whole = await text(host, (await node("exact")).ref);
    expect([whole.truncated, whole.bytes]).toEqual([false, MAX_SLICE_BYTES]);
    expect(whole.text).toBe(exactValue);
    // One byte more in the file still decodes whole: its escapes shrink below the limit.
    const shrunk = await text(host, (await node("over")).ref);
    expect([shrunk.truncated, shrunk.bytes, shrunk.text.length]).toEqual([
      false,
      MAX_SLICE_BYTES + 1,
      MAX_SLICE_BYTES - 1,
    ]);
    const b64Ref = (await node("b64")).ref;
    const prefix = await text(host, b64Ref);
    expect([prefix.truncated, prefix.bytes]).toEqual([true, b64.byteLength]);
    expect(prefix.text).toBe(decodeUtf8(b64.subarray(0, MAX_SLICE_BYTES)));
    expect(await text(host, b64Ref, 16)).toEqual({
      text: "QUJDQUJDQUJDQUJD",
      truncated: true,
      bytes: b64.byteLength,
    });
    await expect(text(host, b64Ref, MAX_SLICE_BYTES + 1)).rejects.toBeInstanceOf(
      SliceTooLargeError,
    );
  }, 120_000);

  it("serves a string head of exactly the limit, and refuses one byte more", async () => {
    const exactRef = (await node("exact")).ref;
    const b64Ref = (await node("b64")).ref;
    const whole = await host.handle({ _tag: "stringHead", ref: exactRef, bytes: MAX_SLICE_BYTES });
    expect(sameBytes(whole, utf8.encode(exactValue))).toBe(true);
    const prefix = await host.handle({ _tag: "stringHead", ref: b64Ref, bytes: MAX_SLICE_BYTES });
    expect(sameBytes(prefix, b64.subarray(0, MAX_SLICE_BYTES))).toBe(true);
    expect(Array.from(await host.handle({ _tag: "stringHead", ref: b64Ref, bytes: 3 }))).toEqual([
      0x51, 0x55, 0x4a,
    ]);
    await expect(
      host.handle({ _tag: "stringHead", ref: b64Ref, bytes: MAX_SLICE_BYTES + 1 }),
    ).rejects.toBeInstanceOf(SliceTooLargeError);
  }, 120_000);

  it("decodes a base64 head of exactly the limit, and refuses one byte more", async () => {
    const ref = (await node("b64")).ref;
    const head = await host.handle({
      _tag: "decodeBase64Head",
      ref,
      decodedBytes: MAX_SLICE_BYTES,
    });
    expect(head.byteLength).toBe(MAX_SLICE_BYTES);
    let wrong = 0;
    for (let i = 0; i < head.byteLength; i++) if (head[i] !== 0x41 + (i % 3)) wrong++;
    expect(wrong).toBe(0);
    await expect(
      host.handle({ _tag: "decodeBase64Head", ref, decodedBytes: MAX_SLICE_BYTES + 1 }),
    ).rejects.toBeInstanceOf(SliceTooLargeError);
  }, 120_000);

  it("slices exactly the limit out of the file, and refuses one byte more", async () => {
    const { documentId } = await opened;
    const start = (await node("exact")).range.start + 1;
    const slice = await host.handle({
      _tag: "slice",
      documentId,
      tapeId: 0,
      range: { start, end: start + MAX_SLICE_BYTES },
    });
    expect(sameBytes(slice, exact)).toBe(true);
    await expect(
      host.handle({
        _tag: "slice",
        documentId,
        tapeId: 0,
        range: { start, end: start + MAX_SLICE_BYTES + 1 },
      }),
    ).rejects.toBeInstanceOf(SliceTooLargeError);
  }, 120_000);

  it("expands nested JSON of exactly the limit, and refuses one byte more", async () => {
    const nested = await host.handle({ _tag: "expandNested", ref: (await node("exact")).ref });
    expect([nested.bytes, nested.root.kind, nested.root.childCount]).toEqual([
      exactValue.length,
      "array",
      1,
    ]);
    const page = await host.handle({ _tag: "children", ref: nested.root.ref, from: 0, count: 1 });
    const inner = await text(host, (page.nodes[0] as NodeSummary).ref);
    expect([inner.truncated, inner.bytes]).toEqual([false, MAX_SLICE_BYTES - 6]);
    expect(inner.text).toBe(exactValue.slice(2, -2));
    await expect(
      host.handle({ _tag: "expandNested", ref: (await node("over")).ref }),
    ).rejects.toBeInstanceOf(SliceTooLargeError);
  }, 120_000);
});

describe("the engine host at the key limit and over a long literal", () => {
  const key = "k".repeat(MAX_KEY_BYTES);
  const longKey = "k".repeat(MAX_KEY_BYTES + 1);
  const bytes = utf8.encode(`{"${key}":12345678901234567890,"${longKey}":2}`);
  const host = new EngineHost(platform(2));
  const opened = host.handle({ _tag: "open", source: new Blob([bytes]), name: "keys.json" });
  afterAll(async () => {
    await host.handle({ _tag: "close", documentId: (await opened).documentId });
  });

  it("decodes a key of exactly the key limit, and refuses one byte more", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const page = await host.handle({ _tag: "children", ref: root.ref, from: 0, count: 2 });
    const [first, second] = page.nodes as [NodeSummary, NodeSummary];
    expect(await host.handle({ _tag: "keyText", ref: first.ref })).toBe(key);
    await expect(host.handle({ _tag: "keyText", ref: second.ref })).rejects.toBeInstanceOf(
      SliceTooLargeError,
    );
  });

  it("returns a prefix of a literal longer than the limit", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const page = await host.handle({ _tag: "children", ref: root.ref, from: 0, count: 1 });
    const ref = (page.nodes[0] as NodeSummary).ref;
    expect(await text(host, ref, 8)).toEqual({ text: "12345678", truncated: true, bytes: 20 });
    expect(await text(host, ref, 20)).toEqual({
      text: "12345678901234567890",
      truncated: false,
      bytes: 20,
    });
  });
});

describe("the engine host over escaped strings at every limit", () => {
  // Quotes, backslashes, control characters and 2-, 3- and 4-byte UTF-8, rendered
  // with JSON.stringify's escapes or with every non-ASCII character as \uXXXX.
  const Atom = Schema.Literals(["a", " ", '"', "\\", "/", "\n", "\u0001", "é", "€", "😀"]);
  const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 }));
  const cases = Arbitrary.schema(
    Schema.Array(Schema.Tuple([Schema.Array(Atom), Limit, Schema.Boolean])),
  );
  const escapeNonAscii = (token: string) =>
    token.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const host = new EngineHost(platform(2));
  let executed = 0;
  afterAll(() => {
    expect(executed).toBe(150);
  });

  it.live.prop(
    "returns the longest prefix within the limit, and says whether it is the whole value",
    [cases],
    ([items]) =>
      Effect.promise(async () => {
        executed++;
        const rendered = items.map(([atoms, limit, escapeAll]) => {
          const value = atoms.join("");
          const token = escapeAll ? escapeNonAscii(JSON.stringify(value)) : JSON.stringify(value);
          return { value, limit, token };
        });
        const bytes = utf8.encode(`[${rendered.map((r) => r.token).join(",")}]`);
        expect(parseJsonSlice(bytes)).toEqual(rendered.map((r) => r.value));
        const info = await host.handle({ _tag: "open", source: new Blob([bytes]), name: "s.json" });
        try {
          const root = await host.handle({ _tag: "root", documentId: info.documentId });
          const page = await host.handle({
            _tag: "children",
            ref: root.ref,
            from: 0,
            count: CHILDREN_PAGE_LIMIT,
          });
          expect(page.nodes.length).toBe(rendered.length);
          for (const [i, { value, limit, token }] of rendered.entries()) {
            const ref = (page.nodes[i] as NodeSummary).ref;
            const got = await text(host, ref, limit);
            const gotBytes = utf8.encode(got.text);
            expect(got.bytes).toBe(utf8.encode(token).byteLength - 2);
            expect(got.truncated).toBe(utf8.encode(value).byteLength > limit);
            expect(value.startsWith(got.text)).toBe(true);
            expect(gotBytes.byteLength).toBeLessThanOrEqual(limit);
            if (got.truncated) {
              const next = String.fromCodePoint(value.codePointAt(got.text.length) as number);
              expect(gotBytes.byteLength + utf8.encode(next).byteLength).toBeGreaterThan(limit);
            }
            const head = await host.handle({ _tag: "stringHead", ref, bytes: limit });
            expect(decodeUtf8(head)).toBe(got.text);
          }
        } finally {
          await host.handle({ _tag: "close", documentId: info.documentId });
        }
      }),
    { arbitrary: { runs: 150 } },
  );
});

describe("the engine host over a wide document under a token budget", () => {
  const count = 5000;
  const bytes = wideSample(createPrng(5), count);
  const parsed = parseJsonSlice(bytes) as Array<{ id: number; name: string }>;
  const host = new EngineHost(platform(4), {
    regionBytes: 64 * 1024,
    tokenBudget: 3000,
    bucketCache: 3,
  });
  const opened = host.handle({ _tag: "open", source: new Blob([bytes]), name: "wide.json" });
  afterAll(async () => {
    await host.handle({ _tag: "close", documentId: (await opened).documentId });
  });

  it("keeps the root's child count and serves children from buckets, page by page", async () => {
    const { documentId } = await opened;
    // `root` answers as soon as region 0 is on the tape; `node` waits for the whole index.
    const early = await host.handle({ _tag: "root", documentId });
    const root = await host.handle({ _tag: "node", ref: early.ref });
    expect(root.kind).toBe("array");
    expect(root.childCount).toBe(count);
    expect(root.range).toEqual({ start: 0, end: bytes.byteLength - 1 });
    expect(root.childrenIndexed).toBe(false);
    const seen: number[] = [];
    for (let from = 0; from < count; from += CHILDREN_PAGE_LIMIT) {
      const page = await host.handle({
        _tag: "children",
        ref: root.ref,
        from,
        count: CHILDREN_PAGE_LIMIT,
      });
      expect(page.total).toBe(count);
      expect(page.nodes.length).toBe(Math.min(CHILDREN_PAGE_LIMIT, count - from));
      for (const node of page.nodes) {
        expect(node.kind).toBe("object");
        expect(node.key).toBeNull();
        expect(node.ref.tapeId).toBeGreaterThan(0);
        const id = await member(host, node, "id");
        seen.push(Number((await text(host, id.ref)).text));
      }
    }
    expect(seen).toEqual(parsed.map((o) => o.id));
  });

  it("serves rows from bucket tapes with their keys and previews", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    const page = await host.handle({
      _tag: "rows",
      ref: root.ref,
      from: 1030,
      count: 3,
      previewBytes: 160,
    });
    expect(page.total).toBe(count);
    expect(page.rows.map((row) => row.node.kind)).toEqual(["object", "object", "object"]);
    const fields = await host.handle({
      _tag: "rows",
      ref: page.rows[1]!.node.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
      previewBytes: 160,
    });
    const expected = parsed[1031]!;
    expect(fields.rows.find((row) => row.key === "id")?.preview?.text).toBe(String(expected.id));
    expect(fields.rows.find((row) => row.key === "name")?.preview).toEqual({
      text: expected.name,
      truncated: false,
      bytes: utf8.encode(expected.name).byteLength,
    });
  });

  it("answers arbitrary pages across bucket boundaries", async () => {
    const { documentId } = await opened;
    const root = await host.handle({ _tag: "root", documentId });
    for (const [from, size] of [
      [1020, 10],
      [2047, 3],
      [4990, 50],
      [0, 1],
      [3071, 1024],
    ] as const) {
      const page = await host.handle({ _tag: "children", ref: root.ref, from, count: size });
      const ids = await Promise.all(
        page.nodes.map(async (node) =>
          Number((await text(host, (await member(host, node, "id")).ref)).text),
        ),
      );
      expect(ids).toEqual(parsed.slice(from, from + size).map((o) => o.id));
      const names = await Promise.all(
        page.nodes.map(
          async (node) => (await text(host, (await member(host, node, "name")).ref)).text,
        ),
      );
      expect(names).toEqual(parsed.slice(from, from + size).map((o) => o.name));
    }
  });

  it("keeps a member's key when the key and its value fall in different regions", async () => {
    // Keys long enough that region boundaries land inside them and between a key and
    // its value; the first member of each region is a bucket anchor.
    const parts: string[] = [];
    for (let i = 0; i < 400; i++) parts.push(`"key-${"abcdefghij".repeat(3)}-${i}": [${i}]`);
    const objectBytes = utf8.encode(`{${parts.join(", ")}}`);
    const objectHost = new EngineHost(platform(2), { regionBytes: 128, tokenBudget: 100 });
    const info = await objectHost.handle({
      _tag: "open",
      source: new Blob([objectBytes]),
      name: "cut-keys.json",
    });
    try {
      const early = await objectHost.handle({ _tag: "root", documentId: info.documentId });
      const root = await objectHost.handle({ _tag: "node", ref: early.ref });
      expect(root.childrenIndexed).toBe(false);
      expect(root.childCount).toBe(400);
      const keys: string[] = [];
      for (let from = 0; from < 400; from += 7) {
        const page = await objectHost.handle({ _tag: "children", ref: root.ref, from, count: 7 });
        for (const node of page.nodes) {
          expect(node.kind).toBe("array");
          keys.push(await objectHost.handle({ _tag: "keyText", ref: node.ref }));
        }
      }
      expect(keys).toEqual(parts.map((_, i) => `key-${"abcdefghij".repeat(3)}-${i}`));
    } finally {
      await objectHost.handle({ _tag: "close", documentId: info.documentId });
    }
  });

  it("keeps member keys when the cut container is an object", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 3000; i++) parts.push(`"k${i}":{"v":${i},"s":"x${i}"}`);
    const objectBytes = utf8.encode(`{${parts.join(",")}}`);
    const objectHost = new EngineHost(platform(3), { regionBytes: 16 * 1024, tokenBudget: 1000 });
    const info = await objectHost.handle({
      _tag: "open",
      source: new Blob([objectBytes]),
      name: "object.json",
    });
    try {
      const early = await objectHost.handle({ _tag: "root", documentId: info.documentId });
      const root = await objectHost.handle({ _tag: "node", ref: early.ref });
      expect(root.childrenIndexed).toBe(false);
      expect(root.childCount).toBe(3000);
      const page = await objectHost.handle({
        _tag: "children",
        ref: root.ref,
        from: 2047,
        count: 3,
      });
      expect(
        await Promise.all(
          page.nodes.map((n) => objectHost.handle({ _tag: "keyText", ref: n.ref })),
        ),
      ).toEqual(["k2047", "k2048", "k2049"]);
      expect(
        await text(objectHost, (await member(objectHost, page.nodes[1] as NodeSummary, "v")).ref),
      ).toEqual({ text: "2048", truncated: false, bytes: 4 });
    } finally {
      await objectHost.handle({ _tag: "close", documentId: info.documentId });
    }
  });

  it("opens a file that is not JSON as text, with its bytes still readable", async () => {
    const textBytes = utf8.encode("name,size\nquipu,2\nkhipu,3\n");
    const textHost = new EngineHost(platform(2));
    const info = await textHost.handle({
      _tag: "open",
      source: new Blob([textBytes]),
      name: "notes.csv",
    });
    try {
      expect(info.format).toBe("text");
      const slice = await textHost.handle({
        _tag: "slice",
        documentId: info.documentId,
        tapeId: 0,
        range: { start: 0, end: 9 },
      });
      expect(new TextDecoder().decode(slice)).toBe("name,size");
      expect(
        await textHost.handle({ _tag: "headText", documentId: info.documentId, bytes: 9 }),
      ).toEqual({ text: "name,size", truncated: true, bytes: textBytes.byteLength });
      await expect(
        textHost.handle({ _tag: "root", documentId: info.documentId }),
      ).rejects.toBeInstanceOf(NodeNotFoundError);
    } finally {
      await textHost.handle({ _tag: "close", documentId: info.documentId });
    }
  });

  it("opens an empty file as text without indexing", async () => {
    const emptyHost = new EngineHost(platform(1));
    const info = await emptyHost.handle({ _tag: "open", source: new Blob([]), name: "empty.txt" });
    try {
      expect(info).toMatchObject({ size: 0, format: "text" });
    } finally {
      await emptyHost.handle({ _tag: "close", documentId: info.documentId });
    }
  });

  it("answers from the merged prefix while later regions index, and says what can still grow", async () => {
    const sampleBytes = harSample(createPrng(7), { targetBytes: 300 * 1024 });
    const total = (parseJsonSlice(sampleBytes) as { log: { entries: unknown[] } }).log.entries
      .length;
    const gate = Promise.withResolvers<void>();
    const gated = new EngineHost(
      {
        workers: 3,
        crossOriginIsolated: true,
        createPool: (workers) => {
          const pool = createLocalPool(workers);
          const call = pool.call.bind(pool);
          pool.call = ((worker, job, transfer) =>
            job.type === "structure" && job.region >= 1
              ? gate.promise.then(() => call(worker, job, transfer))
              : call(worker, job, transfer)) as typeof pool.call;
          return pool;
        },
      },
      { regionBytes: 32 * 1024 },
    );
    const info = await gated.handle({
      _tag: "open",
      source: new Blob([sampleBytes]),
      name: "slow.har",
    });
    try {
      const root = await gated.handle({ _tag: "root", documentId: info.documentId });
      const log = await member(gated, root, "log");
      const entries = await member(gated, log, "entries");
      expect(entries.settled).toBe(false);
      // What the engine serves while it indexes must decode on the UI side, growing
      // containers included: their end is a lower bound, never before their start.
      for (const node of [root, log, entries]) {
        expect(Schema.decodeUnknownSync(EngineResult.node)(node)).toEqual(node);
      }
      const early = await gated.handle({
        _tag: "children",
        ref: entries.ref,
        from: 0,
        count: CHILDREN_PAGE_LIMIT,
      });
      expect(early.nodes.length).toBeGreaterThan(0);
      expect(early.nodes.length).toBeLessThan(total);
      expect(early.nodes[0]?.settled).toBe(true);
      expect(await gated.handle({ _tag: "keyText", ref: log.ref })).toBe("log");
      gate.resolve();
      const done = await gated.handle({ _tag: "node", ref: entries.ref });
      expect(done).toMatchObject({ settled: true, childCount: total });
    } finally {
      gate.resolve();
      await gated.handle({ _tag: "close", documentId: info.documentId });
    }
  });
});
