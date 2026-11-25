import { visibleWorldBox, zoomFloorFor, type Camera, type Viewport } from "@quipu/canvas/camera";
import { createEditor } from "@quipu/canvas/editor";
import {
  boxContainsBox,
  boxContainsPoint,
  expandBox,
  type Box,
  type Point,
} from "@quipu/canvas/geometry";
import {
  chooseMapDetail,
  MAP_MARK_CAP,
  MAP_TITLE_MIN_ZOOM,
  visibleRowRange,
  type MapDetail,
} from "@quipu/canvas/mapLod";
import {
  cameraShowing,
  exceedsFloor,
  overviewCamera,
  readableFitCamera,
  sameFrame,
} from "@quipu/canvas/mapView";
import { edgeGuttersFor, type EdgeGutters } from "@quipu/canvas/mapEdges";
import { createSpatialIndex } from "@quipu/canvas/spatialIndex";
import type { NodeRef } from "@quipu/contracts/engine";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { getInspectSource, getMapSource, type OpenDocument } from "../../documents/documentSession";
import { useMatchFilterStore } from "../../documents/hitFilter";
import { createWorkerLayoutRunner } from "../../documents/mapLayoutRunner";
import { useTraceStore } from "../../documents/TracePanel";
import {
  MAP_CHAR_WIDTH,
  MAP_HEADER_HEIGHT,
  MAP_NODE_PADDING,
  MAP_ROW_HEIGHT,
  MapModel,
  type MapNode,
  type MapSnapshot,
} from "../../documents/mapModel";
import {
  nodeBytes,
  selectedNodeId as selectedTreeIdOf,
  useSelectionStore,
} from "../../documents/selectionStore";
import type { TreeModel } from "../../documents/treeModel";
import { useHitSet } from "../../documents/useHitSet";
import { syntaxVariableFor } from "../../syntaxCssVariables";
import { DrawingSurface, type SurfaceContext } from "../board/DrawingSurface";
import { measureBoardText } from "../board/boardPaint";
import { MapMinimap } from "./MapMinimap";
import { MAP_CHEVRON_WIDTH, MAP_DIM_OPACITY, MapEdge, MapNodeView, mapRowTextX } from "./MapNodes";
import { downloadMapBlob, exportMapPng, exportMapSvg } from "./MapExport";
import { MapRowEditor, useMapRowEditing } from "./MapRowEditor";
import { readThemeColor } from "./mapPaint";
import { registerMapController } from "./mapRegistry";
import { useMapStatus } from "./mapStatus";
import { useMapSearchMarks, type MapSearchMarks } from "./mapSearch";
import { TraceArcs } from "./TraceArcs";

/** Screen pixels beyond the viewport that stay mounted (the surface uses the same). */
const MOUNT_MARGIN_PX = 400;
const count = new Intl.NumberFormat("en-US");

/** What the select tool does on the map, beside its name in the toolbar. */
const MAP_TOOL_HINTS = {
  select: "Drag empty space to pan; Shift+drag to select drawings",
} as const;

/**
 * One character's width of the map's monospace font at 12 px, in world units,
 * measured as the map draws it: a text element in the map's own SVG, so the
 * font that actually loaded and any spacing the page applies are counted.
 */
function measureMonospace(svg: SVGSVGElement | null): number {
  if (svg === null) return MAP_CHAR_WIDTH;
  const probe = globalThis.document.createElementNS("http://www.w3.org/2000/svg", "text");
  probe.setAttribute("font-family", "var(--font-mono)");
  probe.setAttribute("font-size", "12");
  probe.setAttribute("visibility", "hidden");
  probe.textContent = "0".repeat(100);
  svg.append(probe);
  const width = probe.getComputedTextLength() / 100;
  probe.remove();
  return width > 0 ? width : MAP_CHAR_WIDTH;
}

interface MountedNode {
  readonly node: MapNode;
  readonly position: Point;
  readonly rowRange: readonly [number, number];
}

/** The quantized window the surface mounts; the same cell size so both layers agree. */
function nearBox(quantized: Camera, viewport: Viewport): Box {
  return expandBox(visibleWorldBox(quantized, viewport), MOUNT_MARGIN_PX / quantized.k);
}

/** The camera snapped to half the mount margin, so a short pan keeps the same mount window. */
const MOUNT_CELL = MOUNT_MARGIN_PX / 2;
const quantize = (value: number) => Math.round(value / MOUNT_CELL) * MOUNT_CELL;

/**
 * One map per open document, kept while its tree lives: switching to the Tree
 * or Source view and back finds the map as it was left (the hosts and pages
 * opened, a capture's grouping read once), not rebuilt from the first page.
 */
const models = new WeakMap<TreeModel, MapModel>();
function mapModelFor(tree: TreeModel, documentId: number, format: "json" | "har"): MapModel {
  let model = models.get(tree);
  if (model === undefined) {
    const inspect = getInspectSource();
    model = new MapModel(tree, {
      documentId,
      format,
      layout: createWorkerLayoutRunner,
      source: { ...getMapSource(), decode: inspect.decode },
    });
    models.set(tree, model);
  }
  return model;
}

