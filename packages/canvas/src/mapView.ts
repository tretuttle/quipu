/**
 * Where the map puts its camera: the first frame, Zoom to fit, and bringing a
 * node into view for keyboard focus or a search hit. All of them keep content
 * inside the usable area, the viewport minus the chrome floating over it (the
 * drawing toolbar on top, the minimap and zoom controls at the bottom), and
 * none of them ends on a zoom where the map has no text.
 */
import { normalizeZoom, type Camera, type Viewport } from "./camera.ts";
import type { Box } from "./geometry.ts";

/** Screen pixels the chrome takes on each side of the map. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * The map's chrome: the toolbar across the top, the minimap and zoom controls
 * in the bottom right, the node count and status in the bottom left.
 */
export const MAP_INSETS: Insets = { top: 72, right: 24, bottom: 200, left: 24 };

/** The zoom a readable frame uses: rows at their own 12 px, as easy to read as the tree. */
export const MAP_READABLE_ZOOM = 1;
/**
 * The least zoom the whole map may be fitted at: below it a 12 px row is
 * under 10 px on screen, drawn but tiring to read, so the frame anchors on
 * the root instead.
 */
export const MAP_COMFORTABLE_ZOOM = 0.8;

/** Space a fit leaves between the content and the usable area's edges, in screen pixels. */
const FIT_MARGIN = 16;

/** The part of the viewport no chrome covers, in screen pixels. */
export function usableArea(viewport: Viewport, insets: Insets = MAP_INSETS): Box {
  // A viewport too small for the insets keeps at least half of itself.
  const left = Math.min(insets.left, viewport.width / 4);
  const right = Math.min(insets.right, viewport.width / 4);
  const top = Math.min(insets.top, viewport.height / 4);
  const bottom = Math.min(insets.bottom, viewport.height / 4);
  return {
    x: left,
    y: top,
    width: Math.max(1, viewport.width - left - right),
    height: Math.max(1, viewport.height - top - bottom),
  };
}

/** The zoom at which `bounds` fills the usable area, capped at 1. */
function fittingZoom(bounds: Box, area: Box, minZoom: number): number {
  const k = Math.min(
    (area.width - FIT_MARGIN * 2) / Math.max(bounds.width, 1),
    (area.height - FIT_MARGIN * 2) / Math.max(bounds.height, 1),
    1,
  );
  // The map's own floor holds here, even above the canvas default.
  return Math.max(minZoom, normalizeZoom(k, minZoom));
}

/** Whether `bounds` is too large to show whole at the zoom floor. */
export function exceedsFloor(
  bounds: Box,
  viewport: Viewport,
  minZoom: number,
  insets: Insets = MAP_INSETS,
): boolean {
  const area = usableArea(viewport, insets);
  const fits = Math.min(
    (area.width - FIT_MARGIN * 2) / Math.max(bounds.width, 1),
    (area.height - FIT_MARGIN * 2) / Math.max(bounds.height, 1),
  );
  return fits < minZoom;
}

/**
 * The whole of `bounds`, centered in the usable area: the map's overview. A
 * map larger than fits at the zoom floor is framed from its top left instead,
 * so what shows starts where the map does, clear of the toolbar.
 */
export function overviewCamera(
  bounds: Box,
  viewport: Viewport,
  minZoom: number,
  insets: Insets = MAP_INSETS,
): Camera {
  const area = usableArea(viewport, insets);
  const k = fittingZoom(bounds, area, minZoom);
  if (exceedsFloor(bounds, viewport, minZoom, insets)) {
    return { x: area.x + FIT_MARGIN - bounds.x * k, y: area.y + FIT_MARGIN - bounds.y * k, k };
  }
  return {
    x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * k,
    y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * k,
    k,
  };
}

/**
 * Zoom to fit for a map: the overview when it is comfortable to read
 * (`MAP_COMFORTABLE_ZOOM` or more); otherwise `MAP_READABLE_ZOOM` with
 * `anchor` (the root, or the focused node) at the top left of the usable
 * area, so the first thing shown is text a user reads without leaning in.
 */
export function readableFitCamera(
  bounds: Box,
  anchor: Box,
  viewport: Viewport,
  minZoom: number,
  insets: Insets = MAP_INSETS,
): Camera {
  const overview = overviewCamera(bounds, viewport, minZoom, insets);
  if (overview.k >= MAP_COMFORTABLE_ZOOM) return overview;
  const area = usableArea(viewport, insets);
  const k = MAP_READABLE_ZOOM;
  return {
    x: area.x + FIT_MARGIN - anchor.x * k,
    y: area.y + FIT_MARGIN - anchor.y * k,
    k,
  };
}

/** Whether two cameras show the same frame, to the pixel. */
export function sameFrame(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.k - b.k) < 1e-4;
}

/**
 * The camera that shows `box` inside the usable area, moving as little as
 * possible. A box larger than the area shows its top left corner.
 */
export function cameraShowing(
  camera: Camera,
  viewport: Viewport,
  box: Box,
  insets: Insets = MAP_INSETS,
): Camera {
  const area = usableArea(viewport, insets);
  const left = box.x * camera.k + camera.x;
  const top = box.y * camera.k + camera.y;
  const right = left + box.width * camera.k;
  const bottom = top + box.height * camera.k;
  const shift = (start: number, end: number, from: number, to: number) => {
    if (start < from) return from - start;
    if (end > to) return Math.max(from - start, to - end);
    return 0;
  };
  const dx = shift(left, right, area.x + FIT_MARGIN, area.x + area.width - FIT_MARGIN);
  const dy = shift(top, bottom, area.y + FIT_MARGIN, area.y + area.height - FIT_MARGIN);
  return dx === 0 && dy === 0 ? camera : { x: camera.x + dx, y: camera.y + dy, k: camera.k };
}
