/**
 * The camera: `screen = k * world + (x, y)`, the d3-zoom transform (ISC math)
 * with Excalidraw's limits. Nothing here schedules a frame.
 */
import { clamp, roundTo, type Box, type Point } from "./geometry.ts";

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** One keyboard or button step. */
export const ZOOM_STEP = 0.1;
/** The wheel delta is capped so a trackpad fling cannot jump across the whole range. */
const MAX_WHEEL_ZOOM_DELTA = ZOOM_STEP * 100;

export const IDENTITY_CAMERA: Camera = { x: 0, y: 0, k: 1 };
/** World units of empty space a fit leaves around the content. */
const FIT_PADDING = 48;
/** No zoom floor goes under this: `roundTo(k, 6)` would collapse it to 0. */
const ZOOM_FLOOR = 1e-6;

/**
 * Clamps a zoom to the camera's range. `minZoom` lowers the floor below
 * `MIN_ZOOM` for content the default range cannot fit (a map with thousands
 * of nodes); it never raises it.
 */
export function normalizeZoom(k: number, minZoom = MIN_ZOOM): number {
  return roundTo(clamp(k, Math.max(ZOOM_FLOOR, Math.min(minZoom, MIN_ZOOM)), MAX_ZOOM), 6);
}

/** The zoom at which `bounds` plus its padding fills the viewport, before any clamp. */
function zoomFitting(bounds: Box, viewport: Viewport, padding = FIT_PADDING): number {
  const width = Math.max(bounds.width + padding * 2, 1);
  const height = Math.max(bounds.height + padding * 2, 1);
  return Math.min(viewport.width / width, viewport.height / height);
}

/** The zoom floor that lets `bounds` fit: `MIN_ZOOM`, or lower when the content needs it. */
export function zoomFloorFor(bounds: Box | null, viewport: Viewport): number {
  return bounds === null ? MIN_ZOOM : Math.min(MIN_ZOOM, zoomFitting(bounds, viewport));
}

export function worldToScreen(camera: Camera, p: Point): Point {
  return { x: p.x * camera.k + camera.x, y: p.y * camera.k + camera.y };
}

export function screenToWorld(camera: Camera, p: Point): Point {
  return { x: (p.x - camera.x) / camera.k, y: (p.y - camera.y) / camera.k };
}

/** The world box the viewport shows. */
export function visibleWorldBox(camera: Camera, viewport: Viewport): Box {
  const topLeft = screenToWorld(camera, { x: 0, y: 0 });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: viewport.width / camera.k,
    height: viewport.height / camera.k,
  };
}

export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x + dx, y: camera.y + dy, k: camera.k };
}

/** Zooms to `k` keeping the world point under `screenPoint` fixed. */
export function zoomCameraTo(
  camera: Camera,
  k: number,
  screenPoint: Point,
  minZoom = MIN_ZOOM,
): Camera {
  const nextK = normalizeZoom(k, minZoom);
  if (nextK === camera.k) return camera;
  const world = screenToWorld(camera, screenPoint);
  return {
    x: screenPoint.x - world.x * nextK,
    y: screenPoint.y - world.y * nextK,
    k: nextK,
  };
}

export function viewportCenter(viewport: Viewport): Point {
  return { x: viewport.width / 2, y: viewport.height / 2 };
}

/**
 * The zoom change a wheel event asks for, Excalidraw-style: a percentage of the
 * current zoom, capped, with a log boost above 100% that shrinks for small
 * trackpad deltas. `deltaY` is the event's deltaY in pixels (positive zooms out).
 */
export function wheelZoomFactor(deltaY: number, currentK: number): number {
  const sign = Math.sign(deltaY);
  const capped = Math.min(Math.abs(deltaY), MAX_WHEEL_ZOOM_DELTA);
  let delta = (capped / 100) * ZOOM_STEP * 5;
  if (currentK > 1) {
    delta *= Math.max(1, Math.log(currentK) * Math.min(1, capped / 10));
  }
  return 1 - sign * delta;
}

export interface FitOptions {
  /** World units of empty space around the content. */
  readonly padding?: number;
  /** When false (the default fit), zoom never passes 1. */
  readonly allowZoomPastOne?: boolean;
  /** The zoom floor; `MIN_ZOOM` unless the content needs a lower one (`zoomFloorFor`). */
  readonly minZoom?: number;
}

/** Centers `bounds` in the viewport at the largest zoom that fits, clamped. */
export function fitCameraToBox(bounds: Box, viewport: Viewport, options: FitOptions = {}): Camera {
  let k = zoomFitting(bounds, viewport, options.padding ?? FIT_PADDING);
  if (!options.allowZoomPastOne) k = Math.min(k, 1);
  k = normalizeZoom(k, options.minZoom ?? MIN_ZOOM);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return { x: viewport.width / 2 - cx * k, y: viewport.height / 2 - cy * k, k };
}
