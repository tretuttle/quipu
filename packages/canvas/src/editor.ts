/**
 * The drawing editor: one scene, one camera, one tool, one history. The shell
 * feeds it pointer events in screen pixels and commands; it answers with an
 * immutable state snapshot the shell paints from. Nothing here schedules a
 * frame or touches the DOM.
 */
import {
  alignElements,
  distributeElements,
  duplicateElements,
  groupElements,
  ungroupElements,
  type AlignEdge,
  type DistributeAxis,
} from "./arrange.ts";
import { centerBinding } from "./bindings.ts";
import {
  fitCameraToBox,
  IDENTITY_CAMERA,
  MIN_ZOOM,
  normalizeZoom,
  panCamera,
  screenToWorld,
  viewportCenter,
  visibleWorldBox,
  wheelZoomFactor,
  worldToScreen,
  zoomCameraTo,
  zoomFloorFor,
  ZOOM_STEP,
  type Camera,
  type Viewport,
} from "./camera.ts";
import {
  DEFAULT_STYLE,
  isBindable,
  isLinearElement,
  isTextBearing,
  type Element,
  type ElementId,
  type ElementStyle,
  type FontFamily,
  type TextAlign,
} from "./elements.ts";
import { keyBetween } from "./fractionalIndex.ts";
import {
  boxCenter,
  boxContainsBox,
  boxContainsPoint,
  boxFromCorners,
  distance,
  expandBox,
  rotatePoint,
  rotatedBoxCorners,
  unionBoxes,
  type Box,
  type Point,
} from "./geometry.ts";
import { createHistory, type HistoryEntry } from "./history.ts";
import {
  elementBounds,
  elementBox,
  frameLabelBox,
  hitElement,
  hitElementBox,
  linearWorldPoints,
} from "./hitTest.ts";
import { createRng, type Rng } from "./random.ts";
import { createScene, refreshBindingsFor, type Scene } from "./scene.ts";
import { SNAP_DISTANCE_PX, snapBox, type SnapGuide } from "./snapping.ts";
import { layoutText, type MeasureText } from "./text.ts";
import {
  NO_MODIFIERS,
  type GestureState,
  type Handle,
  type PointerModifiers,
  type Tool,
} from "./tools.ts";

/** Excalidraw's hit threshold in screen pixels; divided by zoom. */
const HIT_THRESHOLD_PX = 10;
/** Screen pixels a pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
const HANDLE_RADIUS_PX = 7;
const DEFAULT_NOTE_SIZE = 160;
/** What a new frame is called, and what an emptied name goes back to. */
const DEFAULT_FRAME_NAME = "Frame";
const DEFAULT_FONT_SIZE = 20;

export interface TextStyle {
  readonly fontSize: number;
  readonly fontFamily: FontFamily;
  readonly textAlign: TextAlign;
}

const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: "hand",
  textAlign: "left",
};

export interface HandlePosition {
  readonly handle: Handle;
  /** World coordinates. */
  readonly point: Point;
}

export interface EditorState {
  readonly elements: ReadonlyArray<Element>;
  readonly selectedIds: ReadonlySet<ElementId>;
  readonly tool: Tool;
  readonly toolLocked: boolean;
  readonly camera: Camera;
  /** The zoom Zoom out stops at: `MIN_ZOOM`, or lower when the content needs it to fit. */
  readonly zoomFloor: number;
  readonly viewport: Viewport;
  readonly gesture: GestureState;
  readonly guides: ReadonlyArray<SnapGuide>;
  readonly marquee: Box | null;
  /** The text or note element a DOM editor should be open on. */
  readonly editingTextId: ElementId | null;
  /** The element an arrow end would bind to if released now. */
  readonly bindingTargetId: ElementId | null;
  readonly style: ElementStyle;
  readonly textStyle: TextStyle;
  readonly gridEnabled: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Bounds of the selection, or null. */
  readonly selectionBox: Box | null;
  readonly handles: ReadonlyArray<HandlePosition>;
  readonly revision: number;
}

/**
 * Bindable boxes that live outside the scene: the map's data nodes. An arrow
 * end dropped on one binds to its id; after every layout commit the shell
 * calls `refreshExternalBindings` so the arrows follow.
 */
export interface ExternalTargets {
  /** The current box of a target, or null when it is not drawn right now. */
  readonly boxOf: (id: string) => Box | null;
  /** The topmost target whose box holds the point (within `threshold`), or null. */
  readonly hitAt: (world: Point, threshold: number) => string | null;
}

export interface EditorOptions {
  /** Seeds ids and rough.js seeds, so a test is reproducible. */
  readonly seed: number;
  readonly measure: MeasureText;
  readonly elements?: ReadonlyArray<Element>;
  readonly viewport?: Viewport;
}

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface Editor {
  readonly getState: () => EditorState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setViewport: (viewport: Viewport) => void;
  readonly setTool: (tool: Tool, options?: { readonly locked?: boolean }) => void;
  /** Pans with the hand tool until `releaseTemporaryTool`, then restores the tool. */
  readonly holdHandTool: () => void;
  readonly releaseTemporaryTool: () => void;
  readonly pointerDown: (screen: Point, modifiers?: PointerModifiers) => void;
  readonly pointerMove: (screen: Point, modifiers?: PointerModifiers) => void;
  readonly pointerUp: (screen: Point, modifiers?: PointerModifiers) => void;
  readonly pointerCancel: () => void;
  readonly doubleClick: (screen: Point) => void;
  readonly wheel: (screen: Point, input: WheelInput) => void;
  readonly escape: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly selectAll: () => void;
  readonly select: (ids: Iterable<ElementId>) => void;
  readonly deleteSelection: () => void;
  readonly duplicateSelection: () => void;
  readonly groupSelection: () => void;
  readonly ungroupSelection: () => void;
  readonly alignSelection: (edge: AlignEdge) => void;
  readonly distributeSelection: (axis: DistributeAxis) => void;
  readonly nudgeSelection: (dx: number, dy: number) => void;
  readonly bringForward: () => void;
  readonly sendBackward: () => void;
  readonly bringToFront: () => void;
  readonly sendToBack: () => void;
  readonly setStyle: (patch: Partial<ElementStyle>) => void;
  readonly setTextStyle: (patch: Partial<TextStyle>) => void;
  readonly toggleGrid: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly zoomReset: () => void;
  readonly zoomToFit: () => void;
  readonly pan: (dx: number, dy: number) => void;
  readonly setCamera: (camera: Camera) => void;
  /** Starts editing the selected text or note, or does nothing. */
  readonly editSelectedText: () => void;
  readonly commitText: (id: ElementId, text: string) => void;
  readonly cancelText: () => void;
  /** Places an image element at the viewport center, scaled to fit. */
  readonly insertImage: (fileId: string, naturalWidth: number, naturalHeight: number) => ElementId;
  /** Replaces the scene (loading a saved drawing); history is reset. */
  readonly loadElements: (elements: ReadonlyArray<Element>) => void;
  /** Boxes outside the scene that arrows may bind to; null when there are none. */
  readonly setExternalTargets: (targets: ExternalTargets | null) => void;
  /** Moves every arrow end bound to an external target onto its current box. */
  readonly refreshExternalBindings: () => void;
  /** Extra content `zoomToFit` frames beside the drawing (the map's bounds). */
  readonly setContentBounds: (bounds: (() => Box | null) | null) => void;
  /**
   * Decides what Zoom to fit shows, given the current camera and viewport;
   * null (or a policy returning null) keeps the plain fit of everything.
   */
  readonly setFitPolicy: (
    policy: ((camera: Camera, viewport: Viewport, minZoom: number) => Camera | null) | null,
  ) => void;
  /**
   * Whether dragging empty space with the select tool pans (the map) rather
   * than drawing a selection marquee (a board). With it on, Shift+drag still
   * draws the marquee.
   */
  readonly setEmptyDragPans: (pans: boolean) => void;
  /** Zoom out stops at `floor` instead of the default (null restores it). */
  readonly setZoomFloor: (floor: number | null) => void;
  /** Every record including tombstones, for persistence. */
  readonly allElements: () => ReadonlyArray<Element>;
  /** Ids whose bounds intersect the viewport expanded by `marginPx` screen pixels. */
  readonly visibleIds: (marginPx: number) => ReadonlySet<ElementId>;
  readonly hitTest: (screen: Point) => ElementId | null;
  readonly worldPoint: (screen: Point) => Point;
  readonly screenPoint: (world: Point) => Point;
  readonly scene: Scene;
}

