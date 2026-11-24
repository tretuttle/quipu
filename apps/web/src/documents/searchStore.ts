import type {
  ByteRange,
  JqResult,
  PathQueryResult,
  PathStep,
  SearchMode,
  SearchSummary,
} from "@quipu/contracts/engine";
import { JQ_DEFAULT_TIMEOUT_MS } from "@quipu/contracts/engine";
import { create } from "zustand";

import { type OpenDocument, useDocumentSession } from "./documentSession.ts";
import { type DocumentSelection, narrowedSelection, useSelectionStore } from "./selectionStore.ts";
import type { SearchedQuery } from "./treePaint.ts";

export type QueryPanel = "find" | "path" | "jq";

/** What jq runs on: the whole document, or the node selected in it. */
export type JqScope = "document" | "selection";

/**
 * The query panels that apply to a document, from what the engine says of its
 * structure: path queries and jq read the indexed structure, which a converted
 * format (YAML, CSV, …) has as much as JSON does, so only a document shown as
 * text offers Find alone.
 */
export const queryPanelsFor = (
  document: Pick<OpenDocument, "structure"> | null,
): ReadonlyArray<QueryPanel> =>
  document === null || document.structure === "none" ? ["find"] : ["find", "path", "jq"];

/** The hit the user last stepped to, and the nodes that hold it so the tree can open the way. */
export interface CurrentHit {
  readonly index: number;
  readonly range: ByteRange;
  readonly path: ReadonlyArray<PathStep>;
  /** Bumped by every step, so stepping onto the same hit scrolls to it again. */
  readonly revision: number;
}

type Phase = "idle" | "searching" | "done" | "error";

interface SearchState {
  /** The open query bar; null when closed. */
  readonly panel: QueryPanel | null;
  /** Bumped to move focus into the bar's input again (the chord pressed twice). */
  readonly focusRevision: number;
  readonly documentId: number | null;
  readonly text: string;
  readonly mode: SearchMode;
  readonly caseSensitive: boolean;
  readonly phase: Phase;
  readonly summary: SearchSummary | null;
  /** The query the last search was started for; the bar searches again only when it differs. */
  readonly searched: string | null;
  /** What the finished search looked for, so the views can mark it inside a row's text. */
  readonly query: SearchedQuery | null;
  /**
   * Where the first step of the search went: the first hit, or the first hit
   * after a node the user had selected in this document.
   */
  readonly startedFrom: "start" | "selection" | null;
  readonly error: string | null;
  readonly current: CurrentHit | null;
  readonly pathText: string;
  readonly pathPhase: Phase;
  readonly pathResult: PathQueryResult | null;
  readonly pathError: string | null;
  readonly jqProgram: string;
  /** The scope the user picked; null follows the selection (the node when one is selected). */
  readonly jqScope: JqScope | null;
  readonly jqPhase: Phase;
  readonly jqResult: JqResult | null;
  readonly jqError: string | null;
  readonly open: (panel: QueryPanel) => void;
  readonly close: () => void;
  readonly setText: (text: string) => void;
  readonly setMode: (mode: SearchMode) => void;
  readonly setCaseSensitive: (caseSensitive: boolean) => void;
  readonly run: () => Promise<void>;
  readonly step: (delta: 1 | -1) => Promise<void>;
  readonly setPathText: (text: string) => void;
  readonly runPath: () => Promise<void>;
  readonly setJqProgram: (program: string) => void;
  readonly setJqScope: (scope: JqScope) => void;
  readonly runJq: () => Promise<void>;
  /** The document's bytes changed: hits and results are for the old bytes, so they are found again. */
  readonly documentChanged: () => Promise<void>;
}

export const searchKey = (
  documentId: number | null,
  mode: SearchMode,
  caseSensitive: boolean,
  text: string,
) => `${documentId ?? ""}\u0000${mode}\u0000${caseSensitive ? 1 : 0}\u0000${text}`;

/** Results listed for a path query. */
const PATH_RESULT_LIMIT = 1000;

const openDocument = (): OpenDocument | null => {
  const { session } = useDocumentSession.getState();
  return session.phase === "open" ? session.document : null;
};

let searchGeneration = 0;
let pathGeneration = 0;
let jqGeneration = 0;
let stepRevision = 0;
/** The hit the last step moved to, known at once so two quick steps go two hits on. */
let cursor: number | null = null;

const message = (error: unknown, fallback: string) => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const text = (error as { message: unknown }).message;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return fallback;
};

const initial = {
  panel: null,
  focusRevision: 0,
  documentId: null,
  text: "",
  mode: "literal" as SearchMode,
  caseSensitive: false,
  phase: "idle" as Phase,
  summary: null,
  searched: null,
  query: null as SearchedQuery | null,
  startedFrom: null as "start" | "selection" | null,
  error: null,
  current: null,
  pathText: "$",
  pathPhase: "idle" as Phase,
  pathResult: null,
  pathError: null,
  jqProgram: ".",
  jqScope: null as JqScope | null,
  jqPhase: "idle" as Phase,
  jqResult: null,
  jqError: null,
};

