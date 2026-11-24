import type { Camera } from "@quipu/canvas/camera";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

import {
  type EditMode,
  type NodeEditRequest,
  startNodeEdit,
  useNodeEditor,
} from "../../documents/documentEdits";
import {
  MAP_HEADER_HEIGHT,
  MAP_ROW_HEIGHT,
  type MapLocation,
  type MapNode,
  type MapRow,
  type MapSnapshot,
  textColumns,
} from "../../documents/mapModel";
import type { TreeModel } from "../../documents/treeModel";
import { NodeEditor } from "../edit/NodeEditor";
import { mapRowTextX } from "./MapNodes";

/** The floating editor's width bounds, in its own pixels (before it is scaled with the row). */
const MIN_EDITOR_WIDTH = 240;
const MAX_EDITOR_WIDTH = 420;
/** Room the type badge and the field's padding take beside the text, in the editor's own pixels. */
const BADGE_ROOM = 72;
/** The editor's text, and the map's, at 100 %: 12 px. */
const TEXT_SIZE = 12;
/** The smallest the editor's text gets on screen, however far out the map is. */
const MIN_TEXT_SIZE = 10;

/** The map node and row a tree node is edited on: its own row, or the row in its parent that names it. */
function rowOf(snapshot: MapSnapshot, treeId: string) {
  const location = snapshot.locations.get(treeId);
  if (location === undefined) return null;
  let node = snapshot.byId.get(location.nodeId);
  let rowIndex = location.rowIndex;
  if (node !== undefined && rowIndex === null && node.parentId !== null) {
    const own = node;
    node = snapshot.byId.get(node.parentId);
    rowIndex = node?.rows.findIndex((row) => row.childId === own.id) ?? -1;
  }
  const row = rowIndex === null ? undefined : node?.rows[rowIndex];
  const at = node === undefined ? undefined : snapshot.positions.get(node.id);
  if (node === undefined || row === undefined || at === undefined || rowIndex === null) return null;
  return { node, row, rowIndex, at };
}

/**
 * Editing on the map: which row an editor is open on, and how a double-click,
 * Enter or the edit commands open one. Only rows that are nodes of the file are
 * edited: not a host, page or range group, nor anything inside a decoded value.
 * When the editor closes, the keyboard goes back to the map node it was on.
 */
export function useMapRowEditing({
  tree,
  documentId,
  selectedLocation,
  hostRef,
}: {
  readonly tree: TreeModel;
  readonly documentId: number;
  readonly selectedLocation: MapLocation | null;
  readonly hostRef: RefObject<HTMLDivElement | null>;
}) {
  const request = useNodeEditor((state) =>
    state.request?.surface === "map" && state.request.documentId === documentId
      ? state.request
      : null,
  );
  const locationRef = useRef(selectedLocation);
  useEffect(() => {
    locationRef.current = selectedLocation;
  }, [selectedLocation]);

  const editRow = useCallback(
    (row: MapRow, mode: EditMode) => {
      if (row.decoded || row.treeId === null || tree.isInsideDecoded(row.treeId)) return false;
      const node = tree.summaryOf(row.treeId);
      if (node === undefined) return false;
      const scalar = node.kind !== "object" && node.kind !== "array";
      if (mode === "key" ? node.key === null : !scalar) return false;
      return startNodeEdit({ node, rowId: row.treeId, decoded: false }, mode, "map");
    },
    [tree],
  );

  /** Enter on a focused node edits its selected row when that row is a scalar. */
  const editSelectedRow = useCallback(
    (node: MapNode) => {
      const at = locationRef.current;
      if (at === null || at.nodeId !== node.id || at.rowIndex === null) return false;
      const row = node.rows[at.rowIndex];
      return row !== undefined && !row.expandable && editRow(row, "value");
    },
    [editRow],
  );

  const wasEditing = useRef(false);
  useEffect(() => {
    if (request !== null) {
      wasEditing.current = true;
      return;
    }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    // A press elsewhere that closed the editor keeps the focus it moved.
    const active = document.activeElement;
    if (active !== null && active !== document.body && !hostRef.current?.contains(active)) return;
    const at = locationRef.current;
    if (at === null) return;
    hostRef.current
      ?.querySelector<SVGGElement>(`[data-map-node="${CSS.escape(at.nodeId)}"]`)
      ?.focus({ preventScroll: true });
  }, [request, hostRef]);

  return useMemo(
    () => ({ request, editRow, editSelectedRow }),
    [request, editRow, editSelectedRow],
  );
}

/**
 * The editor over the row it edits, in screen space: it follows the camera, so
 * it sits on the row at any zoom and stays there while the camera is still. Its
 * box is the row's own box (one row tall, its text as large as the row's, at
 * least as wide as the text it edits); only where the row's text is under
 * `MIN_TEXT_SIZE` does it grow past the row, centered on it.
 */
export function MapRowEditor({
  editing,
  snapshot,
  camera,
}: {
  readonly editing: NodeEditRequest | null;
  readonly snapshot: MapSnapshot;
  readonly camera: Camera;
}) {
  if (editing === null || editing.rowId === null) return null;
  const place = rowOf(snapshot, editing.rowId);
  if (place === null) return null;
  const { node, row, rowIndex, at } = place;
  const x = at.x + mapRowTextX(row, editing.mode, snapshot.charWidth);
  const y = at.y + MAP_HEADER_HEIGHT + rowIndex * MAP_ROW_HEIGHT;
  const scale = Math.max(MIN_TEXT_SIZE / TEXT_SIZE, camera.k);
  const rowWidth = ((at.x + node.width - x) * camera.k) / scale;
  const text = editing.mode === "key" ? row.key : row.value;
  const textWidth = textColumns(text) * snapshot.charWidth + BADGE_ROOM;
  const width = Math.max(MIN_EDITOR_WIDTH, textWidth, Math.min(MAX_EDITOR_WIDTH, rowWidth));
  return (
    // No padding or border of its own: unscaled it is one row (20 px) tall.
    <div
      className="absolute z-20 rounded-sm bg-popover text-popover-foreground shadow-md"
      data-board-chrome=""
      data-map-row-editor=""
      style={{
        left: x * camera.k + camera.x,
        top: (y + MAP_ROW_HEIGHT / 2) * camera.k + camera.y,
        width,
        transform: `translateY(-50%) scale(${scale})`,
        transformOrigin: "left center",
      }}
    >
      <NodeEditor request={editing} variant="inline" size="row" />
    </div>
  );
}
