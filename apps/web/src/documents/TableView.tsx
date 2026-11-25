import type { NodeSummary } from "@quipu/contracts/engine";
import type {
  HarRequestRowSummary,
  TableCellValue,
  TableColumn,
  TableRow,
} from "@quipu/contracts/table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, FilterXIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { NodeEditor } from "~/components/edit/NodeEditor";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { type NodeEditRequest, startNodeEdit, useNodeEditor } from "./documentEdits.ts";
import type { OpenDocument } from "./documentSession.ts";
import {
  formatBodySize,
  formatDurationMs,
  HarTimelineScrubber,
  HarWaterfallBar,
} from "./HarWaterfall.tsx";
import { selectedNodeId, useSelectionStore } from "./selectionStore.ts";
import { TABLE_VIEW_PAGE_SIZE, TableModel, type TableSource } from "./tableModel.ts";
import { nodeId } from "./treeModel.ts";

const ROW_HEIGHT = 28;
const PAGE_ROWS = 10;
const FILTER_DEBOUNCE_MS = 120;
const TABLE_EDIT_PREFIX = "table:";

const cellEditId = (rowIndex: number, columnKey: string) =>
  `${TABLE_EDIT_PREFIX}${rowIndex}:${columnKey}`;

const harColumnWidth = (key: string): string => {
  switch (key) {
    case "#":
      return "56px";
    case "method":
      return "76px";
    case "status":
      return "72px";
    case "url":
      return "minmax(240px, 2fr)";
    case "mimeType":
      return "140px";
    case "bodySize":
      return "88px";
    case "timeMs":
      return "84px";
    default:
      return "minmax(140px, 1fr)";
  }
};

