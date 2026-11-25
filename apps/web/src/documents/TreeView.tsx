import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import { NodeEditor } from "~/components/edit/NodeEditor";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import {
  type EditMode,
  type NodeEditRequest,
  startNodeEdit,
  useNodeEditor,
} from "./documentEdits.ts";
import { type HitSet, useSearchStore } from "./searchStore.ts";
import type { QueryClient } from "./documentSession.ts";
import { nodeBytes, selectedNodeId, useSelectionStore } from "./selectionStore.ts";
import { useRowLit } from "./treeLit.ts";
import { type LabelPart, matchParts, treeKeyPaint, treeValuePaint } from "./treePaint.ts";
import { useHitSet } from "./useHitSet.ts";
import { nodeId, type TreeModel, type ViewRow } from "./treeModel.ts";

const ROW_HEIGHT = 28;
const INDENT_PX = 16;
/**
 * Rows deeper than this stop moving right and show their level instead: a
 * document 100 000 levels deep would otherwise push its rows' text past the
 * edge of the list, and the list would look empty.
 */
const MAX_INDENT_LEVELS = 24;
const indentOf = (depth: number) => Math.min(depth, MAX_INDENT_LEVELS) * INDENT_PX;
const TYPE_AHEAD_RESET_MS = 700;
const PAGE_ROWS = 10;

/**
 * The outline of an opened document. Only the rows on screen are mounted
 * (`@legendapp/list`); each one decodes its key and preview from the engine
 * when it appears. The keyboard follows the WAI-ARIA tree pattern: Up and Down
 * move between visible rows, Right opens or enters, Left closes or leaves,
 * Enter and Space toggle, and typing jumps to a row. A click selects a row; the
 * disclosure triangle and a double-click on a container open or close it, and a
 * double-click on a key or a scalar value edits it.
 */
