import { describe, expect, it } from "@effect/vitest";

import {
  diffMapLayout,
  layoutMapTree,
  MAP_COLUMN_GAP,
  MAP_SIBLING_GAP,
  MAP_WRAP_HEIGHT,
  type MapLayoutNode,
} from "./mapLayout.ts";

const ROW = 20;
const node = (id: string, parentId: string | null, rows: number, anchorRow = 0): MapLayoutNode => ({
  id,
  parentId,
  width: 160,
  height: 28 + rows * ROW,
  anchor: 28 + anchorRow * ROW,
});

describe("the map layout", () => {
  it("puts children one column right of their parent, stacked from the row that names them", () => {
    const tree = [
      node("root", null, 3),
      node("a", "root", 2, 0),
      node("b", "root", 1, 1),
      node("c", "root", 5, 2),
    ];
    const { positions, bounds } = layoutMapTree(tree);
    expect(positions.get("root")).toEqual({ x: 0, y: 0 });
    const columnX = 160 + MAP_COLUMN_GAP;
    expect(positions.get("a")).toEqual({ x: columnX, y: 28 });
    // b's row is at 48 but a's subtree ends at 28 + 68 = 96, so b stacks below it.
    expect(positions.get("b")).toEqual({ x: columnX, y: 28 + 68 + MAP_SIBLING_GAP });
    expect(positions.get("c")?.x).toBe(columnX);
    expect(positions.get("c")?.y).toBe(28 + 68 + MAP_SIBLING_GAP + 48 + MAP_SIBLING_GAP);
    expect(bounds).toEqual({
      x: 0,
      y: 0,
      width: columnX + 160,
      height: (positions.get("c")?.y ?? 0) + 28 + 5 * ROW,
    });
  });

  it("drops a child to its row when the rows above it leave room", () => {
    const tree = [node("root", null, 10), node("late", "root", 1, 7)];
    const { positions } = layoutMapTree(tree);
    expect(positions.get("late")).toEqual({ x: 160 + MAP_COLUMN_GAP, y: 28 + 7 * ROW });
  });

  it("keeps every node before an expanded one in place, and shifts only what follows", () => {
    const before = [
      node("root", null, 4),
      node("a", "root", 2, 0),
      node("b", "root", 2, 1),
      node("c", "root", 2, 2),
      node("d", "root", 2, 3),
    ];
    const first = layoutMapTree(before);
    // Expanding b adds a tall subtree under it.
    const after = [
      ...before.slice(0, 3),
      node("b1", "b", 10, 0),
      node("b2", "b", 10, 1),
      ...before.slice(3),
    ];
    const second = layoutMapTree(after);
    for (const id of ["root", "a", "b"]) {
      expect(second.positions.get(id), id).toEqual(first.positions.get(id));
    }
    // b's subtree: its header row (28), b1, a gap, b2; it was b's own 68 before.
    const grew = 28 + (28 + 10 * ROW) + MAP_SIBLING_GAP + (28 + 10 * ROW) - (28 + 2 * ROW);
    expect(second.positions.get("c")?.y).toBe((first.positions.get("c")?.y ?? 0) + grew);
    expect(second.positions.get("d")?.y).toBe((first.positions.get("d")?.y ?? 0) + grew);
    expect(second.positions.get("b1")).toEqual({
      x: 2 * (160 + MAP_COLUMN_GAP),
      y: (first.positions.get("b")?.y ?? 0) + 28,
    });
    const patch = diffMapLayout(first.positions, second.positions);
    expect([...patch.moved.keys()].toSorted()).toEqual(["b1", "b2", "c", "d"]);
    expect(patch.removed).toEqual([]);
    // Collapsing b again restores the first layout exactly and names what left.
    const third = layoutMapTree(before);
    expect(third.positions).toEqual(first.positions);
    expect(diffMapLayout(second.positions, third.positions).removed.toSorted()).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("lays out a chain 20 000 levels deep and 50 000 nodes wide without recursion", () => {
    const deep: MapLayoutNode[] = [node("n0", null, 1)];
    for (let i = 1; i < 20_000; i++) deep.push(node(`n${i}`, `n${i - 1}`, 1));
    const chain = layoutMapTree(deep);
    expect(chain.positions.get("n19999")?.x).toBe(19_999 * (160 + MAP_COLUMN_GAP));

    const wide: MapLayoutNode[] = [node("root", null, 50_000)];
    for (let i = 0; i < 50_000; i++) wide.push(node(`c${i}`, "root", 2, i));
    const fan = layoutMapTree(wide);
    expect(fan.positions.size).toBe(50_001);
    // 50 000 children wrap into columns: the block is a rectangle, not a 4.6 million unit column.
    const { width, height } = fan.bounds as { width: number; height: number };
    expect(height).toBeLessThan(100 * 1000 + 28 + 50_000 * ROW);
    expect(width / Math.max(height - 50_000 * ROW, 1)).toBeGreaterThan(0.25);
  });

  it("wraps a long run of siblings into columns, in order, without overlap", () => {
    const tree: MapLayoutNode[] = [node("root", null, 3)];
    for (let i = 0; i < 200; i++) tree.push(node(`c${i}`, "root", 2, 0));
    const { positions, bounds } = layoutMapTree(tree);
    const boxes = Array.from({ length: 200 }, (_, i) => positions.get(`c${i}`)!);
    // The first child keeps its place; the rest fill columns top to bottom, left to right.
    expect(boxes[0]).toEqual({ x: 160 + MAP_COLUMN_GAP, y: 28 });
    for (let i = 1; i < boxes.length; i++) {
      const [a, b] = [boxes[i - 1]!, boxes[i]!];
      expect(b.x > a.x || (b.x === a.x && b.y >= a.y + 68 + MAP_SIBLING_GAP), `c${i}`).toBe(true);
      if (b.x > a.x) expect(b.y).toBe(28);
    }
    // No column runs past the wrap height, and the block is wider than one column.
    for (const box of boxes) expect(box.y + 68).toBeLessThanOrEqual(28 + MAP_WRAP_HEIGHT);
    const columns = new Set(boxes.map((box) => box.x)).size;
    expect(columns).toBeGreaterThan(1);
    expect(bounds?.height).toBeLessThanOrEqual(28 + MAP_WRAP_HEIGHT);
    // A short list does not wrap.
    const short = layoutMapTree(tree.slice(0, 11));
    expect(new Set([...short.positions.values()].map((p) => p.x))).toEqual(
      new Set([0, 160 + MAP_COLUMN_GAP]),
    );
  });

  it("stacks several roots and handles an empty tree", () => {
    expect(layoutMapTree([])).toEqual({ positions: new Map(), bounds: null });
    const { positions } = layoutMapTree([node("x", null, 1), node("y", null, 1)]);
    expect(positions.get("y")).toEqual({ x: 0, y: 48 + MAP_SIBLING_GAP });
  });
});
