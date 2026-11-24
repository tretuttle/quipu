/**
 * Element geometry and the precise hit tests. The broad phase is the spatial
 * index; these run on the handful of candidates it returns. Filled shapes hit
 * on their interior plus a stroke threshold, open strokes on stroke distance
 * only, so a box-shaped hit never grabs the wrong arrow in a bundle.
 */
import { getStroke } from "perfect-freehand";

import {
  boxCenter,
  boxContainsPoint,
  diamondVertices,
  distanceToEllipseOutline,
  distanceToPolygonOutline,
  distanceToPolyline,
  ellipseRadiusAt,
  pointInPolygon,
  rotatePoint,
  rotatedBoxBounds,
  boxFromPoints,
  type Box,
  type Point,
} from "./geometry.ts";
import {
  isLinearElement,
  type Element,
  type FrameElement,
  type FreehandElement,
  type LinearElement,
} from "./elements.ts";

/**
 * The element's unrotated box in world coordinates. A line, arrow or stroke
 * keeps `x`/`y` at its first point and its other points may go negative, so
 * its box is the extent of its points.
 */
export function elementBox(element: Element): Box {
  if (isLinearElement(element) || element.type === "freehand") {
    const extent = boxFromPoints(element.points.map(([px, py]) => ({ x: px, y: py })));
    if (extent === null) return { x: element.x, y: element.y, width: 0, height: 0 };
    return {
      x: element.x + extent.x,
      y: element.y + extent.y,
      width: extent.width,
      height: extent.height,
    };
  }
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

/** A frame's name is drawn in this size, in the band just above the frame. */
export const FRAME_LABEL_FONT_SIZE = 14;
const FRAME_LABEL_BAND = 20;

/** Where a frame's name sits: the band above its top edge, as wide as the frame. */
export function frameLabelBox(frame: FrameElement): Box {
  const box = elementBox(frame);
  return { x: box.x, y: box.y - FRAME_LABEL_BAND, width: box.width, height: FRAME_LABEL_BAND };
}

/** The axis-aligned box around the element after rotation: what the index stores. */
export function elementBounds(element: Element): Box {
  return rotatedBoxBounds(elementBox(element), element.angle);
}

/** A linear element's points in world coordinates. */
export function linearWorldPoints(element: LinearElement): Point[] {
  const center = boxCenter(elementBox(element));
  return element.points.map(([px, py]) =>
    rotatePoint({ x: element.x + px, y: element.y + py }, center, element.angle),
  );
}

/** The freehand base size in world units for a stroke width. */
export function freehandSize(strokeWidth: number): number {
  return strokeWidth * 3;
}

/** The outline polygon perfect-freehand builds for a stroke, in world coordinates. */
function freehandOutline(element: FreehandElement): Point[] {
  const outline = getStroke(
    element.points.map(([px, py, pressure]) => [px, py, pressure]),
    {
      size: freehandSize(element.style.strokeWidth),
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: element.simulatePressure,
      last: true,
    },
  );
  const center = boxCenter(elementBox(element));
  return outline.map(([ox, oy]) =>
    rotatePoint({ x: element.x + (ox ?? 0), y: element.y + (oy ?? 0) }, center, element.angle),
  );
}

/** Moves a point into the element's unrotated frame. */
function toLocal(element: Element, p: Point): Point {
  if (element.angle === 0) return p;
  return rotatePoint(p, boxCenter(elementBox(element)), -element.angle);
}

function hasFill(element: Element): boolean {
  return element.style.fill !== "none";
}

/**
 * True when `p` is on the element: within `threshold` world units of its
 * outline, or inside it when the element is filled (or is text, a note, a
 * frame or an image, which read as solid).
 */
export function hitElement(element: Element, p: Point, threshold: number): boolean {
  if (element.isDeleted) return false;
  const box = elementBox(element);
  switch (element.type) {
    case "rectangle": {
      const local = toLocal(element, p);
      const solid = hasFill(element);
      if (solid) return boxContainsPoint(box, local, threshold);
      if (!boxContainsPoint(box, local, threshold)) return false;
      const corners = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      ];
      return distanceToPolygonOutline(local, corners) <= threshold;
    }
    case "note":
    case "frame":
    case "image":
    case "text": {
      return boxContainsPoint(box, toLocal(element, p), threshold);
    }
    case "ellipse": {
      const local = toLocal(element, p);
      if (hasFill(element) && ellipseRadiusAt(box, local) <= 1) return true;
      return distanceToEllipseOutline(box, local) <= threshold;
    }
    case "diamond": {
      const local = toLocal(element, p);
      const vertices = diamondVertices(box);
      if (hasFill(element) && pointInPolygon(local, vertices)) return true;
      return distanceToPolygonOutline(local, vertices) <= threshold;
    }
    case "line":
    case "arrow": {
      const points = linearWorldPoints(element);
      if (hasFill(element) && points.length > 2 && pointInPolygon(p, points)) return true;
      return distanceToPolyline(p, points) <= threshold;
    }
    case "freehand": {
      const outline = freehandOutline(element);
      if (outline.length < 3) {
        return distanceToPolyline(p, outline) <= threshold;
      }
      return pointInPolygon(p, outline) || distanceToPolygonOutline(p, outline) <= threshold;
    }
  }
}

/**
 * True when `p` is inside the element's own (rotated) box plus `threshold`,
 * whatever the fill. Selected elements drag from anywhere inside their box,
 * and a hollow box is the fallback hit when nothing else is under the pointer.
 */
export function hitElementBox(element: Element, p: Point, threshold: number): boolean {
  if (element.isDeleted) return false;
  return boxContainsPoint(elementBox(element), toLocal(element, p), threshold);
}

/**
 * The point on the element's outline where a ray from its center toward
 * `toward` leaves it, used to land an arrow end on a shape's edge.
 */
export function outlinePointToward(element: Element, toward: Point, gap: number): Point {
  const box = elementBox(element);
  const center = boxCenter(box);
  const local = toLocal(element, toward);
  const dx = local.x - center.x;
  const dy = local.y - center.y;
  if (dx === 0 && dy === 0) return toward;
  const halfW = box.width / 2 + gap;
  const halfH = box.height / 2 + gap;
  let t: number;
  switch (element.type) {
    case "ellipse": {
      if (halfW === 0 || halfH === 0) return toward;
      const nx = dx / halfW;
      const ny = dy / halfH;
      t = 1 / Math.sqrt(nx * nx + ny * ny);
      break;
    }
    case "diamond": {
      // |dx|/halfW + |dy|/halfH = 1 on the outline.
      const denominator = Math.abs(dx) / halfW + Math.abs(dy) / halfH;
      t = denominator === 0 ? 1 : 1 / denominator;
      break;
    }
    default: {
      const tx = dx === 0 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx);
      const ty = dy === 0 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy);
      t = Math.min(tx, ty);
    }
  }
  const edge = { x: center.x + dx * t, y: center.y + dy * t };
  return rotatePoint(edge, center, element.angle);
}