/** The largest side of the cached overview, in device pixels. */
const OVERVIEW_MAX_SIDE = 4096;

/**
 * The overview painted into one canvas when even one SVG rect per node would
 * miss the frame: marks colored by type, and during a search the nodes holding
 * a hit in the search color with the rest faded. Every node is drawn once per
 * layout commit, search answer and doubling of the zoom into an offscreen
 * bitmap; a frame then blits that bitmap under the camera, so a pan or zoom
 * over 50 k nodes costs one drawImage. The SVG above keeps the focused and
 * selected nodes.
 */
function MapBitmap({
  snapshot,
  marks,
  camera,
  viewport,
}: {
  readonly snapshot: MapSnapshot;
  readonly marks: MapSearchMarks | null;
  readonly camera: Camera;
  readonly viewport: Viewport;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<{
    snapshot: MapSnapshot;
    marks: MapSearchMarks | null;
    bucket: number;
    scale: number;
    bitmap: HTMLCanvasElement;
  } | null>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    const bounds = snapshot.bounds;
    if (!canvas || !context || bounds === null) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    // The cache scale follows the zoom in powers of two, capped by the bitmap's side.
    const bucket = Math.floor(Math.log2(camera.k * ratio));
    let cache = cacheRef.current;
    if (
      cache === null ||
      cache.snapshot !== snapshot ||
      cache.marks !== marks ||
      cache.bucket !== bucket
    ) {
      const wanted = 2 ** (bucket + 1);
      const scale = Math.min(
        wanted,
        OVERVIEW_MAX_SIDE / Math.max(1, bounds.width),
        OVERVIEW_MAX_SIDE / Math.max(1, bounds.height),
      );
      const bitmap = document.createElement("canvas");
      bitmap.width = Math.max(1, Math.ceil(bounds.width * scale));
      bitmap.height = Math.max(1, Math.ceil(bounds.height * scale));
      const paint = bitmap.getContext("2d");
      if (!paint) return;
      const paints = {
        object: readThemeColor(syntaxVariableFor("brace", 0, "object")),
        array: readThemeColor(syntaxVariableFor("bracket", 0, "array")),
        group: readThemeColor("--info"),
        decoded: readThemeColor("--map-decoded-accent"),
        hit: readThemeColor("--map-search-stroke"),
      };
      const fillNode = (target: CanvasRenderingContext2D, node: MapNode, at: Point) => {
        target.fillStyle = marks?.get(node.id)?.lit
          ? paints.hit
          : node.decoded
            ? paints.decoded
            : node.kind === "object"
              ? paints.object
              : node.kind === "array" || node.kind === "chunk"
                ? paints.array
                : paints.group;
        target.fillRect(
          (at.x - bounds.x) * scale,
          (at.y - bounds.y) * scale,
          Math.max(1, node.width * scale),
          Math.max(1, node.height * scale),
        );
      };
      // Faded nodes go to a layer of their own that is laid down once at the
      // dim opacity: at a far zoom several nodes share a pixel, and fading each
      // one would stack back up to full color.
      const faded = marks === null ? null : document.createElement("canvas");
      const fadedPaint = faded?.getContext("2d") ?? null;
      if (faded !== null) {
        faded.width = bitmap.width;
        faded.height = bitmap.height;
      }
      const drawn: Array<readonly [MapNode, Point]> = [];
      for (const node of snapshot.nodes) {
        const at = snapshot.positions.get(node.id);
        if (!at) continue;
        if (fadedPaint !== null && marks?.get(node.id)?.dim) {
          fillNode(fadedPaint, node, at);
        } else {
          drawn.push([node, at]);
        }
      }
      if (faded !== null) {
        paint.globalAlpha = MAP_DIM_OPACITY;
        paint.drawImage(faded, 0, 0);
        paint.globalAlpha = 1;
      }
      for (const [node, at] of drawn) fillNode(paint, node, at);
      cache = { snapshot, marks, bucket, scale, bitmap };
      cacheRef.current = cache;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;
    const k = camera.k / cache.scale;
    context.drawImage(
      cache.bitmap,
      bounds.x * camera.k + camera.x,
      bounds.y * camera.k + camera.y,
      cache.bitmap.width * k,
      cache.bitmap.height * k,
    );
  }, [snapshot, marks, camera, viewport]);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      data-testid="map-bitmap"
    />
  );
}

/**
 * The document as a node-link map on the drawing surface:
 * open containers are nodes with their rows, edges link a row to the node it
 * opened, the viewport is culled through the spatial index with level of
 * detail by zoom and density, and the board tools draw on the same canvas.
 * The SVG is a tree: one focused item at a time, arrow keys move between
 * parent, child and siblings, and the selection is the one every view shares.
 */
