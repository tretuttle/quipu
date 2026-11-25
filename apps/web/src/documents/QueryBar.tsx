import { LegendList } from "@legendapp/list/react";
import { JQ_OUTPUT_LIMIT_BYTES, MAX_SLICE_BYTES, type PathMatch } from "@quipu/contracts/engine";
import {
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FilterIcon,
  LayersIcon,
  RegexIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Toggle } from "~/components/ui/toggle";
import { ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useResolvedKeybindings } from "~/keybindingsStore";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/formatBytes";
import type { OpenDocument } from "./documentSession.ts";
import { useMatchFilterStore } from "./hitFilter.ts";
import {
  type JqScope,
  jqScopeOf,
  type QueryPanel,
  queryPanelsFor,
  searchKey,
  useSearchStore,
} from "./searchStore.ts";
import { narrowedSelection, nodeBytes, useSelectionStore } from "./selectionStore.ts";
import { returnFocusToView } from "./viewFocus.ts";

const TYPE_DEBOUNCE_MS = 150;
const PATH_ROW_HEIGHT = 24;
const PATH_LIST_HEIGHT = 160;
const count = new Intl.NumberFormat("en-US");

const PANELS: ReadonlyArray<{ id: QueryPanel; label: string }> = [
  { id: "find", label: "Find" },
  { id: "path", label: "Path" },
  { id: "jq", label: "jq" },
];

/**
 * The query bar above the document's views: find (literal or regular
 * expression, with counts and next/previous), path queries and the jq bar. It
 * asks the engine for everything; nothing here parses the document.
 */
