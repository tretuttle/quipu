import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type {
  DiffChange,
  DiffMark,
  DiffMergedRow,
  HarDiffClass,
  HarDiffEntry,
  StructuralDiffResult,
} from "@quipu/contracts/diff";
import {
  ArrowLeftRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClipboardPasteIcon,
  FileUpIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { Toggle } from "~/components/ui/toggle";
import { ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  type CompareClient,
  type CompareMode,
  CompareModel,
  type CompareTargetDocument,
  harClassSymbol,
  harEntryKey,
  type HarFilter,
  markSymbol,
} from "./compareModel.ts";

const ROW_HEIGHT = 28;
const HAR_ROW_HEIGHT = 36;
const INDENT_PX = 16;
const MAX_INDENT_LEVELS = 24;
const indentOf = (depth: number) => Math.min(depth, MAX_INDENT_LEVELS) * INDENT_PX;

const MARK_ROW_CLASS: Record<DiffMark, string> = {
  same: "",
  inside: "",
  added: "bg-success/10",
  removed: "bg-destructive/10",
  changed: "bg-warning/10",
  moved: "bg-info/10",
};

const MARK_BADGE_CLASS: Record<DiffMark, string> = {
  same: "text-muted-foreground/50",
  inside: "text-muted-foreground/70",
  added: "text-success-foreground font-semibold",
  removed: "text-destructive-foreground font-semibold",
  changed: "text-warning-foreground font-semibold",
  moved: "text-info-foreground font-semibold",
};

const HAR_CLASS_ROW_STYLE: Record<HarDiffClass, string> = {
  same: "",
  added: "bg-success/10",
  removed: "bg-destructive/10",
  changed: "bg-warning/10",
};

const HAR_CLASS_TEXT_STYLE: Record<HarDiffClass, string> = {
  same: "text-muted-foreground",
  added: "text-success-foreground",
  removed: "text-destructive-foreground",
  changed: "text-warning-foreground",
};

function chooseFileWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.har,.jsonc,.jsonl,.ndjson,application/json,text/plain";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function formatChangeLabel(change: DiffChange): string {
  const ptr = (p: string | null) => (p === "" ? "/" : (p ?? ""));
  switch (change.kind) {
    case "added":
      return `Added ${ptr(change.pathB)}`;
    case "removed":
      return `Removed ${ptr(change.pathA)}`;
    case "changed":
      return change.pathA !== change.pathB
        ? `Changed ${ptr(change.pathB)} (was ${ptr(change.pathA)})`
        : `Changed ${ptr(change.pathB)}`;
    case "moved":
      return `Moved ${ptr(change.pathA)} to ${ptr(change.pathB)}`;
  }
}

export interface CompareViewProps {
  readonly primary: CompareTargetDocument;
  readonly client?: CompareClient | null;
  readonly model?: CompareModel;
}

/**
 * Side-by-side / merged structural JSON and HAR capture comparison view.
 * Supports F7 / Shift+F7 change stepping, reference document swapping,
 * file & clipboard target selection, and inline HAR response body structural diffs.
 */