export function TreeView({
  model,
  queries,
}: {
  readonly model: TreeModel;
  /** What search asks of the engine; rows with no hit are dimmed while a search has hits. */
  readonly queries: QueryClient;
}) {
  const hitSet = useHitSet({ documentId: model.documentId, queries });
  // The rows that lead to the hit search stepped to stay readable while the rest dim.
  const currentPath = useSearchStore((state) => state.current?.path ?? null);
  const onCurrentPath = new Set((currentPath ?? []).map((step) => nodeId(step.node.ref)));
  const rows = useSyncExternalStore(model.subscribe, model.view);
  // The focused row: the last one this view moved to, unless another view selected
  // a node since (the selection every view shares), which then takes the focus.
  const selection = useSelectionStore((state) => state.selection);
  const selectedId =
    selection !== null && selectedNodeId(selection, model.documentId) !== null
      ? model.rowIdOf(selection.ref)
      : null;
  const editing = useNodeEditor((state) =>
    state.request?.surface === "tree" && state.request.documentId === model.documentId
      ? state.request
      : null,
  );
  const [local, setLocal] = useState({ id: model.rootId, revision: 0 });
  const followsSelection =
    selection !== null &&
    selection.origin !== "tree" &&
    selection.revision > local.revision &&
    selectedId !== null &&
    rows.some((row) => row.id === selectedId);
  const focusedId = followsSelection && selectedId !== null ? selectedId : local.id;
  const setFocusedId = (id: string) =>
    setLocal({ id, revision: useSelectionStore.getState().selection?.revision ?? 0 });
  const listRef = useRef<LegendListRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const moveFocus = useRef(false);
  const typed = useRef({ text: "", at: 0 });

  /** Moves the cursor to a row and shares it: the source scrolls to the node's bytes. */
  const choose = (row: ViewRow) => {
    setFocusedId(row.id);
    const node = row.node;
    // A decoded value's rows have no bytes in the file for the other views to show.
    if (row.kind !== "node" || node === null || model.isInsideDecoded(row.id)) return;
    const current = useSelectionStore.getState().selection;
    if (
      current?.origin === "tree" &&
      current.ref.token === node.ref.token &&
      current.ref.tapeId === node.ref.tapeId
    ) {
      return;
    }
    useSelectionStore.getState().select({
      documentId: node.ref.documentId,
      ref: node.ref,
      range: nodeBytes(node),
      origin: "tree",
      path: null,
    });
  };

  /**
   * Brings a row another view picked (a search hit, a path result, a pick in
   * the source or the map) into view with room around it: a row already well
   * inside the list stays put, any other is scrolled to the middle rather
   * than left on an edge.
   */
  const revealRow = useEffectEvent((index: number, id: string) => {
    const scroller = containerRef.current?.firstElementChild;
    const element = containerRef.current?.querySelector(`[data-row-id="${CSS.escape(id)}"]`);
    if (scroller instanceof HTMLElement && element instanceof HTMLElement) {
      const box = scroller.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (rect.top >= box.top + ROW_HEIGHT && rect.bottom <= box.bottom - ROW_HEIGHT) return;
    }
    void listRef.current?.scrollToIndex?.({ index, animated: false, viewPosition: 0.5 });
  });

  // A node chosen in the source or by search: open the way to it and move the cursor there.
  useEffect(() => {
    if (
      selection !== null &&
      selection.documentId === model.documentId &&
      selection.origin !== "tree" &&
      selection.origin !== "map" &&
      selection.origin !== "edit"
    ) {
      // Clear any unconsumed focus request from a prior tree/edit action before revealing a search/source pick.
      moveFocus.current = false;
    }
    if (
      selection === null ||
      selection.origin === "tree" ||
      selection.documentId !== model.documentId ||
      selection.path === null
    ) {
      return;
    }
    let cancelled = false;
    void model.reveal(selection.path).then((id) => {
      if (cancelled || id === null) return;
      setFocusedId(id);
      const index = model.view().findIndex((row) => row.id === id);
      if (index >= 0) revealRow(index, id);
    });
    return () => {
      cancelled = true;
    };
  }, [selection, model]);

  // A row that left the list (its parent closed, or a loading row that filled in)
  // hands the cursor to the row now at its place, so the tree never loses it.
  const [lastIndex, setLastIndex] = useState(0);
  const found = rows.findIndex((row) => row.id === focusedId);
  // Remembered as the render finds it (React's pattern for state that follows other state).
  if (found >= 0 && found !== lastIndex) setLastIndex(found);
  const focusedIndex = Math.max(0, found >= 0 ? found : Math.min(lastIndex, rows.length - 1));
  const cursorId = rows[focusedIndex]?.id ?? focusedId;

  // Another view's pick scrolls its row into view; a pick on the map also moves the
  // keyboard focus here (the source and the query bar keep theirs).
  useEffect(() => {
    if (!followsSelection) return;
    const index = rows.findIndex((row) => row.id === focusedId);
    if (index < 0) return;
    // After an edit made here the keyboard comes back to the edited row.
    const active = document.activeElement;
    const editedHere =
      selection?.origin === "edit" &&
      (active === null || active === document.body || containerRef.current?.contains(active));
    if (selection?.origin === "map" || editedHere) moveFocus.current = true;
    revealRow(index, focusedId);
  }, [followsSelection, focusedId, rows, selection?.origin, selection?.revision]);

  // The Inspector shows the row that has the focus.
  useEffect(() => {
    model.select(cursorId);
  }, [model, cursorId]);

  useEffect(() => {
    if (!moveFocus.current) return;
    // Wait until the pending external selection catches up rather than focusing the previous row.
    if (
      selection !== null &&
      selection.documentId === model.documentId &&
      selection.origin !== "tree" &&
      selection.revision > local.revision &&
      !followsSelection
    ) {
      return;
    }
    const target = containerRef.current?.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(cursorId)}"]`,
    );
    if (target) {
      moveFocus.current = false;
      target.focus({ preventScroll: true });
    }
  }, [cursorId, rows, selection, model.documentId, local.revision, followsSelection]);

  /**
   * A row far from the one that had the focus (End, Home, a search hit) is
   * mounted by the list only after it scrolls there, after the effect above
   * ran: the row takes the focus itself when it appears.
   */
  const claimFocus = (element: HTMLElement) => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    element.focus({ preventScroll: true });
  };

  const goTo = (index: number) => {
    let at = Math.max(0, Math.min(rows.length - 1, index));
    // A loading row is a placeholder, not a place: the cursor stops on the row it loads for.
    while (at > 0 && rows[at]?.kind === "pending") at--;
    const row = rows[at];
    if (!row) return;
    moveFocus.current = true;
    choose(row);
    void listRef.current?.scrollIndexIntoView?.({ index: rows.indexOf(row), animated: false });
  };

  /** Opens the editor in a row; a container's value is edited in the Inspector, which the F2 command opens. */
  const edit = (row: ViewRow, mode: EditMode) => {
    // A decoded value's rows are read-only: they offer no editor.
    if (row.kind !== "node" || row.node === null || row.decoded || model.isInsideDecoded(row.id))
      return;
    choose(row);
    startNodeEdit({ node: row.node, rowId: row.id, decoded: false }, mode, "tree");
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = rows[focusedIndex];
    if (!row) return;
    switch (event.key) {
      case "ArrowDown":
        goTo(focusedIndex + 1);
        break;
      case "ArrowUp":
        goTo(focusedIndex - 1);
        break;
      case "PageDown":
        goTo(focusedIndex + PAGE_ROWS);
        break;
      case "PageUp":
        goTo(focusedIndex - PAGE_ROWS);
        break;
      case "Home":
        goTo(0);
        break;
      case "End":
        goTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.expandable && !row.expanded) void model.setExpanded(row.id, true);
        else if (row.expanded) goTo(focusedIndex + 1);
        break;
      case "ArrowLeft":
        if (row.expanded && row.id !== model.rootId) void model.setExpanded(row.id, false);
        else if (row.parentId !== null)
          goTo(rows.findIndex((candidate) => candidate.id === row.parentId));
        break;
      case "Enter":
        // A scalar has nothing to open: Enter edits it.
        if (row.kind === "node" && row.node !== null && !row.expandable && isScalar(row.node.kind))
          edit(row, "value");
        else if (row.expandable) void model.toggle(row.id);
        break;
      case " ":
        if (row.expandable) void model.toggle(row.id);
        break;
      default: {
        if (event.key.length !== 1 || event.shiftKey) return;
        const now = Date.now();
        const buffer =
          now - typed.current.at > TYPE_AHEAD_RESET_MS ? event.key : typed.current.text + event.key;
        typed.current = { text: buffer, at: now };
        const needle = buffer.toLowerCase();
        const first = buffer.length > 1 ? 0 : 1;
        for (let step = first; step < rows.length + first; step++) {
          const at = (focusedIndex + step) % rows.length;
          const candidate = rows[at];
          if (candidate && candidate.name.toLowerCase().startsWith(needle)) {
            goTo(at);
            break;
          }
        }
        event.preventDefault();
        return;
      }
    }
    event.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label="Document tree"
      data-tree-view=""
      className="group/tree flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
    >
      <LegendList<ViewRow>
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.id}
        // The list re-renders its rows only when this changes: every row prop that is not in the row's
        // data is part of it (the cursor, the selection, the editor's row and mode).
        extraData={`${cursorId}:${selectedId ?? ""}:${hitSet?.searchId ?? ""}:${editing?.rowId ?? ""}:${editing?.mode ?? ""}:${(currentPath ?? []).length}`}
        estimatedItemSize={ROW_HEIGHT}
        drawDistance={400}
        className="min-h-0 flex-1 overflow-x-hidden overscroll-y-contain px-2 py-2"
        renderItem={({ item: row }) => (
          <TreeRowView
            model={model}
            row={row}
            hitSet={hitSet}
            focused={row.id === cursorId}
            selected={row.id === selectedId}
            onCurrentPath={onCurrentPath.has(row.id)}
            editing={editing !== null && editing.rowId === row.id ? editing : null}
            onFocusRow={() => choose(row)}
            onToggle={() => void model.toggle(row.id)}
            onEdit={(mode) => edit(row, mode)}
            claimFocus={claimFocus}
          />
        )}
      />
    </div>
  );
}