function statusBadgeClasses(statusClass: HarRequestRowSummary["statusClass"]): string {
  switch (statusClass) {
    case "2xx":
      return "bg-success/8 text-success-foreground dark:bg-success/16";
    case "3xx":
      return "bg-info/8 text-info-foreground dark:bg-info/16";
    case "4xx":
      return "bg-warning/8 text-warning-foreground dark:bg-warning/16";
    case "5xx":
      return "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

export interface TableViewProps {
  readonly document: OpenDocument;
  readonly source: TableSource;
  /** Optional logical row indices (0-based in target array) for hit-filter integration. */
  readonly filteredRowIndices?: ReadonlyArray<number> | null;
}

/**
 * Virtualized tabular view over any JSON array or HAR capture (`$.log.entries`).
 * Uses fixed-height row virtualization, view-only worker sorting and per-column
 * substring filtering, inline scalar editing, and the HAR request waterfall.
 */
export function TableView({ document: doc, source, filteredRowIndices = null }: TableViewProps) {
  const [model] = useState(() => new TableModel(doc.documentId, source));
  const snapshot = useSyncExternalStore(model.subscribe, model.view);
  const [showTimeline, setShowTimeline] = useState(true);
  const [focusedRow, setFocusedRow] = useState(0);
  const [focusedCol, setFocusedCol] = useState(0);
  const [filterDrafts, setFilterDrafts] = useState<Record<string, string>>({});

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const filterTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const selection = useSelectionStore((state) => state.selection);
  const selectedId = selection !== null ? selectedNodeId(selection, doc.documentId) : null;

  const editing = useNodeEditor((state) =>
    state.request?.documentId === doc.documentId &&
    state.request.rowId?.startsWith(TABLE_EDIT_PREFIX)
      ? state.request
      : null,
  );

  useEffect(() => {
    void model.load();
    return () => {
      model.dispose();
    };
  }, [model]);

  useEffect(() => {
    void model.setFilteredRowIndices(filteredRowIndices);
  }, [model, filteredRowIndices]);

  // Live edits, undo, redo, and transforms bump document.revision; reload the view permutation.
  const initialRevision = useRef(doc.revision);
  useEffect(() => {
    model.setDocumentRevision(doc.revision);
    if (doc.revision === initialRevision.current) return;
    initialRevision.current = doc.revision;
    void model.reload();
  }, [doc.revision, model]);

  useEffect(() => {
    const timers = filterTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return observeResize(el, (entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === "number" && h > 0) setViewportHeight(h);
    });
  }, [snapshot.phase, snapshot.matchedRows]);

  const isHar = snapshot.target?.isHarEntries === true;
  const columns = snapshot.columns;

  const gridTemplateColumns = isHar
    ? [...columns.map((c) => harColumnWidth(c.key)), "minmax(180px, 1.5fr)"].join(" ")
    : ["56px", ...columns.map(() => "minmax(150px, 1fr)")].join(" ");

  const selectRowOrCell = (row: TableRow, cell?: TableCellValue) => {
    const ref = cell?.ref ?? row.ref;
    const current = useSelectionStore.getState().selection;
    if (
      current?.origin === "tree" &&
      current.ref.token === ref.token &&
      current.ref.tapeId === ref.tapeId
    ) {
      return;
    }
    useSelectionStore.getState().select({
      documentId: doc.documentId,
      ref,
      range: row.span,
      // Keep "tree" origin so Source/Inspector sync without altering shared SelectionOrigin.
      origin: "tree",
      path: null,
    });
  };

  const editCell = (row: TableRow, col: TableColumn) => {
    const cell = row.cells[col.key];
    if (!cell || !cell.editable || cell.ref === null || cell.kind === null) return;
    const syntheticNode: NodeSummary = {
      ref: cell.ref,
      kind: cell.kind,
      range: row.span,
      span: row.span,
      key: null,
      childCount: 0,
      childrenIndexed: true,
      settled: true,
    };
    selectRowOrCell(row, cell);
    startNodeEdit(
      {
        node: syntheticNode,
        rowId: cellEditId(row.rowIndex, col.key),
        decoded: false,
      },
      "value",
      "tree",
    );
  };

  const goToRow = (index: number) => {
    if (snapshot.matchedRows === 0) return;
    const clamped = Math.max(0, Math.min(snapshot.matchedRows - 1, index));
    setFocusedRow(clamped);
    model.requestRow(clamped);
    const row = model.rowAt(clamped);
    if (row) selectRowOrCell(row);
    const scroller = scrollRef.current;
    if (scroller) {
      const rowTop = clamped * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      if (rowTop < scroller.scrollTop) {
        scroller.scrollTop = rowTop;
      } else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
      }
    }
  };

  const onFilterInputChange = (column: string, value: string) => {
    setFilterDrafts((prev) => {
      if (value === "") {
        const next = { ...prev };
        delete next[column];
        return next;
      }
      return { ...prev, [column]: value };
    });
    const prevTimer = filterTimers.current.get(column);
    if (prevTimer !== undefined) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      filterTimers.current.delete(column);
      void model.setFilter(column, value);
    }, FILTER_DEBOUNCE_MS);
    filterTimers.current.set(column, timer);
  };

  const flushFilter = (column: string, value: string) => {
    const prevTimer = filterTimers.current.get(column);
    if (prevTimer !== undefined) {
      clearTimeout(prevTimer);
      filterTimers.current.delete(column);
    }
    void model.setFilter(column, value);
  };

  const clearAll = () => {
    for (const timer of filterTimers.current.values()) clearTimeout(timer);
    filterTimers.current.clear();
    setFilterDrafts({});
    void model.clearAllFilters();
  };

  const hasActiveControls =
    snapshot.sort !== null ||
    Object.keys(snapshot.filters).length > 0 ||
    snapshot.timeWindow !== null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing !== null) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowDown":
        goToRow(focusedRow + 1);
        break;
      case "ArrowUp":
        goToRow(focusedRow - 1);
        break;
      case "PageDown":
        goToRow(focusedRow + PAGE_ROWS);
        break;
      case "PageUp":
        goToRow(focusedRow - PAGE_ROWS);
        break;
      case "Home":
        goToRow(0);
        break;
      case "End":
        goToRow(snapshot.matchedRows - 1);
        break;
      case "ArrowRight":
        setFocusedCol((c) => Math.min(Math.max(0, columns.length - 1), c + 1));
        break;
      case "ArrowLeft":
        setFocusedCol((c) => Math.max(0, c - 1));
        break;
      case "Enter": {
        const row = model.rowAt(focusedRow);
        const col = columns[focusedCol];
        if (row && col) editCell(row, col);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const totalSpanMs = snapshot.harTimeline?.totalSpanMs ?? 0;

  return (
    <div
      ref={containerRef}
      data-table-view=""
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={onKeyDown}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1.5 text-xs">
        {snapshot.targets.length > 1 ? (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Array</span>
            <Select
              value={snapshot.target?.path ?? ""}
              onValueChange={(nextPath) => {
                if (typeof nextPath === "string" && nextPath.length > 0) {
                  setFilterDrafts({});
                  void model.setTargetPath(nextPath);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-60 shrink-0" aria-label="Target array">
                <SelectValue>{snapshot.target?.label ?? "Select array"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {snapshot.targets.map((target) => (
                  <SelectItem key={target.path} value={target.path}>
                    {target.label} ({target.rowCount.toLocaleString("en-US")})
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : snapshot.target ? (
          <span className="font-mono text-foreground">{snapshot.target.label}</span>
        ) : null}

        <span data-table-row-count="" className="text-muted-foreground tabular-nums">
          {snapshot.matchedRows === snapshot.totalRows
            ? `${snapshot.totalRows.toLocaleString("en-US")} rows`
            : `${snapshot.matchedRows.toLocaleString("en-US")} of ${snapshot.totalRows.toLocaleString("en-US")} rows`}
        </span>

        {filteredRowIndices !== null ? (
          <Badge variant="info" size="sm">
            Match filter active
          </Badge>
        ) : null}

        <div className="ms-auto flex items-center gap-1.5">
          {isHar && snapshot.harTimeline !== null ? (
            <Button
              size="xs"
              variant={showTimeline ? "secondary" : "outline"}
              onClick={() => setShowTimeline((v) => !v)}
              data-toggle-timeline=""
            >
              {showTimeline ? "Hide timeline" : "Show timeline"}
            </Button>
          ) : null}
          {hasActiveControls ? (
            <Button size="xs" variant="outline" onClick={clearAll} data-clear-table-filters="">
              <FilterXIcon />
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      {isHar && showTimeline && snapshot.harTimeline !== null ? (
        <HarTimelineScrubber
          timeline={snapshot.harTimeline}
          timeWindow={snapshot.timeWindow}
          onTimeWindowChange={(win) => void model.setTimeWindow(win)}
        />
      ) : null}

      {snapshot.phase === "loading" && snapshot.totalRows === 0 ? (
        <div
          role="status"
          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner size="sm" />
          Loading table…
        </div>
      ) : snapshot.phase === "error" ? (
        <div
          role="alert"
          className="flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-destructive-foreground"
        >
          {snapshot.error}
        </div>
      ) : columns.length === 0 && snapshot.totalRows === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
          No tabular array found in this document.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
          <div className="flex min-h-0 w-max min-w-full flex-1 flex-col">
            <div
              role="row"
              style={{ gridTemplateColumns }}
              className="grid shrink-0 items-center border-b bg-muted/40 text-xs font-medium text-muted-foreground"
            >
              {isHar ? null : <div className="flex h-7 items-center border-e px-2 text-2xs">#</div>}
              {columns.map((col, colIndex) => {
                const sorted = snapshot.sort?.column === col.key ? snapshot.sort.direction : null;
                return (
                  <button
                    key={col.key}
                    type="button"
                    data-column-sort={col.key}
                    onClick={() => {
                      setFocusedCol(colIndex);
                      void model.toggleSort(col.key);
                    }}
                    className={cn(
                      "flex h-7 min-w-0 items-center gap-1 border-e px-2 text-start outline-none",
                      "hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      sorted !== null && "text-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{col.label}</span>
                    {sorted === "asc" ? (
                      <ArrowUpIcon className="size-3 shrink-0" />
                    ) : sorted === "desc" ? (
                      <ArrowDownIcon className="size-3 shrink-0" />
                    ) : (
                      <ArrowUpDownIcon className="size-3 shrink-0 opacity-40" />
                    )}
                  </button>
                );
              })}
              {isHar ? <div className="flex h-7 items-center px-2 text-xs">Waterfall</div> : null}
            </div>

            <div
              role="row"
              style={{ gridTemplateColumns }}
              className="grid shrink-0 items-center border-b bg-background py-1"
            >
              {isHar ? null : <div className="px-2" />}
              {columns.map((col) => (
                <div key={col.key} className="min-w-0 border-e px-1.5">
                  <Input
                    nativeInput
                    size="row"
                    font="mono"
                    aria-label={`Filter ${col.label}`}
                    placeholder="Filter…"
                    value={filterDrafts[col.key] ?? snapshot.filters[col.key] ?? ""}
                    onChange={(event) => onFilterInputChange(col.key, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        flushFilter(col.key, event.currentTarget.value);
                      }
                    }}
                  />
                </div>
              ))}
              {isHar ? <div className="px-2" /> : null}
            </div>

            {snapshot.matchedRows === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
                No matching rows.
              </div>
            ) : (
              <div
                ref={scrollRef}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain"
              >
                <VirtualTableRows
                  model={model}
                  matchedRows={snapshot.matchedRows}
                  scrollTop={scrollTop}
                  viewportHeight={viewportHeight}
                  columns={columns}
                  isHar={isHar}
                  totalSpanMs={totalSpanMs}
                  gridTemplateColumns={gridTemplateColumns}
                  focusedRow={focusedRow}
                  focusedCol={focusedCol}
                  selectedId={selectedId}
                  editing={editing}
                  onSelectRowCell={(displayIndex, row, colIndex) => {
                    setFocusedRow(displayIndex);
                    setFocusedCol(colIndex);
                    const col = columns[colIndex];
                    selectRowOrCell(row, col ? row.cells[col.key] : undefined);
                  }}
                  onEditCell={editCell}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TABLE_OVERSCAN_ROWS = 4;

function VirtualTableRows({
  model,
  matchedRows,
  scrollTop,
  viewportHeight,
  columns,
  isHar,
  totalSpanMs,
  gridTemplateColumns,
  focusedRow,
  focusedCol,
  selectedId,
  editing,
  onSelectRowCell,
  onEditCell,
}: {
  readonly model: TableModel;
  readonly matchedRows: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly isHar: boolean;
  readonly totalSpanMs: number;
  readonly gridTemplateColumns: string;
  readonly focusedRow: number;
  readonly focusedCol: number;
  readonly selectedId: string | null;
  readonly editing: NodeEditRequest | null;
  readonly onSelectRowCell: (displayIndex: number, row: TableRow, colIndex: number) => void;
  readonly onEditCell: (row: TableRow, col: TableColumn) => void;
}) {
  const totalHeight = matchedRows * ROW_HEIGHT;
  const clampedScrollTop = Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight));
  const startRow = Math.max(0, Math.floor(clampedScrollTop / ROW_HEIGHT) - TABLE_OVERSCAN_ROWS);
  const endRow = Math.min(
    matchedRows,
    startRow + Math.ceil(viewportHeight / ROW_HEIGHT) + TABLE_OVERSCAN_ROWS * 2,
  );
  const visibleCount = Math.max(0, endRow - startRow);

  return (
    <div style={{ height: totalHeight }}>
      <div style={{ transform: `translateY(${startRow * ROW_HEIGHT}px)` }}>
        {Array.from({ length: visibleCount }, (_, offset) => {
          const displayIndex = startRow + offset;
          return (
            <TableRowItem
              key={displayIndex}
              model={model}
              displayIndex={displayIndex}
              columns={columns}
              isHar={isHar}
              totalSpanMs={totalSpanMs}
              gridTemplateColumns={gridTemplateColumns}
              focused={displayIndex === focusedRow}
              focusedCol={focusedCol}
              selectedNodeKey={selectedId}
              editing={editing}
              onSelectRow={(row, colIndex) => onSelectRowCell(displayIndex, row, colIndex)}
              onEditCell={onEditCell}
            />
          );
        })}
      </div>
    </div>
  );
}

function TableRowItem({
  model,
  displayIndex,
  columns,
  isHar,
  totalSpanMs,
  gridTemplateColumns,
  focused,
  focusedCol,
  selectedNodeKey,
  editing,
  onSelectRow,
  onEditCell,
}: {
  readonly model: TableModel;
  readonly displayIndex: number;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly isHar: boolean;
  readonly totalSpanMs: number;
  readonly gridTemplateColumns: string;
  readonly focused: boolean;
  readonly focusedCol: number;
  readonly selectedNodeKey: string | null;
  readonly editing: NodeEditRequest | null;
  readonly onSelectRow: (row: TableRow, colIndex: number) => void;
  readonly onEditCell: (row: TableRow, col: TableColumn) => void;
}) {
  const row = model.rowAt(displayIndex);
  useEffect(() => {
    if (row === undefined) {
      // Prefetch around visible virtualized row.
      model.requestRow(displayIndex);
      if (displayIndex % TABLE_VIEW_PAGE_SIZE === 0) {
        model.requestRow(displayIndex + TABLE_VIEW_PAGE_SIZE);
      }
    }
  }, [model, displayIndex, row]);

  if (row === undefined) {
    return (
      <div
        role="row"
        style={{ gridTemplateColumns }}
        className="grid h-7 items-center border-b px-2 text-xs text-muted-foreground/60"
      >
        <span>Loading…</span>
      </div>
    );
  }

  const rowSelected = selectedNodeKey !== null && nodeId(row.ref) === selectedNodeKey;
  const har = row.har;

  return (
    <div
      role="row"
      data-table-row={row.rowIndex}
      aria-selected={focused || rowSelected}
      style={{ gridTemplateColumns }}
      className={cn(
        "grid h-7 cursor-default select-none items-center border-b text-xs",
        focused || rowSelected ? "bg-accent/60" : "hover:bg-accent/30",
      )}
    >
      {isHar ? null : (
        <div
          className="flex h-full items-center border-e px-2 font-mono text-2xs tabular-nums text-muted-foreground"
          onClick={() => onSelectRow(row, 0)}
        >
          {row.rowIndex + 1}
        </div>
      )}

      {columns.map((col, colIndex) => {
        const cell = row.cells[col.key];
        const isEditingCell =
          editing !== null && editing.rowId === cellEditId(row.rowIndex, col.key);
        const cellFocused = focused && focusedCol === colIndex;

        if (isEditingCell && editing !== null) {
          return (
            <div key={col.key} className="flex h-full min-w-0 items-center border-e px-1">
              <NodeEditor request={editing} variant="inline" size="row" className="w-full" />
            </div>
          );
        }

        return (
          <div
            key={col.key}
            role="gridcell"
            data-table-cell={`${row.rowIndex}:${col.key}`}
            className={cn(
              "flex h-full min-w-0 items-center truncate border-e px-2",
              cellFocused && "ring-1 ring-inset ring-ring",
            )}
            onClick={() => onSelectRow(row, colIndex)}
            onDoubleClick={() => onEditCell(row, col)}
          >
            {isHar && har !== null ? (
              <HarCellContent colKey={col.key} har={har} />
            ) : (
              <GenericCellContent cell={cell} />
            )}
          </div>
        );
      })}

      {isHar && har !== null ? (
        <div
          className="flex h-full min-w-0 items-center px-2"
          onClick={() => onSelectRow(row, Math.max(0, columns.length - 1))}
        >
          <HarWaterfallBar entry={har} totalSpanMs={totalSpanMs} />
        </div>
      ) : null}
    </div>
  );
}

function GenericCellContent({ cell }: { readonly cell: TableCellValue | undefined }) {
  if (!cell) return <span className="text-muted-foreground/40">—</span>;
  if (cell.kind === "null") {
    return <span className="font-mono text-muted-foreground">null</span>;
  }
  if (cell.kind === "number" || cell.kind === "true" || cell.kind === "false") {
    return <span className="truncate font-mono tabular-nums text-foreground">{cell.text}</span>;
  }
  if (cell.kind === "object" || cell.kind === "array") {
    return <span className="truncate font-mono text-muted-foreground">{cell.text}</span>;
  }
  return <span className="truncate font-mono text-foreground">{cell.text}</span>;
}

function HarCellContent({
  colKey,
  har,
}: {
  readonly colKey: string;
  readonly har: HarRequestRowSummary;
}) {
  switch (colKey) {
    case "#":
      return (
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">
          {har.entryIndex + 1}
        </span>
      );
    case "method":
      return (
        <span className="truncate font-mono font-medium text-foreground">{har.method ?? "—"}</span>
      );
    case "status":
      return har.status !== null ? (
        <span
          data-slot="badge"
          className={cn(
            "inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-1 font-mono text-xs font-medium leading-none tabular-nums sm:h-4 sm:min-w-4",
            statusBadgeClasses(har.statusClass),
          )}
        >
          {har.status}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "url":
      return <span className="truncate font-mono text-foreground">{har.url ?? "—"}</span>;
    case "mimeType":
      return (
        <span className="truncate font-mono text-muted-foreground">
          {har.mimeType ? har.mimeType.split(";")[0] : "—"}
        </span>
      );
    case "bodySize":
      return (
        <span className="w-full truncate text-end font-mono tabular-nums text-muted-foreground">
          {formatBodySize(har.bodySize)}
        </span>
      );
    case "timeMs":
      return (
        <span className="w-full truncate text-end font-mono tabular-nums text-muted-foreground">
          {formatDurationMs(har.timeMs)}
        </span>
      );
    default:
      return <span className="text-muted-foreground">—</span>;
  }
}