export function CompareView({ primary, client = null, model: externalModel }: CompareViewProps) {
  const [internalModel] = useState(() =>
    externalModel === undefined ? new CompareModel(primary, client) : null,
  );
  const model = externalModel ?? internalModel!;

  useEffect(() => {
    return () => {
      internalModel?.dispose();
    };
  }, [internalModel]);

  const snap = useSyncExternalStore(model.subscribe, model.snapshot);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const treeListRef = useRef<LegendListRef | null>(null);
  const harListRef = useRef<LegendListRef | null>(null);

  useEffect(() => {
    if (snap.focusedRowId === null) return;
    const index = snap.visibleRows.findIndex((r) => r.id === snap.focusedRowId);
    if (index >= 0) {
      treeListRef.current?.scrollIndexIntoView({ index, animated: false });
    }
  }, [snap.focusedRowId, snap.visibleRows]);

  useEffect(() => {
    if (snap.activeHarIndex < 0) return;
    harListRef.current?.scrollIndexIntoView({ index: snap.activeHarIndex, animated: false });
  }, [snap.activeHarIndex]);

  const pickFile = async () => {
    const file = await chooseFileWithInput();
    if (file) await model.openFile(file);
  };

  const pasteFromClipboard = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text.trim().length > 0) {
          await model.openClipboardText(text, "clipboard.json");
          return;
        }
      } catch {
        // Clipboard read permission denied or unavailable; open inline paste editor.
      }
    }
    setPasteOpen(true);
  };

  const submitInlinePaste = async () => {
    if (pasteText.trim().length === 0) return;
    setPasteOpen(false);
    const content = pasteText;
    setPasteText("");
    await model.openClipboardText(content, "clipboard.json");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "F7") {
      event.preventDefault();
      if (event.shiftKey) model.stepPrevious();
      else model.stepNext();
    }
  };

  const refDoc = snap.reference === "a" ? snap.primary : snap.target;
  const targetDoc = snap.reference === "a" ? snap.target : snap.primary;
  const canToggleHar = snap.primary.format === "har" && snap.target?.format === "har";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col outline-none"
      data-compare-view=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="outline" size="sm">
            Ref
          </Badge>
          <span className="max-w-44 truncate font-medium text-foreground">
            {refDoc?.name ?? "None"}
          </span>
          <span className="text-muted-foreground">vs</span>
          <span className="max-w-44 truncate font-medium text-foreground">
            {targetDoc?.name ?? "Select target"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="compact" variant="outline" onClick={() => void pickFile()}>
            <FileUpIcon />
            Open file…
          </Button>
          <Button size="compact" variant="outline" onClick={() => void pasteFromClipboard()}>
            <ClipboardPasteIcon />
            Paste
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="compact"
                  variant="outline"
                  disabled={snap.target === null}
                  onClick={() => void model.swapReference()}
                />
              }
            >
              <ArrowLeftRightIcon />
              Swap ref
            </TooltipTrigger>
            <TooltipPopup side="bottom">Swap which document is the reference</TooltipPopup>
          </Tooltip>
        </div>

        {canToggleHar ? (
          <ToggleGroup
            aria-label="Comparison mode"
            variant="segmented"
            value={[snap.mode]}
            onValueChange={(vals) => {
              const next = vals[0];
              if (next === "har" || next === "structural") void model.setMode(next as CompareMode);
            }}
          >
            <Toggle value="har">HAR Requests</Toggle>
            <Toggle value="structural">JSON Tree</Toggle>
          </ToggleGroup>
        ) : null}

        <div className="ms-auto flex items-center gap-1.5">
          {snap.mode === "har" && snap.har ? <HarCountsSummary har={snap.har} /> : null}
          {snap.mode === "structural" && snap.structural ? (
            <StructuralCountsSummary result={snap.structural} />
          ) : null}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="compact"
                  variant="outline"
                  disabled={snap.status !== "ready"}
                  onClick={() => model.stepPrevious()}
                  aria-label="Previous change"
                />
              }
            >
              <ChevronUpIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Previous change <Kbd>Shift+F7</Kbd>
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="compact"
                  variant="outline"
                  disabled={snap.status !== "ready"}
                  onClick={() => model.stepNext()}
                  aria-label="Next change"
                />
              }
            >
              <ChevronDownIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Next change <Kbd>F7</Kbd>
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {pasteOpen ? (
        <div className="flex flex-col gap-2 border-b bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Paste JSON or HAR text to compare against {snap.primary.name}.
          </p>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder='{"example": true}'
            rows={5}
            aria-label="Paste JSON or HAR content"
          />
          <div className="flex items-center justify-end gap-2">
            <Button size="compact" variant="ghost" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button
              size="compact"
              variant="default"
              disabled={pasteText.trim().length === 0}
              onClick={() => void submitInlinePaste()}
            >
              Compare pasted text
            </Button>
          </div>
        </div>
      ) : null}

      {snap.status === "idle" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <h2 className="font-medium text-foreground text-sm">Compare against another file</h2>
            <p className="text-xs leading-normal text-muted-foreground">
              Open a second JSON or HAR file, or paste text from your clipboard to compare against{" "}
              {snap.primary.name}.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void pickFile()}>
                <FileUpIcon />
                Open file…
              </Button>
              <Button size="sm" variant="outline" onClick={() => void pasteFromClipboard()}>
                <ClipboardPasteIcon />
                Paste from clipboard
              </Button>
            </div>
          </div>
        </div>
      ) : snap.status === "loading" ? (
        <div
          role="status"
          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner size="sm" />
          Computing diff…
        </div>
      ) : snap.status === "error" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div role="alert" className="flex max-w-md flex-col items-center gap-2 text-center">
            <h2 className="font-medium text-foreground text-sm">Comparison failed</h2>
            <p className="text-xs text-destructive-foreground">{snap.error}</p>
          </div>
        </div>
      ) : snap.mode === "har" && snap.har ? (
        <HarCompareBody
          model={model}
          harFilter={snap.harFilter}
          entries={snap.filteredHarEntries}
          activeHarIndex={snap.activeHarIndex}
          expandedHarKeys={snap.expandedHarKeys}
          harEntryBodies={snap.harEntryBodies}
          listRef={harListRef}
        />
      ) : snap.structural ? (
        <StructuralCompareBody
          model={model}
          rows={snap.visibleRows}
          changes={snap.structural.changes}
          activeChangeIndex={snap.activeChangeIndex}
          focusedRowId={snap.focusedRowId}
          collapsedIds={snap.collapsedIds}
          listRef={treeListRef}
        />
      ) : null}
    </div>
  );
}

