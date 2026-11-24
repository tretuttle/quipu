import { createEditor, type Editor, type EditorState } from "@quipu/canvas/editor";
import type { Element } from "@quipu/canvas/elements";
import { boxesIntersect, expandBox, type Box, type Point } from "@quipu/canvas/geometry";
import { MAX_ZOOM, visibleWorldBox } from "@quipu/canvas/camera";
import {
  elementBounds,
  elementBox,
  FRAME_LABEL_FONT_SIZE,
  frameLabelBox,
} from "@quipu/canvas/hitTest";
import {
  decodeDrawingJson,
  DRAWING_SCHEMA_VERSION,
  encodeDrawingJson,
  makeDrawingDocument,
  NewerDrawingError,
} from "@quipu/canvas/persistence";
import { createRenderer, type RenderedElement, type Renderer } from "@quipu/canvas/render";
import { GRID_SIZE } from "@quipu/canvas/snapping";
import { TOOL_LABELS, type PointerModifiers, type Tool } from "@quipu/canvas/tools";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { registerBoardEditor } from "../../boards/boardEditorRegistry";
import { putAsset, readAsset, readDrawingScene, writeDrawing } from "../../boards/drawingStore";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { stackedToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fontFamilyFor, measureBoardText, paintFor } from "./boardPaint";
import { BoardStylePanel } from "./BoardStylePanel";
import { BoardToolbar } from "./BoardToolbar";
import { loadHandFont, needsHandFont } from "./handFont";

/** Screen pixels beyond the viewport that stay mounted, so a small pan mounts nothing. */
const MOUNT_MARGIN_PX = 400;
const SAVE_DEBOUNCE_MS = 300;
const HANDLE_SIZE_PX = 8;

type SaveStatus = "loading" | "saved" | "saving" | "error" | "readonly";

/**
 * What the save status says. A board is the drawing, so it says "Saved"; on a
 * document's map the drawings are a layer over the file, so they are named.
 */
const SAVE_STATUS_TEXT = {
  board: {
    loading: "Opening…",
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
    readonly: "Saved by a newer Quipu; changes will not be saved.",
  },
  layer: {
    loading: "Opening drawings…",
    saving: "Saving drawings…",
    saved: "Drawings saved",
    error: "Drawings not saved",
    readonly: "Drawings saved by a newer Quipu; changes will not be saved.",
  },
} as const satisfies Record<"board" | "layer", Record<SaveStatus, string>>;

function modifiersFrom(event: ReactPointerEvent | PointerEvent): PointerModifiers {
  return {
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    pressure: event.pointerType === "mouse" ? 0.5 : event.pressure || 0.5,
  };
}