function nextVersion<E extends Element>(element: E, patch: Partial<E>): E {
  return { ...element, ...patch, version: element.version + 1 };
}

function constrainAngle(origin: Point, p: Point): Point {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return p;
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

export function createEditor(options: EditorOptions): Editor {
  const rng: Rng = createRng(options.seed);
  const scene = createScene(options.elements ?? []);
  const history = createHistory();
  const measure = options.measure;
  const listeners = new Set<() => void>();

  let camera: Camera = IDENTITY_CAMERA;
  let viewport: Viewport = options.viewport ?? { width: 1, height: 1 };
  let tool: Tool = "select";
  let toolLocked = false;
  let toolBeforeTemporary: Tool | null = null;
  let gesture: GestureState = { tool: "select", state: { kind: "idle" } };
  let selectedIds = new Set<ElementId>();
  let guides: ReadonlyArray<SnapGuide> = [];
  let marquee: Box | null = null;
  let editingTextId: ElementId | null = null;
  let bindingTargetId: ElementId | null = null;
  let style: ElementStyle = DEFAULT_STYLE;
  let textStyle: TextStyle = DEFAULT_TEXT_STYLE;
  let gridEnabled = false;
  let revision = 0;
  let snapshot: EditorState | null = null;
  /** Element records at gesture start, for resize and rotate. */
  let gestureStart = new Map<ElementId, Element>();
  let gestureStartBox: Box | null = null;
  /** Moving elements plus the arrows bound to them: never snap targets. */
  let snapExcluded = new Set<ElementId>();
  let pendingTextCreation = false;
  let externalTargets: ExternalTargets | null = null;
  let contentBounds: (() => Box | null) | null = null;
  let fitPolicy: ((camera: Camera, viewport: Viewport, minZoom: number) => Camera | null) | null =
    null;
  let emptyDragPans = false;
  /** The zoom floor: `MIN_ZOOM`, or lower when the external content cannot fit at it. */
  /** A floor the owner set (the map's: the least zoom its cards keep a title at), or null. */
  let zoomFloorOverride: number | null = null;
  const minZoom = (bounds = contentBounds?.() ?? null) => zoomFloorFor(bounds, viewport);
  /** `next`, raised to the owner's floor about `point` when it went under it. */
  const atFloor = (next: Camera, point: Point): Camera => {
    if (zoomFloorOverride === null || next.k >= zoomFloorOverride) return next;
    const k = zoomFloorOverride;
    return {
      x: point.x - ((point.x - next.x) * k) / next.k,
      y: point.y - ((point.y - next.y) * k) / next.k,
      k,
    };
  };

  /** A target outside the scene as a rectangle the binding code can measure. */
  const externalElement = (id: string): Element | null => {
    const box = externalTargets?.boxOf(id) ?? null;
    if (box === null) return null;
    return {
      id,
      type: "rectangle",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      angle: 0,
      index: "a0",
      seed: 1,
      version: 0,
      isDeleted: false,
      locked: true,
      groupIds: [],
      frameId: null,
      style: DEFAULT_STYLE,
    };
  };

  const notify = () => {
    revision += 1;
    snapshot = null;
    for (const listener of listeners) listener();
  };

  const worldPoint = (screen: Point) => screenToWorld(camera, screen);

  /**
   * A note that moved or resized attaches to the map node under its center,
   * or floats free when there is none. Notes on a plain board never attach.
   */
  const withNoteAttachment = (element: Element, current: Element | null): Element => {
    if (element.type !== "note" || externalTargets === null) return element;
    if (
      current !== null &&
      current.x === element.x &&
      current.y === element.y &&
      current.width === element.width &&
      current.height === element.height
    ) {
      return element;
    }
    const targetId = externalTargets.hitAt(boxCenter(elementBox(element)), 0);
    const box = targetId === null ? null : externalTargets.boxOf(targetId);
    if (targetId === null || box === null) {
      return element.attachment ? { ...element, attachment: null } : element;
    }
    return { ...element, attachment: { targetId, offset: [element.x - box.x, element.y - box.y] } };
  };

  /** Puts records, tracks them in the open batch and refreshes bound arrows. */
  const mutate = (elements: ReadonlyArray<Element>, refresh = true) => {
    if (elements.length === 0) return;
    const ids: ElementId[] = [];
    for (const proposed of elements) {
      // A gesture derives each step from its start record, so the version is
      // bumped past whatever the scene holds: caches key on it.
      const current = scene.get(proposed.id);
      const element = withNoteAttachment(proposed, current);
      const record =
        current && element.version <= current.version
          ? { ...element, version: current.version + 1 }
          : element;
      const previous = scene.put(record);
      history.track(record.id, previous, record);
      ids.push(record.id);
    }
    if (!refresh) return;
    for (const arrow of refreshBindingsFor(scene, ids, externalElement)) {
      const previous = scene.put(arrow);
      history.track(arrow.id, previous, arrow);
    }
  };

  const commit = () => {
    history.commit();
    notify();
  };

  const selectedElements = (): Element[] =>
    scene.live().filter((element) => selectedIds.has(element.id));

  const selectionBounds = (): Box | null => unionBoxes(selectedElements().map(elementBounds));

  /** Selecting one member of a group selects the whole outermost group. */
  const expandToGroups = (ids: Iterable<ElementId>): Set<ElementId> => {
    const result = new Set<ElementId>();
    const groups = new Set<string>();
    for (const id of ids) {
      const element = scene.get(id);
      if (!element || element.isDeleted) continue;
      result.add(id);
      const outermost = element.groupIds[element.groupIds.length - 1];
      if (outermost !== undefined) groups.add(outermost);
    }
    if (groups.size > 0) {
      for (const element of scene.live()) {
        const outermost = element.groupIds[element.groupIds.length - 1];
        if (outermost !== undefined && groups.has(outermost)) result.add(element.id);
      }
    }
    return result;
  };

  /** The selection plus the children of any selected frame. */
  const movingIds = (): Set<ElementId> => {
    const ids = new Set(selectedIds);
    for (const element of scene.live()) {
      if (element.frameId && ids.has(element.frameId)) ids.add(element.id);
    }
    return ids;
  };

  const applyEntry = (entry: HistoryEntry, direction: "undo" | "redo") => {
    const records = direction === "undo" ? entry.before : entry.after;
    for (const [id, record] of records) {
      if (record === null) scene.remove(id);
      else scene.put(record);
    }
    selectedIds = new Set([...selectedIds].filter((id) => scene.get(id)?.isDeleted === false));
    editingTextId = null;
    notify();
  };

  const hitThreshold = () => HIT_THRESHOLD_PX / camera.k;

  /**
   * The topmost element under `world` by precise geometry: a hollow shape on
   * its stroke only, so a press in its empty middle starts a marquee. When
   * nothing was hit, a selected element still drags from anywhere inside its box.
   */
  const hitAt = (world: Point, exclude?: ReadonlySet<ElementId>): Element | null => {
    const threshold = hitThreshold();
    const candidates = scene.search(
      expandBox({ x: world.x, y: world.y, width: 0, height: 0 }, threshold),
    );
    let best: Element | null = null;
    let fallback: Element | null = null;
    for (const id of candidates) {
      if (exclude?.has(id)) continue;
      const element = scene.get(id);
      if (!element || element.isDeleted || element.locked) continue;
      if (hitElement(element, world, threshold)) {
        if (best === null || element.index > best.index) best = element;
        continue;
      }
      if (
        selectedIds.has(id) &&
        hitElementBox(element, world, 0) &&
        (fallback === null || element.index > fallback.index)
      ) {
        fallback = element;
      }
    }
    return best ?? fallback;
  };

  /**
   * A binding target: the topmost bindable element whose box holds the point,
   * else an external target (a map node) under it. Drawings sit above the map.
   */
  const bindableAt = (world: Point, exclude: ReadonlySet<ElementId>): Element | null => {
    const threshold = hitThreshold();
    const candidates = scene.search(
      expandBox({ x: world.x, y: world.y, width: 0, height: 0 }, threshold),
    );
    let best: Element | null = null;
    for (const id of candidates) {
      if (exclude.has(id)) continue;
      const element = scene.get(id);
      if (!element || element.isDeleted || !isBindable(element)) continue;
      if (!hitElementBox(element, world, threshold)) continue;
      if (best === null || element.index > best.index) best = element;
    }
    if (best !== null || externalTargets === null) return best;
    const externalId = externalTargets.hitAt(world, threshold);
    return externalId === null ? null : externalElement(externalId);
  };

  /**
   * The binding of an arrow end pressed on `target`: by its center, so the end
   * sits on the target's edge facing the other end. A shape on a board and a
   * card on the map follow the same rule, wherever on them the press landed.
   */
  const bindTo = (target: Element) => centerBinding(target.id);

  const handlePositions = (): HandlePosition[] => {
    const selected = selectedElements();
    if (selected.length === 0) return [];
    const single = selected.length === 1 ? selected[0] : undefined;
    if (single && isLinearElement(single) && single.points.length === 2) {
      const [start, end] = linearWorldPoints(single);
      if (!start || !end) return [];
      return [
        { handle: "nw", point: start },
        { handle: "se", point: end },
      ];
    }
    const box = single ? elementBox(single) : selectionBounds();
    if (!box) return [];
    const angle = single ? single.angle : 0;
    const corners = rotatedBoxCorners(box, angle);
    const [nw, ne, se, sw] = corners;
    const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const rotateOffset = 24 / camera.k;
    const topMid = mid(nw, ne);
    const center = boxCenter(box);
    const toward = { x: topMid.x - center.x, y: topMid.y - center.y };
    const length = Math.hypot(toward.x, toward.y) || 1;
    const handles: HandlePosition[] = [
      { handle: "nw", point: nw },
      { handle: "ne", point: ne },
      { handle: "se", point: se },
      { handle: "sw", point: sw },
    ];
    if (!single || single.type !== "frame") {
      handles.push({
        handle: "rotate",
        point: {
          x: topMid.x + (toward.x / length) * rotateOffset,
          y: topMid.y + (toward.y / length) * rotateOffset,
        },
      });
    }
    if (single) {
      handles.push(
        { handle: "n", point: topMid },
        { handle: "e", point: mid(ne, se) },
        { handle: "s", point: mid(se, sw) },
        { handle: "w", point: mid(sw, nw) },
      );
    }
    return handles;
  };

  const handleAt = (world: Point): Handle | null => {
    const radius = HANDLE_RADIUS_PX / camera.k;
    for (const { handle, point } of handlePositions()) {
      if (distance(point, world) <= radius) return handle;
    }
    return null;
  };

  const baseFields = (at: Point) => ({
    id: rng.nextId("el"),
    x: at.x,
    y: at.y,
    width: 0,
    height: 0,
    angle: 0,
    index: scene.topIndex(),
    seed: rng.nextSeed(),
    version: 0,
    isDeleted: false,
    locked: false,
    groupIds: [] as string[],
    frameId: null,
    style,
  });

  const createBoxElement = (boxTool: Tool, at: Point): Element => {
    const base = baseFields(at);
    switch (boxTool) {
      case "ellipse":
        return { ...base, type: "ellipse" };
      case "diamond":
        return { ...base, type: "diamond" };
      case "frame":
        return {
          ...base,
          type: "frame",
          name: DEFAULT_FRAME_NAME,
          style: { ...style, fill: "none" },
        };
      case "note":
        return { ...base, type: "note", text: "", ...textStyle, textAlign: "center" };
      default:
        return { ...base, type: "rectangle" };
    }
  };

  const textBoxFor = (text: string, size: number, family: FontFamily, maxWidth: number | null) =>
    layoutText(text, { family, size }, measure, maxWidth);

  const startTranslate = (origin: Point) => {
    gestureStart = new Map();
    for (const id of movingIds()) {
      const element = scene.get(id);
      if (element) gestureStart.set(id, element);
    }
    gestureStartBox = unionBoxes([...gestureStart.values()].map(elementBounds));
    snapExcluded = new Set(gestureStart.keys());
    for (const id of gestureStart.keys()) {
      for (const arrowId of scene.boundTo(id)) snapExcluded.add(arrowId);
    }
    gesture = { tool: "select", state: { kind: "translating", origin, last: origin } };
  };

  const translateTo = (world: Point, modifiers: PointerModifiers) => {
    if (gesture.tool !== "select" || gesture.state.kind !== "translating") return;
    const { origin } = gesture.state;
    let dx = world.x - origin.x;
    let dy = world.y - origin.y;
    if (modifiers.shift) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    guides = [];
    if (gestureStartBox && !modifiers.alt) {
      const moved = { ...gestureStartBox, x: gestureStartBox.x + dx, y: gestureStartBox.y + dy };
      const candidates = scene
        .search(visibleWorldBox(camera, viewport))
        .filter((id) => !snapExcluded.has(id))
        .map((id) => scene.get(id))
        .filter((element): element is Element => element !== null && !element.isDeleted)
        .map(elementBounds);
      const snap = snapBox(moved, {
        grid: gridEnabled,
        threshold: SNAP_DISTANCE_PX / camera.k,
        candidates,
      });
      dx += snap.dx;
      dy += snap.dy;
      guides = snap.guides;
    }
    const changed: Element[] = [];
    for (const start of gestureStart.values()) {
      changed.push(nextVersion(start, { x: start.x + dx, y: start.y + dy }));
    }
    mutate(changed);
    notify();
  };

  const resizeTo = (world: Point, modifiers: PointerModifiers) => {
    if (gesture.tool !== "select" || gesture.state.kind !== "resizing" || !gestureStartBox) return;
    const { handle } = gesture.state;
    const start = gestureStartBox;
    const single = gestureStart.size === 1 ? [...gestureStart.values()][0] : undefined;
    // Work in the single element's unrotated frame.
    const local =
      single && single.angle !== 0 ? rotatePoint(world, boxCenter(start), -single.angle) : world;
    let x1 = start.x;
    let y1 = start.y;
    let x2 = start.x + start.width;
    let y2 = start.y + start.height;
    if (handle.includes("w")) x1 = local.x;
    if (handle.includes("e")) x2 = local.x;
    if (handle.includes("n")) y1 = local.y;
    if (handle.includes("s")) y2 = local.y;
    let next = boxFromCorners({ x: x1, y: y1 }, { x: x2, y: y2 });
    if (modifiers.shift && start.width > 0 && start.height > 0) {
      const ratio = start.width / start.height;
      const width = Math.max(next.width, next.height * ratio);
      const height = width / ratio;
      next = {
        x: handle.includes("w") ? x2 - width : x1,
        y: handle.includes("n") ? y2 - height : y1,
        width,
        height,
      };
    }
    const sx = start.width === 0 ? 1 : next.width / start.width;
    const sy = start.height === 0 ? 1 : next.height / start.height;
    const changed: Element[] = [];
    for (const original of gestureStart.values()) {
      const box = elementBox(original);
      const nx = next.x + (box.x - start.x) * sx;
      const ny = next.y + (box.y - start.y) * sy;
      if (isLinearElement(original)) {
        const points = original.points.map(([px, py]): [number, number] => [px * sx, py * sy]);
        changed.push(
          nextVersion(original, {
            x: next.x + (original.x - start.x) * sx,
            y: next.y + (original.y - start.y) * sy,
            width: box.width * sx,
            height: box.height * sy,
            points,
          }),
        );
      } else if (original.type === "freehand") {
        const points = original.points.map(([px, py, p]): [number, number, number] => [
          px * sx,
          py * sy,
          p,
        ]);
        changed.push(
          nextVersion(original, {
            x: next.x + (original.x - start.x) * sx,
            y: next.y + (original.y - start.y) * sy,
            width: box.width * sx,
            height: box.height * sy,
            points,
          }),
        );
      } else if (original.type === "text") {
        const fontSize = Math.max(4, original.fontSize * Math.min(sx, sy));
        const layout = textBoxFor(original.text, fontSize, original.fontFamily, null);
        changed.push(
          nextVersion(original, {
            x: nx,
            y: ny,
            width: layout.width,
            height: layout.height,
            fontSize,
          }),
        );
      } else {
        changed.push(
          nextVersion(original, { x: nx, y: ny, width: box.width * sx, height: box.height * sy }),
        );
      }
    }
    mutate(changed);
    notify();
  };

  const rotateTo = (world: Point) => {
    if (gesture.tool !== "select" || gesture.state.kind !== "rotating" || !gestureStartBox) return;
    const center = boxCenter(gestureStartBox);
    const { origin } = gesture.state;
    const delta =
      Math.atan2(world.y - center.y, world.x - center.x) -
      Math.atan2(origin.y - center.y, origin.x - center.x);
    const changed: Element[] = [];
    for (const original of gestureStart.values()) {
      const box = elementBox(original);
      const movedCenter = rotatePoint(boxCenter(box), center, delta);
      changed.push(
        nextVersion(original, {
          x: original.x + movedCenter.x - boxCenter(box).x,
          y: original.y + movedCenter.y - boxCenter(box).y,
          angle: original.angle + delta,
        }),
      );
    }
    mutate(changed);
    notify();
  };

  const dragEndTo = (world: Point, modifiers: PointerModifiers) => {
    if (gesture.tool !== "select" || gesture.state.kind !== "draggingEnd") return;
    const { id, end } = gesture.state;
    const element = scene.get(id);
    if (!element || !isLinearElement(element)) return;
    const points = element.points.map(([px, py]) => ({ x: element.x + px, y: element.y + py }));
    const other = end === "start" ? points[points.length - 1] : points[0];
    const target = other ? constrainOrRaw(other, world, modifiers) : world;
    const bindTarget = bindableAt(target, new Set([id]));
    bindingTargetId = bindTarget?.id ?? null;
    const binding = bindTarget ? bindTo(bindTarget) : null;
    const absolute = points.map((p, i) =>
      (end === "start" ? i === 0 : i === points.length - 1) ? target : p,
    );
    const origin = absolute[0] as Point;
    mutate([
      nextVersion(element, {
        x: origin.x,
        y: origin.y,
        points: absolute.map((p): [number, number] => [p.x - origin.x, p.y - origin.y]),
        ...(end === "start" ? { startBinding: binding } : { endBinding: binding }),
      }),
    ]);
    notify();
  };

  const constrainOrRaw = (origin: Point, p: Point, modifiers: PointerModifiers) =>
    modifiers.shift ? constrainAngle(origin, p) : p;

  const finishSelectGesture = (world: Point, modifiers: PointerModifiers) => {
    if (gesture.tool !== "select") return;
    const state = gesture.state;
    switch (state.kind) {
      case "translating":
      case "resizing":
      case "rotating":
      case "draggingEnd": {
        gestureStart = new Map();
        gestureStartBox = null;
        guides = [];
        bindingTargetId = null;
        history.commit();
        break;
      }
      case "brushing": {
        const box = boxFromCorners(state.origin, world);
        const inside = scene
          .search(box)
          .map((id) => scene.get(id))
          .filter(
            (element): element is Element =>
              element !== null &&
              !element.isDeleted &&
              !element.locked &&
              boxContainsBox(box, elementBounds(element)),
          )
          .map((element) => element.id);
        const next = modifiers.shift ? new Set([...selectedIds, ...inside]) : new Set(inside);
        selectedIds = expandToGroups(next);
        marquee = null;
        break;
      }
      case "pointingShape": {
        if (modifiers.shift && state.wasSelected) {
          selectedIds = new Set([...selectedIds].filter((id) => id !== state.id));
        } else if (!modifiers.shift) {
          selectedIds = expandToGroups([state.id]);
        }
        break;
      }
      default:
        break;
    }
    gesture = { tool: "select", state: { kind: "idle" } };
    notify();
  };

  const startEditingText = (id: ElementId) => {
    editingTextId = id;
    selectedIds = new Set([id]);
    gesture = { tool: "select", state: { kind: "editingText", id } };
    notify();
  };

  const commitText = (id: ElementId, text: string) => {
    const element = scene.get(id);
    editingTextId = null;
    gesture = { tool: tool === "select" ? "select" : "select", state: { kind: "idle" } };
    if (element?.type === "frame") {
      // A frame keeps a name: an emptied one goes back to the default.
      const name = text.trim().length === 0 ? DEFAULT_FRAME_NAME : text.trim();
      selectedIds = new Set([id]);
      if (name === element.name) {
        notify();
        return;
      }
      mutate([nextVersion(element, { name })]);
      commit();
      return;
    }
    if (!element || !isTextBearing(element)) {
      notify();
      return;
    }
    if (element.type === "text") {
      if (text.trim().length === 0) {
        if (pendingTextCreation) {
          scene.remove(id);
          history.discard();
        } else {
          mutate([nextVersion(element, { isDeleted: true })]);
        }
        selectedIds = new Set();
        pendingTextCreation = false;
        commit();
        return;
      }
      const layout = textBoxFor(text, element.fontSize, element.fontFamily, null);
      mutate([nextVersion(element, { text, width: layout.width, height: layout.height })]);
    } else {
      mutate([nextVersion(element, { text })]);
    }
    pendingTextCreation = false;
    selectedIds = new Set([id]);
    if (!toolLocked) tool = "select";
    commit();
  };

  const setTool = (next: Tool, setOptions?: { readonly locked?: boolean }) => {
    if (editingTextId !== null) return;
    tool = next;
    toolLocked = setOptions?.locked ?? false;
    toolBeforeTemporary = null;
    gesture = { tool: next, state: { kind: "idle" } } as GestureState;
    if (next !== "select") selectedIds = new Set();
    notify();
  };

  const pointerDown = (screen: Point, modifiers: PointerModifiers = NO_MODIFIERS) => {
    const world = worldPoint(screen);
    if (editingTextId !== null) return;
    switch (tool) {
      case "select": {
        const handle = selectedIds.size > 0 ? handleAt(world) : null;
        const single = selectedIds.size === 1 ? scene.get([...selectedIds][0] as string) : null;
        if (handle && single && isLinearElement(single) && single.points.length === 2) {
          gestureStart = new Map([[single.id, single]]);
          gesture = {
            tool: "select",
            state: { kind: "draggingEnd", id: single.id, end: handle === "nw" ? "start" : "end" },
          };
          return;
        }
        if (handle === "rotate") {
          gestureStart = new Map(selectedElements().map((element) => [element.id, element]));
          gestureStartBox = selectionBounds();
          gesture = { tool: "select", state: { kind: "rotating", origin: world, startAngle: 0 } };
          return;
        }
        if (handle) {
          gestureStart = new Map(selectedElements().map((element) => [element.id, element]));
          gestureStartBox = single ? elementBox(single) : selectionBounds();
          gesture = { tool: "select", state: { kind: "resizing", handle, origin: world } };
          return;
        }
        const hit = hitAt(world);
        if (hit) {
          const wasSelected = selectedIds.has(hit.id);
          if (!wasSelected) {
            selectedIds = modifiers.shift
              ? new Set([...selectedIds, ...expandToGroups([hit.id])])
              : expandToGroups([hit.id]);
          }
          gesture = {
            tool: "select",
            state: { kind: "pointingShape", origin: world, id: hit.id, wasSelected },
          };
          notify();
          return;
        }
        if (!modifiers.shift) selectedIds = new Set();
        if (emptyDragPans && !modifiers.shift) {
          gesture = { tool: "hand", state: { kind: "dragging", last: screen } };
          notify();
          return;
        }
        gesture = { tool: "select", state: { kind: "pointingCanvas", origin: world } };
        notify();
        return;
      }
      case "hand": {
        gesture = { tool: "hand", state: { kind: "dragging", last: screen } };
        return;
      }
      case "rectangle":
      case "ellipse":
      case "diamond":
      case "frame":
      case "note": {
        const element = createBoxElement(tool, world);
        mutate([element], false);
        gesture = { tool, state: { kind: "dragging", id: element.id, origin: world } };
        notify();
        return;
      }
      case "line":
      case "arrow": {
        const base = baseFields(world);
        const startTarget = bindableAt(world, new Set());
        const startBinding = startTarget ? bindTo(startTarget) : null;
        const element: Element =
          tool === "arrow"
            ? {
                ...base,
                type: "arrow",
                points: [
                  [0, 0],
                  [0, 0],
                ],
                startBinding,
                endBinding: null,
                startArrowhead: "none",
                endArrowhead: "arrow",
              }
            : {
                ...base,
                type: "line",
                points: [
                  [0, 0],
                  [0, 0],
                ],
                startBinding,
                endBinding: null,
              };
        mutate([element], false);
        gesture = { tool, state: { kind: "dragging", id: element.id } };
        notify();
        return;
      }
      case "freehand": {
        const base = baseFields(world);
        const element: Element = {
          ...base,
          type: "freehand",
          points: [[0, 0, modifiers.pressure]],
          simulatePressure: modifiers.pressure === 0.5,
        };
        mutate([element], false);
        gesture = { tool: "freehand", state: { kind: "drawing", id: element.id } };
        notify();
        return;
      }
      case "text": {
        const hit = hitAt(world);
        if (hit && isTextBearing(hit)) {
          startEditingText(hit.id);
          return;
        }
        const base = baseFields(world);
        const layout = textBoxFor("", textStyle.fontSize, textStyle.fontFamily, null);
        const element: Element = {
          ...base,
          type: "text",
          text: "",
          ...textStyle,
          width: layout.width,
          height: layout.height,
        };
        pendingTextCreation = true;
        mutate([element], false);
        startEditingText(element.id);
        return;
      }
      case "eraser": {
        const hit = hitAt(world);
        gesture = {
          tool: "eraser",
          state: { kind: "dragging", hit: new Set(hit ? [hit.id] : []) },
        };
        notify();
        return;
      }
      case "image":
        return;
    }
  };

  const pointerMove = (screen: Point, modifiers: PointerModifiers = NO_MODIFIERS) => {
    const world = worldPoint(screen);
    switch (gesture.tool) {
      case "select": {
        const state = gesture.state;
        if (state.kind === "pointingShape" || state.kind === "pointingCanvas") {
          const moved = distance(worldToScreen(camera, state.origin), screen) >= DRAG_THRESHOLD_PX;
          if (!moved) return;
          if (state.kind === "pointingShape") {
            startTranslate(state.origin);
            translateTo(world, modifiers);
          } else {
            gesture = {
              tool: "select",
              state: { kind: "brushing", origin: state.origin, current: world },
            };
            marquee = boxFromCorners(state.origin, world);
            notify();
          }
          return;
        }
        if (state.kind === "translating") {
          translateTo(world, modifiers);
          return;
        }
        if (state.kind === "brushing") {
          gesture = { tool: "select", state: { ...state, current: world } };
          marquee = boxFromCorners(state.origin, world);
          notify();
          return;
        }
        if (state.kind === "resizing") {
          resizeTo(world, modifiers);
          return;
        }
        if (state.kind === "rotating") {
          rotateTo(world);
          return;
        }
        if (state.kind === "draggingEnd") {
          dragEndTo(world, modifiers);
          return;
        }
        return;
      }
      case "hand": {
        if (gesture.state.kind !== "dragging") return;
        const { last } = gesture.state;
        camera = panCamera(camera, screen.x - last.x, screen.y - last.y);
        gesture = { tool: "hand", state: { kind: "dragging", last: screen } };
        notify();
        return;
      }
      case "rectangle":
      case "ellipse":
      case "diamond":
      case "frame":
      case "note": {
        if (gesture.state.kind !== "dragging") return;
        const element = scene.get(gesture.state.id);
        if (!element) return;
        const { origin } = gesture.state;
        let corner = world;
        if (modifiers.shift) {
          const size = Math.max(Math.abs(world.x - origin.x), Math.abs(world.y - origin.y));
          corner = {
            x: origin.x + Math.sign(world.x - origin.x || 1) * size,
            y: origin.y + Math.sign(world.y - origin.y || 1) * size,
          };
        }
        let box = boxFromCorners(origin, corner);
        if (modifiers.alt) {
          box = {
            x: origin.x - box.width,
            y: origin.y - box.height,
            width: box.width * 2,
            height: box.height * 2,
          };
          if (corner.x < origin.x || corner.y < origin.y)
            box = boxFromCorners(
              { x: origin.x - (corner.x - origin.x), y: origin.y - (corner.y - origin.y) },
              corner,
            );
        }
        mutate(
          [nextVersion(element, { x: box.x, y: box.y, width: box.width, height: box.height })],
          false,
        );
        notify();
        return;
      }
      case "line":
      case "arrow": {
        if (gesture.state.kind !== "dragging") return;
        const element = scene.get(gesture.state.id);
        if (!element || !isLinearElement(element)) return;
        const origin = { x: element.x, y: element.y };
        const end = constrainOrRaw(origin, world, modifiers);
        const target = bindableAt(end, new Set([element.id]));
        bindingTargetId = target?.id ?? null;
        const points = element.points.map((p) => p);
        points[points.length - 1] = [end.x - origin.x, end.y - origin.y];
        mutate(
          [
            nextVersion(element, {
              points,
              endBinding: target ? centerBinding(target.id) : null,
            }),
          ],
          false,
        );
        notify();
        return;
      }
      case "freehand": {
        if (gesture.state.kind !== "drawing") return;
        const element = scene.get(gesture.state.id);
        if (!element || element.type !== "freehand") return;
        const last = element.points[element.points.length - 1];
        const px = world.x - element.x;
        const py = world.y - element.y;
        if (last && last[0] === px && last[1] === py) return;
        mutate(
          [nextVersion(element, { points: [...element.points, [px, py, modifiers.pressure]] })],
          false,
        );
        notify();
        return;
      }
      case "eraser": {
        if (gesture.state.kind !== "dragging") return;
        const hit = hitAt(world);
        if (!hit || gesture.state.hit.has(hit.id)) return;
        gesture = {
          tool: "eraser",
          state: { kind: "dragging", hit: new Set([...gesture.state.hit, hit.id]) },
        };
        notify();
        return;
      }
      default:
        return;
    }
  };

  const finishCreation = (id: ElementId, keep: boolean) => {
    const element = scene.get(id);
    if (!element) return;
    if (!keep) {
      scene.remove(id);
      history.discard();
      gesture = { tool, state: { kind: "idle" } } as GestureState;
      notify();
      return;
    }
    // Refresh bindings now that the final geometry is known.
    mutate([element]);
    history.commit();
    selectedIds = new Set([id]);
    if (!toolLocked) tool = "select";
    gesture = { tool, state: { kind: "idle" } } as GestureState;
    bindingTargetId = null;
    notify();
  };

  const pointerUp = (screen: Point, modifiers: PointerModifiers = NO_MODIFIERS) => {
    const world = worldPoint(screen);
    switch (gesture.tool) {
      case "select":
        finishSelectGesture(world, modifiers);
        return;
      case "hand":
        // A pan that started on empty space with the select tool goes back to it.
        gesture = { tool, state: { kind: "idle" } } as GestureState;
        notify();
        return;
      case "rectangle":
      case "ellipse":
      case "diamond":
      case "frame":
      case "note": {
        if (gesture.state.kind !== "dragging") return;
        const element = scene.get(gesture.state.id);
        if (!element) return;
        const tiny =
          element.width * camera.k < DRAG_THRESHOLD_PX &&
          element.height * camera.k < DRAG_THRESHOLD_PX;
        if (tiny) {
          if (element.type === "note") {
            mutate(
              [nextVersion(element, { width: DEFAULT_NOTE_SIZE, height: DEFAULT_NOTE_SIZE })],
              false,
            );
          } else {
            finishCreation(element.id, false);
            return;
          }
        }
        if (element.type === "frame") {
          const frameBox = elementBox(scene.get(element.id) ?? element);
          const children = scene
            .search(frameBox)
            .map((id) => scene.get(id))
            .filter(
              (child): child is Element =>
                child !== null &&
                !child.isDeleted &&
                child.id !== element.id &&
                child.type !== "frame" &&
                boxContainsBox(frameBox, elementBounds(child)),
            )
            .map((child) => nextVersion(child, { frameId: element.id }));
          mutate(children, false);
        }
        const id = element.id;
        finishCreation(id, true);
        if (element.type === "note") startEditingText(id);
        return;
      }
      case "line":
      case "arrow": {
        if (gesture.state.kind !== "dragging") return;
        const element = scene.get(gesture.state.id);
        if (!element || !isLinearElement(element)) return;
        const last = element.points[element.points.length - 1] ?? [0, 0];
        const length = Math.hypot(last[0], last[1]) * camera.k;
        finishCreation(element.id, length >= DRAG_THRESHOLD_PX);
        return;
      }
      case "freehand": {
        if (gesture.state.kind !== "drawing") return;
        const element = scene.get(gesture.state.id);
        if (!element || element.type !== "freehand") return;
        if (element.points.length === 1) {
          const [p] = element.points;
          mutate(
            [
              nextVersion(element, {
                points: [p as [number, number, number], [0.1, 0.1, p?.[2] ?? 0.5]],
              }),
            ],
            false,
          );
        }
        const bounds = elementBox(scene.get(element.id) ?? element);
        mutate(
          [
            nextVersion(scene.get(element.id) ?? element, {
              width: bounds.width,
              height: bounds.height,
            }),
          ],
          false,
        );
        const id = element.id;
        const locked = toolLocked;
        finishCreation(id, true);
        // Freehand stays armed: a pen keeps drawing strokes.
        if (!locked) {
          tool = "freehand";
          gesture = { tool: "freehand", state: { kind: "idle" } };
          selectedIds = new Set();
          notify();
        }
        return;
      }
      case "eraser": {
        if (gesture.state.kind !== "dragging") return;
        const hits = [...gesture.state.hit]
          .map((id) => scene.get(id))
          .filter((element): element is Element => element !== null && !element.isDeleted)
          .map((element) => nextVersion(element, { isDeleted: true }));
        const erased = gesture.state.hit;
        mutate(hits, false);
        history.commit();
        selectedIds = new Set([...selectedIds].filter((id) => !erased.has(id)));
        gesture = { tool: "eraser", state: { kind: "idle" } };
        notify();
        return;
      }
      default:
        return;
    }
  };

  const pointerCancel = () => {
    if (history.isBatching()) {
      for (const [id, record] of history.discard()) {
        if (record === null) scene.remove(id);
        else scene.put(record);
      }
    }
    gestureStart = new Map();
    gestureStartBox = null;
    guides = [];
    marquee = null;
    bindingTargetId = null;
    gesture = { tool, state: { kind: "idle" } } as GestureState;
    notify();
  };

  /** The topmost frame whose name is drawn under `world`, or null. */
  const frameLabelAt = (world: Point): Element | null => {
    let best: Element | null = null;
    for (const element of scene.live()) {
      if (element.type !== "frame" || element.locked) continue;
      if (!boxContainsPoint(frameLabelBox(element), world)) continue;
      if (best === null || element.index > best.index) best = element;
    }
    return best;
  };

  const doubleClick = (screen: Point) => {
    if (editingTextId !== null) return;
    const world = worldPoint(screen);
    const label = frameLabelAt(world);
    if (label) {
      startEditingText(label.id);
      return;
    }
    const hit = hitAt(world);
    if (hit && isTextBearing(hit)) {
      startEditingText(hit.id);
      return;
    }
    if (hit) return;
    const previous = tool;
    tool = "text";
    pointerDown(screen);
    if (!toolLocked) tool = previous === "text" ? "text" : "select";
  };

  const wheel = (screen: Point, input: WheelInput) => {
    if (input.ctrl || input.meta) {
      camera = atFloor(
        zoomCameraTo(camera, camera.k * wheelZoomFactor(input.deltaY, camera.k), screen, minZoom()),
        screen,
      );
    } else if (input.shift) {
      camera = panCamera(camera, -(input.deltaX || input.deltaY), 0);
    } else {
      camera = panCamera(camera, -input.deltaX, -input.deltaY);
    }
    notify();
  };

  const escape = () => {
    if (editingTextId !== null) {
      cancelText();
      return;
    }
    if (gesture.state.kind !== "idle") {
      pointerCancel();
      return;
    }
    if (selectedIds.size > 0) {
      selectedIds = new Set();
    } else if (tool !== "select") {
      tool = "select";
      gesture = { tool: "select", state: { kind: "idle" } };
    }
    notify();
  };

  const cancelText = () => {
    const id = editingTextId;
    editingTextId = null;
    gesture = { tool: "select", state: { kind: "idle" } };
    if (id !== null && pendingTextCreation) {
      scene.remove(id);
      history.discard();
      selectedIds = new Set();
    }
    pendingTextCreation = false;
    if (!toolLocked) tool = "select";
    notify();
  };

  const withSelection = (run: (selected: Element[]) => ReadonlyArray<Element>) => {
    const selected = selectedElements();
    if (selected.length === 0) return;
    mutate(run(selected));
    commit();
  };

  const zOrder = (direction: "forward" | "backward" | "front" | "back") => {
    const all = scene.all();
    const selected = selectedElements();
    if (selected.length === 0) return;
    const selectedSet = new Set(selected.map((element) => element.id));
    const changed: Element[] = [];
    if (direction === "front") {
      let above = all[all.length - 1]?.index ?? null;
      for (const element of selected) {
        const key = keyBetween(above, null);
        changed.push(nextVersion(element, { index: key }));
        above = key;
      }
    } else if (direction === "back") {
      let below = all[0]?.index ?? null;
      for (const element of selected.toReversed()) {
        const key = keyBetween(null, below);
        changed.push(nextVersion(element, { index: key }));
        below = key;
      }
    } else {
      const live = scene.live();
      for (const element of selected) {
        const position = live.findIndex((candidate) => candidate.id === element.id);
        const neighbor = direction === "forward" ? live[position + 1] : live[position - 1];
        if (!neighbor || selectedSet.has(neighbor.id)) continue;
        const beyond = direction === "forward" ? live[position + 2] : live[position - 2];
        const key =
          direction === "forward"
            ? keyBetween(neighbor.index, beyond?.index ?? null)
            : keyBetween(beyond?.index ?? null, neighbor.index);
        changed.push(nextVersion(element, { index: key }));
      }
    }
    mutate(changed, false);
    commit();
  };

  const getState = (): EditorState => {
    if (snapshot) return snapshot;
    snapshot = {
      elements: scene.live(),
      selectedIds,
      tool,
      toolLocked,
      camera,
      zoomFloor: zoomFloorOverride ?? Math.max(1e-6, Math.min(minZoom(), MIN_ZOOM)),
      viewport,
      gesture,
      guides,
      marquee,
      editingTextId,
      bindingTargetId,
      style,
      textStyle,
      gridEnabled,
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      selectionBox: selectionBounds(),
      handles: handlePositions(),
      revision,
    };
    return snapshot;
  };

  return {
    scene,
    getState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setViewport: (next) => {
      if (next.width === viewport.width && next.height === viewport.height) return;
      viewport = next;
      notify();
    },
    setTool,
    holdHandTool: () => {
      if (tool === "hand" || toolBeforeTemporary !== null || editingTextId !== null) return;
      toolBeforeTemporary = tool;
      tool = "hand";
      gesture = { tool: "hand", state: { kind: "idle" } };
      notify();
    },
    releaseTemporaryTool: () => {
      if (toolBeforeTemporary === null) return;
      tool = toolBeforeTemporary;
      toolBeforeTemporary = null;
      gesture = { tool, state: { kind: "idle" } } as GestureState;
      notify();
    },
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    doubleClick,
    wheel,
    escape,
    undo: () => {
      const entry = history.undo();
      if (entry) applyEntry(entry, "undo");
    },
    redo: () => {
      const entry = history.redo();
      if (entry) applyEntry(entry, "redo");
    },
    selectAll: () => {
      selectedIds = new Set(
        scene
          .live()
          .filter((element) => !element.locked)
          .map((element) => element.id),
      );
      if (tool !== "select") tool = "select";
      gesture = { tool: "select", state: { kind: "idle" } };
      notify();
    },
    select: (ids) => {
      selectedIds = expandToGroups(ids);
      notify();
    },
    deleteSelection: () => {
      withSelection((selected) => {
        const ids = movingIds();
        return scene
          .live()
          .filter((element) => ids.has(element.id) || selected.includes(element))
          .map((element) => nextVersion(element, { isDeleted: true }));
      });
      selectedIds = new Set();
      notify();
    },
    duplicateSelection: () => {
      const selected = selectedElements();
      if (selected.length === 0) return;
      const all = scene.all();
      const result = duplicateElements(selected, {
        rng,
        aboveIndex: all[all.length - 1]?.index ?? null,
        offset: 10,
      });
      mutate(result.elements);
      selectedIds = new Set(result.elements.map((element) => element.id));
      commit();
    },
    groupSelection: () => withSelection((selected) => groupElements(selected, rng.nextId("g"))),
    ungroupSelection: () => withSelection((selected) => ungroupElements(selected)),
    alignSelection: (edge) => withSelection((selected) => alignElements(selected, edge)),
    distributeSelection: (axis) => withSelection((selected) => distributeElements(selected, axis)),
    nudgeSelection: (dx, dy) => {
      const ids = movingIds();
      if (ids.size === 0) return;
      mutate(
        [...ids]
          .map((id) => scene.get(id))
          .filter((element): element is Element => element !== null && !element.isDeleted)
          .map((element) => nextVersion(element, { x: element.x + dx, y: element.y + dy })),
      );
      commit();
    },
    bringForward: () => zOrder("forward"),
    sendBackward: () => zOrder("backward"),
    bringToFront: () => zOrder("front"),
    sendToBack: () => zOrder("back"),
    setStyle: (patch) => {
      style = { ...style, ...patch };
      // Sketch text is handwritten; Clean text uses the interface font. Monospace stays.
      const family: FontFamily | null =
        patch.roughness === undefined ? null : patch.roughness > 0 ? "hand" : "sans";
      if (family !== null && textStyle.fontFamily !== "mono") {
        textStyle = { ...textStyle, fontFamily: family };
      }
      const selected = selectedElements();
      if (selected.length > 0) {
        mutate(
          selected.map((element) => {
            const restyled = { style: { ...element.style, ...patch } };
            if (family === null || !isTextBearing(element) || element.fontFamily === "mono") {
              return nextVersion(element, restyled);
            }
            if (element.type === "text") {
              const layout = textBoxFor(element.text, element.fontSize, family, null);
              return nextVersion(element, {
                ...restyled,
                fontFamily: family,
                width: layout.width,
                height: layout.height,
              });
            }
            return nextVersion(element, { ...restyled, fontFamily: family });
          }),
        );
        commit();
        return;
      }
      notify();
    },
    setTextStyle: (patch) => {
      textStyle = { ...textStyle, ...patch };
      const selected = selectedElements().filter(isTextBearing);
      if (selected.length > 0) {
        mutate(
          selected.map((element) => {
            const next = { ...element, ...patch };
            if (next.type === "text") {
              const layout = textBoxFor(next.text, next.fontSize, next.fontFamily, null);
              return nextVersion(element, { ...patch, width: layout.width, height: layout.height });
            }
            return nextVersion(element, patch);
          }),
        );
        commit();
        return;
      }
      notify();
    },
    toggleGrid: () => {
      gridEnabled = !gridEnabled;
      notify();
    },
    zoomIn: () => {
      camera = zoomCameraTo(camera, camera.k * (1 + ZOOM_STEP), viewportCenter(viewport));
      notify();
    },
    zoomOut: () => {
      const center = viewportCenter(viewport);
      camera = atFloor(zoomCameraTo(camera, camera.k / (1 + ZOOM_STEP), center, minZoom()), center);
      notify();
    },
    zoomReset: () => {
      camera = zoomCameraTo(camera, 1, viewportCenter(viewport));
      notify();
    },
    zoomToFit: () => {
      const bounds = unionBoxes(
        [scene.bounds(), contentBounds?.() ?? null].filter((box): box is Box => box !== null),
      );
      const chosen = fitPolicy?.(camera, viewport, minZoom(contentBounds ? bounds : null)) ?? null;
      if (chosen !== null) {
        camera = chosen;
        notify();
        return;
      }
      // A board keeps the `MIN_ZOOM` floor; a map's content lowers it until the map fits.
      camera = bounds
        ? fitCameraToBox(bounds, viewport, { minZoom: minZoom(contentBounds ? bounds : null) })
        : { ...IDENTITY_CAMERA };
      notify();
    },
    pan: (dx, dy) => {
      camera = panCamera(camera, dx, dy);
      notify();
    },
    setCamera: (next) => {
      camera = { x: next.x, y: next.y, k: normalizeZoom(next.k, minZoom()) };
      notify();
    },
    editSelectedText: () => {
      if (selectedIds.size !== 1) return;
      const element = scene.get([...selectedIds][0] as string);
      if (element && (isTextBearing(element) || element.type === "frame")) {
        startEditingText(element.id);
      }
    },
    commitText,
    cancelText,
    insertImage: (fileId, naturalWidth, naturalHeight) => {
      const visible = visibleWorldBox(camera, viewport);
      const maxWidth = visible.width * 0.6;
      const maxHeight = visible.height * 0.6;
      const scale = Math.min(
        1,
        maxWidth / Math.max(1, naturalWidth),
        maxHeight / Math.max(1, naturalHeight),
      );
      const width = naturalWidth * scale;
      const height = naturalHeight * scale;
      const center = boxCenter(visible);
      const element: Element = {
        ...baseFields({ x: center.x - width / 2, y: center.y - height / 2 }),
        type: "image",
        fileId,
        width,
        height,
      };
      mutate([element], false);
      selectedIds = new Set([element.id]);
      tool = "select";
      gesture = { tool: "select", state: { kind: "idle" } };
      commit();
      return element.id;
    },
    loadElements: (elements) => {
      for (const existing of scene.all()) scene.remove(existing.id);
      for (const element of elements) scene.put(element);
      selectedIds = new Set();
      editingTextId = null;
      gesture = { tool, state: { kind: "idle" } } as GestureState;
      // A load is not an edit: nothing to undo.
      history.clear();
      notify();
    },
    allElements: () => scene.all(),
    setExternalTargets: (targets) => {
      externalTargets = targets;
    },
    refreshExternalBindings: () => {
      // A layout change is not an edit: notes and arrows follow without a history entry.
      const bound = new Set<ElementId>();
      let moved = false;
      for (const element of scene.live()) {
        if (element.type === "note" && element.attachment) {
          const { targetId, offset } = element.attachment;
          const box = scene.get(targetId) === null ? externalTargets?.boxOf(targetId) : null;
          // A node that is not drawn right now keeps the note where it is.
          if (!box) continue;
          const x = box.x + offset[0];
          const y = box.y + offset[1];
          if (x === element.x && y === element.y) continue;
          scene.put({ ...element, x, y, version: element.version + 1 });
          bound.add(element.id);
          moved = true;
          continue;
        }
        if (!isLinearElement(element)) continue;
        for (const binding of [element.startBinding, element.endBinding]) {
          if (binding && scene.get(binding.targetId) === null) bound.add(binding.targetId);
        }
      }
      if (bound.size === 0) return;
      const changed = refreshBindingsFor(scene, bound, externalElement);
      for (const arrow of changed) scene.put(arrow);
      if (moved || changed.length > 0) notify();
    },
    setContentBounds: (bounds) => {
      contentBounds = bounds;
    },
    setFitPolicy: (policy) => {
      fitPolicy = policy;
    },
    setEmptyDragPans: (pans) => {
      emptyDragPans = pans;
    },
    setZoomFloor: (floor) => {
      zoomFloorOverride = floor;
      if (floor !== null && camera.k < floor) {
        camera = atFloor(camera, viewportCenter(viewport));
        notify();
      }
    },
    visibleIds: (marginPx) =>
      new Set(scene.search(expandBox(visibleWorldBox(camera, viewport), marginPx / camera.k))),
    hitTest: (screen) => hitAt(worldPoint(screen))?.id ?? null,
    worldPoint,
    screenPoint: (world) => worldToScreen(camera, world),
  };
}