function StructuralCountsSummary({ result }: { readonly result: StructuralDiffResult }) {
  const { added, removed, changed, moved } = result.counts;
  return (
    <div className="flex items-center gap-1" data-diff-counts="">
      <Badge variant="success" size="sm">
        +{added}
      </Badge>
      <Badge variant="error" size="sm">
        -{removed}
      </Badge>
      <Badge variant="warning" size="sm">
        ~{changed}
      </Badge>
      {moved > 0 ? (
        <Badge variant="info" size="sm">
          →{moved}
        </Badge>
      ) : null}
    </div>
  );
}

function HarCountsSummary({
  har,
}: {
  readonly har: NonNullable<ReturnType<CompareModel["snapshot"]>["har"]>;
}) {
  const { same, added, removed, changed } = har.counts;
  return (
    <div className="flex items-center gap-1" data-har-diff-counts="">
      <Badge variant="outline" size="sm">
        ={same}
      </Badge>
      <Badge variant="success" size="sm">
        +{added}
      </Badge>
      <Badge variant="error" size="sm">
        -{removed}
      </Badge>
      <Badge variant="warning" size="sm">
        ~{changed}
      </Badge>
    </div>
  );
}

function StructuralCompareBody({
  model,
  rows,
  changes,
  activeChangeIndex,
  focusedRowId,
  collapsedIds,
  listRef,
}: {
  readonly model: CompareModel;
  readonly rows: ReadonlyArray<DiffMergedRow>;
  readonly changes: ReadonlyArray<DiffChange>;
  readonly activeChangeIndex: number;
  readonly focusedRowId: string | null;
  readonly collapsedIds: ReadonlySet<string>;
  readonly listRef: React.RefObject<LegendListRef | null>;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex min-w-0 flex-1 flex-col font-mono text-xs"
        role="tree"
        aria-label="Merged diff tree"
      >
        <LegendList
          ref={listRef}
          data={rows as DiffMergedRow[]}
          keyExtractor={(row) => row.id}
          extraData={`${focusedRowId ?? ""}:${collapsedIds.size}`}
          estimatedItemSize={ROW_HEIGHT}
          drawDistance={400}
          recycleItems
          className="min-h-0 flex-1 overflow-x-hidden overscroll-y-contain"
          renderItem={({ item }) => (
            <MergedDiffTreeRow
              row={item}
              collapsed={collapsedIds.has(item.id)}
              focused={item.id === focusedRowId}
              onToggle={() => model.toggleRow(item.id)}
              onFocus={() => model.focusRow(item.id)}
            />
          )}
        />
      </div>

      <aside
        aria-label="Change list"
        className="flex w-72 shrink-0 flex-col border-s bg-muted/20"
        data-compare-changes=""
      >
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs font-medium text-foreground">
          <span>Changes</span>
          <Badge variant="outline" size="sm">
            {changes.length}
          </Badge>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {changes.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              Documents are structurally equal.
            </p>
          ) : (
            changes.map((change, index) => {
              const active = index === activeChangeIndex;
              return (
                <button
                  key={`${change.kind}:${change.pathB ?? change.pathA ?? index}`}
                  type="button"
                  data-change-item=""
                  data-active={active ? "" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-xs transition-colors outline-none",
                    "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                  onClick={() => model.selectChange(index)}
                >
                  <span className={cn("w-3 shrink-0 text-center", MARK_BADGE_CLASS[change.kind])}>
                    {markSymbol(change.kind)}
                  </span>
                  <span className="min-w-0 truncate">{formatChangeLabel(change)}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

function MergedDiffTreeRow({
  row,
  collapsed,
  focused,
  onToggle,
  onFocus,
}: {
  readonly row: DiffMergedRow;
  readonly collapsed: boolean;
  readonly focused: boolean;
  readonly onToggle: () => void;
  readonly onFocus: () => void;
}) {
  const indent = indentOf(row.depth);
  const label = row.key !== null ? row.key : row.index !== null ? String(row.index) : "root";

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={focused}
      {...(row.expandable ? { "aria-expanded": !collapsed } : {})}
      data-diff-row={row.id}
      data-diff-mark={row.mark}
      style={{ paddingInlineStart: indent + 6 }}
      className={cn(
        "flex min-h-7 min-w-0 cursor-default select-none items-center gap-1.5 border-s-2 border-transparent pe-2 text-xs outline-none",
        MARK_ROW_CLASS[row.mark],
        focused ? "border-s-ring bg-accent" : "hover:bg-accent/40",
      )}
      onClick={onFocus}
      onDoubleClick={() => {
        if (row.expandable) onToggle();
      }}
    >
      <span className={cn("w-3 shrink-0 text-center", MARK_BADGE_CLASS[row.mark])}>
        {markSymbol(row.mark)}
      </span>
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center"
        onClick={(e) => {
          if (!row.expandable) return;
          e.stopPropagation();
          onToggle();
        }}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            row.expandable ? (collapsed ? "" : "rotate-90") : "invisible",
          )}
        />
      </span>
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      <span className="shrink-0 text-muted-foreground/60">:</span>
      <span className="min-w-0 truncate text-muted-foreground">{row.value}</span>
      {row.wasValue !== null ? (
        <span className="min-w-0 truncate text-destructive-foreground/80">
          (was {row.wasValue})
        </span>
      ) : null}
    </div>
  );
}

function HarCompareBody({
  model,
  harFilter,
  entries,
  activeHarIndex,
  expandedHarKeys,
  harEntryBodies,
  listRef,
}: {
  readonly model: CompareModel;
  readonly harFilter: HarFilter;
  readonly entries: ReadonlyArray<HarDiffEntry>;
  readonly activeHarIndex: number;
  readonly expandedHarKeys: ReadonlySet<string>;
  readonly harEntryBodies: ReadonlyMap<
    string,
    ReturnType<CompareModel["snapshot"]>["harEntryBodies"] extends ReadonlyMap<string, infer V>
      ? V
      : never
  >;
  readonly listRef: React.RefObject<LegendListRef | null>;
}) {
  const diffEntries = entries.filter((e) => e.classification !== "same");

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs">
          <ToggleGroup
            aria-label="Filter HAR entries"
            variant="segmented"
            value={[harFilter]}
            onValueChange={(vals) => {
              const v = vals[0];
              if (v) model.setHarFilter(v as HarFilter);
            }}
          >
            <Toggle value="all">All</Toggle>
            <Toggle value="differences">Differences</Toggle>
            <Toggle value="changed">Changed</Toggle>
            <Toggle value="added">Added</Toggle>
            <Toggle value="removed">Removed</Toggle>
          </ToggleGroup>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <LegendList
            ref={listRef}
            data={entries as HarDiffEntry[]}
            keyExtractor={harEntryKey}
            extraData={`${activeHarIndex}:${expandedHarKeys.size}:${[...harEntryBodies.entries()].map(([k, v]) => `${k}=${v.status}`).join("|")}`}
            estimatedItemSize={HAR_ROW_HEIGHT}
            drawDistance={400}
            recycleItems={false}
            className="min-h-0 flex-1 overflow-x-hidden overscroll-y-contain"
            renderItem={({ item, index }) => {
              const key = harEntryKey(item);
              const expanded = expandedHarKeys.has(key);
              const bodyState = harEntryBodies.get(key);
              return (
                <div
                  data-har-diff-row={key}
                  data-har-class={item.classification}
                  className={cn(
                    "border-b",
                    HAR_CLASS_ROW_STYLE[item.classification],
                    index === activeHarIndex && "bg-accent/70",
                  )}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => {
                      model.selectHarEntry(index);
                      void model.toggleHarEntry(item);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        model.selectHarEntry(index);
                        void model.toggleHarEntry(item);
                      }
                    }}
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono font-semibold",
                        HAR_CLASS_TEXT_STYLE[item.classification],
                      )}
                    >
                      {harClassSymbol(item.classification)}
                    </span>
                    <Badge variant="outline" size="sm">
                      {item.method || "REQ"}
                    </Badge>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {formatStatusPair(item.statusBefore, item.statusAfter)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {item.url}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.changedSections.map((sec) => (
                        <Badge key={sec} variant="warning" size="sm">
                          {sec}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {expanded ? (
                    <div className="border-t bg-background/80 px-6 py-2">
                      {bodyState?.status === "loading" ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Spinner size="xs" />
                          Diffing response body…
                        </div>
                      ) : bodyState?.status === "error" ? (
                        <p className="text-xs text-destructive-foreground">{bodyState.error}</p>
                      ) : bodyState?.diff ? (
                        <InlineBodyDiff diff={bodyState.diff} />
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No body difference details available.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            }}
          />
        </div>
      </div>

      <aside
        aria-label="Changed requests"
        className="flex w-72 shrink-0 flex-col border-s bg-muted/20"
        data-compare-changes=""
      >
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs font-medium text-foreground">
          <span>Request changes</span>
          <Badge variant="outline" size="sm">
            {diffEntries.length}
          </Badge>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {diffEntries.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No request differences in this filter.
            </p>
          ) : (
            diffEntries.map((entry) => {
              const filteredIdx = entries.indexOf(entry);
              const active = filteredIdx === activeHarIndex;
              return (
                <button
                  key={harEntryKey(entry)}
                  type="button"
                  data-change-item=""
                  data-active={active ? "" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-xs transition-colors outline-none",
                    "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                  onClick={() => model.selectHarEntry(filteredIdx)}
                >
                  <span
                    className={cn(
                      "w-3 shrink-0 text-center font-semibold",
                      HAR_CLASS_TEXT_STYLE[entry.classification],
                    )}
                  >
                    {harClassSymbol(entry.classification)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{entry.method}</span>
                  <span className="min-w-0 truncate">{entry.url}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

function InlineBodyDiff({ diff }: { readonly diff: StructuralDiffResult }) {
  if (diff.rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Empty body.</p>;
  }
  return (
    <div
      data-har-body-diff=""
      className="max-h-64 overflow-y-auto rounded-sm border bg-card font-mono text-xs"
    >
      {diff.rows.map((row) => (
        <div
          key={row.id}
          data-diff-mark={row.mark}
          style={{ paddingInlineStart: indentOf(row.depth) + 8 }}
          className={cn("flex items-center gap-1.5 pe-2 py-0.5", MARK_ROW_CLASS[row.mark])}
        >
          <span className={cn("w-3 shrink-0 text-center", MARK_BADGE_CLASS[row.mark])}>
            {markSymbol(row.mark)}
          </span>
          <span className="shrink-0 font-medium text-foreground">
            {row.key !== null ? row.key : row.index !== null ? String(row.index) : "body"}
          </span>
          <span className="shrink-0 text-muted-foreground/60">:</span>
          <span className="min-w-0 truncate text-muted-foreground">{row.value}</span>
          {row.wasValue !== null ? (
            <span className="min-w-0 truncate text-destructive-foreground/80">
              (was {row.wasValue})
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function formatStatusPair(before: number | null, after: number | null): string {
  const b = before === null ? "—" : String(before);
  const a = after === null ? "—" : String(after);
  return b === a ? b : `${b} -> ${a}`;
}
