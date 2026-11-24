import type { NodePath, SourceRow } from "@quipu/contracts/engine";
import { syntaxColor } from "@quipu/shared/syntaxTable";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { NodeEditor } from "~/components/edit/NodeEditor";
import { Spinner } from "~/components/ui/spinner";
import { useSyntaxTheme } from "~/hooks/useSyntaxTheme";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { openDocument, selectedTarget, startNodeEdit, useNodeEditor } from "./documentEdits.ts";
import type { OpenDocument, QueryClient } from "./documentSession.ts";
import { useHitSet } from "./useHitSet.ts";
import { useSearchStore } from "./searchStore.ts";
import { nodeBytes, useSelectionStore } from "./selectionStore.ts";
import { DOCUMENT_FORMATS } from "./documentFormats.ts";
import { useProblemFocus } from "./problemFocus.ts";
import { type LineTokens, SHIKI_MAX_BYTES, highlightSmallDocument } from "./sourceHighlight.ts";
import {
  type ColorSpan,
  type RowMarks,
  type SourceClient,
  SourceWindowModel,
  byteAtUnit,
  runsOf,
} from "./sourceWindow.ts";

/** One row's height in CSS pixels: one line of the code font. */
const ROW_HEIGHT = 20;
/** The floating value editor's width in CSS pixels. */
const EDITOR_WIDTH = 360;
const GUTTER_PADDING_COLUMNS = 2;
const MIN_GUTTER_COLUMNS = 4;
const SCROLLBAR_MIN_THUMB = 24;
/** Pixels of wheel travel that make one row, for devices that report pixels. */
const WHEEL_LINE_PIXELS = ROW_HEIGHT;

/**
 * - `auto`: shiki for a small file (up to 1 MiB),
 *   the structural index for anything bigger, nothing for text.
 * - `shiki` and `index` pin one path; the equality test renders both.
 */
export type SourceHighlighter = "auto" | "shiki" | "index";

type Painted = "shiki" | "index" | "pending" | "none";

export interface SourceDocument {
  readonly documentId: number;
  readonly size: number;
  readonly format: OpenDocument["format"];
  /**
   * `converted` when the tree indexes a conversion of the file: node and hit
   * ranges are not positions in this text, so the view neither follows nor
   * makes the shared selection and marks no hits. Absent means `native`.
   */
  readonly structure?: OpenDocument["structure"];
  /** Where the text stops being valid JSON: the byte is marked, and "show the problem" scrolls to it. */
  readonly problem?: OpenDocument["problem"];
  readonly source: SourceClient;
  /** What search asks of the engine; absent where nothing is searched (the equality harness). */
  readonly queries?: QueryClient;
  /** Changes when the document's bytes do; the rows are read again. Absent where nothing is edited. */
  readonly revision?: number;
}

/**
 * The document's bytes as text: virtualized by byte offset, colored for the
 * visible rows only, and tied to the selection the tree shares. It never
 * parses: rows, their colors and the node under a click all come from the
 * engine as bounded slices.
 */