/** Elements are memoized on their record, so a pan re-renders none of them. */
function ElementNode({
  element,
  renderer,
  assetUrl,
}: {
  readonly element: Element;
  readonly renderer: Renderer;
  readonly assetUrl: string | null;
}) {
  const rendered: RenderedElement = renderer.render(element);
  return (
    <g
      data-element-id={element.id}
      data-element-type={element.type}
      opacity={rendered.opacity === 1 ? undefined : rendered.opacity}
      transform={
        rendered.rotation
          ? `rotate(${rendered.rotation.degrees} ${rendered.rotation.cx} ${rendered.rotation.cy})`
          : undefined
      }
    >
      {rendered.primitives.map((primitive) => {
        switch (primitive.kind) {
          case "path":
            return (
              <path
                key={primitive.key}
                d={primitive.d}
                stroke={paintFor(primitive.stroke)}
                fill={paintFor(primitive.fill)}
                strokeWidth={primitive.strokeWidth}
                strokeDasharray={primitive.dash ? primitive.dash.join(" ") : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          case "text":
            return (
              <text
                key={primitive.key}
                x={
                  primitive.align === "center"
                    ? primitive.x + primitive.width / 2
                    : primitive.align === "right"
                      ? primitive.x + primitive.width
                      : primitive.x
                }
                y={primitive.y}
                fill={paintFor(primitive.fill)}
                fontSize={primitive.fontSize}
                fontFamily={fontFamilyFor(primitive.fontFamily)}
                textAnchor={
                  primitive.align === "center"
                    ? "middle"
                    : primitive.align === "right"
                      ? "end"
                      : "start"
                }
                dominantBaseline="text-before-edge"
              >
                {primitive.lines
                  .map((text, n) => ({ key: `${primitive.key}-line${n}`, text, first: n === 0 }))
                  .map((line) => (
                    <tspan
                      key={line.key}
                      x={
                        primitive.align === "center"
                          ? primitive.x + primitive.width / 2
                          : primitive.align === "right"
                            ? primitive.x + primitive.width
                            : primitive.x
                      }
                      dy={line.first ? 0 : `${primitive.lineHeight}em`}
                    >
                      {line.text.length === 0 ? " " : line.text}
                    </tspan>
                  ))}
              </text>
            );
          case "image":
            return assetUrl ? (
              <image
                key={primitive.key}
                href={assetUrl}
                x={primitive.x}
                y={primitive.y}
                width={primitive.width}
                height={primitive.height}
                preserveAspectRatio="none"
              />
            ) : (
              <rect
                key={primitive.key}
                x={primitive.x}
                y={primitive.y}
                width={primitive.width}
                height={primitive.height}
                fill={paintFor("frame-fill")}
                stroke={paintFor("frame-stroke")}
              />
            );
        }
      })}
    </g>
  );
}

function ElementsLayer({
  elements,
  renderer,
  assetUrls,
}: {
  readonly elements: ReadonlyArray<Element>;
  readonly renderer: Renderer;
  readonly assetUrls: ReadonlyMap<string, string>;
}) {
  return (
    <g role="group" aria-label="Drawing">
      {elements.map((element) => (
        <ElementNode
          key={element.id}
          element={element}
          renderer={renderer}
          assetUrl={element.type === "image" ? (assetUrls.get(element.fileId) ?? null) : null}
        />
      ))}
    </g>
  );
}

function TextEditorOverlay({
  editor,
  state,
}: {
  readonly editor: Editor;
  readonly state: EditorState;
}) {
  const id = state.editingTextId;
  const element =
    id === null ? null : (state.elements.find((candidate) => candidate.id === id) ?? null);
  const [value, setValue] = useState(() =>
    element?.type === "frame"
      ? element.name
      : element && (element.type === "text" || element.type === "note")
        ? element.text
        : "",
  );
  const committed = useRef(false);
  if (element?.type === "frame" && id !== null) {
    // A frame's name: one line over its label. Enter keeps it, Escape leaves it as it was.
    const label = frameLabelBox(element);
    const at = editor.screenPoint({ x: label.x, y: label.y });
    const k = state.camera.k;
    const finish = (keep: boolean) => {
      if (committed.current) return;
      committed.current = true;
      if (keep) editor.commitText(id, value);
      else editor.cancelText();
    };
    return (
      <input
        aria-label="Frame name"
        autoFocus
        className="absolute m-0 border-0 bg-transparent p-0 text-foreground outline-none"
        data-testid="board-frame-name-editor"
        onBlur={() => finish(true)}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            finish(event.key === "Enter");
          }
          event.stopPropagation();
        }}
        style={{
          left: at.x,
          top: at.y,
          width: Math.max(label.width * k, 120),
          height: label.height * k,
          fontSize: FRAME_LABEL_FONT_SIZE * k,
          fontFamily: fontFamilyFor("sans"),
        }}
        value={value}
      />
    );
  }
  if (!element || (element.type !== "text" && element.type !== "note") || id === null) return null;
  const box = elementBox(element);
  const topLeft = editor.screenPoint({ x: box.x, y: box.y });
  const k = state.camera.k;
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    editor.commitText(id, value);
  };
  const padding = element.type === "note" ? Math.min(12, box.width / 8) * k : 0;
  return (
    <textarea
      aria-label={element.type === "note" ? "Sticky note text" : "Text"}
      autoFocus
      className="absolute m-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-foreground outline-none"
      data-testid="board-text-editor"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
          event.preventDefault();
          commit();
        }
        event.stopPropagation();
      }}
      style={{
        left: topLeft.x + padding,
        top: topLeft.y + padding,
        width: Math.max(
          element.type === "note" ? box.width * k - padding * 2 : box.width * k + 8 * k,
          120,
        ),
        height: Math.max(
          element.type === "note" ? box.height * k - padding * 2 : box.height * k,
          element.fontSize * 1.25 * k,
        ),
        fontSize: element.fontSize * k,
        lineHeight: 1.25,
        fontFamily: fontFamilyFor(element.fontFamily),
        textAlign: element.textAlign,
        whiteSpace: element.type === "note" ? "pre-wrap" : "pre",
      }}
      value={value}
    />
  );
}

