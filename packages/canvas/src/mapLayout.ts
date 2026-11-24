/**
 * The map's tree layout: left to right, one column per depth of expansion,
 * children stacked under their parent's top. Every placement is a function of
 * the tree in traversal order, so expanding or collapsing a node moves only
 * that node's subtree and the subtrees of its ancestors' later siblings; every
 * node before them in reading order keeps its position, so arrows and notes
 * bound to nodes stay where the user left them.
 *
 * Nothing here parses a document or touches the DOM: the caller measures each
 * node (width, height, and the offset of the row a child hangs from) and gets
 * positions back. Both passes are linear and iterative, so a deeply expanded
 * document cannot overflow the stack.
 */
import type { Box, Point } from "./geometry.ts";

/** Horizontal distance between a node's right edge and its children's left edge. */
export const MAP_COLUMN_GAP = 72;
/** Vertical distance between two sibling subtrees. */
export const MAP_SIBLING_GAP = 24;

export interface MapLayoutNode {
  readonly id: string;
  /** The parent's id, or null for a root. Children keep the order they arrive in. */
  readonly parentId: string | null;
  readonly width: number;
  readonly height: number;
  /**
   * Where this node's edge leaves its parent, as an offset from the parent's
   * top: the row that names it. A child is placed at or below that offset.
   */
  readonly anchor: number;
}

export interface MapLayout {
  /** Top-left world position per node id. */
  readonly positions: ReadonlyMap<string, Point>;
  /** The box around every node, or null for an empty tree. */
  readonly bounds: Box | null;
}

/** What changed between two layouts: the caller applies this instead of a full copy. */
export interface MapLayoutPatch {
  readonly moved: ReadonlyMap<string, Point>;
  readonly removed: ReadonlyArray<string>;
}

interface Indexed {
  readonly order: number[];
  readonly children: Map<number, number[]>;
  readonly roots: number[];
}

/** Depth-first order with each node's children in input order. */
function indexTree(nodes: ReadonlyArray<MapLayoutNode>): Indexed {
  const byId = new Map<string, number>();
  nodes.forEach((node, i) => byId.set(node.id, i));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  nodes.forEach((node, i) => {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent === undefined) {
      roots.push(i);
      return;
    }
    const list = children.get(parent);
    if (list) list.push(i);
    else children.set(parent, [i]);
  });
  const order: number[] = [];
  const stack = roots.toReversed();
  while (stack.length > 0) {
    const i = stack.pop() as number;
    order.push(i);
    const list = children.get(i);
    if (list) for (let c = list.length - 1; c >= 0; c--) stack.push(list[c] as number);
  }
  return { order, children, roots };
}

/**
 * A parent whose children stack taller than this wraps them into columns, so
 * an expanded list draws as a block rather than a hairline at a far zoom.
 */
export const MAP_WRAP_HEIGHT = 4000;
/** Columns of wrapped children aim at a block this many times wider than tall (screens are wide). */
const WRAP_ASPECT = 1.6;

/**
 * Places every node. Roots are stacked at x = 0 like siblings; a child column
 * starts `MAP_COLUMN_GAP` right of its parent's right edge. Children stack
 * from the row that names them; when they would stack taller than
 * {@link MAP_WRAP_HEIGHT} they fill several columns side by side instead, in
 * order, each column as tall as makes the block about as wide as a screen.
 */
export function layoutMapTree(nodes: ReadonlyArray<MapLayoutNode>): MapLayout {
  const { order, children, roots } = indexTree(nodes);
  const subtreeHeight = new Float64Array(nodes.length);
  const subtreeWidth = new Float64Array(nodes.length);
  // Each child's offset from its parent's top-left, decided bottom-up.
  const offsetX = new Float64Array(nodes.length);
  const offsetY = new Float64Array(nodes.length);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k] as number;
    const node = nodes[i] as MapLayoutNode;
    const list = children.get(i);
    let blockHeight = 0;
    let blockWidth = 0;
    if (list && list.length > 0) {
      const childX = node.width + MAP_COLUMN_GAP;
      // One column, children dropped to the rows that name them.
      let cursor = 0;
      let widest = 0;
      for (const c of list) {
        cursor = Math.max(cursor, (nodes[c] as MapLayoutNode).anchor);
        cursor += (subtreeHeight[c] as number) + MAP_SIBLING_GAP;
        widest = Math.max(widest, subtreeWidth[c] as number);
      }
      const stacked = cursor - MAP_SIBLING_GAP;
      if (stacked <= MAP_WRAP_HEIGHT || list.length < 2) {
        cursor = 0;
        for (const c of list) {
          cursor = Math.max(cursor, (nodes[c] as MapLayoutNode).anchor);
          offsetX[c] = childX;
          offsetY[c] = cursor;
          cursor += (subtreeHeight[c] as number) + MAP_SIBLING_GAP;
        }
        blockHeight = stacked;
        blockWidth = widest;
      } else {
        // Wrapped: columns of children from the first child's row, filled in order.
        const top = (nodes[list[0] as number] as MapLayoutNode).anchor;
        const columns = Math.max(
          1,
          Math.round(Math.sqrt((WRAP_ASPECT * stacked) / (widest + MAP_COLUMN_GAP))),
        );
        const target = Math.max(MAP_WRAP_HEIGHT, stacked / columns);
        let x = childX;
        let y = top;
        let columnWidth = 0;
        for (const c of list) {
          const height = subtreeHeight[c] as number;
          if (y > top && y + height > top + target) {
            x += columnWidth + MAP_COLUMN_GAP;
            y = top;
            columnWidth = 0;
          }
          offsetX[c] = x;
          offsetY[c] = y;
          y += height + MAP_SIBLING_GAP;
          columnWidth = Math.max(columnWidth, subtreeWidth[c] as number);
          blockHeight = Math.max(blockHeight, y - MAP_SIBLING_GAP);
        }
        blockWidth = x + columnWidth - childX;
      }
    }
    subtreeHeight[i] = Math.max(node.height, blockHeight);
    subtreeWidth[i] = blockWidth > 0 ? node.width + MAP_COLUMN_GAP + blockWidth : node.width;
  }
  // Top-down: roots stack at x = 0; every child sits at its offset from its parent.
  const positions = new Map<string, Point>();
  const lefts = new Float64Array(nodes.length);
  const tops = new Float64Array(nodes.length);
  let rootCursor = 0;
  for (const r of roots) {
    lefts[r] = 0;
    tops[r] = rootCursor;
    rootCursor += (subtreeHeight[r] as number) + MAP_SIBLING_GAP;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const i of order) {
    const node = nodes[i] as MapLayoutNode;
    const x = lefts[i] as number;
    const top = tops[i] as number;
    positions.set(node.id, { x, y: top });
    minX = Math.min(minX, x);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, x + node.width);
    maxY = Math.max(maxY, top + node.height);
    for (const c of children.get(i) ?? []) {
      lefts[c] = x + (offsetX[c] as number);
      tops[c] = top + (offsetY[c] as number);
    }
  }
  const bounds =
    nodes.length === 0 ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  return { positions, bounds };
}

/** The positions that differ from `previous`, and the ids that are gone. */
export function diffMapLayout(
  previous: ReadonlyMap<string, Point> | null,
  next: ReadonlyMap<string, Point>,
): MapLayoutPatch {
  const moved = new Map<string, Point>();
  for (const [id, point] of next) {
    const before = previous?.get(id);
    if (!before || before.x !== point.x || before.y !== point.y) moved.set(id, point);
  }
  const removed: string[] = [];
  if (previous) for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
  return { moved, removed };
}
