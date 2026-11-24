import { layoutMapTree } from "@quipu/canvas/mapLayout";
import type {
  Decoded,
  Detection,
  HarEntriesPage,
  NodeRef,
  NodeSummary,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "vite-plus/test";

import {
  MAP_HEADER_HEIGHT,
  MAP_ROW_HEIGHT,
  MAP_ROW_PAGE,
  MapModel,
  type MapSnapshot,
  textColumns,
} from "./mapModel.ts";
import { TreeModel, type TreeSource } from "./treeModel.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Detection says "JSON", as the engine's does; the decode counts the keys.
const jsonDetection = (_text: string): Detection => ({
  kind: "json",
  label: "JSON",
  mime: null,
  structured: true,
});
const imageDetection: Detection = {
  kind: "base64",
  label: "base64 · image/png",
  mime: "image/png",
  structured: false,
};

/** An in-memory engine over a JS value, plus the HAR grouping it would derive. */
function fakeEngine(value: Json) {
  interface Item {
    readonly summary: NodeSummary;
    readonly key: string | null;
    readonly children: number[];
    readonly text: string;
    readonly json: Json;
  }
  const items: Item[] = [];
  const add = (json: Json, key: string | null): number => {
    const token = items.length;
    const kind =
      json === null
        ? "null"
        : Array.isArray(json)
          ? "array"
          : typeof json === "object"
            ? "object"
            : typeof json === "string"
              ? "string"
              : typeof json === "number"
                ? "number"
                : json
                  ? "true"
                  : "false";
    const children: number[] = [];
    items.push({
      summary: {
        ref: { documentId: 1, tapeId: 0, token },
        kind,
        // Only a string's length matters here: detection skips short ones.
        range: { start: 0, end: JSON.stringify(json).length },
        span: { start: 0, end: 0 },
        key: key === null ? null : 0,
        childCount: 0,
        childrenIndexed: true,
        settled: true,
      },
      key,
      children,
      text: typeof json === "string" ? json : String(json),
      json,
    });
    if (Array.isArray(json)) json.forEach((child) => children.push(add(child, null)));
    else if (json !== null && typeof json === "object") {
      for (const [k, child] of Object.entries(json)) children.push(add(child, k));
    }
    const placed = items[token] as Item;
    items[token] = { ...placed, summary: { ...placed.summary, childCount: children.length } };
    return token;
  };
  add(value, null);
  const ref = (token: number): NodeRef => ({ documentId: 1, tapeId: 0, token });
  /** Containers the fake index has not finished counting: token → children known so far. */
  const partial = new Map<number, number>();
  /** Whether `harEntries` reads only the entries the index has counted, as the engine's does. */
  let harFollowsIndex = false;
  const summaryOf = (token: number): NodeSummary => {
    const summary = (items[token] as Item).summary;
    const known = partial.get(token);
    return known === undefined ? summary : { ...summary, childCount: known, settled: false };
  };
  const source: TreeSource = {
    node: async (at) => summaryOf(at.token),
    rows: async (at, from, count, previewBytes) => {
      const item = items[at.token] as Item;
      return {
        from,
        total: item.children.length,
        rows: item.children.slice(from, from + count).map((t) => {
          const child = items[t] as Item;
          const scalar = child.summary.kind !== "object" && child.summary.kind !== "array";
          return {
            node: summaryOf(t),
            key: child.key,
            preview: scalar
              ? { text: child.text.slice(0, previewBytes), truncated: false, bytes: 0 }
              : null,
          };
        }),
      };
    },
    keyText: async (at) => (items[at.token] as Item).key ?? "",
    text: async (at) => ({ text: (items[at.token] as Item).text, truncated: false, bytes: 0 }),
    // A string holding JSON decodes into a nested document; one starting like a PNG is an image.
    detect: async (at) => {
      const text = (items[at.token] as Item).text;
      if (text.startsWith("{")) return [jsonDetection(text)];
      if (text.startsWith("iVBOR")) return [imageDetection];
      return [];
    },
    decode: async (at): Promise<Decoded> => {
      const text = (items[at.token] as Item).text;
      const base = { layers: [], bytes: text.length };
      if (text.startsWith("{")) {
        const root = add(JSON.parse(text) as Json, null);
        return {
          ...base,
          kind: "json",
          label: `JSON · ${Object.keys(JSON.parse(text) as object).length} keys`,
          mime: "application/json",
          document: { root: (items[root] as Item).summary, bytes: text.length },
          view: { _tag: "text", value: { text, truncated: false, bytes: text.length } },
        };
      }
      if (text.startsWith("iVBOR")) {
        return {
          ...base,
          kind: "base64",
          label: imageDetection.label,
          mime: "image/png",
          bytes: 68,
          document: null,
          view: { _tag: "image", mime: "image/png", bytes: 68 },
        };
      }
      throw new Error("not decodable");
    },
    frames: async (_at, from) => ({ from, total: 0, frames: [] }),
  };
  const harEntries = async (
    _documentId: number,
    from: number,
    count: number,
  ): Promise<HarEntriesPage> => {
    const root = items[0] as Item;
    const log = root.children.map((t) => items[t] as Item).find((item) => item.key === "log");
    const entries = log?.children
      .map((t) => items[t] as Item)
      .find((item) => item.key === "entries");
    const pages = log?.children.map((t) => items[t] as Item).find((item) => item.key === "pages");
    if (!log || !entries) return { entries: null, from, total: 0, pages: [], items: [] };
    const pageItems = (pages?.children ?? []).map((t) => {
      const page = items[t] as Item;
      const fields = page.children.map((c) => items[c] as Item);
      return {
        ref: ref(t),
        id: fields.find((f) => f.key === "id")?.text ?? null,
        title: fields.find((f) => f.key === "title")?.text ?? null,
      };
    });
    const entriesToken = log.children.find((t) => (items[t] as Item).key === "entries") as number;
    const counted = harFollowsIndex ? partial.get(entriesToken) : undefined;
    const total = counted ?? entries.children.length;
    const slice = entries.children.slice(from, Math.min(from + count, total)).map((t) => {
      const entry = (items[t] as Item).json as {
        pageref?: string;
        request: { url: string; method: string };
        response: { status: number };
      };
      return {
        ref: ref(t),
        host: new URL(entry.request.url).host,
        pageref: entry.pageref ?? null,
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
      };
    });
    return {
      entries: ref(log.children.find((t) => (items[t] as Item).key === "entries") as number),
      from,
      total,
      pages: pageItems,
      items: slice,
    };
  };
  return {
    source,
    root: (items[0] as Item).summary,
    harEntries,
    decode: source.decode,
    /**
     * Makes the container under `key` look half indexed (`known` children,
     * not settled) until `finish` is called, as a big file is while the
     * engine is still reading it.
     */
    indexing(key: string, known: number) {
      const token = items.findIndex((item) => item.key === key);
      partial.set(token, known);
      return {
        finish: () => partial.clear(),
      };
    },
    /**
     * A capture half indexed as the engine has it: `log` not settled, its
     * entries counted up to `known`, and `harEntries` reading no further.
     */
    indexingCapture(known: number) {
      harFollowsIndex = true;
      const log = items.findIndex((item) => item.key === "log");
      partial.set(log, (items[log] as Item).children.length);
      partial.set(
        items.findIndex((item) => item.key === "entries"),
        known,
      );
      return {
        finish: () => partial.clear(),
      };
    },
  };
}

const syncLayout = () => ({
  layout: async (nodes: Parameters<typeof layoutMapTree>[0]) => layoutMapTree(nodes),
});
const options = { documentId: 1, layout: syncLayout, rebuildDelayMs: 0 } as const;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What a node shows: its header and its rows as "key: value" (open rows marked with ▸). */
function describeNode(snapshot: MapSnapshot, id: string) {
  const node = snapshot.byId.get(id);
  if (!node) return null;
  return {
    title: `${node.title} ${node.subtitle}`.trim(),
    rows: node.rows.map(
      (row) =>
        `${row.expanded ? "▸ " : ""}${row.key}${row.key && row.value ? ": " : ""}${row.value}`,
    ),
  };
}

describe("MapModel", () => {
  it("shows the root as a node with its keys and values, and opens a child into a linked node", async () => {
    const { source, root } = fakeEngine({
      name: "quipu",
      knots: 3,
      nested: { depth: 2, ok: true },
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "json" });
    model.start();
    await settle();
    let snapshot = model.getSnapshot();
    expect(snapshot.nodes.map((node) => node.id)).toEqual([tree.rootId]);
    expect(describeNode(snapshot, tree.rootId)).toEqual({
      title: "root {} 3 keys",
      rows: ['name: "quipu"', "knots: 3", "nested: {} 2 keys"],
    });
    expect(snapshot.positions.get(tree.rootId)).toEqual({ x: 0, y: 0 });

    await model.toggleRow(tree.rootId, 2);
    await settle();
    snapshot = model.getSnapshot();
    const nested = snapshot.nodes[1];
    expect(nested?.parentId).toBe(tree.rootId);
    expect(describeNode(snapshot, nested!.id)).toEqual({
      title: "nested {} 2 keys",
      rows: ["depth: 2", "ok: true"],
    });
    expect(snapshot.byId.get(tree.rootId)?.rows[2]?.expanded).toBe(true);
    // The child hangs from its row, one column to the right.
    const rootNode = snapshot.byId.get(tree.rootId)!;
    expect(snapshot.positions.get(nested!.id)).toEqual({
      x: rootNode.width + 72,
      y: MAP_HEADER_HEIGHT + 2 * MAP_ROW_HEIGHT,
    });
    // ARIA: level, place among siblings, and the key depth that colors its keys.
    expect(nested).toMatchObject({ level: 2, position: 1, setSize: 1, keyDepth: 2 });
    expect(model.locate(nested!.id)).toEqual({ nodeId: nested!.id, rowIndex: null });
    // A scalar is located as a row of its node.
    const knots = tree.entriesOf(tree.rootId)![1]!;
    expect(model.locate(knots.id)).toEqual({ nodeId: tree.rootId, rowIndex: 1 });

    await model.setExpanded(tree.rootId, false);
    await settle();
    expect(model.getSnapshot().nodes).toHaveLength(1);
    model.stop();
  });

  it("chunks a big array into [0…999] nodes and expands all from where it stopped", async () => {
    const { source, root } = fakeEngine({
      list: Array.from({ length: 2500 }, (_, i) => ({ i })),
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "json" });
    model.start();
    await model.toggleRow(tree.rootId, 0);
    await settle();
    const list = model.getSnapshot().nodes[1]!;
    expect(describeNode(model.getSnapshot(), list.id)?.rows).toEqual([
      "[0…999]: 1,000 items",
      "[1000…1999]: 1,000 items",
      "[2000…2499]: 500 items",
    ]);
    await model.toggleRow(list.id, 2);
    await settle();
    const chunk = model.getSnapshot().nodes.find((node) => node.kind === "chunk")!;
    expect(chunk.title).toBe("[2000…2499]");
    // A node lists its first 100 rows, then one row that shows the next page.
    expect(chunk.rows).toHaveLength(MAP_ROW_PAGE + 1);
    expect(chunk.rows[0]).toMatchObject({ key: "2000", value: "{} 1 key", kind: "object" });
    expect(chunk.rows[MAP_ROW_PAGE]).toMatchObject({
      kind: "more",
      value: "… 400 more · show 100",
    });
    expect(chunk.height).toBe(MAP_HEADER_HEIGHT + (MAP_ROW_PAGE + 1) * MAP_ROW_HEIGHT + 5);
    await model.toggleRow(chunk.id, MAP_ROW_PAGE);
    await settle();
    const more = model.getSnapshot().byId.get(chunk.id)!;
    expect(more.rows).toHaveLength(2 * MAP_ROW_PAGE + 1);
    expect(more.rows[2 * MAP_ROW_PAGE]?.value).toBe("… 300 more · show 100");

    await model.expandAll(null);
    await settle();
    // Every container opened, but each node lists its first page: the rows shown open as nodes.
    const opened = model.getSnapshot().nodes;
    expect(opened.length).toBeGreaterThan(3 * MAP_ROW_PAGE);
    // (the last range was paged to 200 rows above)
    expect(opened.every((node) => node.rows.length <= 2 * MAP_ROW_PAGE + 1)).toBe(true);
    model.stop();
  });

  it("opens every host and page of a capture, or only those under one host, and closes them again", async () => {
    const entry = (n: number, host: string, pageref: string) => ({
      pageref,
      request: { method: "GET", url: `https://${host}/path/${n}` },
      response: { status: 200 },
    });
    const { source, root, harEntries } = fakeEngine({
      log: {
        version: "1.2",
        pages: [
          { id: "page_1", title: "Home" },
          { id: "page_2", title: "Checkout" },
        ],
        entries: [
          entry(0, "cdn.example", "page_1"),
          entry(1, "api.example", "page_1"),
          entry(2, "cdn.example", "page_2"),
        ],
      },
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "har", source: { harEntries } });
    model.start();
    await tree.setExpanded(tree.entriesOf(tree.rootId)![0]!.id, true);
    await settle();
    await settle();
    const titles = () => model.getSnapshot().nodes.map((node) => node.title);

    expect(await model.expandAll(null)).toBe(
      "Opened every host and page. Open a request to see its data.",
    );
    await settle();
    expect(titles()).toEqual(["Capture", "cdn.example", "Home", "Checkout", "api.example", "Home"]);
    model.collapseUnder("har:capture");
    await settle();
    expect(titles()).toEqual(["Capture"]);

    const capture = model.getSnapshot().byId.get("har:capture")!;
    await model.toggleRow(
      "har:capture",
      capture.rows.findIndex((row) => row.key === "cdn.example"),
    );
    await settle();
    const cdn = model.getSnapshot().nodes.find((node) => node.title === "cdn.example")!;
    await model.expandAll(cdn.id);
    await settle();
    expect(titles()).toEqual(["Capture", "cdn.example", "Home", "Checkout"]);
    model.collapseUnder(cdn.id);
    await settle();
    expect(titles()).toEqual(["Capture", "cdn.example"]);
    model.stop();
  });

  it("groups a HAR capture host → page → entry, and opens an entry into its data", async () => {
    const entry = (n: number, host: string, pageref: string) => ({
      pageref,
      request: { method: n % 2 ? "GET" : "POST", url: `https://${host}/path/${n}?q=1` },
      response: { status: 200 + n },
    });
    const { source, root, harEntries } = fakeEngine({
      log: {
        version: "1.2",
        creator: { name: "WebInspector" },
        pages: [
          { id: "page_1", title: "Home" },
          { id: "page_2", title: "Checkout" },
        ],
        entries: [
          entry(0, "cdn.example", "page_1"),
          entry(1, "api.example", "page_1"),
          entry(2, "cdn.example", "page_2"),
          entry(3, "cdn.example", "page_1"),
        ],
      },
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "har", source: { harEntries } });
    model.start();
    // The log must be listed for the capture node to exist: open it as the tree does.
    const logId = tree.entriesOf(tree.rootId)![0]!.id;
    await tree.setExpanded(logId, true);
    await settle();
    await settle();
    let snapshot = model.getSnapshot();
    expect(snapshot.grouping).toEqual({ loaded: 4, total: 4 });
    expect(snapshot.nodes.map((node) => node.kind)).toEqual(["capture"]);
    expect(describeNode(snapshot, "har:capture")).toEqual({
      title: "Capture 4 requests, 2 hosts",
      rows: [
        'version: "1.2"',
        "creator: {} 1 key",
        "cdn.example: 3 requests",
        "api.example: 1 request",
      ],
    });

    await model.toggleRow("har:capture", 2);
    await settle();
    snapshot = model.getSnapshot();
    const host = snapshot.nodes.find((node) => node.kind === "host")!;
    expect(describeNode(snapshot, host.id)).toEqual({
      title: "cdn.example 3 requests, 2 pages",
      rows: ["Home: 2 requests", "Checkout: 1 request"],
    });

    await model.toggleRow(host.id, 0);
    await settle();
    snapshot = model.getSnapshot();
    const page = snapshot.nodes.find((node) => node.kind === "page")!;
    expect(describeNode(snapshot, page.id)).toEqual({
      title: "Home 2 requests",
      rows: ["POST /path/0: 200", "GET /path/3: 203"],
    });

    // Opening a request shows the entry object: request, response and their fields follow.
    await model.toggleRow(page.id, 1);
    await settle();
    snapshot = model.getSnapshot();
    const entryNode = snapshot.nodes.find(
      (node) => node.kind === "object" && node.parentId === page.id,
    )!;
    expect(describeNode(snapshot, entryNode.id)).toEqual({
      title: "GET /path/3 {} 3 keys",
      rows: ['pageref: "page_1"', "request: {} 2 keys", "response: {} 1 key"],
    });
    expect(model.locate(entryNode.id)).toEqual({ nodeId: entryNode.id, rowIndex: null });
    // The same entry is now reachable in the tree too (log → entries → 3), so the tree can select it.
    expect(tree.rows().some((row) => row.id === entryNode.id)).toBe(true);
    model.stop();
  });

  it("opens a decoded value as a card the tree shares, and an image as a preview card", async () => {
    const { source, root, harEntries, decode } = fakeEngine({
      body: JSON.stringify({ a: 1, b: { c: true } }),
      pic: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      name: "a plain string, not encoded",
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, {
      ...options,
      format: "json",
      source: { harEntries, decode },
    });
    model.start();
    const [bodyId, picId, nameId] = tree.entriesOf(tree.rootId)!.map((entry) => entry.id);
    // The map asks for the strings it shows, as the tree's rows do.
    await Promise.all([bodyId, picId, nameId].map((id) => tree.requestText(id!)));
    await settle();
    const rootRows = () => model.getSnapshot().byId.get(tree.rootId)!.rows;
    expect(rootRows().map(({ key, badge, expandable }) => ({ key, badge, expandable }))).toEqual([
      { key: "body", badge: "JSON", expandable: true },
      { key: "pic", badge: "base64 · image/png", expandable: true },
      { key: "name", badge: null, expandable: false },
    ]);

    // Nested JSON opens into a card of its own, whose rows open further; none of it is the file's bytes.
    await model.toggleRow(tree.rootId, 0);
    await settle();
    const card = model.getSnapshot().byId.get(bodyId!)!;
    expect(card).toMatchObject({ kind: "decoded", decoded: true, parentId: tree.rootId });
    expect(describeNode(model.getSnapshot(), bodyId!)).toEqual({
      title: "body JSON · 2 keys",
      rows: ["a: 1", "b: {} 1 key"],
    });
    expect(card.rows.every((row) => row.decoded)).toBe(true);
    await model.toggleRow(bodyId!, 1);
    await settle();
    const inner = model.getSnapshot().nodes.find((node) => node.parentId === bodyId)!;
    expect(inner).toMatchObject({ kind: "object", decoded: true, title: "b" });
    expect(tree.isInsideDecoded(inner.id)).toBe(true);

    // The tree holds the open state: closing it there closes the card, and decode.toggle reopens it.
    expect(tree.isExpanded(bodyId!)).toBe(true);
    await tree.setExpanded(bodyId!, false);
    await settle();
    expect(model.getSnapshot().byId.has(bodyId!)).toBe(false);
    tree.select(bodyId!);
    await tree.toggleSelectedDecode();
    await settle();
    expect(model.getSnapshot().byId.get(bodyId!)?.kind).toBe("decoded");

    // An image has no rows in the tree: the map shows what it is and draws it.
    tree.select(picId!);
    await tree.toggleSelectedDecode();
    await settle();
    await settle();
    expect(describeNode(model.getSnapshot(), picId!)).toEqual({
      title: "pic base64 · image/png",
      rows: ["type: image/png", "size: 68 B"],
    });
    expect(model.getSnapshot().byId.get(picId!)?.preview).toEqual({
      ref: tree.summaryOf(picId!)!.ref,
      mime: "image/png",
    });
    await model.toggleRow(tree.rootId, 1);
    await settle();
    expect(model.getSnapshot().byId.has(picId!)).toBe(false);
    model.stop();
  });

  it("decodes a subtree in bulk, keeps a value closed by hand, and decodes the rest automatically", async () => {
    const { source, root, harEntries, decode } = fakeEngine({
      bodies: {
        first: JSON.stringify({ a: 1, b: 2 }),
        second: JSON.stringify({ c: 3, d: 4 }),
        third: JSON.stringify({ e: 5, f: 6 }),
      },
      later: JSON.stringify({ g: 7, h: 8 }),
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, {
      ...options,
      format: "json",
      source: { harEntries, decode },
    });
    model.start();
    const [bodiesId, laterId] = tree.entriesOf(tree.rootId)!.map((entry) => entry.id);
    await tree.setExpanded(bodiesId!, true);
    const [firstId, secondId, thirdId] = tree.entriesOf(bodiesId!)!.map((entry) => entry.id);
    await settle();
    const decodedCards = () =>
      model
        .getSnapshot()
        .nodes.filter((node) => node.kind === "decoded")
        .map((node) => node.title);

    // Bulk decode of the selection's subtree: every value under `bodies`, and nothing outside it.
    tree.select(bodiesId!);
    expect(await tree.decodeAll(tree.decodeScope, true)).toBe(3);
    await settle();
    expect(decodedCards()).toEqual(["first", "second", "third"]);
    expect(tree.isExpanded(laterId!)).toBe(false);

    // One closed by hand on the map stays closed when automatic decoding comes on.
    await model.toggleRow(bodiesId!, 1);
    tree.setAutoDecode({ enabled: true, kinds: null });
    await settle();
    expect(decodedCards()).toEqual(["first", "third"]);
    expect(tree.isExpanded(secondId!)).toBe(false);

    // A value detected later (it scrolled into view) opens on its own.
    await tree.requestText(laterId!);
    await settle();
    await settle();
    expect(decodedCards()).toEqual(["first", "third", "later"]);

    // Collapsing in bulk wins over automatic decoding too.
    tree.select(tree.rootId);
    expect(await tree.decodeAll(tree.decodeScope, false)).toBe(3);
    tree.setAutoDecode({ enabled: true, kinds: null });
    await settle();
    expect(decodedCards()).toEqual([]);
    expect([firstId, thirdId].map((id) => tree.isExpanded(id!))).toEqual([false, false]);
    model.stop();
  });

  it("decodes automatically only the kinds chosen", async () => {
    const { source, root } = fakeEngine({ body: JSON.stringify({ a: 1, b: 2 }) });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    tree.setAutoDecode({ enabled: true, kinds: ["jwt"] });
    const bodyId = tree.entriesOf(tree.rootId)![0]!.id;
    await tree.requestText(bodyId);
    await settle();
    expect(tree.isExpanded(bodyId)).toBe(false);
    tree.setAutoDecode({ enabled: true, kinds: ["json"] });
    await settle();
    expect(tree.isExpanded(bodyId)).toBe(true);
  });

  it("sizes nodes to the measured font, so a long key and value stay inside the node", async () => {
    const { source, root } = fakeEngine({
      ["longKey_" + "x".repeat(60)]: "a key that is very long to test overflow",
      longString: "Lorem ipsum dolor sit amet, ".repeat(6),
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "json" });
    model.start();
    await settle();
    // The font draws 8.4 px per character, wider than the 7.2 the model assumes at first.
    model.setCharWidth(8.4);
    await settle();
    const node = model.getSnapshot().nodes[0]!;
    for (const row of node.rows) {
      const chars = row.key.length + 2 + row.value.length;
      expect(chars * 8.4 + 36, row.key).toBeLessThanOrEqual(node.width);
    }
    expect(model.getSnapshot().charWidth).toBe(8.4);
    model.stop();
  });

  it("counts CJK and emoji as two columns, so their rows are sized as they are drawn", async () => {
    expect(textColumns("abc")).toBe(3);
    expect(textColumns("東京タワー")).toBe(10);
    expect(textColumns("안녕")).toBe(4);
    expect(textColumns("🚀 ok ✅")).toBe(8);
    // A variation selector and a joiner take no room.
    expect(textColumns("❤\uFE0F")).toBe(2);
    const { source, root } = fakeEngine({ 名前: "東京タワー".repeat(12), ascii: "x".repeat(10) });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "json" });
    model.start();
    await settle();
    const node = model.getSnapshot().nodes[0]!;
    for (const row of node.rows) {
      const columns = textColumns(row.key) + 2 + textColumns(row.value);
      expect(columns * 7.2 + 36, row.key).toBeLessThanOrEqual(node.width);
    }
    // The long CJK value was cut to fit, by columns.
    expect(node.rows[0]!.value.endsWith("…")).toBe(true);
    model.stop();
  });

  it("lists a row past the first page when a reveal asks for it", async () => {
    const { source, root } = fakeEngine({ list: Array.from({ length: 300 }, (_, i) => i) });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "json" });
    model.start();
    const listId = tree.entriesOf(tree.rootId)![0]!.id;
    await model.toggleRow(tree.rootId, 0);
    await settle();
    const target = tree.entriesOf(listId)![250]!;
    expect(model.locate(target.id)).toBeNull();
    await model.reveal([
      { node: tree.summaryOf(tree.rootId)!, index: null },
      { node: tree.summaryOf(listId)!, index: null },
      { node: tree.summaryOf(target.id)!, index: 250 },
    ]);
    await settle();
    expect(model.locate(target.id)).toEqual({ nodeId: listId, rowIndex: 250 });
    model.stop();
  });

  it("says when Expand All stopped at its limit", async () => {
    const { source, root } = fakeEngine({
      many: Array.from({ length: 6000 }, (_, i) => ({ i })),
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "json" });
    model.start();
    expect(await model.expandAll(null)).toBe(
      `Opened 5,000 objects and arrays, the most it opens at once; ${model.getSnapshot().nodes.length} nodes are on the map, the rest behind “more” rows. Run it again to open more.`,
    );
    const small = fakeEngine({ a: { b: 1 } });
    const smallTree = new TreeModel(small.source, small.root);
    await smallTree.setExpanded(smallTree.rootId, true);
    const smallModel = new MapModel(smallTree, { ...options, format: "json" });
    smallModel.start();
    expect(await smallModel.expandAll(null)).toBeNull();
    model.stop();
    smallModel.stop();
  });

  it("opens a request the index had not counted yet, once indexing finishes", async () => {
    const entry = (host: string, n: number) => ({
      pageref: "page_1",
      request: { method: "GET", url: `https://${host}/e/${n}` },
      response: { status: 200 },
    });
    const engine = fakeEngine({
      log: {
        pages: [{ id: "page_1", title: "Home" }],
        entries: [
          ...Array.from({ length: 1200 }, (_, n) => entry("early.example", n)),
          ...Array.from({ length: 3 }, (_, n) => entry("late.example", 1200 + n)),
        ],
      },
    });
    // The engine has counted 400 of the 1,203 entries so far.
    const index = engine.indexing("entries", 400);
    const tree = new TreeModel(engine.source, engine.root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, {
      ...options,
      format: "har",
      source: { harEntries: engine.harEntries },
    });
    const grouped = new Promise<void>((resolve) => {
      const off = model.subscribe(() => {
        if (model.getSnapshot().grouping?.loaded === 1203) {
          off();
          resolve();
        }
      });
    });
    model.start();
    await tree.setExpanded(tree.entriesOf(tree.rootId)![0]!.id, true);
    await grouped;
    await settle();
    const opened = (parentId: string) =>
      model.getSnapshot().nodes.filter((node) => node.parentId === parentId);
    // The capture lists its two hosts; the second holds the requests past the count.
    await model.toggleRow("har:capture", 1);
    await settle();
    const host = opened("har:capture")[0]!;
    expect(host.title).toBe("late.example");
    await model.toggleRow(host.id, 0);
    await settle();
    const page = opened(host.id)[0]!;
    // Asked for while the index is short of it: the request cannot open yet.
    await model.toggleRow(page.id, 0);
    await settle();
    // Indexing finishes; the tree lists the entries again, now in ranges.
    index.finish();
    await tree.refresh();
    await settle();
    await settle();
    const request = opened(page.id)[0];
    expect(request?.title).toBe("GET /e/1200");
    model.stop();
  });

  it("groups the rest of a capture once indexing finishes, after catching up with the index", async () => {
    const entry = (host: string, n: number) => ({
      pageref: "page_1",
      request: { method: "GET", url: `https://${host}/e/${n}` },
      response: { status: 200 },
    });
    const engine = fakeEngine({
      log: {
        pages: [{ id: "page_1", title: "Home" }],
        entries: [
          ...Array.from({ length: 129 }, (_, n) => entry("early.example", n)),
          ...Array.from({ length: 496 }, (_, n) => entry("late.example", 129 + n)),
        ],
      },
    });
    // The engine has counted 129 of the 625 entries when the grouping first reads them.
    const index = engine.indexingCapture(129);
    const tree = new TreeModel(engine.source, engine.root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, {
      ...options,
      format: "har",
      source: { harEntries: engine.harEntries },
    });
    model.start();
    await settle();
    await settle();
    expect(model.getSnapshot().grouping).toEqual({ loaded: 129, total: 129 });
    const capture = () => {
      const node = model.getSnapshot().byId.get("har:capture")!;
      return `${node.title} ${node.subtitle}`;
    };
    expect(capture()).toBe("Capture 129 requests, 1 host");

    // Indexing finishes; the tree lists the root again, the capture takes in the rest.
    index.finish();
    await tree.refresh();
    for (let i = 0; i < 5; i += 1) await settle();
    expect(model.getSnapshot().grouping).toEqual({ loaded: 625, total: 625 });
    expect(capture()).toBe("Capture 625 requests, 2 hosts");
    model.stop();
  });

  it("opens hosts, pages and requests past 1,000 as ranges, as it does array chunks", async () => {
    const entry = (host: string, pageref: string, n: number) => ({
      pageref,
      request: { method: "GET", url: `https://${host}/e/${n}` },
      response: { status: 200 },
    });
    const entries = [
      // One page with 2,500 requests.
      ...Array.from({ length: 2500 }, (_, n) => entry("big.example", "page_1", n)),
      // One host with 1,001 pages.
      ...Array.from({ length: 1001 }, (_, n) => entry("pages.example", `p${n}`, n)),
      // 1,001 more hosts, so the capture lists 1,003.
      ...Array.from({ length: 1001 }, (_, n) => entry(`host-${n}.example`, "page_1", n)),
    ];
    const { source, root, harEntries } = fakeEngine({
      log: { version: "1.2", pages: [{ id: "page_1", title: "Home" }], entries },
    });
    const tree = new TreeModel(source, root);
    await tree.setExpanded(tree.rootId, true);
    const model = new MapModel(tree, { ...options, format: "har", source: { harEntries } });
    const grouped = new Promise<void>((resolve) => {
      const off = model.subscribe(() => {
        const grouping = model.getSnapshot().grouping;
        if (grouping !== null && grouping.loaded === entries.length) {
          off();
          resolve();
        }
      });
    });
    model.start();
    await tree.setExpanded(tree.entriesOf(tree.rootId)![0]!.id, true);
    await grouped;
    await settle();
    const rowsOf = (id: string) => describeNode(model.getSnapshot(), id)?.rows ?? [];
    const opened = (parentId: string) =>
      model.getSnapshot().nodes.filter((node) => node.parentId === parentId);

    expect(describeNode(model.getSnapshot(), "har:capture")).toEqual({
      title: "Capture 4,502 requests, 1,003 hosts",
      rows: ['version: "1.2"', "[0…999]: 1,000 hosts", "[1000…1002]: 3 hosts"],
    });

    // The last range of hosts opens into the hosts it holds.
    await model.toggleRow("har:capture", 2);
    await settle();
    const lastHosts = opened("har:capture")[0]!;
    expect(describeNode(model.getSnapshot(), lastHosts.id)).toEqual({
      title: "[1000…1002] 3 hosts",
      rows: [
        "host-998.example: 1 request",
        "host-999.example: 1 request",
        "host-1000.example: 1 request",
      ],
    });

    // A host with 1,001 pages lists both ranges, and the one past 1,000 holds the last page.
    await model.toggleRow("har:capture", 1);
    await settle();
    const firstHosts = opened("har:capture").find((node) => node.id !== lastHosts.id)!;
    expect(rowsOf(firstHosts.id).slice(0, 2)).toEqual([
      "big.example: 2,500 requests",
      "pages.example: 1,001 requests",
    ]);
    await model.toggleRow(firstHosts.id, 1);
    await settle();
    const pagesHost = opened(firstHosts.id)[0]!;
    expect(describeNode(model.getSnapshot(), pagesHost.id)).toEqual({
      title: "pages.example 1,001 requests, 1,001 pages",
      rows: ["[0…999]: 1,000 pages", "[1000…1000]: 1 page"],
    });
    await model.toggleRow(pagesHost.id, 1);
    await settle();
    expect(rowsOf(opened(pagesHost.id)[0]!.id)).toEqual(["p1000: 1 request"]);

    // A page with 2,500 requests: three ranges, and a request in the last one opens into its data.
    await model.toggleRow(firstHosts.id, 0);
    await settle();
    const bigHost = opened(firstHosts.id).find(
      (node) => node.kind === "host" && node.title === "big.example",
    )!;
    await model.toggleRow(bigHost.id, 0);
    await settle();
    const page = opened(bigHost.id)[0]!;
    expect(describeNode(model.getSnapshot(), page.id)).toEqual({
      title: "Home 2,500 requests",
      rows: ["[0…999]: 1,000 requests", "[1000…1999]: 1,000 requests", "[2000…2499]: 500 requests"],
    });
    await model.toggleRow(page.id, 2);
    await settle();
    const lastRequests = opened(page.id)[0]!;
    expect(lastRequests).toMatchObject({ kind: "chunk", title: "[2000…2499]" });
    expect(lastRequests.rows).toHaveLength(MAP_ROW_PAGE + 1);
    // Showing every page reaches the last request.
    for (let page = 1; page < 5; page += 1) {
      await model.toggleRow(lastRequests.id, page * MAP_ROW_PAGE);
      await settle();
    }
    expect(rowsOf(lastRequests.id)).toHaveLength(500);
    expect(rowsOf(lastRequests.id)[499]).toBe("GET /e/2499: 200");
    await model.toggleRow(lastRequests.id, 499);
    await settle();
    await settle();
    const request = opened(lastRequests.id)[0]!;
    expect(describeNode(model.getSnapshot(), request.id)).toEqual({
      title: "GET /e/2499 {} 3 keys",
      rows: ['pageref: "page_1"', "request: {} 2 keys", "response: {} 1 key"],
    });

    // And each range closes again.
    await model.toggleRow(page.id, 2);
    await settle();
    expect(opened(page.id)).toEqual([]);
    expect(rowsOf(page.id)[2]).toBe("[2000…2499]: 500 requests");
    model.stop();
  });
});
