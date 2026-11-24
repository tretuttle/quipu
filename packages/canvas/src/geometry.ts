/**
 * Plain geometry over world coordinates: points, boxes, rotation and the
 * distance tests hit testing needs. No DOM, no element types.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned box, `x`/`y` at the top-left, extents never negative. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** A box from any two corners, so a drag in either direction yields positive extents. */
export function boxFromCorners(a: Point, b: Point): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function boxCenter(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function boxContainsPoint(box: Box, p: Point, slop = 0): boolean {
  return (
    p.x >= box.x - slop &&
    p.x <= box.x + box.width + slop &&
    p.y >= box.y - slop &&
    p.y <= box.y + box.height + slop
  );
}

/** True when `inner` sits wholly inside `outer` (edges may touch). */
export function boxContainsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function expandBox(box: Box, margin: number): Box {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };
}

/** The smallest box around every box given; null for an empty list. */
export function unionBoxes(boxes: ReadonlyArray<Box>): Box | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (minX === Number.POSITIVE_INFINITY) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boxFromPoints(points: ReadonlyArray<Point>): Box | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Rotates `p` about `center` by `angle` radians (positive is clockwise on screen). */
export function rotatePoint(p: Point, center: Point, angle: number): Point {
  if (angle === 0) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** The four corners of a box after rotation about its center. */
export function rotatedBoxCorners(box: Box, angle: number): [Point, Point, Point, Point] {
  const c = boxCenter(box);
  return [
    rotatePoint({ x: box.x, y: box.y }, c, angle),
    rotatePoint({ x: box.x + box.width, y: box.y }, c, angle),
    rotatePoint({ x: box.x + box.width, y: box.y + box.height }, c, angle),
    rotatePoint({ x: box.x, y: box.y + box.height }, c, angle),
  ];
}

/** The axis-aligned box around a rotated box. */
export function rotatedBoxBounds(box: Box, angle: number): Box {
  if (angle === 0) return box;
  return boxFromPoints(rotatedBoxCorners(box, angle)) ?? box;
}

/** Distance from `p` to the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Distance from `p` to the nearest segment of a polyline. */
export function distanceToPolyline(p: Point, points: ReadonlyArray<Point>): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  const first = points[0];
  if (points.length === 1 || first === undefined) return first ? distance(p, first) : Infinity;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    best = Math.min(best, distanceToSegment(p, a, b));
  }
  return best;
}

/** Even-odd test for a closed polygon. */
export function pointInPolygon(p: Point, polygon: ReadonlyArray<Point>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from `p` to the closed outline of a polygon. */
export function distanceToPolygonOutline(p: Point, polygon: ReadonlyArray<Point>): number {
  if (polygon.length === 0) return Number.POSITIVE_INFINITY;
  const first = polygon[0];
  if (first === undefined) return Number.POSITIVE_INFINITY;
  return distanceToPolyline(p, [...polygon, first]);
}

/**
 * Signed "radius" of `p` relative to an ellipse inscribed in `box`: 1 on the
 * outline, less inside. Angle is handled by the caller.
 */
export function ellipseRadiusAt(box: Box, p: Point): number {
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx === 0 || ry === 0) return Number.POSITIVE_INFINITY;
  const c = boxCenter(box);
  const nx = (p.x - c.x) / rx;
  const ny = (p.y - c.y) / ry;
  return Math.sqrt(nx * nx + ny * ny);
}

/**
 * Distance from `p` to an ellipse outline. The nearest point is the root of a
 * function that is monotone on the bracket the point gives, so bisection finds
 * the global nearest point for any aspect ratio, where a Newton step can settle
 * on the far vertex. The point is measured from the center first, so large
 * world coordinates do not cost precision.
 */
export function distanceToEllipseOutline(box: Box, p: Point): number {
  const a = box.width / 2;
  const b = box.height / 2;
  if (a === 0 || b === 0) return distanceToSegment(p, { x: box.x, y: box.y }, boxBottomRight(box));
  const c = boxCenter(box);
  // Symmetry: solve in the first quadrant, with the major axis along x.
  const dx = Math.abs(p.x - c.x);
  const dy = Math.abs(p.y - c.y);
  return a >= b ? quadrantEllipseDistance(a, b, dx, dy) : quadrantEllipseDistance(b, a, dy, dx);
}

/** Distance from (y0, y1), both non-negative, to the ellipse with semi-axes e0 >= e1 > 0. */
function quadrantEllipseDistance(e0: number, e1: number, y0: number, y1: number): number {
  if (y1 > 0) {
    if (y0 === 0) return Math.abs(y1 - e1);
    const z0 = y0 / e0;
    const z1 = y1 / e1;
    const g = z0 * z0 + z1 * z1 - 1;
    if (g === 0) return 0;
    const r0 = (e0 / e1) * (e0 / e1);
    const s = ellipseRoot(r0, z0, z1, g);
    const x0 = (r0 * y0) / (s + r0);
    const x1 = y1 / (s + 1);
    return Math.hypot(x0 - y0, x1 - y1);
  }
  // On the major axis: the nearest point is off-axis only inside the evolute's cusp.
  const numerator = e0 * y0;
  const denominator = e0 * e0 - e1 * e1;
  if (numerator < denominator) {
    const t = numerator / denominator;
    return Math.hypot(e0 * t - y0, e1 * Math.sqrt(1 - t * t));
  }
  return Math.abs(y0 - e0);
}

/** The root `s` of (r0 z0 / (s + r0))^2 + (z1 / (s + 1))^2 = 1, by bisection on its bracket. */
function ellipseRoot(r0: number, z0: number, z1: number, g: number): number {
  const n0 = r0 * z0;
  let s0 = z1 - 1;
  let s1 = g < 0 ? 0 : Math.hypot(n0, z1) - 1;
  let s = 0;
  // Each step halves the bracket; it stops once the midpoint cannot move.
  for (let i = 0; i < 1100; i += 1) {
    s = (s0 + s1) / 2;
    if (s === s0 || s === s1) break;
    const ratio0 = n0 / (s + r0);
    const ratio1 = z1 / (s + 1);
    const value = ratio0 * ratio0 + ratio1 * ratio1 - 1;
    if (value > 0) s0 = s;
    else if (value < 0) s1 = s;
    else break;
  }
  return s;
}

function boxBottomRight(box: Box): Point {
  return { x: box.x + box.width, y: box.y + box.height };
}

/** The diamond inscribed in a box: its four vertices in clockwise order. */
export function diamondVertices(box: Box): [Point, Point, Point, Point] {
  const c = boxCenter(box);
  return [
    { x: c.x, y: box.y },
    { x: box.x + box.width, y: c.y },
    { x: c.x, y: box.y + box.height },
    { x: box.x, y: c.y },
  ];
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}