export function SourceView({
  document: doc,
  compact = false,
  highlighter = "auto",
}: {
  readonly document: SourceDocument;
  /** The right panel's narrower treatment: no gutter padding beyond the numbers. */
  readonly compact?: boolean;
  readonly highlighter?: SourceHighlighter;
}) {
  // One model per document (the view is keyed by it): an edit reloads its rows instead of starting over.
  const [model] = useState(() => new SourceWindowModel(doc.source, doc.size));
  const viewportId = useId();
  const view = useSyncExternalStore(model.subscribe, model.view);
  const theme = useSyntaxTheme();
  const selection = useSelectionStore((state) => state.selection);
  const select = useSelectionStore((state) => state.select);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [metrics, setMetrics] = useState<{
    readonly rows: number;
    readonly columns: number;
    readonly height: number;
  } | null>(null);
  const started = useRef(false);

  const linked = doc.structure !== "converted";
  const grammar = DOCUMENT_FORMATS[doc.format].grammar;
  const mode: "shiki" | "index" | "none" =
    grammar === null
      ? "none"
      : highlighter === "shiki" || (highlighter === "auto" && doc.size <= SHIKI_MAX_BYTES)
        ? "shiki"
        : "index";

  // Shiki's tokens for a small document, for the active theme.
  const [tokens, setTokens] = useState<{
    readonly key: string;
    readonly lines: LineTokens | null;
  } | null>(null);
  const tokenKey = `${doc.documentId}:${doc.revision ?? 0}:${theme.appearance}:${JSON.stringify(theme.table)}`;
  useEffect(() => {
    if (mode !== "shiki" || doc.size === 0) return;
    let cancelled = false;
    void (async () => {
      const head = await doc.source.text(doc.size);
      const lines = await highlightSmallDocument(
        head.text,
        theme.table,
        theme.appearance,
        grammar ?? "json",
      );
      if (!cancelled) setTokens({ key: tokenKey, lines });
    })().catch(() => {
      // Shiki could not load: the rows keep the index's colors, which are the same.
      if (!cancelled) setTokens({ key: tokenKey, lines: null });
    });
    return () => {
      cancelled = true;
    };
  }, [mode, doc.source, doc.size, theme, tokenKey, grammar]);

  const shikiReady = mode === "shiki" && tokens !== null && tokens.key === tokenKey;
  const shikiLines = shikiReady ? tokens.lines : null;
  const painted: Painted =
    mode === "none"
      ? "none"
      : mode === "index"
        ? "index"
        : shikiLines !== null
          ? "shiki"
          : highlighter === "shiki" && !shikiReady
            ? "pending"
            : "index";

  const colorsFor = (row: SourceRow): ReadonlyArray<ColorSpan> => {
    if (painted === "shiki" && shikiLines !== null) return shikiLines.colorsForRow(row);
    if (painted === "pending" || painted === "none") return [];
    return row.spans.map((span) => ({
      from: span.from,
      to: span.to,
      color: syntaxColor(theme.table, span.kind, span.depth, span.container),
    }));
  };

  // Measure the viewport: how many rows fit, and how many characters a row holds.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const probe = probeRef.current;
    if (viewport === null || probe === null) return;
    return observeResize(viewport, () => {
      const characterWidth = probe.getBoundingClientRect().width / 100;
      const height = viewport.clientHeight;
      const width = viewport.clientWidth;
      if (characterWidth === 0 || height === 0) return;
      setMetrics({
        rows: Math.max(1, Math.floor(height / ROW_HEIGHT)),
        columns: Math.max(1, Math.floor(width / characterWidth)),
        height,
      });
    });
  }, []);

  // Wide enough for any line number or byte offset in the file, so scrolling
  // never changes how many characters a row holds (and so never re-wraps rows).
  const gutterColumns =
    Math.max(MIN_GUTTER_COLUMNS, String(Math.max(0, doc.size)).length) + GUTTER_PADDING_COLUMNS;

  const columns = metrics?.columns ?? 0;
  const bodyColumns = Math.max(16, columns - gutterColumns - 2);
  useEffect(() => {
    if (metrics === null) return;
    model.setViewport(metrics.rows + 1, bodyColumns);
    if (!started.current) {
      started.current = true;
      const current = useSelectionStore.getState().selection;
      const problemAt = useProblemFocus.getState().take(doc.documentId);
      void model.start(
        problemAt ?? (linked && current?.documentId === doc.documentId ? current.range.start : 0),
        "third",
      );
    }
  }, [metrics, bodyColumns, model, doc.documentId, linked]);

  // "Show the problem" while the view is already on screen.
  const pendingProblem = useProblemFocus((state) => state.pending);
  useEffect(() => {
    if (pendingProblem === null || !started.current) return;
    const offset = useProblemFocus.getState().take(doc.documentId);
    if (offset !== null) void model.jumpTo(offset, "third");
  }, [pendingProblem, model, doc.documentId]);
  // The problem's offset is the file's as it opened; after an edit it may sit elsewhere.
  const problemRange =
    doc.problem === null || doc.problem === undefined || (doc.revision ?? 0) > 0
      ? null
      : { start: doc.problem.offset, end: doc.problem.offset + 1 };

  // An edit changed the bytes: read the rows on screen again.
  const shownRevision = useRef(doc.revision ?? 0);
  useEffect(() => {
    const revision = doc.revision ?? 0;
    if (revision === shownRevision.current) return;
    shownRevision.current = revision;
    if (started.current) void model.reload(doc.size);
  }, [doc.revision, doc.size, model]);

  // Follow a selection the tree made: scroll to its bytes.
  const followed = useRef(0);
  useEffect(() => {
    if (!linked || selection === null || selection.documentId !== doc.documentId) return;
    if (selection.revision === followed.current) return;
    followed.current = selection.revision;
    if (selection.origin === "source" || !started.current) return;
    void model.jumpTo(selection.range.start, "third");
  }, [selection, model, doc.documentId, linked]);

  const selected =
    linked && selection !== null && selection.documentId === doc.documentId
      ? selection.range
      : null;

  // Search hits: lit in the rows on screen, everything else dimmed, and the view
  // scrolls to the hit the user stepped to.
  const hitSet = useHitSet(
    doc.queries === undefined || !linked
      ? null
      : { documentId: doc.documentId, queries: doc.queries },
  );
  const currentHit = useSearchStore((state) => state.current);
  const followedHit = useRef(0);
  useEffect(() => {
    if (hitSet === null || currentHit === null || currentHit.revision === followedHit.current)
      return;
    followedHit.current = currentHit.revision;
    if (!started.current) return;
    void model.jumpTo(currentHit.range.start, "third");
  }, [hitSet, currentHit, model]);
  const [litRanges, setLitRanges] = useState<{
    readonly key: string;
    readonly ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  } | null>(null);
  const windowFrom = view.rows[view.top]?.start ?? 0;
  const windowTo =
    view.rows[Math.min(view.rows.length - 1, view.top + (metrics?.rows ?? 0))]?.end ?? 0;
  const hitKey = hitSet === null ? null : `${hitSet.searchId}:${windowFrom}:${windowTo}`;
  useEffect(() => {
    if (hitSet === null || hitKey === null || windowTo <= windowFrom) return;
    let cancelled = false;
    void hitSet
      .ranges(windowFrom, windowTo, 4096)
      .then((ranges) => {
        if (!cancelled) setLitRanges({ key: hitKey, ranges });
      })
      .catch(() => {
        if (!cancelled) setLitRanges({ key: hitKey, ranges: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [hitSet, hitKey, windowFrom, windowTo]);
  const marks: RowMarks | null =
    hitSet === null
      ? null
      : {
          ranges:
            litRanges !== null && litRanges.key.startsWith(`${hitSet.searchId}:`)
              ? litRanges.ranges
              : [],
          current: currentHit?.range ?? null,
        };

  const wheelRemainder = useRef(0);
  const onWheel = (event: WheelEvent) => {
    const pixels = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_PIXELS : event.deltaY;
    wheelRemainder.current += pixels;
    const rows = Math.trunc(wheelRemainder.current / ROW_HEIGHT);
    if (rows === 0) return;
    wheelRemainder.current -= rows * ROW_HEIGHT;
    model.scrollBy(rows);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const page = Math.max(1, (metrics?.rows ?? 20) - 1);
    switch (event.key) {
      case "Enter":
        editSelected();
        break;
      case "ArrowDown":
        model.scrollBy(1);
        break;
      case "ArrowUp":
        model.scrollBy(-1);
        break;
      case "PageDown":
      case " ":
        model.scrollBy(page);
        break;
      case "PageUp":
        model.scrollBy(-page);
        break;
      case "Home":
        void model.scrollToStart();
        break;
      case "End":
        void model.scrollToEnd();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /** The byte under a pointer event, or null off the rows. */
  const byteAt = (event: React.MouseEvent) => {
    const rowElement = (event.target as Element).closest<HTMLElement>("[data-row-start]");
    if (rowElement === null) return null;
    const start = Number(rowElement.dataset.rowStart);
    const row = view.rows.find((candidate) => candidate.start === start);
    if (row === undefined) return null;
    const code = rowElement.querySelector<HTMLElement>("[data-row-code]");
    const unit =
      code === null
        ? 0
        : unitAtPoint(code, event.clientX, event.clientY, row.text.length, probeRef);
    return Math.min(row.start + byteAtUnit(row.text, unit), Math.max(row.start, row.end - 1));
  };

  const onClick = (event: React.MouseEvent) => {
    if (!linked || window.getSelection()?.isCollapsed === false) return;
    const byte = byteAt(event);
    if (byte === null) return;
    void doc.source.nodeAt(byte).then((result: NodePath) => {
      const innermost = result.path[result.path.length - 1];
      if (innermost === undefined) return;
      select({
        documentId: doc.documentId,
        ref: innermost.node.ref,
        // The node's bytes in the document as it is now: an edit moves them off the file's offsets.
        range: nodeBytes(innermost.node),
        origin: "source",
        path: result.path,
      });
    });
  };

  // Double-clicking a value opens the editor on it, right under the token.
  // The right panel's copy only reads: the editor opens in the main view.
  const editable = !compact && doc.revision !== undefined && doc.format !== "text";
  const onDoubleClick = (event: React.MouseEvent) => {
    if (!editable || !linked) return;
    const byte = byteAt(event);
    if (byte === null) return;
    const anchor = { x: event.clientX, y: event.clientY };
    window.getSelection()?.removeAllRanges();
    void doc.source.nodeAt(byte).then((result: NodePath) => {
      const innermost = result.path[result.path.length - 1];
      if (innermost === undefined) return;
      const node = innermost.node;
      // Punctuation and keys belong to the container around them: nothing to edit in place.
      if (node.kind === "object" || node.kind === "array") return;
      const tree = openDocument()?.tree ?? null;
      startNodeEdit(
        { node, rowId: tree?.rowIdOf(node.ref) ?? null, decoded: false },
        "value",
        "source",
        anchor,
      );
    });
  };

  /** Enter edits the selected value, under its row when the row is on screen. */
  const editSelected = () => {
    if (!editable) return;
    const target = selectedTarget(openDocument());
    if (target === null || target.decoded) return;
    if (target.node.kind === "object" || target.node.kind === "array") return;
    const start = target.node.span.start;
    const rowElement = [
      ...(viewportRef.current?.querySelectorAll<HTMLElement>("[data-row-start]") ?? []),
    ].find(
      (element) =>
        Number(element.dataset.rowStart) <= start && start <= Number(element.dataset.rowEnd),
    );
    const rect = rowElement?.getBoundingClientRect();
    startNodeEdit(
      target,
      "value",
      "source",
      rect === undefined ? null : { x: rect.left + 48, y: rect.top + ROW_HEIGHT / 2 },
    );
  };

  const editing = useNodeEditor((state) =>
    editable && state.request?.surface === "source" && state.request.documentId === doc.documentId
      ? state.request
      : null,
  );
  // Under the token that was double-clicked (in the window's coordinates), or at the top of the view.
  const editorStyle: CSSProperties | null =
    editing === null
      ? null
      : editing.anchor === null
        ? { position: "absolute", left: 48, top: 8, width: EDITOR_WIDTH }
        : {
            position: "fixed",
            left: Math.max(
              8,
              Math.min(editing.anchor.x - 24, window.innerWidth - EDITOR_WIDTH - 8),
            ),
            top: Math.min(editing.anchor.y + ROW_HEIGHT / 2, window.innerHeight - 120),
            width: EDITOR_WIDTH,
          };

  // The scrollbar: its thumb is where the first row sits in the file.
  const track = useRef<HTMLDivElement | null>(null);
  const grab = useRef<number | null>(null);
  const first = view.rows[view.top];
  const lastVisible = view.rows[Math.min(view.rows.length - 1, view.top + (metrics?.rows ?? 1))];
  const trackHeight = metrics?.height ?? 0;
  const shownBytes = first && lastVisible ? lastVisible.end - first.start : 0;
  // The whole file is on screen: no thumb. Measured in rows, not bytes, because the last row ends
  // before the file's final line break and a byte ratio would come out just short of the track.
  const allShown =
    view.atStart && view.atEnd && view.top === 0 && view.rows.length <= (metrics?.rows ?? 0);
  const thumbHeight =
    view.size === 0 || allShown
      ? trackHeight
      : Math.min(
          trackHeight,
          Math.max(SCROLLBAR_MIN_THUMB, (trackHeight * shownBytes) / Math.max(1, view.size)),
        );
  const thumbTop =
    view.size === 0 || first === undefined
      ? 0
      : (first.start / view.size) * Math.max(0, trackHeight - thumbHeight);

  const dragTo = (clientY: number) => {
    const element = track.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const room = Math.max(1, rect.height - thumbHeight);
    const offset = grab.current ?? thumbHeight / 2;
    void model.scrollToFraction((clientY - rect.top - offset) / room);
  };
  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const onThumb =
      event.clientY >= rect.top + thumbTop && event.clientY <= rect.top + thumbTop + thumbHeight;
    grab.current = onThumb ? event.clientY - rect.top - thumbTop : null;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!onThumb) dragTo(event.clientY);
  };
  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    dragTo(event.clientY);
  };
  const onTrackPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    grab.current = null;
  };

  const visible = view.rows.slice(view.top, view.top + (metrics?.rows ?? 0) + 1);

  return (
    <div
      data-source-view=""
      data-highlighter={painted}
      data-theme={`${theme.appearance}:${theme.themeId}`}
      data-state={view.loading ? "loading" : view.error === null ? "ready" : "error"}
      data-first-row-start={first?.start ?? ""}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-code text-code-foreground"
    >
      {linked ? null : (
        <p role="note" className="shrink-0 border-b px-3 py-1 text-muted-foreground text-xs">
          The file as written. The tree reads it converted to JSON, so selections and search matches
          don't show here.
        </p>
      )}
      <div
        ref={viewportRef}
        id={viewportId}
        role="document"
        aria-label="Document text"
        tabIndex={0}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden pe-3 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          compact && "text-2xs",
        )}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {visible.map((row) => (
          <SourceRowView
            key={row.start}
            row={row}
            gutterColumns={gutterColumns}
            colors={colorsFor(row)}
            selection={selected}
            marks={marks}
            problem={problemRange}
          />
        ))}
        {view.loading && view.rows.length === 0 ? (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground"
          >
            <Spinner size="sm" />
            Reading…
          </div>
        ) : null}
        {view.error !== null ? (
          <div role="alert" className="px-4 py-3 text-destructive-foreground">
            {view.error}
          </div>
        ) : null}
      </div>
      {editing !== null && editorStyle !== null ? (
        <div
          className="z-20 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg"
          style={editorStyle}
        >
          <NodeEditor request={editing} variant="inline" />
        </div>
      ) : null}
      <span
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute -z-10 font-mono text-xs whitespace-pre"
      >
        {"0".repeat(100)}
      </span>
      <div
        ref={track}
        role="scrollbar"
        aria-label="Document position"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={view.size}
        aria-valuenow={first?.start ?? 0}
        aria-controls={viewportId}
        tabIndex={-1}
        className="absolute inset-y-0 end-0 flex w-3 justify-center"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
      >
        {thumbHeight < trackHeight ? (
          <div
            data-scroll-thumb=""
            className="pointer-events-none absolute w-1.5 rounded-full bg-foreground/20"
            style={{ top: thumbTop, height: thumbHeight }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The gutter's text: the line number where the row starts a line, else nothing, else the byte offset. */
function gutterLabel(row: SourceRow): string {
  if (row.line === null) return String(row.start);
  return row.column === 0 ? String(row.line) : "";
}

function SourceRowView({
  row,
  gutterColumns,
  colors,
  selection,
  marks,
  problem,
}: {
  readonly row: SourceRow;
  readonly gutterColumns: number;
  readonly colors: ReadonlyArray<ColorSpan>;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly marks: RowMarks | null;
  readonly problem: { readonly start: number; readonly end: number } | null;
}) {
  const runs = runsOf(row, colors, selection, marks, problem);
  const label = gutterLabel(row);
  return (
    <div
      data-row-start={row.start}
      data-row-end={row.end}
      className="flex w-full items-center whitespace-pre"
      style={{ height: ROW_HEIGHT }}
    >
      <span
        aria-hidden="true"
        data-row-gutter=""
        className="shrink-0 select-none pe-2 text-right text-muted-foreground/60"
        style={{ width: `${gutterColumns}ch` }}
      >
        {label}
      </span>
      {/* A wrapped row hangs under its line's text; the engine left room for it. */}
      {row.indent > 0 ? (
        <span aria-hidden="true" className="shrink-0" style={{ width: `${row.indent}ch` }} />
      ) : null}
      <span data-row-code="" className="min-w-0 overflow-hidden">
        {runs.map((run) => (
          <span
            key={run.from}
            data-selected={run.selected ? "" : undefined}
            data-hit={run.hit ? (run.current ? "current" : "") : undefined}
            data-problem={run.problem ? "" : undefined}
            className={cn(
              run.selected && "bg-primary/20",
              run.problem && "bg-destructive/20 underline decoration-destructive decoration-wavy",
              run.hit &&
                (run.current
                  ? "bg-search-hit-current text-search-hit-current-foreground"
                  : "bg-search-hit text-search-hit-foreground"),
              marks !== null && !run.hit && "opacity-45",
            )}
            style={run.color === null ? undefined : { color: run.color }}
          >
            {run.text}
          </span>
        ))}
      </span>
    </div>
  );
}

/** The UTF-16 index in a row's text under a point, from the caret the browser reports. */
function unitAtPoint(
  code: HTMLElement,
  x: number,
  y: number,
  length: number,
  probeRef: { readonly current: HTMLSpanElement | null },
): number {
  const position = code.ownerDocument.caretPositionFromPoint?.(x, y);
  if (position !== null && position !== undefined && code.contains(position.offsetNode)) {
    const walker = code.ownerDocument.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let before = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node === position.offsetNode) return Math.min(length, before + position.offset);
      before += node.textContent?.length ?? 0;
    }
  }
  const probe = probeRef.current;
  const width = probe === null ? 0 : probe.getBoundingClientRect().width / 100;
  if (width === 0) return 0;
  return Math.max(0, Math.min(length, Math.floor((x - code.getBoundingClientRect().left) / width)));
}
