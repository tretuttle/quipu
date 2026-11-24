import type { NodeKind, NodeRef, NodeSummary } from "@quipu/contracts/engine";
import { describe, expect, it } from "vite-plus/test";

import { TreeModel, type TreeSource } from "./treeModel.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = ReadonlyArray<string | number>;

const kindOf = (json: Json): NodeKind =>
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

const childrenOf = (json: Json): Array<[string | null, Json]> =>
  Array.isArray(json)
    ? json.map((child) => [null, child])
    : json !== null && typeof json === "object"
      ? Object.entries(json)
      : [];

/**
 * A document the way the engine numbers it across edits: an edit gives the
 * edited node and everything under it new refs (a new tape), and every other
 * node keeps its ref.
 */
class EditedDocument {
  private value: Json;
  private readonly refs = new Map<string, NodeRef>();
  private readonly paths = new Map<string, Path>();
  private tapes = 0;
  private tokens = 0;

  constructor(value: Json) {
    this.value = value;
    this.number([], value, 0);
  }

  private number(path: Path, json: Json, tapeId: number) {
    const ref = { documentId: 1, tapeId, token: this.tokens++ };
    this.refs.set(JSON.stringify(path), ref);
    this.paths.set(`${ref.tapeId}.${ref.token}`, path);
    childrenOf(json).forEach(([key, child], index) =>
      this.number([...path, key ?? index], child, tapeId),
    );
  }

  private at(path: Path): Json {
    let json = this.value;
    for (const step of path) json = (json as Record<string | number, Json>)[step] as Json;
    return json;
  }

  refOf(path: Path) {
    return this.refs.get(JSON.stringify(path)) as NodeRef;
  }

  edit(path: Path, next: Json) {
    const parent = this.at(path.slice(0, -1)) as Record<string | number, Json>;
    parent[path[path.length - 1] as string | number] = next;
    this.number(path, next, ++this.tapes);
  }

  private summary(path: Path): NodeSummary {
    const json = this.at(path);
    return {
      ref: this.refOf(path),
      kind: kindOf(json),
      range: { start: 0, end: 0 },
      span: { start: 0, end: 0 },
      key: typeof path[path.length - 1] === "string" ? 0 : null,
      childCount: childrenOf(json).length,
      childrenIndexed: true,
      settled: true,
    };
  }

  private pathOf(ref: NodeRef) {
    const path = this.paths.get(`${ref.tapeId}.${ref.token}`);
    // A ref under an edited node is dead, as the engine's is.
    if (path === undefined || this.refOf(path).tapeId !== ref.tapeId) throw new Error("dead ref");
    return path;
  }

  readonly source: TreeSource = {
    node: async (ref) => this.summary(this.pathOf(ref)),
    rows: async (ref, from, count) => {
      const path = this.pathOf(ref);
      const children = childrenOf(this.at(path));
      return {
        from,
        total: children.length,
        rows: children.slice(from, from + count).map(([key, child], offset) => {
          const index = from + offset;
          const scalar = kindOf(child) !== "object" && kindOf(child) !== "array";
          const text = typeof child === "string" ? child : JSON.stringify(child);
          return {
            node: this.summary([...path, key ?? index]),
            key,
            preview: scalar ? { text, truncated: false, bytes: text.length } : null,
          };
        }),
      };
    },
    keyText: async () => "",
    text: async () => ({ text: "", truncated: false, bytes: 0 }),
    detect: async () => [],
    decode: async () => {
      throw new Error("nothing decodes");
    },
    frames: async (_ref, from) => ({ from, total: 0, frames: [] }),
  };
}

/** What the tree shows: each row's depth, name, value and whether it is open. */
const shown = (tree: TreeModel) =>
  tree
    .view()
    .map(
      (row) => `${"  ".repeat(row.depth)}${row.name}: ${row.value}${row.expanded ? " (open)" : ""}`,
    );

const idOf = (ref: NodeRef) => `${ref.tapeId}.${ref.token}`;

describe("the tree after an edit", () => {
  const open = async (doc: EditedDocument, paths: ReadonlyArray<Path>) => {
    const tree = new TreeModel(doc.source, await doc.source.node(doc.refOf([])));
    await tree.setExpanded(tree.rootId, true);
    for (const path of paths) await tree.setExpanded(idOf(doc.refOf(path)), true);
    return tree;
  };

  it("lists the edited value, keeps open what is still there, and keeps the edited row open under its new id", async () => {
    const doc = new EditedDocument({ a: { x: 1, y: [1, 2] }, b: { z: true }, c: 5 });
    const tree = await open(doc, [["a"], ["a", "y"], ["b"]]);
    const before = idOf(doc.refOf(["a"]));
    doc.edit(["a"], { x: 2, w: "new" });
    await tree.reload(new Map([[idOf(doc.refOf(["a"])), before]]));
    expect(shown(tree)).toEqual([
      "root: {} 3 keys (open)",
      "  a: {} 2 keys (open)",
      "    x: 2",
      '    w: "new"',
      "  b: {} 1 key (open)",
      "    z: true",
      "  c: 5",
    ]);
  });

  it("closes an edited container it was not told about, and shows a changed scalar", async () => {
    const doc = new EditedDocument({ a: { x: 1 }, list: [10, 20, 30] });
    const tree = await open(doc, [["a"], ["list"]]);
    doc.edit(["a"], { x: 9 });
    doc.edit(["list", 1], 21);
    await tree.reload();
    expect(shown(tree)).toEqual([
      "root: {} 2 keys (open)",
      "  a: {} 1 key",
      "  list: [] 3 items (open)",
      "    0: 10",
      "    1: 21",
      "    2: 30",
    ]);
  });
});