export function MapView({
  document,
}: {
  readonly document: OpenDocument & { readonly tree: TreeModel };
}) {
  const { tree, documentId, format, fileKey } = document;
  // Decoded images and binary values read their decode and bytes as the Inspector does.
  const inspectSource = useMemo(() => getInspectSource(), []);
  const model = useMemo(
    () => mapModelFor(tree, documentId, format === "har" ? "har" : "json"),
    [tree, documentId, format],
  );
  useEffect(() => {
    model.start();
    return () => model.stop();
  }, [model]);
  const editor = useMemo(
    () => createEditor({ seed: 0x51_55_49_50, measure: measureBoardText }),
    [],
  );
  // On the map, dragging empty space pans; Shift+drag draws the selection marquee.
  useEffect(() => {
    editor.setEmptyDragPans(true);
    // Below this zoom a card's title cannot be read: the map never shows blank boxes.
    editor.setZoomFloor(MAP_TITLE_MIN_ZOOM);
  }, [editor]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const editorState = useSyncExternalStore(editor.subscribe, editor.getState, editor.getState);
  const { camera, viewport } = editorState;
  const snapshotRef = useRef(snapshot);
  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // Boxes of every laid-out node, packed once per layout commit.
  const index = useMemo(() => {
    const built = createSpatialIndex();
    built.load(
      snapshot.nodes.flatMap((node): Array<readonly [string, Box]> => {
        const at = snapshot.positions.get(node.id);
        return at ? [[node.id, { x: at.x, y: at.y, width: node.width, height: node.height }]] : [];
      }),
    );
    return built;
  }, [snapshot.nodes, snapshot.positions]);
  const indexRef = useRef(index);
  useLayoutEffect(() => {
    indexRef.current = index;
  }, [index]);

  const boxOf = useCallback((id: string): Box | null => {
    const current = snapshotRef.current;
    const node = current.byId.get(id);
    const at = current.positions.get(id);
    return node && at ? { x: at.x, y: at.y, width: node.width, height: node.height } : null;
  }, []);
  const nodeAt = useCallback(
    (world: Point, threshold: number): MapNode | null => {
      const hits = indexRef.current.search(
        expandBox({ x: world.x, y: world.y, width: 0, height: 0 }, threshold),
      );
      let best: MapNode | null = null;
      for (const id of hits) {
        const box = boxOf(id);
        const node = snapshotRef.current.byId.get(id);
        if (!box || !node || !boxContainsPoint(box, world, threshold)) continue;
        if (best === null || node.level > best.level) best = node;
      }
      return best;
    },
    [boxOf],
  );

  // Arrows bind to nodes; fit frames the map; a layout commit moves bound arrows along.
  useEffect(() => {
    editor.setExternalTargets({
      // A node that is not drawn (collapsed, or not reopened after a reload) lends
      // its arrows and notes to the row or card of its nearest shown ancestor.
      boxOf: (id) => {
        const location = model.attachmentLocation(id);
        const box = location === null ? null : boxOf(location.nodeId);
        if (box === null || location === null || location.rowIndex === null) return box;
        return {
          x: box.x,
          y: box.y + MAP_HEADER_HEIGHT + location.rowIndex * MAP_ROW_HEIGHT,
          width: box.width,
          height: MAP_ROW_HEIGHT,
        };
      },
      hitAt: (world, threshold) => nodeAt(world, threshold)?.id ?? null,
    });
    editor.setContentBounds(() => snapshotRef.current.bounds);
    return () => {
      editor.setExternalTargets(null);
      editor.setContentBounds(null);
    };
  }, [editor, boxOf, nodeAt, model]);
  useEffect(() => {
    editor.refreshExternalBindings();
  }, [editor, snapshot]);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** What the last Expand All held back, said in the status line until the next one. */
  const setNotice = useCallback((notice: string | null) => useMapStatus.setState({ notice }), []);
  /** Set once the user picks or drives something on the map: automatic framing stops. */
  const userActed = useRef(false);
  const focusPending = useRef(false);
  const childFocusPending = useRef<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Nodes are sized in the font they are drawn with, measured once it has loaded.
  useEffect(() => {
    let live = true;
    const measure = () => {
      if (!live) return;
      const svg = hostRef.current?.querySelector<SVGSVGElement>("svg[role=tree]") ?? null;
      model.setCharWidth(measureMonospace(svg));
    };
    measure();
    void globalThis.document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, [model]);
  const rootId = snapshot.nodes[0]?.id ?? null;
  const resolvedFocus = focusedId !== null && snapshot.byId.has(focusedId) ? focusedId : rootId;

  // A node focused before the layout placed it is brought into view once it has a place.
  const showPending = useRef<{ id: string; rowIndex: number | null } | null>(null);
  const moveFocusTo = useCallback(
    (id: string, takeFocus = true, rowIndex: number | null = null) => {
      focusPending.current = takeFocus;
      setFocusedId(id);
      const nodeBox = boxOf(id);
      showPending.current = nodeBox === null ? { id, rowIndex } : null;
      // A row is brought into view on its own: a long node may not fit.
      const box =
        nodeBox === null || rowIndex === null
          ? nodeBox
          : {
              x: nodeBox.x,
              y: nodeBox.y + MAP_HEADER_HEIGHT + rowIndex * MAP_ROW_HEIGHT,
              width: nodeBox.width,
              height: MAP_ROW_HEIGHT,
            };
      if (box) {
        const state = editor.getState();
        const next = cameraShowing(state.camera, state.viewport, box);
        if (next !== state.camera) editor.setCamera(next);
      }
    },
    [boxOf, editor],
  );

  useLayoutEffect(() => {
    if (!focusPending.current || resolvedFocus === null) return;
    // An open value editor keeps the keyboard; the node takes it when the editor closes.
    if (window.document.activeElement?.closest("[data-node-editor]")) return;
    const target = hostRef.current?.querySelector<SVGGElement>(
      `[data-map-node="${CSS.escape(resolvedFocus)}"]`,
    );
    if (target) {
      focusPending.current = false;
      target.focus({ preventScroll: true });
    }
    // Runs after each snapshot too: the node may only mount once the layout lands.
  }, [resolvedFocus, snapshot]);

  useEffect(() => {
    const pending = showPending.current;
    if (pending === null || !snapshot.positions.has(pending.id)) return;
    moveFocusTo(pending.id, false, pending.rowIndex);
  }, [snapshot, moveFocusTo]);

  // Zoom to fit, and the first frame: the whole map when it is readable;
  // otherwise a readable zoom with the focused node (or the root) at the top
  // left. Pressed again on that frame, Zoom to fit shows the whole map.
  const focusedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    focusedRef.current = focusedId;
  }, [focusedId]);
  const lastFit = useRef<{ camera: Camera; overview: boolean; bounds: Box } | null>(null);
  /**
   * `pressed`: the user asked for Zoom to fit. Pressed again on the frame it
   * gave, with the map unchanged, it switches to the whole map (and back).
   */
  const fitFrame = useCallback(
    (camera: Camera, size: Viewport, minZoom: number, pressed: boolean): Camera | null => {
      const current = snapshotRef.current;
      const bounds = current.bounds;
      const rootNode = current.nodes[0];
      if (bounds === null || rootNode === undefined) return null;
      const anchorId =
        focusedRef.current !== null && current.positions.has(focusedRef.current)
          ? focusedRef.current
          : rootNode.id;
      const anchor = boxOf(anchorId) ?? bounds;
      // The map's floor, where its cards still carry a title.
      const floor = Math.max(minZoom, MAP_TITLE_MIN_ZOOM);
      const readable = readableFitCamera(bounds, anchor, size, floor);
      if (!pressed) return readable;
      const overview = overviewCamera(bounds, size, floor);
      const previous = lastFit.current;
      const again =
        previous !== null &&
        sameFrame(camera, previous.camera) &&
        previous.bounds.width === bounds.width &&
        previous.bounds.height === bounds.height;
      const next =
        again && !previous.overview && !sameFrame(readable, overview) ? overview : readable;
      lastFit.current = { camera: next, overview: next === overview, bounds };
      if (next === overview && exceedsFloor(bounds, size, floor)) {
        useMapStatus.setState({
          notice: `The whole map does not fit at ${Math.round(floor * 100)} %: showing its top left`,
        });
      }
      return next;
    },
    [boxOf],
  );
  useEffect(() => {
    editor.setFitPolicy((camera, size, minZoom) => fitFrame(camera, size, minZoom, true));
    return () => editor.setFitPolicy(null);
  }, [editor, fitFrame]);

  // The first frame, and a frame again when the map's root changes (a HAR's
  // capture node replaces the JSON root) or its grouping settles, as long as
  // the user has not moved the camera or picked something since.
  const autoFrame = useRef<{ camera: Camera | null; rootId: string | null; settled: boolean }>({
    camera: null,
    rootId: null,
    settled: false,
  });
  const frameRootId = snapshot.nodes[0]?.id ?? null;
  const frameRootPlaced = frameRootId !== null && snapshot.positions.has(frameRootId);
  // As laid out: a frame on the settled capture needs the settled capture's bounds.
  const laidOutGrouping = snapshot.laidOutGrouping;
  const groupingSettled =
    laidOutGrouping === null ||
    (laidOutGrouping.total !== null && laidOutGrouping.loaded >= laidOutGrouping.total);
  useEffect(() => {
    if (!frameRootPlaced || snapshot.bounds === null || viewport.width <= 1) return;
    const state = autoFrame.current;
    const changed = state.rootId !== frameRootId || (groupingSettled && !state.settled);
    if (!changed) return;
    const untouched =
      state.camera === null ||
      (sameFrame(editor.getState().camera, state.camera) && !userActed.current);
    autoFrame.current = { camera: state.camera, rootId: frameRootId, settled: groupingSettled };
    if (!untouched) return;
    const { camera: current, viewport: size } = editor.getState();
    const next = fitFrame(current, size, zoomFloorFor(snapshot.bounds, size), false);
    if (next === null) return;
    editor.setCamera(next);
    autoFrame.current = {
      camera: editor.getState().camera,
      rootId: frameRootId,
      settled: groupingSettled,
    };
  }, [
    editor,
    fitFrame,
    frameRootId,
    frameRootPlaced,
    groupingSettled,
    snapshot.bounds,
    viewport.width,
  ]);

  // A resized window keeps the map framed: framed again while the user has not
  // moved the camera since the last automatic frame; otherwise the point at the
  // middle of the view stays at the middle.
  const lastViewport = useRef<Viewport | null>(null);
  useEffect(() => {
    const previous = lastViewport.current;
    lastViewport.current = viewport;
    if (previous === null || previous.width <= 1 || viewport.width <= 1) return;
    if (previous.width === viewport.width && previous.height === viewport.height) return;
    const { camera: current } = editor.getState();
    const framed = autoFrame.current.camera;
    if (framed !== null && sameFrame(framed, current) && !userActed.current) {
      const next = fitFrame(
        current,
        viewport,
        zoomFloorFor(snapshotRef.current.bounds, viewport),
        false,
      );
      if (next === null) return;
      editor.setCamera(next);
      autoFrame.current = { ...autoFrame.current, camera: editor.getState().camera };
      return;
    }
    editor.setCamera({
      x: current.x + (viewport.width - previous.width) / 2,
      y: current.y + (viewport.height - previous.height) / 2,
      k: current.k,
    });
  }, [editor, fitFrame, viewport]);

  const selection = useSelectionStore((state) => state.selection);
  // A row inside a decoded value is selected in the tree alone (the Inspector
  // shows it); every other pick is the selection all views share.
  const treeSelectedId = useSyncExternalStore(tree.subscribe, () => tree.selectedRowId);
  const selectedTreeId = tree.isInsideDecoded(treeSelectedId)
    ? treeSelectedId
    : selectedTreeIdOf(selection, documentId);
  // Read from the snapshot, not through the model: the compiler memoizes on
  // what it can see, and the snapshot is what changes.
  const selectedLocation =
    selectedTreeId === null ? null : (snapshot.locations.get(selectedTreeId) ?? null);
  // Another view's pick, or a step to the next search hit, brings its node (or
  // row) into view and focuses it, once per pick; a node the map has not
  // opened yet is reached through its path, as the tree does, and through the
  // host, page and range that group it in a HAR capture.
  const followedRevision = useRef(0);
  const revealedRevision = useRef(0);
  const selectedLaidOut =
    selectedLocation !== null && snapshot.positions.has(selectedLocation.nodeId);
  useEffect(() => {
    if (selection === null || selection.origin === "map") return;
    if (selection.revision === followedRevision.current) return;
    if (!selectedLocation) {
      if (selection.path !== null && revealedRevision.current !== selection.revision) {
        revealedRevision.current = selection.revision;
        void model.reveal(selection.path);
      }
      return;
    }
    // The node is listed before the layout places it: follow it once it has a place.
    if (!selectedLaidOut) return;
    followedRevision.current = selection.revision;
    // Stepping through search hits keeps the keyboard in the query bar.
    moveFocusTo(selectedLocation.nodeId, selection.origin !== "search", selectedLocation.rowIndex);
  }, [selection, selectedLocation, selectedLaidOut, moveFocusTo, model]);

  // Match filter: hide non-matching branches when toggled on.
  const matchFilterEnabled = useMatchFilterStore((state) => state.enabled);
  const matchedIds = useMatchFilterStore((state) => state.matchedIds);
  useEffect(() => {
    model.setMatchFilter(matchFilterEnabled ? matchedIds : null);
  }, [model, matchFilterEnabled, matchedIds]);

  // Transient trace arcs.
  const traceResult = useTraceStore((state) => state.result);
  const traceOriginRange = useTraceStore((state) => state.originRange);

  // Search: nodes and rows holding a hit are lit, the rest dimmed.
  const hitSet = useHitSet(document);
  const searchMarks = useMapSearchMarks(hitSet, snapshot, tree);
  const searchMarksRef = useRef(searchMarks);
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  useLayoutEffect(() => {
    searchMarksRef.current = searchMarks;
    cameraRef.current = camera;
    viewportRef.current = viewport;
  }, [searchMarks, camera, viewport]);

  const select = useCallback(
    (treeId: string | null) => {
      const node = treeId === null ? undefined : tree.summaryOf(treeId);
      // A host or page group, or a range of a long array, is not a node of the document.
      if (treeId === null || node === undefined) return;
      tree.select(treeId);
      // A decoded value's rows have no bytes in the file for the other views to show.
      if (tree.isInsideDecoded(treeId)) return;
      useSelectionStore.getState().select({
        documentId: node.ref.documentId,
        ref: node.ref,
        range: nodeBytes(node),
        origin: "map",
        path: null,
      });
    },
    [tree],
  );

  // The map has one current node: the keyboard moves it as a click does, and the
  // selection every view and the Inspector use moves with it.
  const moveCurrentTo = useCallback(
    (id: string) => {
      moveFocusTo(id);
      const node = snapshotRef.current.byId.get(id);
      if (node !== undefined && node.treeId !== null) select(node.treeId);
      // A HAR host or page is not a node of the document: nothing in the file is selected.
      else useSelectionStore.getState().clear();
    },
    [moveFocusTo, select],
  );

  // Right on a closed node opens it and lands on its first child once it exists.
  useEffect(() => {
    const parent = childFocusPending.current;
    if (parent === null) return;
    const first = snapshot.childrenOf.get(parent)?.[0];
    if (first !== undefined) {
      childFocusPending.current = null;
      moveCurrentTo(first);
    }
  }, [snapshot, moveCurrentTo]);

  const rowEditing = useMapRowEditing({ tree, documentId, selectedLocation, hostRef });

  useEffect(() => {
    const current = () => {
      const id = focusedId !== null && snapshotRef.current.byId.has(focusedId) ? focusedId : rootId;
      return id === null ? null : (snapshotRef.current.byId.get(id) ?? null);
    };
    const siblings = (node: MapNode) =>
      node.parentId === null
        ? snapshotRef.current.nodes.filter((n) => n.parentId === null).map((n) => n.id)
        : (snapshotRef.current.childrenOf.get(node.parentId) ?? []);
    const acted = () => {
      userActed.current = true;
    };
    return registerMapController({
      selectionScope: () => {
        const node = current();
        return node === null ? [] : model.treeIdsUnder(node.id);
      },
      focusSibling: (step) => {
        acted();
        const node = current();
        if (!node) return;
        const list = siblings(node);
        const at = list.indexOf(node.id);
        const next = list[at + step];
        if (next !== undefined) moveCurrentTo(next);
      },
      focusFirstSibling: () => {
        acted();
        const node = current();
        const first = node ? siblings(node)[0] : undefined;
        if (first !== undefined) moveCurrentTo(first);
      },
      focusLastSibling: () => {
        acted();
        const node = current();
        const list = node ? siblings(node) : [];
        const last = list[list.length - 1];
        if (last !== undefined) moveCurrentTo(last);
      },
      focusChild: () => {
        acted();
        const node = current();
        if (!node) return;
        const children = snapshotRef.current.childrenOf.get(node.id) ?? [];
        if (children[0] !== undefined) {
          moveCurrentTo(children[0]);
        } else if (node.expandable && !node.expanded) {
          childFocusPending.current = node.id;
          // A HAR page (or a range of its requests) lists requests, each opened by
          // reading its part of `log.entries`: open the one Right lands on, as a
          // click would, not every request at once. Other nodes open whole.
          const listsRequests =
            node.treeId === null && node.rows.some((row) => row.treeId !== null);
          const first = node.rows.findIndex((row) => row.expandable);
          if (listsRequests && first >= 0) void model.toggleRow(node.id, first);
          else void model.setExpanded(node.id, true);
        }
      },
      focusParent: () => {
        acted();
        const node = current();
        if (!node) return;
        if (node.expanded) void model.setExpanded(node.id, false);
        else if (node.parentId !== null) moveCurrentTo(node.parentId);
      },
      toggleFocused: () => {
        acted();
        const node = current();
        // Enter on a selected scalar row edits it; on anything else it opens or closes.
        if (node && rowEditing.editSelectedRow(node)) return;
        if (node?.expandable) void model.setExpanded(node.id, !node.expanded);
      },
      expandAll: () => {
        acted();
        void model.expandAll(null).then(setNotice);
      },
      collapseAll: () => {
        acted();
        setNotice(null);
        model.collapseAll();
        if (rootId !== null) moveCurrentTo(rootId);
      },
      expandUnder: () => {
        acted();
        const node = current();
        if (node) void model.expandAll(node.id).then(setNotice);
      },
      collapseUnder: () => {
        acted();
        setNotice(null);
        const node = current();
        if (node) model.collapseUnder(node.id);
      },
      exportImage: async (format, scope) => {
        const baseName = document.name.replace(/\.[^.]+$/, "") || "map";
        const options = {
          snapshot: snapshotRef.current,
          scope,
          camera: cameraRef.current,
          viewport: viewportRef.current,
          marks: searchMarksRef.current,
        };
        if (format === "svg") {
          const { svg } = exportMapSvg(options);
          downloadMapBlob(
            new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
            `${baseName}-map.svg`,
          );
          return;
        }
        const { blob } = await exportMapPng(options);
        downloadMapBlob(blob, `${baseName}-map.png`);
      },
    });
  }, [model, document.name, focusedId, rootId, moveCurrentTo, rowEditing, setNotice]);

  const onCanvasPointerDown = useCallback(
    (world: Point, event: ReactPointerEvent<HTMLDivElement>): boolean => {
      const state = editor.getState();
      if (state.tool !== "select") return false;
      // Drawings sit above the map: a press on one is the editor's.
      if (editor.hitTest(editor.screenPoint(world)) !== null) return false;
      const node = nodeAt(world, 0);
      if (node === null) return false;
      userActed.current = true;
      const at = boxOf(node.id) as Box;
      const localX = world.x - at.x;
      const localY = world.y - at.y;
      editor.select([]);
      if (localY >= MAP_HEADER_HEIGHT) {
        const rowIndex = Math.floor((localY - MAP_HEADER_HEIGHT) / MAP_ROW_HEIGHT);
        const row = node.rows[rowIndex];
        if (row?.kind === "more") {
          model.showMore(node.id);
          moveFocusTo(node.id);
          return true;
        }
        if (row) {
          const onChevron = localX < MAP_NODE_PADDING + MAP_CHEVRON_WIDTH + 2;
          if (row.expandable && (onChevron || event.detail >= 2)) {
            void model.toggleRow(node.id, rowIndex);
          }
          // A host, page or range row groups requests; it leaves the selection as it is.
          if (row.treeId !== null) select(row.treeId);
          moveFocusTo(node.id);
          return true;
        }
      }
      select(node.treeId);
      moveFocusTo(node.id);
      return true;
    },
    [editor, nodeAt, boxOf, model, select, moveFocusTo],
  );

  // A double-click on a row is the map's, not the drawing layer's (which would start a text):
  // on a key it renames it, on a scalar's value it edits it, on a row that opens it toggles it.
  const onDoubleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const canvas = (event.target as Element).closest("[data-board-canvas]");
      if (canvas === null || (event.target as Element).closest("[data-board-chrome]")) return;
      if (editor.getState().tool !== "select") return;
      const rect = canvas.getBoundingClientRect();
      const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (editor.hitTest(local) !== null) return;
      const world = editor.worldPoint(local);
      const node = nodeAt(world, 0);
      if (node === null) return;
      const at = boxOf(node.id) as Box;
      const localY = world.y - at.y;
      if (localY < MAP_HEADER_HEIGHT) return;
      const row = node.rows[Math.floor((localY - MAP_HEADER_HEIGHT) / MAP_ROW_HEIGHT)];
      if (row === undefined) return;
      const localX = world.x - at.x;
      const onChevron = localX < MAP_NODE_PADDING + MAP_CHEVRON_WIDTH + 2;
      const part = localX < mapRowTextX(row, "value", snapshot.charWidth) ? "key" : "value";
      if (!onChevron && rowEditing.editRow(row, part)) {
        event.stopPropagation();
        return;
      }
      if (row.expandable && !onChevron) {
        event.stopPropagation();
        void model.toggleRow(node.id, node.rows.indexOf(row));
      }
    },
    [editor, nodeAt, boxOf, model, rowEditing],
  );

  // The mount window is quantized, so a pan recomputes the set only when it
  // crosses a cell; between cells every frame reuses it (50 k nodes at a far
  // zoom would otherwise be searched and sorted per frame).
  const qx = quantize(camera.x);
  const qy = quantize(camera.y);
  const qk = Number(camera.k.toPrecision(3));
  const near = useMemo(() => nearBox({ x: qx, y: qy, k: qk }, viewport), [qx, qy, qk, viewport]);
  const selectedNodeId = selectedLocation?.nodeId ?? null;
  const { mounted, visibleRows, visibleNodes } = useMemo(() => {
    const list: MountedNode[] = [];
    let rows = 0;
    // The whole of a dense map in view: the overview bitmap draws it, so the
    // index is not searched and only the focused and selected nodes mount.
    const whole =
      snapshot.bounds !== null &&
      snapshot.nodes.length > MAP_MARK_CAP &&
      boxContainsBox(near, snapshot.bounds);
    const ids = new Set(whole ? [] : index.search(near));
    const count = whole ? snapshot.nodes.length : ids.size;
    if (resolvedFocus !== null) ids.add(resolvedFocus);
    if (selectedNodeId !== null) ids.add(selectedNodeId);
    for (const id of ids) {
      const node = snapshot.byId.get(id);
      const position = snapshot.positions.get(id);
      if (!node || !position) continue;
      const rowRange = visibleRowRange(
        position.y,
        MAP_HEADER_HEIGHT,
        MAP_ROW_HEIGHT,
        node.rows.length,
        near.y,
        near.y + near.height,
      );
      rows += rowRange[1] - rowRange[0];
      list.push({ node, position, rowRange });
    }
    list.sort((a, b) => a.node.level - b.node.level);
    return { mounted: list, visibleRows: rows, visibleNodes: Math.max(count, list.length) };
  }, [index, near, resolvedFocus, selectedNodeId, snapshot]);
  const detail: MapDetail = chooseMapDetail({
    zoom: camera.k,
    visibleNodes,
    visibleRows,
  });
  const svgNodes =
    detail === "bitmap"
      ? mounted.filter(
          ({ node }) => node.id === resolvedFocus || node.id === selectedLocation?.nodeId,
        )
      : mounted;
  const bindingTargetId = editorState.bindingTargetId;

  // The status bar shows the map's node count and how far a capture's grouping has got.
  const nodeCount = snapshot.nodes.length;
  const grouping = snapshot.grouping;
  const groupingText =
    grouping === null
      ? ""
      : grouping.total === null
        ? " · grouping requests…"
        : grouping.loaded < grouping.total
          ? ` · grouping ${count.format(grouping.loaded)} of ${count.format(grouping.total)} requests…`
          : "";
  useEffect(() => {
    useMapStatus.setState({
      status: `${count.format(nodeCount)} node${nodeCount === 1 ? "" : "s"}${groupingText}`,
    });
  }, [nodeCount, groupingText]);
  useEffect(() => () => useMapStatus.setState({ status: null, notice: null }), []);

  // Parents whose children wrap into columns route their edges through the gutters.
  const edgeGutters = useMemo(() => {
    const gutters = new Map<string, EdgeGutters>();
    for (const [parentId, childIds] of snapshot.childrenOf) {
      const parent = snapshot.byId.get(parentId);
      const at = snapshot.positions.get(parentId);
      if (!parent || !at || childIds.length < 2) continue;
      const children: Box[] = [];
      for (const id of childIds) {
        const child = snapshot.byId.get(id);
        const childAt = snapshot.positions.get(id);
        if (child && childAt)
          children.push({ ...childAt, width: child.width, height: child.height });
      }
      const routed = edgeGuttersFor(
        { ...at, width: parent.width, height: parent.height },
        children,
      );
      if (routed !== null) gutters.set(parentId, routed);
    }
    return gutters;
  }, [snapshot]);

  // Strings on screen are asked once what they decode as, as the tree's rows are:
  // the answer gives the row its badge and its chevron.
  useEffect(() => {
    if (detail !== "full") return;
    for (const { node, rowRange } of svgNodes) {
      for (const row of node.rows.slice(rowRange[0], rowRange[1])) {
        if (row.kind === "string" && row.treeId !== null) void tree.requestText(row.treeId);
      }
    }
  }, [detail, svgNodes, tree]);

  const loadPreview = useCallback((ref: NodeRef) => inspectSource.preview(ref), [inspectSource]);

  const renderWorld = (_context: SurfaceContext) => (
    <g data-map-detail={detail} data-map-nodes={visibleNodes}>
      {detail === "bitmap"
        ? null
        : svgNodes.map(({ node, position }) => {
            if (node.parentId === null) return null;
            const parent = snapshot.byId.get(node.parentId);
            const parentAt = snapshot.positions.get(node.parentId);
            if (!parent || !parentAt) return null;
            return (
              <MapEdge
                key={`edge:${node.id}`}
                from={{
                  x: parentAt.x + parent.width,
                  y: parentAt.y + node.anchor + MAP_ROW_HEIGHT / 2,
                }}
                to={{ x: position.x, y: position.y + MAP_HEADER_HEIGHT / 2 }}
                gutters={edgeGutters.get(node.parentId) ?? null}
              />
            );
          })}
      {svgNodes.map(({ node, position, rowRange }) => (
        <MapNodeView
          key={node.id}
          node={node}
          marks={searchMarks?.get(node.id) ?? null}
          loadPreview={loadPreview}
          position={position}
          detail={detail === "bitmap" ? "marks" : detail}
          zoom={detail === "titles" ? qk : 1}
          charWidth={snapshot.charWidth}
          rowRange={rowRange}
          focused={node.id === resolvedFocus}
          selected={selectedLocation?.nodeId === node.id && selectedLocation.rowIndex === null}
          selectedRow={selectedLocation?.nodeId === node.id ? selectedLocation.rowIndex : null}
          bindingTarget={bindingTargetId === node.id}
        />
      ))}
      {detail !== "bitmap" && traceResult !== null && traceResult.occurrences.length > 0 ? (
        <TraceArcs
          snapshot={snapshot}
          occurrences={traceResult.occurrences}
          originRange={traceOriginRange}
        />
      ) : null}
    </g>
  );

  const renderBackdrop = (context: SurfaceContext) =>
    detail === "bitmap" ? (
      <MapBitmap
        snapshot={snapshot}
        marks={searchMarks}
        camera={context.state.camera}
        viewport={context.state.viewport}
      />
    ) : null;

  const renderChrome = (context: SurfaceContext) => (
    <>
      <MapRowEditor
        editing={rowEditing.request}
        snapshot={snapshot}
        camera={context.state.camera}
      />
      <MapMinimap
        snapshot={snapshot}
        camera={context.state.camera}
        viewport={context.state.viewport}
        onJump={(world) => {
          const { viewport: size, camera: cam } = editor.getState();
          editor.setCamera({
            x: size.width / 2 - world.x * cam.k,
            y: size.height / 2 - world.y * cam.k,
            k: cam.k,
          });
        }}
      />
    </>
  );

  return (
    <div
      ref={hostRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-map-view=""
      data-map-detail={detail}
      data-map-selected={selectedLocation?.nodeId}
      data-map-selected-row={selectedLocation?.rowIndex ?? undefined}
      onDoubleClickCapture={onDoubleClickCapture}
    >
      <DrawingSurface
        storageKey={`document:${fileKey}`}
        label="Map canvas"
        testIdPrefix="map"
        editor={editor}
        svgRole="tree"
        svgLabel="Document map"
        renderBackdrop={renderBackdrop}
        renderWorld={renderWorld}
        renderChrome={renderChrome}
        onCanvasPointerDown={onCanvasPointerDown}
        toolHints={MAP_TOOL_HINTS}
        fitLabel="Zoom to fit (Shift+1). Press again to see the whole map."
        saveStatusShown="whenDrawn"
      />
    </div>
  );
}
