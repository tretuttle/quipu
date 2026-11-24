import { describe, expect, it } from "@effect/vitest";

import type { Box, Point } from "./geometry.ts";
import { edgeGuttersFor, edgePath } from "./mapEdges.ts";
import { layoutMapTree, MAP_COLUMN_GAP, type MapLayoutNode } from "./mapLayout.ts";

const ROW = 20;
const HEADER = 28;
const node = (id: string, parentId: string | null, rows: number, anchorRow = 0): MapLayoutNode => ({
  id,
  parentId,
  width: 160,
  height: HEADER + rows * ROW,
  anchor: HEADER + anchorRow * ROW,
});

/** The corners of an `M x y H x V y …` path. */
function corners(path: string): Point[] {
  const points: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  for (const [, command, args] of path.matchAll(/([MHV])([^MHVC]+)/g)) {
    const values = (args as string).trim().split(/\s+/).map(Number);
    if (command === "M") at = { x: values[0]!, y: values[1]! };
    else if (command === "H") at = { x: values[0]!, y: at.y };
    else at = { x: at.x, y: values[0]! };
    points.push(at);
  }
  return points;
}

/** Points along a polyline every few units, for testing against boxes. */
function along(points: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let s = 0; s <= steps; s += 1) {
      out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
    }
  }
  return out;
}

const inside = (p: Point, box: Box) =>
  p.x > box.x + 1 && p.x < box.x + box.width - 1 && p.y > box.y + 1 && p.y < box.y + box.height - 1;

/** A parent with 40 children, wrapped into columns by the layout, and every edge's path. */
function wrappedTree() {
  const tree: MapLayoutNode[] = [node("root", null, 40)];
  for (let i = 0; i < 40; i += 1) tree.push(node(`c${i}`, "root", 6, i));
  const { positions } = layoutMapTree(tree);
  const boxes = new Map(
    tree.map((n) => [n.id, { ...positions.get(n.id)!, width: n.width, height: n.height }]),
  );
  const parent = boxes.get("root")!;
  const children = tree.slice(1).map((n) => boxes.get(n.id)!);
  return { tree, boxes, parent, children };
}

describe("map edges", () => {
  it("routes a wrapped parent's edges through the gutters, never across a card", () => {
    const { tree, boxes, parent, children } = wrappedTree();
    expect(new Set(children.map((c) => c.x)).size).toBeGreaterThan(1);
    const gutters = edgeGuttersFor(parent, children);
    expect(gutters).not.toBeNull();
    for (const [i, child] of children.entries()) {
      const from = { x: parent.x + parent.width, y: parent.y + HEADER + i * ROW + ROW / 2 };
      const to = { x: child.x, y: child.y + HEADER / 2 };
      const path = edgePath(from, to, gutters);
      const points = corners(path);
      // Axis-aligned, from the row to the child's left side.
      expect(points[0]).toEqual(from);
      expect(points.at(-1)).toEqual(to);
      for (const point of along(points)) {
        for (const n of tree)
          expect(inside(point, boxes.get(n.id)!), `c${i} crosses ${n.id}`).toBe(false);
      }
      // Its vertical run is the gutter just before its own column.
      expect(points.at(-2)?.x).toBe(child.x - MAP_COLUMN_GAP / 2);
    }
  });

  it("keeps the curve for children in one column", () => {
    const parent = { x: 0, y: 0, width: 160, height: 100 };
    const children = [
      { x: 232, y: 28, width: 160, height: 60 },
      { x: 232, y: 112, width: 160, height: 60 },
    ];
    expect(edgeGuttersFor(parent, children)).toBeNull();
    expect(edgePath({ x: 160, y: 38 }, { x: 232, y: 42 }, null)).toMatch(/^M160 38C/);
  });

  it("would cross cards with straight curves, which is why wrapped blocks are routed", () => {
    const { tree, boxes, parent, children } = wrappedTree();
    let crossings = 0;
    for (const [i, child] of children.entries()) {
      const from = { x: parent.x + parent.width, y: parent.y + HEADER + i * ROW + ROW / 2 };
      const to = { x: child.x, y: child.y + HEADER / 2 };
      // The plain curve, sampled as a straight chord between its ends.
      for (const point of along([from, to])) {
        if (tree.some((n) => inside(point, boxes.get(n.id)!))) crossings += 1;
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });
});
