import type { Decoded, Detection, NodeRef, NodeSummary, PathStep } from "@quipu/contracts/engine";
import { describe, expect, it } from "vite-plus/test";

import { CHUNK_SIZE, TreeModel, type TreeSource } from "./treeModel.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** An in-memory engine over a JS value: tokens are numbered in document order. */
function fakeEngine(value: Json) {
  const decodeCalls: string[] = [];
  interface Item {
    readonly summary: NodeSummary;
    readonly key: string | null;
    readonly children: number[];
    readonly text: string;
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
    const placeholder: Item = {
      summary: {
        ref: { documentId: 1, tapeId: 0, token },
        kind,
        range: { start: 0, end: typeof json === "string" ? json.length + 2 : 0 },
        span: { start: 0, end: typeof json === "string" ? json.length + 2 : 0 },
        key: key === null ? null : 0,
        childCount: 0,
        childrenIndexed: true,
        settled: true,
      },
      key,
      children,
      text: typeof json === "string" ? json : String(json),
    };
    items.push(placeholder);
    if (Array.isArray(json)) json.forEach((child) => children.push(add(child, null)));
    else if (json !== null && typeof json === "object") {
      for (const [k, child] of Object.entries(json)) children.push(add(child, k));
    }
    items[token] = {
      ...placeholder,
      summary: { ...placeholder.summary, childCount: children.length },
    };
    return token;
  };
  add(value, null);
  const jsonDetection: Detection = { kind: "json", label: "JSON", mime: null, structured: true };
  const source: TreeSource = {
    node: async (ref) => (items[ref.token] as Item).summary,
    rows: async (ref, from, count, previewBytes) => {
      const item = items[ref.token] as Item;
      return {
        from,
        total: item.children.length,
        rows: item.children.slice(from, from + count).map((t) => {
          const child = items[t] as Item;
          const scalar = child.summary.kind !== "object" && child.summary.kind !== "array";
          return {
            node: child.summary,
            key: child.key,
            preview: scalar
              ? {
                  text: child.text.slice(0, previewBytes),
                  truncated: child.text.length > previewBytes,
                  bytes: child.text.length,
                }
              : null,
          };
        }),
      };
    },
    keyText: async (ref: NodeRef) => (items[ref.token] as Item).key ?? "",
    text: async (ref) => ({ text: (items[ref.token] as Item).text, truncated: false, bytes: 0 }),
    // A string holding a JSON object or array decodes as JSON; "query …" decodes as GraphQL text.
    detect: async (ref) => {
      const item = items[ref.token] as Item;
      if (item.summary.kind !== "string") return [];
      if (/^[{[]/.test(item.text)) return [jsonDetection];
      if (item.text.startsWith("query ")) {
        return [{ kind: "graphql", label: "GraphQL · query", mime: null, structured: true }];
      }
      if (item.text.startsWith("PNG")) {
        return [
          { kind: "base64", label: "base64 · image/png", mime: "image/png", structured: false },
        ];
      }
      return [];
    },
    decode: async (ref, kind): Promise<Decoded> => {
      const item = items[ref.token] as Item;
      decodeCalls.push(`${ref.token}:${kind}`);
      if (item.text.includes("not really")) throw new Error("The value is not valid JSON.");
      if (kind === "json") {
        const root = add(JSON.parse(item.text) as Json, null);
        const summary = (items[root] as Item).summary;
        return {
          kind,
          label: "JSON",
          layers: [],
          mime: "application/json",
          bytes: item.text.length,
          document: { root: summary, bytes: item.text.length },
          view: {
            _tag: "text",
            value: { text: item.text, truncated: false, bytes: item.text.length },
          },
        };
      }
      // The real printer lives in the engine; the model only needs text with line breaks.
      const pretty = item.text.replace(/ /g, "\n");
      return {
        kind,
        label: "GraphQL",
        layers: [],
        mime: null,
        bytes: item.text.length,
        document: null,
        view: { _tag: "text", value: { text: pretty, truncated: false, bytes: pretty.length } },
      };
    },
    frames: async (ref, from, count) => {
      const item = items[ref.token] as Item;
      const kids = item.children.slice(from, from + count);
      return {
        from,
        total: item.children.length,
        frames: kids.map((token, offset) => ({
          index: from + offset,
          ref: (items[token] as Item).summary.ref,
          direction: offset % 2 === 0 ? ("send" as const) : ("receive" as const),
          time: 1.5,
          opcode: 1,
          size: 12 + offset,
          preview: `frame ${from + offset}`,
          mime: null,
          dataRef: null,
          detections: [],
        })),
      };
    },
  };
  return { source, root: (items[0] as Item).summary, decodeCalls };
}

/** Each row as the view draws it: indentation, then the key or index and the preview or size. */
function labels(model: TreeModel) {
  return model.view().map((row) => {
    const pad = "  ".repeat(row.depth);
    const name = row.kind === "node" && row.id === model.rootId ? "" : row.name;
    const value = row.kind === "node" && row.value === "" ? "" : row.value;
    return `${pad}${name}${name && value ? ": " : ""}${value}`;
  });
}

async function show(model: TreeModel) {
  await Promise.all(model.rows().map((row) => model.requestText(row.id)));
  return labels(model);
}

describe("TreeModel", () => {
  it("lists the keys and values of an opened container, indented under it", async () => {
    const { source, root } = fakeEngine({
      name: "quipu",
      nested: { depth: 2 },
      list: [true, null],
    });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    expect(await show(model)).toEqual([
      "{} 3 keys",
      '  name: "quipu"',
      "  nested: {} 1 key",
      "  list: [] 2 items",
    ]);

    const list = model.rows().find((row) => model.keyOf(row.id) === "list")!;
    await model.setExpanded(list.id, true);
    expect(await show(model)).toEqual([
      "{} 3 keys",
      '  name: "quipu"',
      "  nested: {} 1 key",
      "  list: [] 2 items",
      "    0: true",
      "    1: null",
    ]);
  });

  it("opens one path from two rows at once, and both see the children", async () => {
    // A HAR page opens its entries together: each walks log → entries → entry.
    const { source, root } = fakeEngine({ log: { entries: [{ a: 1 }, { b: 2 }] } });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const byKey = (key: string) => model.rows().find((row) => model.keyOf(row.id) === key)!;
    const open = async (which: number) => {
      await model.setExpanded(byKey("log").id, true);
      await show(model);
      await model.setExpanded(byKey("entries").id, true);
      await show(model);
      const entry = model.rows().filter((row) => row.depth === 3)[which]!;
      await model.setExpanded(entry.id, true);
    };
    await Promise.all([open(0), open(1)]);
    expect(await show(model)).toEqual([
      "{} 1 key",
      "  log: {} 1 key",
      "    entries: [] 2 items",
      "      0: {} 1 key",
      "        a: 1",
      "      1: {} 1 key",
      "        b: 2",
    ]);
  });

  it("splits a big array into ranges and lists one range's elements on demand", async () => {
    const big = Array.from({ length: CHUNK_SIZE * 2 + 5 }, (_, i) => i);
    const { source, root } = fakeEngine(big);
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    expect(await show(model)).toEqual([
      "[] 2,005 items",
      "  [0…999]",
      "  [1000…1999]",
      "  [2000…2004]",
    ]);
    const second = model.rows()[2]!;
    await model.setExpanded(second.id, true);
    const shown = await show(model);
    expect(shown).toHaveLength(4 + CHUNK_SIZE);
    expect(shown[3]).toBe("    1000: 1000");
    expect(shown[2 + CHUNK_SIZE]).toBe("    1999: 1999");
  });

  it("collapses everything back to the root", async () => {
    const { source, root } = fakeEngine({ a: { b: { c: 1 } } });
    const model = new TreeModel(source, root);
    await model.expandAll();
    expect(model.rows().length).toBeGreaterThan(3);
    model.collapseAll();
    // The root stays open: its members are the first thing the view shows.
    expect(await show(model)).toEqual(["{} 1 key", "  a: {} 1 key"]);
  });

  it("lists a container again with its final size once the index is done", async () => {
    const { source, root } = fakeEngine({ items: [1, 2, 3] });
    let grown = false;
    const partial: TreeSource = {
      ...source,
      rows: async (ref, from, count, previewBytes) => {
        const page = await source.rows(ref, from, count, previewBytes);
        return grown ? page : { ...page, total: 1, rows: page.rows.slice(0, 1) };
      },
    };
    const model = new TreeModel(partial, root);
    await model.setExpanded(model.rootId, true);
    const items = model.rows()[1]!;
    await model.setExpanded(items.id, true);
    expect(model.rows()).toHaveLength(3);
    grown = true;
    await model.refresh();
    expect(model.rows()).toHaveLength(5);
  });

  describe("revealing the node the source named", () => {
    /** The path the engine would give for the node at `positions` children down from the root. */
    async function pathTo(source: TreeSource, root: NodeSummary, positions: number[]) {
      const path: PathStep[] = [{ node: root, index: null }];
      let at = root;
      for (const position of positions) {
        const page = await source.rows(at.ref, position, 1, 16);
        at = (page.rows[0] as (typeof page.rows)[number]).node;
        path.push({ node: at, index: position });
      }
      return path;
    }

    it("opens every container on the way and names the row of the node", async () => {
      const { source, root } = fakeEngine({ a: { b: [10, 20, 30] }, z: 1 });
      const model = new TreeModel(source, root);
      await model.setExpanded(model.rootId, true);
      const path = await pathTo(source, root, [0, 0, 1]);
      const id = await model.reveal(path);
      expect(id).toBe(`0.${(path[3] as PathStep).node.ref.token}`);
      expect(await show(model)).toEqual([
        "{} 2 keys",
        "  a: {} 1 key",
        "    b: [] 3 items",
        "      0: 10",
        "      1: 20",
        "      2: 30",
        "  z: 1",
      ]);
    });

    it("opens the range of a big array that holds the element", async () => {
      const big = Array.from({ length: CHUNK_SIZE * 3 }, (_, i) => `v${i}`);
      const { source, root } = fakeEngine({ list: big });
      const model = new TreeModel(source, root);
      await model.setExpanded(model.rootId, true);
      const path = await pathTo(source, root, [0, 1500]);
      const id = await model.reveal(path);
      const rows = await show(model);
      expect(id).not.toBeNull();
      expect(rows).toContain('      1500: "v1500"');
      expect(rows).toContain("    [0…999]");
      expect(rows).not.toContain('      0: "v0"');
    });

    it("answers with the nearest row it could reach when a listing lacks the node", async () => {
      const { source, root } = fakeEngine({ a: { b: 1 } });
      const model = new TreeModel(source, root);
      const path = await pathTo(source, root, [0, 0]);
      const ghost: PathStep = {
        node: { ...(path[2] as PathStep).node, ref: { documentId: 1, tapeId: 7, token: 99 } },
        index: 0,
      };
      const id = await model.reveal([...path.slice(0, 2), ghost]);
      expect(id).toBe(`0.${(path[1] as PathStep).node.ref.token}`);
    });
  });

  it("offers a string that decodes as an expandable row with a badge, and lists the decoded value under it", async () => {
    const { source, root, decodeCalls } = fakeEngine({
      id: 7,
      body: '{"status":"ok","inner":{"deep":true}}',
    });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const body = model.view().find((row) => row.name === "body")!;
    expect(body.expandable).toBe(true);
    expect(body.badge).toBe("JSON");
    expect(model.view().find((row) => row.name === "id")!.expandable).toBe(false);
    // Detecting is not decoding: nothing is indexed until the row is opened.
    expect(decodeCalls).toEqual([]);

    await model.setExpanded(body.id, true);
    expect(await show(model)).toEqual([
      "{} 2 keys",
      "  id: 7",
      '  body: "{"status":"ok","inner":{"deep":true}}"',
      '    status: "ok"',
      "    inner: {} 1 key",
    ]);
    expect(model.view().find((row) => row.name === "status")!.decoded).toBe(true);
    expect(decodeCalls).toEqual(["2:json"]);

    // The decoded children expand like any others, and decode again when they are strings that decode.
    const inner = model.view().find((row) => row.name === "inner")!;
    await model.setExpanded(inner.id, true);
    expect((await show(model)).at(-1)).toBe("      deep: true");
  });

  it("shows a decoded text value as numbered lines under its row", async () => {
    const { source, root } = fakeEngine({ q: "query { viewer { login } }" });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const query = model.view().find((row) => row.name === "q")!;
    await model.setExpanded(query.id, true);
    const rows = model.view().slice(2);
    expect(rows.map((row) => [row.kind, row.name, row.value])).toEqual(
      ["query", "{", "viewer", "{", "login", "}", "}"].map((line, i) => [
        "text",
        String(i + 1),
        line,
      ]),
    );
  });

  it("takes the chevron away from a value whose decode fails, and says why", async () => {
    const { source, root } = fakeEngine({ bad: '{"not really": json' });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const bad = model.view().find((row) => row.name === "bad")!;
    expect(bad.expandable).toBe(true);
    await model.setExpanded(bad.id, true);
    const after = model.view().find((row) => row.name === "bad")!;
    expect(after.expandable).toBe(false);
    expect(after.badge).toBeNull();
    expect(model.error).toBe("The value is not valid JSON.");
  });

  it("does not offer a chevron for an image: its preview is in the Inspector", async () => {
    const { source, root } = fakeEngine({ logo: "PNG-bytes-as-base64-text" });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const logo = model.view().find((row) => row.name === "logo")!;
    expect(logo.badge).toBe("base64 · image/png");
    expect(logo.expandable).toBe(false);
  });

  it("selects a row and reports where it sits", async () => {
    const { source, root } = fakeEngine({ log: { entries: [{ url: "https://a.test/" }] } });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const log = model.view().find((row) => row.name === "log")!;
    await model.setExpanded(log.id, true);
    await show(model);
    const entries = model.view().find((row) => row.name === "entries")!;
    await model.setExpanded(entries.id, true);
    await show(model);
    const first = model.view().find((row) => row.name === "0")!;
    await model.setExpanded(first.id, true);
    await show(model);
    const url = model.view().find((row) => row.name === "url")!;

    expect(model.selection()?.path).toEqual(["root"]);
    model.select(url.id);
    const selection = model.selection()!;
    expect(selection.path).toEqual(["root", "log", "entries", "0", "url"]);
    expect(selection.name).toBe("url");
    expect(selection.node.kind).toBe("string");
    expect(selection.parent?.key).toBeNull();
    // Unrelated updates keep the same selection object, so the Inspector does not re-read.
    await model.setExpanded(log.id, false);
    await model.setExpanded(log.id, true);
    expect(model.selection()).toBe(selection);
  });

  it("labels the frames of a _webSocketMessages array with direction, kind and size", async () => {
    const { source, root } = fakeEngine({
      _webSocketMessages: [{ type: "send" }, { type: "receive" }],
    });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const frames = model.view().find((row) => row.name === "_webSocketMessages")!;
    await model.setExpanded(frames.id, true);
    // The labels arrive after the rows.
    await model.idle();
    const rows = model
      .view()
      .slice(2)
      .map((row) => row.value);
    expect(rows).toEqual(["↑ send · text · 12 B · frame 0", "↓ receive · text · 13 B · frame 1"]);
  });

  it("filters rows to exact hits plus ancestors and restores full tree when toggled off", async () => {
    const { source, root } = fakeEngine({
      alpha: { matchKey: "needle", sibling: "noise" },
      beta: { deep: "other" },
    });
    const model = new TreeModel(source, root);
    await model.setExpanded(model.rootId, true);
    await show(model);
    const alpha = model.view().find((row) => row.name === "alpha")!;
    const beta = model.view().find((row) => row.name === "beta")!;
    await model.setExpanded(alpha.id, true);
    await model.setExpanded(beta.id, true);
    await show(model);

    const fullRows = model.view();
    expect(fullRows.length).toBe(6); // root, alpha, matchKey, sibling, beta, deep

    const matchRow = fullRows.find((row) => row.name === "matchKey")!;
    model.setMatchFilter(new Set([matchRow.id]));
    const filtered = model.view();
    expect(filtered.map((row) => row.name)).toEqual(["root", "alpha", "matchKey"]);
    expect(filtered.length).toBe(3); // 1 hit + 2 ancestors

    model.setMatchFilter(null);
    expect(model.view().length).toBe(6);
  });
});