/** What a layer under or over the drawing is given to paint with. */
export interface SurfaceContext {
  readonly editor: Editor;
  readonly state: EditorState;
  /** The world box that stays mounted: the viewport plus a margin, quantized. */
  readonly near: Box;
  readonly host: HTMLDivElement | null;
}

export interface DrawingSurfaceProps {
  /** The drawings-store key the scene is saved under (a board id, or a document's file key). */
  readonly storageKey: string;
  /** The accessible name of the canvas host. */
  readonly label: string;
  /** Prefix for the surface's test ids (`board-svg`, `map-svg`, …). */
  readonly testIdPrefix: string;
  /** A board is an application region; the map leaves the role to its tree. */
  readonly role?: "application";
  /** An editor the owner created, so it can bind map nodes; the surface makes its own otherwise. */
  readonly editor?: Editor;
  /** Painted under the SVG, in screen space (the map's bitmap overview). */
  readonly renderBackdrop?: (context: SurfaceContext) => ReactNode;
  /** The SVG's own role and name, when it is a widget (the map's tree). */
  readonly svgRole?: "tree";
  readonly svgLabel?: string;
  /** Painted inside the camera group, under the drawing elements. */
  readonly renderWorld?: (context: SurfaceContext) => ReactNode;
  /** Painted inside the SVG in screen space, above handles. */
  readonly renderScreen?: (context: SurfaceContext) => ReactNode;
  /** DOM overlays beside the toolbar and zoom controls (a minimap, a status line). */
  readonly renderChrome?: (context: SurfaceContext) => ReactNode;
  /**
   * First look at a press on the canvas. Returning true consumes it (a map node
   * was hit); false hands it to the drawing editor.
   */
  readonly onCanvasPointerDown?: (
    world: Point,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => boolean;
  /** Runs after each save with the scene's size in bytes (boards record it). */
  readonly onSaved?: (bytes: number) => Promise<void> | void;
  /** Tooltip lines for tools that act differently on this surface (dragging empty space pans on the map). */
  readonly toolHints?: Partial<Record<Tool, string>>;
  /** The Zoom to fit button's tooltip, when this surface fits differently. */
  readonly fitLabel?: string;
  /**
   * The save status line: always (a board, which is its drawing), or only once
   * there is a drawing (the map, whose drawing is a layer over the document),
   * with what was saved named.
   */
  readonly saveStatusShown?: "always" | "whenDrawn";
}

/**
 * One drawing editor painting one SVG, with its toolbar, style panel, text
 * editor, zoom controls and save status: the board, and the surface the map
 * draws itself under. The SVG re-renders only when the editor publishes a
 * change, so an idle canvas paints nothing; a gesture is one render per
 * pointer event, and the elements themselves are memoized.
 */
/** The zoom readout: whole percents, and "<1%" at a far zoom rather than a misleading 0. */
function zoomPercentLabel(k: number): string {
  const percent = Math.round(k * 100);
  return percent === 0 ? "<1%" : `${percent}%`;
}

export function DrawingSurface({
  storageKey,
  label,
  testIdPrefix,
  role,
  editor: ownedEditor,
  renderBackdrop,
  svgRole,
  svgLabel,
  renderWorld,
  renderScreen,
  renderChrome,
  onCanvasPointerDown,
  onSaved,
  toolHints,
  fitLabel = "Zoom to fit (Shift+1)",
  saveStatusShown = "always",
}: DrawingSurfaceProps) {
  const madeEditor = useMemo(
    () => ownedEditor ?? createEditor({ seed: 0x51_55_49_50, measure: measureBoardText }),
    [ownedEditor],
  );
  const editor = ownedEditor ?? madeEditor;
  const boardId = storageKey;
  const state = useSyncExternalStore(editor.subscribe, editor.getState, editor.getState);
  const [renderer, setRenderer] = useState(() => createRenderer(measureBoardText));
  // The hand font loads with the first text that uses it; the renderer then
  // starts over, because it caches note layouts measured with a fallback face.
  const [handFontReady, setHandFontReady] = useState(false);
  const wantsHandFont = needsHandFont(state);
  useEffect(() => {
    if (!wantsHandFont || handFontReady) return;
    let cancelled = false;
    void loadHandFont().then(() => {
      if (cancelled) return;
      setRenderer(createRenderer(measureBoardText));
      setHandFontReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [wantsHandFont, handFontReady]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [assetUrls, setAssetUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const lastSavedRef = useRef<ReadonlyArray<Element> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => registerBoardEditor(editor), [editor]);

  // The viewport follows the host's size, through the shared resize observer.
  const observeHost = useCallback(
    (host: HTMLDivElement | null) => {
      hostRef.current = host;
      setHostElement(host);
      if (!host) return;
      return observeResize(host, ([entry]) => {
        if (entry) {
          editor.setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
        }
      });
    },
    [editor],
  );

  // Load the saved drawing once; a newer schema makes the board read-only.
  useEffect(() => {
    let cancelled = false;
    void readDrawingScene(boardId)
      .then((sceneJson) => {
        if (cancelled) return;
        if (sceneJson !== null) {
          const document = decodeDrawingJson(sceneJson);
          editor.loadElements(document.elements);
        }
        lastSavedRef.current = editor.allElements();
        setSaveStatus("saved");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSaveStatus(error instanceof NewerDrawingError ? "readonly" : "error");
        toastManager.add(
          stackedToast({
            type: "error",
            title: "Unable to open this board",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, editor]);

  // Persist after the stream of changes settles; flush on unmount. The status
  // says "Saving…" from the first unsaved change until the newest one is
  // written, so "Saved" never shows while a change is only scheduled.
  useEffect(() => {
    let writes = 0;
    const flush = () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const all = editor.allElements();
      if (lastSavedRef.current === null || all === lastSavedRef.current) return;
      lastSavedRef.current = all;
      const json = encodeDrawingJson(makeDrawingDocument(all));
      setSaveStatus("saving");
      writes += 1;
      const write = writes;
      void writeDrawing({
        schemaVersion: 1,
        documentId: boardId,
        updatedAt: Date.now(),
        sceneSchemaVersion: DRAWING_SCHEMA_VERSION,
        sceneJson: json,
      })
        .then(() => {
          const newest = write === writes && saveTimerRef.current === null;
          if (newest) setSaveStatus("saved");
          return onSaved?.(json.length);
        })
        .catch((error: unknown) => {
          setSaveStatus("error");
          toastManager.add(
            stackedToast({
              type: "error",
              title: "This board could not be saved",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    };
    const unsubscribe = editor.subscribe(() => {
      if (lastSavedRef.current === null) return;
      if (editor.allElements() === lastSavedRef.current) return;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    });
    window.addEventListener("beforeunload", flush);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [boardId, editor, onSaved]);

  // Wheel must be non-passive to keep the page from scrolling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      editor.wheel(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
        },
      );
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [editor]);

  // Image bytes come from the asset store, as object URLs, loaded once per file id.
  const fileIds = useMemo(
    () => state.elements.flatMap((element) => (element.type === "image" ? [element.fileId] : [])),
    [state.elements],
  );
  useEffect(() => {
    const missing = fileIds.filter((fileId) => !assetUrls.has(fileId));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (fileId) => [fileId, await readAsset(fileId)] as const),
    ).then((records) => {
      if (cancelled) return;
      setAssetUrls((current) => {
        const next = new Map(current);
        for (const [fileId, record] of records) {
          if (record && !next.has(fileId)) next.set(fileId, URL.createObjectURL(record.bytes));
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fileIds, assetUrls]);
  useEffect(
    () => () => {
      for (const url of assetUrls.values()) URL.revokeObjectURL(url);
    },
    [assetUrls],
  );

  // Closing the text editor hands the keyboard back to the canvas.
  const wasEditingRef = useRef(false);
  useEffect(() => {
    const editing = state.editingTextId !== null;
    if (wasEditingRef.current && !editing) hostRef.current?.focus({ preventScroll: true });
    wasEditingRef.current = editing;
  }, [state.editingTextId]);

  // The image tool is a file picker. It opens from the editor's own
  // notification, which runs synchronously inside the key or click that chose
  // the tool, so the browser still sees a user gesture; dismissing it returns
  // to the select tool.
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    let previous = editor.getState().tool;
    const unsubscribe = editor.subscribe(() => {
      const { tool } = editor.getState();
      if (tool === "image" && previous !== "image") input.click();
      previous = tool;
    });
    const onCancel = () => editor.setTool("select");
    input.addEventListener("cancel", onCancel);
    return () => {
      unsubscribe();
      input.removeEventListener("cancel", onCancel);
    };
  }, [editor]);

  const onImageChosen = async (file: File | null) => {
    if (!file) {
      editor.setTool("select");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const fileId = await putAsset(file);
      setAssetUrls((current) => new Map(current).set(fileId, URL.createObjectURL(file)));
      editor.insertImage(fileId, bitmap.width, bitmap.height);
      bitmap.close();
    } catch (error) {
      editor.setTool("select");
      toastManager.add(
        stackedToast({
          type: "error",
          title: "Unable to add this image",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
  };

  const localPoint = (event: ReactPointerEvent) => ({
    x: event.clientX - originRef.current.x,
    y: event.clientY - originRef.current.y,
  });

  /** Set while the press that opened a text editor is still in flight. */
  const editorOpenedByPressRef = useRef(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest("[data-board-chrome]")) return;
    if (event.target instanceof HTMLTextAreaElement) return;
    if (editor.getState().editingTextId !== null) {
      // A press outside the text editor commits it; the press itself does nothing more.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    originRef.current = { x: rect.left, y: rect.top };
    if (
      event.button === 0 &&
      onCanvasPointerDown?.(editor.worldPoint(localPoint(event)), event) === true
    ) {
      return;
    }
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.button === 1) {
      editor.holdHandTool();
    }
    editor.pointerDown(localPoint(event), modifiersFrom(event));
    editorOpenedByPressRef.current = editor.getState().editingTextId !== null;
  };
  // The browser focuses the pressed element after mousedown, which would blur
  // (and so commit) a text editor the same press just opened.
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (editorOpenedByPressRef.current) {
      editorOpenedByPressRef.current = false;
      event.preventDefault();
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    editor.pointerMove(localPoint(event), modifiersFrom(event));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    editor.pointerUp(localPoint(event), modifiersFrom(event));
    if (event.button === 1) editor.releaseTemporaryTool();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A shell command already took the key (map navigation, a tool letter).
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.closest("[data-map-node]") === null) return;
    if (event.key === " " && !event.repeat) {
      event.preventDefault();
      editor.holdHandTool();
    } else if (event.key === "Escape") {
      editor.escape();
    } else if (event.key === "Enter") {
      editor.editSelectedText();
    }
  };
  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") editor.releaseTemporaryTool();
  };

  // Mount only what is near the viewport. The camera is quantized to half the
  // margin, so a pan changes the query box only when it crosses a cell, and
  // the margin always covers the distance travelled inside one. The cull reads
  // the element list itself (not the editor's index) so React sees what it
  // depends on and recomputes exactly when the list or the box changes.
  const cell = MOUNT_MARGIN_PX / 2;
  const quantizedCamera = {
    x: Math.round(state.camera.x / cell) * cell,
    y: Math.round(state.camera.y / cell) * cell,
    k: Number(state.camera.k.toPrecision(3)),
  };
  const near = expandBox(
    visibleWorldBox(quantizedCamera, state.viewport),
    MOUNT_MARGIN_PX / quantizedCamera.k,
  );
  const mountedElements = state.elements.filter((element) =>
    boxesIntersect(near, elementBounds(element)),
  );
  const context: SurfaceContext = { editor, state, near, host: hostElement };

  const { camera } = state;
  const transform = `translate(${camera.x} ${camera.y}) scale(${camera.k})`;
  const gridStep = GRID_SIZE * camera.k;
  const showGrid = state.gridEnabled && gridStep >= 10;
  const selected = state.elements.filter((element) => state.selectedIds.has(element.id));
  const bindingTarget =
    state.bindingTargetId === null
      ? null
      : (state.elements.find((element) => element.id === state.bindingTargetId) ?? null);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid={`${testIdPrefix}-view`}
    >
      <div
        aria-label={label}
        className="relative min-h-0 flex-1 cursor-crosshair touch-none overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        data-board-canvas=""
        data-tool={state.tool}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          editor.doubleClick({ x: event.clientX - rect.left, y: event.clientY - rect.top });
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onMouseDown={onMouseDown}
        onPointerCancel={() => editor.pointerCancel()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={observeHost}
        role={role}
        tabIndex={0}
      >
        {renderBackdrop?.(context)}
        <svg
          aria-label={svgLabel}
          className="absolute inset-0 size-full select-none"
          data-testid={`${testIdPrefix}-svg`}
          role={svgRole}
          data-zoom={camera.k}
          xmlns="http://www.w3.org/2000/svg"
        >
          {showGrid ? (
            <>
              <defs>
                <pattern
                  id="board-grid"
                  patternUnits="userSpaceOnUse"
                  width={gridStep}
                  height={gridStep}
                  x={camera.x % gridStep}
                  y={camera.y % gridStep}
                >
                  <circle cx={0.5} cy={0.5} r={1} fill="var(--canvas-grid)" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#board-grid)" />
            </>
          ) : null}
          <g transform={transform} data-testid={`${testIdPrefix}-camera`}>
            {renderWorld?.(context)}
            <ElementsLayer elements={mountedElements} renderer={renderer} assetUrls={assetUrls} />
            {bindingTarget ? <BoundsRect box={elementBounds(bindingTarget)} dashed /> : null}
            {selected.map((element) => (
              <BoundsRect key={element.id} box={elementBounds(element)} />
            ))}
            {state.selectionBox && selected.length > 1 ? (
              <BoundsRect box={state.selectionBox} dashed />
            ) : null}
            {state.guides.map((guide) => (
              <line
                key={`${guide.axis}:${guide.at}:${guide.from}:${guide.to}`}
                x1={guide.axis === "x" ? guide.at : guide.from}
                x2={guide.axis === "x" ? guide.at : guide.to}
                y1={guide.axis === "x" ? guide.from : guide.at}
                y2={guide.axis === "x" ? guide.to : guide.at}
                stroke="var(--canvas-guide)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                data-testid="board-guide"
              />
            ))}
            {state.marquee ? (
              <rect
                x={state.marquee.x}
                y={state.marquee.y}
                width={state.marquee.width}
                height={state.marquee.height}
                fill="var(--canvas-selection-fill)"
                stroke="var(--canvas-selection)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                data-testid="board-marquee"
              />
            ) : null}
          </g>
          {state.editingTextId === null
            ? state.handles.map(({ handle, point }) => {
                const screen = editor.screenPoint(point);
                return handle === "rotate" ? (
                  <circle
                    key={handle}
                    cx={screen.x}
                    cy={screen.y}
                    r={HANDLE_SIZE_PX / 2}
                    fill="var(--canvas-handle)"
                    stroke="var(--canvas-selection)"
                    data-handle={handle}
                  />
                ) : (
                  <rect
                    key={handle}
                    x={screen.x - HANDLE_SIZE_PX / 2}
                    y={screen.y - HANDLE_SIZE_PX / 2}
                    width={HANDLE_SIZE_PX}
                    height={HANDLE_SIZE_PX}
                    fill="var(--canvas-handle)"
                    stroke="var(--canvas-selection)"
                    data-handle={handle}
                  />
                );
              })
            : null}
          {renderScreen?.(context)}
        </svg>
        <TextEditorOverlay key={state.editingTextId ?? "none"} editor={editor} state={state} />
        <div
          className="pointer-events-none absolute inset-x-0 top-3 flex justify-center"
          data-board-chrome=""
        >
          <BoardToolbar
            tool={state.tool}
            onSelectTool={(tool) => editor.setTool(tool)}
            hints={toolHints}
          />
        </div>
        {state.tool !== "hand" &&
        state.tool !== "eraser" &&
        state.tool !== "image" &&
        (state.tool !== "select" || selected.length > 0) ? (
          <div className="pointer-events-none absolute top-16 left-3" data-board-chrome="">
            <BoardStylePanel style={state.style} onChange={(patch) => editor.setStyle(patch)} />
          </div>
        ) : null}
        <div
          className="surface-glass absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-border/60 p-1 shadow-sm"
          data-board-chrome=""
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Zoom out"
                  // Disabled at the floor, where another step would change nothing.
                  disabled={camera.k <= state.zoomFloor * 1.0001}
                  onClick={() => editor.zoomOut()}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <MinusIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Zoom out (-)</TooltipPopup>
          </Tooltip>
          <Button
            aria-label="Reset zoom"
            onClick={() => editor.zoomReset()}
            size="xs"
            variant="ghost"
          >
            <span className="w-10 text-center tabular-nums" data-testid={`${testIdPrefix}-zoom`}>
              {zoomPercentLabel(camera.k)}
            </span>
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Zoom in"
                  disabled={camera.k >= MAX_ZOOM * 0.9999}
                  onClick={() => editor.zoomIn()}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Zoom in (+)</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Zoom to fit"
                  onClick={() => editor.zoomToFit()}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <MaximizeIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">{fitLabel}</TooltipPopup>
          </Tooltip>
        </div>
        {saveStatusShown === "always" || state.elements.length > 0 ? (
          <div
            aria-live="polite"
            className="pointer-events-none absolute bottom-3 left-3 text-xs text-muted-foreground"
            data-board-chrome=""
            data-testid={`${testIdPrefix}-save-status`}
            role="status"
          >
            {SAVE_STATUS_TEXT[saveStatusShown === "whenDrawn" ? "layer" : "board"][saveStatus]}
          </div>
        ) : null}
        <span aria-live="polite" className="sr-only" role="status">
          {TOOL_LABELS[state.tool]}
        </span>
        {renderChrome?.(context)}
        <input
          accept="image/*"
          aria-label="Choose an image"
          className="hidden"
          data-testid="board-image-input"
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            void onImageChosen(file);
          }}
          ref={fileInputRef}
          type="file"
        />
      </div>
    </div>
  );
}

function BoundsRect({ box, dashed = false }: { readonly box: Box; readonly dashed?: boolean }) {
  return (
    <rect
      x={box.x}
      y={box.y}
      width={box.width}
      height={box.height}
      fill="none"
      stroke="var(--canvas-selection)"
      strokeWidth={1}
      strokeDasharray={dashed ? "4 3" : undefined}
      vectorEffect="non-scaling-stroke"
      data-testid={dashed ? "board-selection-bounds" : "board-selection"}
    />
  );
}