/**
 * Find, path and jq share one bar. The store holds what the user typed and what
 * the engine answered; the engine holds the hits themselves, so the UI thread
 * never sees more than the ranges of what is on screen.
 */
export const useSearchStore = create<SearchState>((set, get) => ({
  ...initial,
  open: (panel) =>
    set((state) => ({
      // A panel the document does not offer (path or jq on text) opens Find instead.
      panel: queryPanelsFor(openDocument()).includes(panel) ? panel : "find",
      focusRevision: state.focusRevision + 1,
      documentId: openDocument()?.documentId ?? state.documentId,
    })),
  close: () => {
    const { summary, documentId } = get();
    searchGeneration++;
    const document = openDocument();
    if (summary !== null && document !== null && document.documentId === documentId) {
      void document.queries.closeSearch(summary.searchId).catch(() => null);
    }
    set({
      panel: null,
      phase: "idle",
      summary: null,
      searched: null,
      query: null,
      startedFrom: null,
      error: null,
      current: null,
    });
  },
  setText: (text) => {
    set({ text });
    if (text === "") {
      set({
        phase: "idle",
        summary: null,
        searched: null,
        query: null,
        startedFrom: null,
        error: null,
        current: null,
      });
      searchGeneration++;
    }
  },
  setMode: (mode) => set({ mode }),
  setCaseSensitive: (caseSensitive) => set({ caseSensitive }),
  run: async () => {
    const document = openDocument();
    const { text, mode, caseSensitive, summary: previous } = get();
    const mine = ++searchGeneration;
    cursor = null;
    if (document === null || text === "") return;
    if (previous !== null) void document.queries.closeSearch(previous.searchId).catch(() => null);
    set({
      phase: "searching",
      error: null,
      documentId: document.documentId,
      searched: searchKey(document.documentId, mode, caseSensitive, text),
    });
    try {
      const summary = await document.queries.search({ mode, text, caseSensitive });
      if (mine !== searchGeneration) {
        void document.queries.closeSearch(summary.searchId).catch(() => null);
        return;
      }
      // Stepping starts after a node the user picked in this document; otherwise at the first hit.
      const placed = anchor !== null && anchor.documentId === document.documentId ? anchor : null;
      set({
        phase: "done",
        summary,
        current: null,
        query: { text, mode, caseSensitive },
        startedFrom: placed === null ? "start" : "selection",
      });
      if (summary.count > 0 && summary.retained > 0) {
        const from = placed === null ? 0 : placed.offset;
        const index = await document.queries.seek(summary.searchId, from);
        if (mine !== searchGeneration) return;
        await goTo(document, summary, index, mine);
      }
    } catch (error) {
      if (mine !== searchGeneration) return;
      set({
        phase: "error",
        summary: null,
        current: null,
        error: message(error, "The search failed."),
      });
    }
  },
  step: async (delta) => {
    const document = openDocument();
    const { summary, current } = get();
    if (document === null || summary === null || summary.retained === 0) return;
    const next = (cursor ?? current?.index ?? (delta === 1 ? -1 : 0)) + delta;
    const wrapped = ((next % summary.retained) + summary.retained) % summary.retained;
    cursor = wrapped;
    await goTo(document, summary, wrapped, searchGeneration);
  },
  setPathText: (pathText) => set({ pathText }),
  runPath: async () => {
    const document = openDocument();
    const mine = ++pathGeneration;
    if (document === null) return;
    set({ pathPhase: "searching", pathError: null });
    try {
      const pathResult = await document.queries.path(get().pathText, PATH_RESULT_LIMIT);
      if (mine !== pathGeneration) return;
      set({ pathPhase: "done", pathResult });
    } catch (error) {
      if (mine !== pathGeneration) return;
      set({
        pathPhase: "error",
        pathResult: null,
        pathError: message(error, "The path query failed."),
      });
    }
  },
  setJqProgram: (jqProgram) => set({ jqProgram }),
  setJqScope: (jqScope) => set({ jqScope }),
  runJq: async () => {
    const document = openDocument();
    const mine = ++jqGeneration;
    if (document === null) return;
    const selected = narrowedSelection(useSelectionStore.getState().selection, document.documentId);
    const scope = jqScopeOf(get().jqScope, selected !== null);
    const target =
      scope === "selection" && selected !== null
        ? selected.ref
        : { documentId: document.documentId, tapeId: 0, token: 0 };
    set({ jqPhase: "searching", jqError: null });
    try {
      const jqResult = await document.queries.jq(target, get().jqProgram, JQ_DEFAULT_TIMEOUT_MS);
      if (mine !== jqGeneration) return;
      set({ jqPhase: "done", jqResult });
    } catch (error) {
      if (mine !== jqGeneration) return;
      set({ jqPhase: "error", jqResult: null, jqError: message(error, "jq failed.") });
    }
  },
  documentChanged: async () => {
    const { summary, pathResult, jqResult } = get();
    if (pathResult !== null) void get().runPath();
    if (jqResult !== null) void get().runJq();
    const document = openDocument();
    if (summary === null || document === null || document.documentId !== get().documentId) return;
    // Found again in place: the hits change, the selection the edit made stays.
    const { text, mode, caseSensitive } = get();
    const mine = ++searchGeneration;
    cursor = null;
    void document.queries.closeSearch(summary.searchId).catch(() => null);
    set({ phase: "searching", error: null, current: null });
    try {
      const next = await document.queries.search({ mode, text, caseSensitive });
      if (mine !== searchGeneration) {
        void document.queries.closeSearch(next.searchId).catch(() => null);
        return;
      }
      set({ phase: "done", summary: next, query: { text, mode, caseSensitive } });
    } catch (error) {
      if (mine !== searchGeneration) return;
      set({ phase: "error", summary: null, error: message(error, "The search failed.") });
    }
  },
}));

