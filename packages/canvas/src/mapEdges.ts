/**
 * The map's edges: a row of a parent links to the node it opened. An
 * ordinary parent stacks its children in one column next to it, and a
 * curve reaches each of them across the empty gap. A parent whose children
 * wrap into several columns (`layoutMapTree`) routes its edges through the
 * empty space instead, so no edge crosses a card: out of the row to a trunk
 * in the gap beside the parent, up to a bus just above the block, along the
 * bus to the gutter before the child's column, down the gutter, and into the
 * child's left side. Edges to one parent share the trunk and the bus, which
 * reads as one tidy bundle.
 */
import type { Box, Point } from "./geometry.ts";
import { MAP_COLUMN_GAP, MAP_SIBLING_GAP } from "./mapLayout.ts";

/** Where a wrapped parent's edges run: its trunk's x and its bus's y, in world units. */
export interface EdgeGutters {
  readonly trunkX: number;
  readonly busY: number;
}

/**
 * The gutters a parent's edges use, or null when its children sit in one
 * column (the curve is clear then). `children` are the boxes of the nodes
 * the parent opened.
 */
export function edgeGuttersFor(parent: Box, children: ReadonlyArray<Box>): EdgeGutters | null {
  if (children.length < 2) return null;
  const first = children[0] as Box;
  if (children.every((child) => Math.abs(child.x - first.x) < 1)) return null;
  let top = first.y;
  for (const child of children) top = Math.min(top, child.y);
  return {
    trunkX: parent.x + parent.width + MAP_COLUMN_GAP / 2,
    busY: top - MAP_SIBLING_GAP / 2,
  };
}

/** The SVG path of one edge, from a parent's row (`from`) to its child's header (`to`). */
export function edgePath(from: Point, to: Point, gutters: EdgeGutters | null): string {
  if (gutters === null) {
    const midX = (from.x + to.x) / 2;
    return `M${from.x} ${from.y}C${midX} ${from.y} ${midX} ${to.y} ${to.x} ${to.y}`;
  }
  const gutterX = to.x - MAP_COLUMN_GAP / 2;
  const { trunkX, busY } = gutters;
  // The first column's gutter is the trunk itself.
  if (Math.abs(gutterX - trunkX) < 1) {
    return `M${from.x} ${from.y}H${trunkX}V${to.y}H${to.x}`;
  }
  return `M${from.x} ${from.y}H${trunkX}V${busY}H${gutterX}V${to.y}H${to.x}`;
}
