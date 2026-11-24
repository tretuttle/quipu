/**
 * Level of detail for the map. SVG is the renderer; what changes with zoom and
 * density is how much of each node it mounts. "full" draws the node with its
 * rows; "titles" draws only its title; "marks" draws one rect per node, no
 * text; "bitmap" paints the marks into one canvas and keeps SVG for the
 * selection, the focus and the hover. The thresholds are paint limits, never
 * a refusal: a file is always drawn.
 */
export type MapDetail = "full" | "titles" | "marks" | "bitmap";

/** Below this zoom a 12 px label is under 7 px tall: unreadable, so rows are not mounted. */
export const MAP_TEXT_MIN_ZOOM = 0.55;
/**
 * The map's zoom floor. Down to it a node keeps its title, drawn at a fixed
 * size on screen ("titles"), so the map's shape stays labeled one level of
 * detail longer than its rows. The title must fit inside the card: the
 * smallest card (a header and one row, 48 units) is 12 px tall here, so every
 * title is at least 11 px and no card is ever drawn as a blank box.
 */
export const MAP_TITLE_MIN_ZOOM = 0.25;
/** Full nodes mounted at once; past it even a readable zoom falls back to marks. */
export const MAP_FULL_NODE_CAP = 600;
/** Rows (text lines) mounted at once across every full node. */
export const MAP_ROW_CAP = 5000;
/** SVG rects for marks; past it the overview goes to one canvas. */
export const MAP_MARK_CAP = 6000;

export interface MapDetailInput {
  readonly zoom: number;
  /** Nodes whose box intersects the mounted window. */
  readonly visibleNodes: number;
  /** Rows those nodes would mount at full detail (after row culling). */
  readonly visibleRows: number;
}

export function chooseMapDetail(input: MapDetailInput): MapDetail {
  if (
    input.zoom >= MAP_TEXT_MIN_ZOOM &&
    input.visibleNodes <= MAP_FULL_NODE_CAP &&
    input.visibleRows <= MAP_ROW_CAP
  ) {
    return "full";
  }
  // Titles wherever marks would be drawn: a node is never a blank box at a zoom it can be read.
  if (input.zoom >= MAP_TITLE_MIN_ZOOM && input.visibleNodes <= MAP_MARK_CAP) return "titles";
  return input.visibleNodes <= MAP_MARK_CAP ? "marks" : "bitmap";
}

/**
 * The rows of one node that intersect a vertical window, as [first, end).
 * Rows have one height and start `headerHeight` under the node's top.
 */
export function visibleRowRange(
  nodeTop: number,
  headerHeight: number,
  rowHeight: number,
  rowCount: number,
  windowTop: number,
  windowBottom: number,
): readonly [number, number] {
  if (rowCount === 0 || rowHeight <= 0) return [0, 0];
  const firstRowTop = nodeTop + headerHeight;
  const first = Math.max(0, Math.floor((windowTop - firstRowTop) / rowHeight));
  const end = Math.min(rowCount, Math.ceil((windowBottom - firstRowTop) / rowHeight));
  return first >= end ? [0, 0] : [first, end];
}