/** The scope jq runs in: the user's pick, else the selected node when there is one. */
export const jqScopeOf = (picked: JqScope | null, hasSelection: boolean): JqScope =>
  picked !== "document" && hasSelection ? "selection" : "document";

/**
 * The last node the user placed the selection on in the open document, in a
 * view or by an edit. A search step or a path result moves the selection too,
 * but not this: typing on in the find bar keeps counting from the user's node.
 */
let anchor: { readonly documentId: number; readonly offset: number } | null = null;
useSelectionStore.subscribe((state) => {
  const selection: DocumentSelection | null = state.selection;
  if (selection === null || selection.origin === "search") return;
  // The root stands for the whole document: counting starts at the first hit again.
  anchor =
    narrowedSelection(selection, selection.documentId) === null
      ? null
      : { documentId: selection.documentId, offset: selection.range.start };
});

/** Moves to hit `index` (wrapping), and shares it: the source scrolls and the tree opens the way. */
async function goTo(
  document: OpenDocument,
  summary: SearchSummary,
  index: number,
  generation: number,
): Promise<void> {
  const hit = await document.queries.hit(summary.searchId, index);
  if (hit === null || generation !== searchGeneration) return;
  const found = await document.source.nodeAt(hit.range.start);
  if (generation !== searchGeneration) return;
  cursor = hit.index;
  useSearchStore.setState({
    current: { index: hit.index, range: hit.range, path: found.path, revision: ++stepRevision },
  });
  const innermost = found.path[found.path.length - 1];
  if (innermost !== undefined) {
    useSelectionStore.getState().select({
      documentId: document.documentId,
      ref: innermost.node.ref,
      range: hit.range,
      origin: "search",
      path: found.path,
    });
  }
}

// A different document starts with a clean bar.
let lastDocument: number | null = null;
useDocumentSession.subscribe((state) => {
  const id = state.session.phase === "open" ? state.session.document.documentId : null;
  if (id === lastDocument) return;
  lastDocument = id;
  anchor = null;
  searchGeneration++;
  pathGeneration++;
  jqGeneration++;
  useSearchStore.setState({
    ...initial,
    panel: useSearchStore.getState().panel,
    text: useSearchStore.getState().text,
    mode: useSearchStore.getState().mode,
    caseSensitive: useSearchStore.getState().caseSensitive,
    jqScope: useSearchStore.getState().jqScope,
    documentId: id,
  });
  // A document without the panel that was open (path or jq on text) shows Find.
  const panel = useSearchStore.getState().panel;
  if (
    panel !== null &&
    !queryPanelsFor(state.session.phase === "open" ? state.session.document : null).includes(panel)
  ) {
    useSearchStore.setState({ panel: "find" });
  }
  // The text typed for the last document is searched again in the new one.
  if (id !== null && useSearchStore.getState().panel === "find")
    void useSearchStore.getState().run();
});

/**
 * The hits of the active search, as the Map and the other views ask for them:
 * ranges inside a byte window, and whether given ranges hold one.
 */
export interface HitSet {
  readonly documentId: number;
  readonly searchId: number;
  readonly count: number;
  /** What the search looked for; null when the store no longer knows. */
  readonly query: SearchedQuery | null;
  /** Hits that start before this offset are all known; past it, asking costs a scan. */
  readonly retainedUntil: number;
  readonly ranges: (from: number, to: number, limit: number) => Promise<ReadonlyArray<ByteRange>>;
  readonly isLit: (ranges: ReadonlyArray<ByteRange>) => Promise<ReadonlyArray<boolean>>;
}

export function hitSetOf(
  phase: Phase,
  documentId: number | null,
  summary: SearchSummary | null,
  document: Pick<OpenDocument, "documentId" | "queries"> | null,
  query: SearchedQuery | null = null,
): HitSet | null {
  if (document === null || phase !== "done" || summary === null || summary.count === 0) {
    return null;
  }
  if (documentId !== document.documentId) return null;
  const { queries } = document;
  return {
    documentId: document.documentId,
    searchId: summary.searchId,
    count: summary.count,
    query,
    retainedUntil: summary.retainedUntil,
    ranges: async (from, to, limit) =>
      (await queries.hits(summary.searchId, from, to, limit)).ranges,
    isLit: (ranges) => queries.lit(summary.searchId, ranges),
  };
}