function TreeRowView({
  model,
  row,
  hitSet,
  focused,
  selected,
  onCurrentPath,
  editing,
  onFocusRow,
  onToggle,
  onEdit,
  claimFocus,
}: {
  readonly model: TreeModel;
  readonly row: ViewRow;
  readonly hitSet: HitSet | null;
  readonly focused: boolean;
  readonly selected: boolean;
  /** The row leads to the hit search last stepped to. */
  readonly onCurrentPath: boolean;
  /** The editor open on this row, if any. */
  readonly editing: NodeEditRequest | null;
  readonly onFocusRow: () => void;
  readonly onToggle: () => void;
  readonly onEdit: (mode: EditMode) => void;
  readonly claimFocus: (element: HTMLElement) => void;
}) {
  useEffect(() => {
    if (row.kind === "node") void model.requestText(row.id);
  }, [model, row.id, row.kind]);
  const { lit, inside } = useRowLit(hitSet, row);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused && rowRef.current !== null) claimFocus(rowRef.current);
  }, [focused, claimFocus]);

  const indent = indentOf(row.depth);
  // The level of a row deeper than the indent shows, so the nesting can still be read.
  const level =
    row.depth > MAX_INDENT_LEVELS ? (
      <span
        aria-hidden="true"
        data-tree-level=""
        className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums"
      >
        {row.depth}
      </span>
    ) : null;
  // The cursor row: the theme's selection role, stronger while the tree has the keyboard.
  const current = cn(
    "border-s-(--tree-row-marker-inactive) bg-(--tree-row-selected-inactive)",
    "group-focus-within/tree:bg-(--tree-row-selected) group-focus-within/tree:border-s-(--tree-row-marker)",
  );

  if (row.kind === "pending") {
    return (
      <div
        role="treeitem"
        aria-level={row.depth + 1}
        aria-posinset={1}
        aria-setsize={1}
        aria-selected={false}
        style={{ paddingInlineStart: indent + 8 }}
        className="flex h-7 items-center text-xs text-muted-foreground/60"
      >
        {row.value}
      </div>
    );
  }

  if (row.kind === "text") {
    return (
      <div
        ref={rowRef}
        role="treeitem"
        data-row-id={row.id}
        data-decoded-line=""
        tabIndex={focused ? 0 : -1}
        aria-level={row.depth + 1}
        aria-posinset={row.position}
        aria-setsize={row.setSize}
        aria-selected={focused}
        style={{ paddingInlineStart: indent + 4 + 14 }}
        className={cn(
          "flex h-7 min-w-0 cursor-default select-none items-center gap-2 rounded-sm border-s-2 border-transparent pe-2 font-mono text-xs outline-none",
          "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          focused ? current : "hover:bg-accent/50",
        )}
        onFocus={onFocusRow}
        onClick={onFocusRow}
      >
        {level}
        <span className="w-6 shrink-0 text-end text-muted-foreground/60">{row.name}</span>
        <span className="min-w-0 truncate whitespace-pre text-foreground">{row.value}</span>
      </div>
    );
  }

  const key = row.name;
  const value = row.value;
  const query = lit ? (hitSet?.query ?? null) : null;
  const keyParts = matchParts(key, query);
  const valueParts = matchParts(value, query);
  const marked = keyParts.some((part) => part.match) || valueParts.some((part) => part.match);
  const searching = hitSet !== null;
  return (
    <div
      ref={rowRef}
      role="treeitem"
      data-row-id={row.id}
      data-hit={searching && lit ? "" : undefined}
      data-hit-path={searching && !lit && (inside || onCurrentPath) ? "" : undefined}
      tabIndex={focused ? 0 : -1}
      aria-level={row.depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.setSize}
      aria-selected={selected}
      data-decoded-child={row.decoded ? "" : undefined}
      {...(row.expandable ? { "aria-expanded": row.expanded } : {})}
      style={{ paddingInlineStart: indent + 4 }}
      className={cn(
        "flex min-h-7 min-w-0 cursor-default select-none items-center gap-1 rounded-sm border-s-2 border-transparent pe-2 text-sm outline-none",
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        focused ? current : "hover:bg-accent/50",
        // A hit the row's text does not show (past its preview, or behind an escape) lights the whole row.
        searching && lit && !marked && "bg-search-hit",
        searching && !lit && !inside && !onCurrentPath && "opacity-45",
      )}
      onFocus={onFocusRow}
      onClick={onFocusRow}
      onDoubleClick={() => {
        if (row.expandable) onToggle();
      }}
    >
      {level}
      <span
        aria-hidden="true"
        data-tree-toggle=""
        className="flex size-4 shrink-0 items-center justify-center"
        onClick={() => {
          if (row.expandable) onToggle();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 text-muted-foreground/70 transition-transform",
            row.expandable ? (row.expanded ? "rotate-90" : "") : "invisible",
          )}
        />
      </span>
      {editing?.mode === "key" ? (
        <NodeEditor request={editing} variant="inline" className="w-64 py-0.5" />
      ) : key ? (
        <span
          className="shrink-0"
          style={{ color: treeKeyPaint(row) }}
          data-tree-key=""
          onDoubleClick={(event) => {
            if (row.node?.key === null || row.node === null) return;
            event.stopPropagation();
            onEdit("key");
          }}
        >
          <Marked parts={keyParts} current={focused} />
        </span>
      ) : null}
      {key && (value || editing?.mode === "value") ? (
        <span className="shrink-0 text-muted-foreground/60">:</span>
      ) : null}
      {editing?.mode === "value" ? (
        <NodeEditor request={editing} variant="inline" className="min-w-48 flex-1 py-0.5" />
      ) : value ? (
        <span
          className="min-w-0 truncate"
          style={{ color: treeValuePaint(row) }}
          data-tree-value=""
          data-value-kind={row.node?.kind}
          onDoubleClick={(event) => {
            if (row.node === null || !isScalar(row.node.kind)) return;
            event.stopPropagation();
            onEdit("value");
          }}
        >
          <Marked parts={valueParts} current={focused} />
        </span>
      ) : null}
      {row.badge ? (
        <Badge variant="outline" size="sm" className="ms-auto" data-decode-badge="">
          {row.badge}
        </Badge>
      ) : null}
    </div>
  );
}

/** A label with what the search matched marked, as the source view marks it. */
function Marked({
  parts,
  current,
}: {
  readonly parts: ReadonlyArray<LabelPart>;
  readonly current: boolean;
}) {
  if (parts.length === 1 && parts[0]?.match !== true) return <>{parts[0]?.text ?? ""}</>;
  return (
    <>
      {withOffsets(parts).map(({ part, offset }) =>
        part.match ? (
          <mark
            key={offset}
            data-search-mark=""
            className={cn(
              "rounded-xs",
              current
                ? "bg-search-hit-current text-search-hit-current-foreground"
                : "bg-search-hit text-search-hit-foreground",
            )}
          >
            {part.text}
          </mark>
        ) : (
          <span key={offset}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Each part with where it starts in the label, a key that stays put while the label does. */
function withOffsets(parts: ReadonlyArray<LabelPart>) {
  const out: Array<{ part: LabelPart; offset: number }> = [];
  let offset = 0;
  for (const part of parts) {
    out.push({ part, offset });
    offset += part.text.length;
  }
  return out;
}

const isScalar = (kind: string) => kind !== "object" && kind !== "array";