export function QueryBar({ document }: { readonly document: OpenDocument }) {
  const panel = useSearchStore((state) => state.panel);
  const close = useSearchStore((state) => state.close);
  const open = useSearchStore((state) => state.open);
  // Closing the bar gives the keyboard back to the view, at the row a search step reached.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (panel !== null) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      queueMicrotask(() => returnFocusToView());
    }
  }, [panel]);
  if (panel === null) return null;
  // Path queries and jq read the document's structure; a text document offers Find alone.
  const offered = queryPanelsFor(document);
  const shown = offered.includes(panel) ? panel : "find";
  return (
    <div
      role="search"
      aria-label="Query"
      className="flex shrink-0 flex-col gap-2 border-b bg-card px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      {/* One kind of query needs no tabs: Find alone keeps its close button on its own row. */}
      {offered.length > 1 ? (
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Query kind" className="flex items-center gap-1">
            {PANELS.filter((entry) => offered.includes(entry.id)).map((entry) => (
              <Button
                key={entry.id}
                role="tab"
                aria-selected={shown === entry.id}
                size="xs"
                variant={shown === entry.id ? "secondary" : "ghost"}
                onClick={() => open(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          <Button
            className="ms-auto"
            size="icon-xs"
            variant="ghost"
            aria-label="Close query bar"
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {shown === "find" ? (
        <FindPanel
          document={document}
          trailing={offered.length > 1 ? null : <CloseButton onClose={close} />}
        />
      ) : null}
      {shown === "path" ? <PathPanel document={document} /> : null}
      {shown === "jq" ? <JqPanel document={document} /> : null}
    </div>
  );
}

/** The last request to focus the bar that an input answered. */
let answeredFocus = -1;

function CloseButton({ onClose }: { readonly onClose: () => void }) {
  return (
    <Button size="icon-xs" variant="ghost" aria-label="Close query bar" onClick={onClose}>
      <XIcon />
    </Button>
  );
}

function useFocusOnOpen(panel: QueryPanel) {
  const ref = useRef<HTMLInputElement | null>(null);
  // Focus when the user opens the panel, and again each time its chord is pressed. A bar
  // drawn again for a document that opened (a save reopens it) leaves the keyboard alone.
  useEffect(() => {
    const focus = () => {
      const input = ref.current;
      if (input === null) return;
      answeredFocus = useSearchStore.getState().focusRevision;
      input.focus();
      input.select();
    };
    if (useSearchStore.getState().focusRevision !== answeredFocus) focus();
    return useSearchStore.subscribe((state, previous) => {
      if (state.focusRevision !== previous.focusRevision && state.panel === panel) focus();
    });
  }, [panel]);
  return ref;
}

function ShortcutTip({
  label,
  command,
}: {
  label: string;
  command: Parameters<typeof shortcutLabelForCommand>[1];
}) {
  const keybindings = useResolvedKeybindings();
  const shortcut = shortcutLabelForCommand(keybindings, command);
  return <>{shortcut === null ? label : `${label} (${shortcut})`}</>;
}

function FindPanel({
  document,
  trailing,
}: {
  readonly document: OpenDocument;
  /** What ends the input row, when the bar has no tab row of its own. */
  readonly trailing: React.ReactNode;
}) {
  const text = useSearchStore((state) => state.text);
  const mode = useSearchStore((state) => state.mode);
  const caseSensitive = useSearchStore((state) => state.caseSensitive);
  const deepDecode = useSearchStore((state) => state.deepDecode);
  const phase = useSearchStore((state) => state.phase);
  const summary = useSearchStore((state) => state.summary);
  const error = useSearchStore((state) => state.error);
  const current = useSearchStore((state) => state.current);
  const startedFrom = useSearchStore((state) => state.startedFrom);
  const setText = useSearchStore((state) => state.setText);
  const setMode = useSearchStore((state) => state.setMode);
  const setCaseSensitive = useSearchStore((state) => state.setCaseSensitive);
  const setDeepDecode = useSearchStore((state) => state.setDeepDecode);
  const run = useSearchStore((state) => state.run);
  const step = useSearchStore((state) => state.step);
  const refreshMatchFilter = useSearchStore((state) => state.refreshMatchFilter);
  const matchFilterEnabled = useMatchFilterStore((state) => state.enabled);
  const inputRef = useFocusOnOpen("find");

  // Search as the user types, once they pause; the options search again at once.
  const documentId = document.documentId;
  useEffect(() => {
    if (text === "") return;
    const timer = setTimeout(() => {
      // Enter may have searched this query already while the pause ran.
      const searched = useSearchStore.getState().searched;
      if (searched !== searchKey(documentId, mode, caseSensitive, text, deepDecode)) void run();
    }, TYPE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, mode, caseSensitive, deepDecode, documentId, run]);

  // Counting from the user's selection is said beside the count, not only in its tooltip.
  const afterSelection = phase === "done" && startedFrom === "selection" && current !== null;
  let status = "";
  if (phase === "searching") status = "Searching…";
  else if (phase === "done" && summary !== null) {
    if (summary.count === 0) status = "No matches";
    else if (current !== null) {
      status = `${count.format(current.index + 1)} of ${count.format(summary.count)}`;
    } else status = `${count.format(summary.count)} matches`;
  }
  const notes: string[] = [];
  if (summary !== null && summary.skipped.length > 0) {
    notes.push(
      `${summary.skipped.length} ${summary.skipped.length === 1 ? "part" : "parts"} of the file skipped: the pattern took too long there`,
    );
  }
  if (summary?.status === "partial") notes.push("stopped early: the pattern is too slow");
  if (summary !== null && summary.limited > 0) {
    notes.push("some long matches may be cut short");
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          size="compact"
          aria-label="Find in document"
          placeholder={mode === "regex" ? "Regular expression" : "Find"}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            // A query that has not been searched yet is searched now, not after the pause.
            if (
              useSearchStore.getState().searched !==
              searchKey(documentId, mode, caseSensitive, text, deepDecode)
            ) {
              void run();
            } else void step(event.shiftKey ? -1 : 1);
          }}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="xs"
                aria-label="Match case"
                pressed={caseSensitive}
                onPressedChange={setCaseSensitive}
              />
            }
          >
            <CaseSensitiveIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Match case</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="xs"
                aria-label="Use regular expression"
                pressed={mode === "regex"}
                onPressedChange={(pressed) => setMode(pressed ? "regex" : "literal")}
              />
            }
          >
            <RegexIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Regular expression</TooltipPopup>
        </Tooltip>
        {document.tree !== null ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    size="xs"
                    aria-label="Deep decode"
                    data-deep-decode=""
                    pressed={deepDecode}
                    onPressedChange={setDeepDecode}
                  />
                }
              >
                <LayersIcon />
                <span className="hidden sm:inline">Deep</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Search inside decoded Base64, gzip, JWT, form, and JSON strings
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    size="xs"
                    aria-label="Show matches only"
                    data-match-filter=""
                    pressed={matchFilterEnabled}
                    onPressedChange={(pressed) => {
                      useMatchFilterStore.getState().setEnabled(pressed);
                      if (pressed) void refreshMatchFilter();
                    }}
                  />
                }
              >
                <FilterIcon />
                <span className="hidden sm:inline">Matches only</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Filter Tree, Map, and Table views to matches only
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous match"
                disabled={summary === null || summary.retained === 0}
                onClick={() => void step(-1)}
              />
            }
          >
            <ChevronUpIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <ShortcutTip label="Previous match" command="search.previous" />
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next match"
                disabled={summary === null || summary.retained === 0}
                onClick={() => void step(1)}
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <ShortcutTip label="Next match" command="search.next" />
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="status"
                aria-live="polite"
                data-search-count=""
                className="flex min-w-24 shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              />
            }
          >
            {phase === "searching" ? <Spinner size="xs" /> : null}
            {status}
          </TooltipTrigger>
          {afterSelection ? (
            <TooltipPopup side="bottom">
              Started at the first match after the selected value
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {/* Beside the count, not in it: the count reads as a count. */}
        {afterSelection ? (
          <span data-search-from="" className="shrink-0 text-muted-foreground text-xs">
            after the selected value
          </span>
        ) : null}
        {trailing}
      </div>
      {phase === "error" && error !== null ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {notes.length > 0 ? (
        <p className="text-xs text-warning-foreground">{notes.join("; ")}</p>
      ) : null}
    </div>
  );
}

function PathPanel({ document }: { readonly document: OpenDocument }) {
  const pathText = useSearchStore((state) => state.pathText);
  const phase = useSearchStore((state) => state.pathPhase);
  const result = useSearchStore((state) => state.pathResult);
  const error = useSearchStore((state) => state.pathError);
  const setPathText = useSearchStore((state) => state.setPathText);
  const runPath = useSearchStore((state) => state.runPath);
  const inputRef = useFocusOnOpen("path");

  const choose = (match: PathMatch) => {
    void document.source.nodeAt(match.node.span.start).then((found) => {
      const innermost = found.path[found.path.length - 1];
      useSelectionStore.getState().select({
        documentId: document.documentId,
        ref: match.node.ref,
        range: nodeBytes(match.node),
        origin: "search",
        path: innermost === undefined ? null : found.path,
      });
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          size="compact"
          font="mono"
          aria-label="Path query"
          placeholder="$.log.entries[*].request.url"
          autoComplete="off"
          spellCheck={false}
          value={pathText}
          onChange={(event) => setPathText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void runPath();
          }}
        />
        <Button size="xs" variant="outline" onClick={() => void runPath()}>
          Run
        </Button>
        <span
          role="status"
          aria-live="polite"
          data-path-count=""
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          {phase === "searching" ? <Spinner size="xs" /> : null}
          {phase === "done" && result !== null
            ? result.total === 0
              ? "No results"
              : `${count.format(result.total)}${result.complete ? "" : "+"} ${result.total === 1 ? "result" : "results"}`
            : ""}
        </span>
      </div>
      {phase === "error" && error !== null ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {phase === "done" && result !== null && result.total === 0 ? (
        <p data-path-note="" className="text-xs text-muted-foreground">
          A path matches the file's own keys and indexes. It does not look inside JSON that a string
          holds; Find searches that text.
        </p>
      ) : null}
      {result !== null && result.results.length > 0 ? (
        <div
          className="min-h-0"
          role="listbox"
          aria-label="Path results"
          // As tall as its results, up to six and a half rows; then it scrolls.
          style={{ height: Math.min(result.results.length * PATH_ROW_HEIGHT, PATH_LIST_HEIGHT) }}
        >
          <LegendList<PathMatch>
            data={[...result.results]}
            keyExtractor={(match) => `${match.node.ref.tapeId}.${match.node.ref.token}`}
            estimatedItemSize={PATH_ROW_HEIGHT}
            className="h-full overflow-x-hidden"
            renderItem={({ item }) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-path-result=""
                className={cn(
                  "flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-start text-xs outline-none",
                  "hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                )}
                onClick={() => choose(item)}
              >
                <span
                  data-path-result-path=""
                  className="min-w-0 max-w-2/3 shrink truncate font-mono text-foreground"
                >
                  {item.path}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {item.node.kind === "object"
                    ? `{${count.format(item.node.childCount)}}`
                    : item.node.kind === "array"
                      ? `[${count.format(item.node.childCount)}]`
                      : item.preview}
                </span>
              </button>
            )}
          />
        </div>
      ) : null}
    </div>
  );
}

function JqPanel({ document }: { readonly document: OpenDocument }) {
  const program = useSearchStore((state) => state.jqProgram);
  const phase = useSearchStore((state) => state.jqPhase);
  const result = useSearchStore((state) => state.jqResult);
  const elementResult = useSearchStore((state) => state.jqElementResult);
  const suggestedPath = useSearchStore((state) => state.jqSuggestedPath);
  const error = useSearchStore((state) => state.jqError);
  const picked = useSearchStore((state) => state.jqScope);
  const setProgram = useSearchStore((state) => state.setJqProgram);
  const setScope = useSearchStore((state) => state.setJqScope);
  const runJq = useSearchStore((state) => state.runJq);
  const runJqElement = useSearchStore((state) => state.runJqElement);
  const loadJqSuggestion = useSearchStore((state) => state.loadJqSuggestion);
  const selection = useSelectionStore((state) => state.selection);
  const inputRef = useFocusOnOpen("jq");

  // The root is the whole document: only a narrower selection is a scope of its own.
  const selected = narrowedSelection(selection, document.documentId);
  const scope = jqScopeOf(picked, selected !== null);
  const bytes =
    scope === "selection" && selected !== null
      ? selected.range.end - selected.range.start
      : document.size;
  const tooLarge = bytes > MAX_SLICE_BYTES;

  const targetRef =
    scope === "selection" && selected !== null
      ? selected.ref
      : { documentId: document.documentId, tapeId: 0, token: 0 };
  useEffect(() => {
    if (tooLarge) void loadJqSuggestion(targetRef.documentId, targetRef.tapeId, targetRef.token);
  }, [tooLarge, targetRef.documentId, targetRef.tapeId, targetRef.token, loadJqSuggestion]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          size="compact"
          font="mono"
          aria-label="jq filter"
          placeholder=".entries[] | select(.status >= 400)"
          autoComplete="off"
          spellCheck={false}
          value={program}
          onChange={(event) => setProgram(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!tooLarge) void runJq();
            else if (suggestedPath !== null) void runJqElement(suggestedPath);
          }}
        />
        <ToggleGroup
          aria-label="Run jq on"
          value={[scope]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "document" || value === "selection") setScope(value as JqScope);
          }}
        >
          <Toggle value="document">Document</Toggle>
          <Toggle value="selection" disabled={selected === null}>
            Selected value
          </Toggle>
        </ToggleGroup>
        <Button
          size="xs"
          variant="outline"
          disabled={phase === "searching" || tooLarge}
          onClick={() => void runJq()}
        >
          {phase === "searching" ? <Spinner size="xs" /> : null}
          Run
        </Button>
      </div>
      {tooLarge ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" data-jq-refusal="" className="text-xs text-warning-foreground">
            {scope === "document"
              ? `The document is ${formatBytes(bytes)}; jq runs on up to ${formatBytes(MAX_SLICE_BYTES)}. Select a value in it and run jq on the selected value.`
              : `The selected value is ${formatBytes(bytes)}; jq runs on up to ${formatBytes(MAX_SLICE_BYTES)}. Select a smaller value.`}
          </p>
          {suggestedPath !== null ? (
            <Button
              size="xs"
              variant="outline"
              data-jq-element-run=""
              disabled={phase === "searching"}
              onClick={() => void runJqElement(suggestedPath)}
            >
              {phase === "searching" ? <Spinner size="xs" /> : null}
              Run per element of {suggestedPath}
            </Button>
          ) : null}
        </div>
      ) : (
        <p data-jq-scope="" className="text-xs text-muted-foreground">
          {scope === "document"
            ? `Runs on the whole document (${formatBytes(bytes)}).`
            : `Runs on the selected value (${formatBytes(bytes)}).`}
        </p>
      )}
      {phase === "error" && error !== null ? (
        <p role="alert" data-jq-refusal="" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {phase === "done" && elementResult !== null ? (
        <p data-jq-element-status="" className="text-xs text-muted-foreground">
          Processed {count.format(elementResult.processed)} of {count.format(elementResult.total)}{" "}
          elements in {elementResult.path}
          {elementResult.errors.length > 0
            ? ` · ${count.format(elementResult.errors.length)} failed`
            : ""}
        </p>
      ) : null}
      {phase === "done" && result !== null ? (
        result.status === "ok" ? (
          <>
            <pre
              aria-label="jq output"
              data-jq-output=""
              className="max-h-56 overflow-auto rounded-md border bg-code p-2 font-mono text-xs text-code-foreground"
            >
              {result.output === "" ? "(no output)" : result.output}
            </pre>
            {result.truncated ? (
              <p className="text-xs text-warning-foreground">
                The output was cut at {formatBytes(JQ_OUTPUT_LIMIT_BYTES)}. Narrow the filter to see
                the rest.
              </p>
            ) : null}
          </>
        ) : (
          <pre
            role="alert"
            data-jq-error=""
            className="max-h-40 overflow-auto whitespace-pre rounded-md border border-destructive/32 bg-destructive/4 p-2 font-mono text-destructive-foreground text-xs"
          >
            {result.message}
          </pre>
        )
      ) : null}
    </div>
  );
}
