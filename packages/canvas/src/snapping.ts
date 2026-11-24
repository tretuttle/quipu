/**
 * Snapping while a selection moves or resizes: to the grid when it is on,
 * to the edges and centers of visible, unselected boxes, and to equal gaps
 * between the nearest visible boxes on an axis. Candidates come from the
 * spatial index for the viewport only, so the cost stays bounded.
 */
import { snapToGrid, type Box } from "./geometry.ts";

/** Excalidraw's snap distance, in screen pixels; divided by zoom at the call site. */
export const SNAP_DISTANCE_PX = 8;
export const GRID_SIZE = 20;

export interface SnapGuide {
  readonly axis: "x" | "y";
  /** The world coordinate the guide sits on. */
  readonly at: number;
  /** The extent along the other axis the guide should span. */
  readonly from: number;
  readonly to: number;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly guides: ReadonlyArray<SnapGuide>;
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] };

function boxLines(box: Box, axis: "x" | "y"): number[] {
  return axis === "x"
    ? [box.x, box.x + box.width / 2, box.x + box.width]
    : [box.y, box.y + box.height / 2, box.y + box.height];
}

interface AxisSnap {
  readonly delta: number;
  readonly guide: SnapGuide;
}

function snapAxis(
  moving: Box,
  candidates: ReadonlyArray<Box>,
  axis: "x" | "y",
  threshold: number,
): AxisSnap | null {
  let best: AxisSnap | null = null;
  const movingLines = boxLines(moving, axis);
  for (const candidate of candidates) {
    const otherLines = boxLines(candidate, axis);
    for (const line of otherLines) {
      for (const movingLine of movingLines) {
        const delta = line - movingLine;
        if (Math.abs(delta) > threshold) continue;
        if (best !== null && Math.abs(delta) >= Math.abs(best.delta)) continue;
        const from =
          axis === "x" ? Math.min(moving.y, candidate.y) : Math.min(moving.x, candidate.x);
        const to =
          axis === "x"
            ? Math.max(moving.y + moving.height, candidate.y + candidate.height)
            : Math.max(moving.x + moving.width, candidate.x + candidate.width);
        best = { delta, guide: { axis, at: line, from, to } };
      }
    }
  }
  return best;
}

/**
 * Equal-gap snap on one axis: when the moving box would sit between two
 * candidates, nudge it so both gaps match; or beside one candidate at the
 * same gap that candidate keeps to its neighbor.
 */
function snapGaps(
  moving: Box,
  candidates: ReadonlyArray<Box>,
  axis: "x" | "y",
  threshold: number,
): AxisSnap | null {
  const start = (b: Box) => (axis === "x" ? b.x : b.y);
  const size = (b: Box) => (axis === "x" ? b.width : b.height);
  const end = (b: Box) => start(b) + size(b);
  const overlapsCross = (a: Box, b: Box) =>
    axis === "x"
      ? a.y < b.y + b.height && b.y < a.y + a.height
      : a.x < b.x + b.width && b.x < a.x + a.width;
  const sorted = candidates
    .filter((c) => overlapsCross(c, moving))
    .sort((a, b) => start(a) - start(b));
  let best: AxisSnap | null = null;
  const consider = (delta: number, at: number, reference: Box) => {
    if (Math.abs(delta) > threshold) return;
    if (best !== null && Math.abs(delta) >= Math.abs(best.delta)) return;
    const from = axis === "x" ? Math.min(moving.y, reference.y) : Math.min(moving.x, reference.x);
    const to =
      axis === "x"
        ? Math.max(moving.y + moving.height, reference.y + reference.height)
        : Math.max(moving.x + moving.width, reference.x + reference.width);
    best = { delta, guide: { axis, at, from, to } };
  };
  // Between two candidates: center the gap.
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (!left || !right) continue;
    const space = start(right) - end(left);
    if (space <= size(moving)) continue;
    const gap = (space - size(moving)) / 2;
    const target = end(left) + gap;
    consider(target - start(moving), target, left);
  }
  // Beside a pair: repeat their gap.
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (!left || !right) continue;
    const gap = start(right) - end(left);
    if (gap < 0) continue;
    const after = end(right) + gap;
    consider(after - start(moving), after, right);
    const before = start(left) - gap - size(moving);
    consider(before - start(moving), before, left);
  }
  return best;
}

export interface SnapOptions {
  readonly grid: boolean;
  /** World units: `SNAP_DISTANCE_PX / camera.k`. */
  readonly threshold: number;
  /** Boxes of visible, unselected elements. */
  readonly candidates: ReadonlyArray<Box>;
}

/** The nudge that snaps `moving` (the selection's box after the raw delta). */
export function snapBox(moving: Box, options: SnapOptions): SnapResult {
  if (options.grid) {
    return {
      dx: snapToGrid(moving.x, GRID_SIZE) - moving.x,
      dy: snapToGrid(moving.y, GRID_SIZE) - moving.y,
      guides: [],
    };
  }
  if (options.candidates.length === 0) return NO_SNAP;
  const x =
    snapAxis(moving, options.candidates, "x", options.threshold) ??
    snapGaps(moving, options.candidates, "x", options.threshold);
  const y =
    snapAxis(moving, options.candidates, "y", options.threshold) ??
    snapGaps(moving, options.candidates, "y", options.threshold);
  const guides: SnapGuide[] = [];
  if (x) guides.push(x.guide);
  if (y) guides.push(y.guide);
  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides };
}
