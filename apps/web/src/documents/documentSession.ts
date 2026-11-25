import type { DesktopOpenedDocument } from "@quipu/contracts";
import type {
  DeepSearchAnnotationsResult,
  DeepSearchQuery,
  DeepSearchSummary,
  TraceResult,
  TraceValueRequest,
} from "@quipu/contracts/deepSearch";
import type { JqElementResult, JqSuggestedPath } from "@quipu/contracts/elementMap";
import type {
  ConvertFormat,
  ConvertSettings,
  DocumentFormat,
  DocumentProblem,
  DocumentStructure,
  ExportTarget,
  DocumentSource,
  EditResult,
  EditState,
  IndexProgress,
  JqResult,
  NodePath,
  NodeRef,
  PathQueryResult,
  SearchHit,
  SearchQuery,
  SearchRanges,
  SaveSink,
  SearchSummary,
  TextValue,
  Transform,
} from "@quipu/contracts/engine";
import type {
  CodegenOptions,
  CodegenResult,
  HarValidationFilter,
  InferOptions,
  Shape,
} from "@quipu/contracts/schema";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { stackedToast } from "../components/ui/toastHelpers";
import { createWindowEngine, type EngineTransport } from "../engine/client.ts";
import { runShellCommand } from "../shellCommands.ts";
import type { FileHandle } from "./fileSystemAccess.ts";
import { journalKeyOf } from "./fingerprint.ts";
import { askAboutUnsavedChanges } from "./unsavedChanges.ts";
import { markOpenDocument, useRecentDocuments } from "./recents.ts";
import type { InspectSource } from "./inspection.ts";
import { preloadSourceView } from "./LazySourceView.tsx";
import { useSelectionStore } from "./selectionStore.ts";
import type { SourceClient } from "./sourceWindow.ts";
import type { CompareClient } from "./compareModel.ts";
import type { TableSource } from "./tableModel.ts";
import { TreeModel, type TreeSource } from "./treeModel.ts";

/** What search, the path bar and the jq bar ask of the engine; the app passes the typed client, tests a fake. */
export interface QueryClient {
  readonly search: (query: SearchQuery) => Promise<SearchSummary>;
  readonly hits: (
    searchId: number,
    from: number,
    to: number,
    limit: number,
  ) => Promise<SearchRanges>;
  readonly lit: (
    searchId: number,
    ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  ) => Promise<ReadonlyArray<boolean>>;
  readonly hit: (searchId: number, index: number) => Promise<SearchHit>;
  readonly seek: (searchId: number, offset: number) => Promise<number>;
  readonly closeSearch: (searchId: number) => Promise<null>;
  readonly path: (path: string, limit: number) => Promise<PathQueryResult>;
  readonly jq: (ref: NodeRef, program: string, timeoutMs: number) => Promise<JqResult>;
  readonly deepSearch?: (query: DeepSearchQuery) => Promise<DeepSearchSummary>;
  readonly deepSearchAnnotations?: (
    searchId: number,
    from: number,
    to: number,
  ) => Promise<DeepSearchAnnotationsResult>;
  readonly traceValue?: (request: TraceValueRequest) => Promise<TraceResult>;
  readonly jqSuggestPath?: (ref: NodeRef) => Promise<JqSuggestedPath | null>;
  readonly jqElement?: (
    ref: NodeRef,
    path: string | undefined,
    program: string,
    timeoutMs: number,
  ) => Promise<JqElementResult>;
}

/** What changes a document's bytes; every call answers with the node it re-indexed. */
export interface EditClient {
  readonly setValue: (ref: NodeRef, json: string) => Promise<EditResult>;
  readonly setKey: (ref: NodeRef, key: string) => Promise<EditResult>;
  readonly transform: (ref: NodeRef, transform: Transform) => Promise<EditResult>;
  readonly undo: () => Promise<EditResult>;
  readonly redo: () => Promise<EditResult>;
  /** A value's text as an editor starts from it: a string decoded, anything else as written. */
  readonly text: (ref: NodeRef, limit: number) => Promise<TextValue>;
  readonly keyText: (ref: NodeRef) => Promise<string>;
  readonly nodeAt: (offset: number) => Promise<NodePath>;
}

/** The engine's history of a document, as the header and the sidebar show it. */
export interface DocumentEditState {
  readonly undoDepth: number;
  readonly redoDepth: number;
  /** Edits since the file was opened or last saved. */
  readonly dirty: boolean;
  /** Edits from a journal the last session left are still being replayed. */
  readonly replaying: boolean;
}

export interface OpenDocument {
  readonly documentId: number;
  readonly name: string;
  /** The document's size now, edits included. */
  readonly size: number;
  readonly format: DocumentFormat;
  /** How the tree relates to the file's text; `converted` means node ranges are not positions in it. */
  readonly structure: DocumentStructure;
  readonly editable: boolean;
  /** Why the document opened as text or read-only, in the engine's words. */
  readonly note: string | null;
  /** The file the document was opened from (null over a desktop port), and its handle when the picker or a drop gave one. */
  readonly file: File | null;
  readonly handle: FileHandle | null;
  /** The desktop main process's id for a document it opened; Save writes back to its path. */
  readonly desktopId: string | null;
  /**
   * A key for what belongs to this file across sessions (its drawing): the
   * name, size and modification time, which is what recents match a file on.
   */
  readonly fileKey: string;
  /** The outline of a JSON or HAR document; null for text. */
  readonly tree: TreeModel | null;
  /** What the source view asks of the engine: rows, the node under a byte, a small file whole. */
  readonly source: SourceClient;
  readonly queries: QueryClient;
  /** The structural index is still running. */
  readonly indexing: boolean;
  /** Where the document stops being valid JSON, once the index knows; null while it does not, or when it is valid. */
  readonly problem: DocumentProblem | null;
  /** Changes whenever the document's bytes do, so a view reads them again. */
  readonly revision: number;
  readonly edit: DocumentEditState;
  readonly edits: EditClient;
  /** Opens the same file again with its journal started over (Discard on restored edits). */
  readonly reopenWithoutJournal: () => Promise<void>;
  /** Opens the same file again for Back or Forward, leaving the recent list in its order. */
  readonly reopen: () => Promise<void>;
  /** Opens the same file again read as `format` (a `.json` file with comments, as JSONC). */
  readonly reopenAs: (format: DocumentFormat) => Promise<void>;
}

export interface OpenFileOptions {
  /** Start the file's journal over instead of restoring the edits it holds. */
  readonly discardJournal?: boolean;
  /** Replace the open document without asking about its unsaved edits. */
  readonly force?: boolean;
  /** Back or Forward is showing it again: the recent list keeps its order. */
  readonly fromHistory?: boolean;
  /** Read the file as this format whatever its name says (a `.json` file as JSONC). */
  readonly asFormat?: DocumentFormat;
  /** The recent document it was opened from: a failure offers to remove it. */
  readonly recentId?: string;
}

export type DocumentSession =
  | { readonly phase: "empty" }
  | { readonly phase: "opening"; readonly name: string }
  | {
      readonly phase: "error";
      readonly name: string;
      readonly message: string;
      /** The recent document that failed to open, which the page offers to remove. */
      readonly recentId: string | null;
    }
  | { readonly phase: "open"; readonly document: OpenDocument };

interface SessionState {
  readonly session: DocumentSession;
  readonly openFile: (
    file: File,
    handle?: FileHandle | null,
    options?: OpenFileOptions,
  ) => Promise<void>;
  /**
   * A file the desktop app opened (dialog, command line, a second launch, a
   * recent): `port` reads it from the main process's handle. The main process
   * has already put it in the recents.
   */
  readonly openDesktopDocument: (
    document: DesktopOpenedDocument,
    port: MessagePort,
  ) => Promise<void>;
  readonly openPastedText: (text: string) => Promise<void>;
  /** Closes the open document, after asking what to do with unsaved edits; false when the user kept it. */
  readonly closeDocument: () => Promise<boolean>;
}

/** What saving and exporting ask of the engine about one document. */
export interface DocumentFileClient {
  /** `inPlace`: the sink is the document's own file; `rekeyJournal` must follow a save that succeeded. */
  readonly save: (sink: SaveSink, inPlace: boolean) => Promise<number>;
  /** Names the file a save in place wrote by its journal key (null for none); its edits are journaled there. */
  readonly rekeyJournal: (journalKey: string | null) => Promise<void>;
  readonly convert: (
    to: ConvertFormat,
    settings: ConvertSettings,
    sink: SaveSink,
  ) => Promise<number>;
  readonly exportTargets: () => Promise<ReadonlyArray<ExportTarget>>;
  /** Moves the document onto a private copy of its file, before the file is written over. */
  readonly detach: () => Promise<void>;
}

/** What one open hands the engine, and what it does once the document shows. */
interface Opening {
  readonly source: DocumentSource;
  readonly name: string;
  readonly fileKey: string;
  /** Where the bytes came from, which is where Save writes them back. */
  readonly origin: Pick<OpenDocument, "file" | "handle" | "desktopId">;
  /** The file's identity across sessions, under which its edits are journaled; null for none. */
  readonly journalKey: () => Promise<string | null>;
  /** Opens the same file again, its journal started over. */
  readonly reopenWithoutJournal: () => Promise<void>;
  readonly reopen: () => Promise<void>;
  readonly reopenAs: (format: DocumentFormat) => Promise<void>;
  readonly opened: () => void;
  readonly options: OpenFileOptions;
}

let engine: EngineTransport | null = null;
const getEngine = () => {
  if (engine === null) {
    engine = createWindowEngine();
    engine.onProgress(onProgress);
    engine.onEditState(onEditState);
  }
  return engine;
};

/** What the map asks the engine beyond the tree: the HAR grouping. */
export const getMapSource = () => {
  const transport = getEngine();
  return {
    harEntries: (documentId: number, from: number, count: number) =>
      transport.request("harEntries", { documentId, from, count }),
  };
};

const sourceFor = (transport: EngineTransport): TreeSource & InspectSource => ({
  node: (ref) => transport.request("node", { ref }),
  rows: (ref, from, count, previewBytes) =>
    transport.request("rows", { ref, from, count, previewBytes }),
  keyText: (ref) => transport.request("keyText", { ref }),
  text: (ref, limit) => transport.request("text", { ref, limit }),
  detect: (ref) => transport.request("detect", { ref }),
  decode: (ref, kind) => transport.request("decode", { ref, kind }),
  preview: (ref) => transport.request("preview", { ref }),
  frames: (ref, from, count) => transport.request("frames", { ref, from, count }),
});

const fileKeyOf = (file: {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
}) => `${file.name}:${file.size}:${file.lastModified}`;

const sourceClientFor = (transport: EngineTransport, documentId: number): SourceClient => ({
  rows: (offset, before, rows, wrapBytes) =>
    transport.request("sourceRows", { documentId, offset, before, rows, wrapBytes }),
  nodeAt: (offset) => transport.request("nodeAt", { documentId, offset }),
  text: (bytes) => transport.request("headText", { documentId, bytes }),
});

const editClientFor = (transport: EngineTransport, documentId: number): EditClient => ({
  setValue: (ref, json) => transport.request("setValue", { ref, json }),
  setKey: (ref, key) => transport.request("setKey", { ref, key }),
  transform: (ref, transform) => transport.request("transform", { ref, transform }),
  undo: () => transport.request("undo", { documentId }),
  redo: () => transport.request("redo", { documentId }),
  text: (ref, limit) => transport.request("text", { ref, limit }),
  keyText: (ref) => transport.request("keyText", { ref }),
  nodeAt: (offset) => transport.request("nodeAt", { documentId, offset }),
});

const queryClientFor = (transport: EngineTransport, documentId: number): QueryClient => ({
  search: (query) => transport.request("search", { documentId, query }),
  hits: (searchId, from, to, limit) =>
    transport.request("searchHits", { documentId, searchId, from, to, limit }),
  lit: (searchId, ranges) => transport.request("searchLit", { documentId, searchId, ranges }),
  hit: (searchId, index) => transport.request("searchHit", { documentId, searchId, index }),
  seek: (searchId, offset) => transport.request("searchSeek", { documentId, searchId, offset }),
  closeSearch: (searchId) => transport.request("searchClose", { documentId, searchId }),
  path: (path, limit) => transport.request("pathQuery", { documentId, path, limit }),
  jq: (ref, program, timeoutMs) => transport.request("jq", { ref, program, timeoutMs }),
  deepSearch: (query) => transport.request("deepSearch", { documentId, query }),
  deepSearchAnnotations: (searchId, from, to) =>
    transport.request("deepSearchAnnotations", { documentId, searchId, from, to }),
  traceValue: (request) => transport.request("traceValue", { documentId, request }),
  jqSuggestPath: (ref) => transport.request("jqSuggestPath", { ref }),
  jqElement: (ref, path, program, timeoutMs) =>
    transport.request("jqElement", {
      ref,
      ...(path === undefined ? {} : { path }),
      program,
      timeoutMs,
    }),
});

export const getDocumentFileClient = (documentId: number): DocumentFileClient => {
  const transport = getEngine();
  return {
    save: async (sink, inPlace) =>
      (
        await transport.request("save", {
          documentId,
          sink,
          indent: null,
          ...(inPlace ? { inPlace } : {}),
        })
      ).bytes,
    rekeyJournal: async (journalKey) => {
      await transport.request("rekeyJournal", { documentId, journalKey });
    },
    convert: async (to, settings, sink) =>
      (await transport.request("convert", { documentId, to, settings, sink })).bytes,
    exportTargets: () => transport.request("exportTargets", { documentId }),
    detach: async () => {
      await transport.request("detach", { documentId });
    },
  };
};

/** What the Inspector reads through: the same engine as the tree. */
export const getInspectSource = (): InspectSource => sourceFor(getEngine());

export const readNodeSummary = (ref: NodeRef) => getEngine().request("node", { ref });

export const readNodeChildren = (ref: NodeRef, from: number, count: number) =>
  getEngine().request("children", { ref, from, count });

/** Virtualized table queries over arrays and HAR captures via worker-side TableIndexHost. */
export const getTableSource = (): TableSource => {
  const transport = getEngine();
  return {
    targets: (documentId) => transport.request("tableTargets", { documentId }),
    query: (spec) =>
      transport.request("tableQuery", {
        documentId: spec.documentId,
        targetPath: spec.targetPath,
        ...(spec.revision === undefined ? {} : { revision: spec.revision }),
        sort: spec.sort,
        filters: [...spec.filters],
        timeWindow: spec.timeWindow,
        filteredRowIndices: spec.filteredRowIndices === null ? null : [...spec.filteredRowIndices],
      }),
    rows: (documentId, queryId, from, count) =>
      transport.request("tableRows", { documentId, queryId, from, count }),
    closeQuery: (documentId, queryId) =>
      transport.request("tableQueryClose", { documentId, queryId }),
  };
};

/** Structural JSON and HAR capture diff client backed by the engine worker. */
export const createCompareClient = (): CompareClient => {
  const transport = getEngine();
  return {
    openTarget: async (source, name) => {
      const info = await transport.request("open", { source, name });
      return {
        documentId: info.documentId,
        name: info.name,
        size: info.size,
        format: info.format,
      };
    },
    closeTarget: async (documentId) => {
      await transport.request("close", { documentId });
    },
    compareStructural: (aDocumentId, bDocumentId) =>
      transport.request("compareStructural", { aDocumentId, bDocumentId }),
    compareHar: (aDocumentId, bDocumentId, reference) =>
      transport.request("compareHar", { aDocumentId, bDocumentId, reference }),
    compareHarEntryBody: (aDocumentId, aEntryIndex, bDocumentId, bEntryIndex) =>
      transport.request("compareHarEntryBody", {
        aDocumentId,
        aEntryIndex,
        bDocumentId,
        bEntryIndex,
      }),
  };
};

export const traceValue = (documentId: number, request: TraceValueRequest) =>
  getEngine().request("traceValue", { documentId, request });

export const inferSchema = (ref: NodeRef, options?: InferOptions) =>
  getEngine().request("inferSchema", {
    ref,
    ...(options === undefined ? {} : { options }),
  });

export const validateSchema = (
  documentId: number,
  schemaText: string,
  filter?: HarValidationFilter | null,
) =>
  getEngine().request("validateSchema", {
    documentId,
    schemaText,
    ...(filter === undefined ? {} : { filter }),
  });

export const codegen = (
  ref: NodeRef,
  options: CodegenOptions,
  shape?: Shape,
): Promise<CodegenResult> =>
  getEngine().request("codegen", {
    ref,
    options,
    ...(shape === undefined ? {} : { shape }),
  });

/** Documents whose index finished before the view existed to hear about it. */
const finished = new Set<number>();
/** Bumped by every open, so a slow open that lost the race cannot replace a newer one. */
let generation = 0;

/** Callers waiting for a document to have nothing left to save. */
const savedWaiters = new Map<number, Set<(saved: boolean) => void>>();

/** Views that read the document again once a recovered journal has been replayed. */
const replayListeners = new Set<(document: OpenDocument) => void>();
export function onJournalReplayed(listener: (document: OpenDocument) => void): () => void {
  replayListeners.add(listener);
  return () => {
    replayListeners.delete(listener);
  };
}

/** Documents whose save is still writing; their waiters hear the save's end, not the engine. */
const savesInFlight = new Set<number>();

const resolveSaved = (documentId: number) => {
  const waiting = savedWaiters.get(documentId);
  savedWaiters.delete(documentId);
  for (const resolve of waiting ?? []) resolve(true);
};

/**
 * Brackets a save. The engine says a document is clean once its worker has
 * handed the last bytes over, which for a stream (a download, the desktop main
 * process) is before they are in place; whoever waits to close or replace the
 * document waits for `end` instead.
 */
export function trackSave(documentId: number) {
  savesInFlight.add(documentId);
  return {
    end: (saved: boolean) => {
      savesInFlight.delete(documentId);
      if (saved) resolveSaved(documentId);
    },
  };
}

function onEditState(state: EditState) {
  if (!state.dirty && !savesInFlight.has(state.documentId)) resolveSaved(state.documentId);
  const { session } = useDocumentSession.getState();
  if (session.phase !== "open" || session.document.documentId !== state.documentId) return;
  const previous = session.document;
  if (previous.revision > state.revision) return;
  const document: OpenDocument = {
    ...previous,
    size: state.size,
    revision: state.revision,
    edit: {
      undoDepth: state.undoDepth,
      redoDepth: state.redoDepth,
      dirty: state.dirty,
      replaying: state.replaying,
    },
  };
  useDocumentSession.setState({ session: { phase: "open", document } });
  if (previous.edit.replaying && !state.replaying) {
    // The replay is over: say what came of it, once.
    const recovered = pendingRestores.get(state.documentId) ?? 0;
    pendingRestores.delete(state.documentId);
    if (state.restoreFailed) reportRestoreFailed(document.name);
    else if (state.dirty && recovered > 0) offerRecovered(document, recovered);
    for (const listener of replayListeners) listener(document);
  }
}

/** Journal records being replayed, by document: told once the replay finishes. */
const pendingRestores = new Map<number, number>();

/** A document that opened without its journal: what that means for its edits. */
function reportJournalUnavailable(name: string, why: "busy" | "unreadable") {
  toastManager.add(
    stackedToast({
      type: "warning",
      ...(why === "busy"
        ? {
            title: `${name} is open in another tab or window`,
            description: "Edits made here are not kept if this tab closes before they are saved.",
          }
        : {
            title: `Unsaved edits to ${name} could not be read`,
            description:
              "It opened as it is on disk. Edits made now are not kept if the tab closes.",
          }),
    }),
  );
}

function reportRestoreFailed(name: string) {
  toastManager.add(
    stackedToast({
      type: "warning",
      title: "Unsaved edits could not be restored",
      description: `${name} opened as it is on disk.`,
    }),
  );
}

/**
 * True while the unsaved-changes question waits on a save of this document: the
 * document is about to be replaced or its window closed, so the save must not
 * open the saved file again afterwards.
 */
export function savingBeforeLeaving(documentId: number): boolean {
  return (savedWaiters.get(documentId)?.size ?? 0) > 0;
}

/**
 * Runs `document.save` and resolves once the engine says nothing is left to
 * save: true then, false when no save command could run. A save the user
 * abandons never resolves; the next question about the document replaces it.
 */
function saveAndWait(documentId: number): Promise<boolean> {
  return new Promise((resolve) => {
    let waiting = savedWaiters.get(documentId);
    if (waiting === undefined) {
      waiting = new Set();
      savedWaiters.set(documentId, waiting);
    }
    waiting.add(resolve);
    if (!runShellCommand("document.save")) {
      waiting.delete(resolve);
      resolve(false);
    }
  });
}

/** Asks about the open document's unsaved edits; true when it may be replaced or closed. */
async function settleUnsavedEdits(session: DocumentSession): Promise<boolean> {
  if (session.phase !== "open" || !session.document.edit.dirty) return true;
  // A new question replaces a save the user started for an older one and never finished.
  for (const waiting of savedWaiters.values()) for (const resolve of waiting) resolve(false);
  savedWaiters.clear();
  const choice = await askAboutUnsavedChanges(session.document.name);
  if (choice === "cancel") return false;
  if (choice === "discard") {
    // Discarded edits are gone: the journal starts over, so they do not come back on the next open.
    await getEngine()
      .request("dropJournal", { documentId: session.document.documentId })
      .catch(() => null);
    return true;
  }
  return saveAndWait(session.document.documentId);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Restored edits from a journal: keep them (they are already applied), or open the file as saved. */
/** The restore notice on screen, and the document it is about: one at a time. */
let recoveredNotice: { readonly documentId: number; readonly toastId: string } | null = null;

const closeRecoveredNotice = () => {
  if (recoveredNotice !== null) toastManager.close(recoveredNotice.toastId);
  recoveredNotice = null;
};

function offerRecovered(document: OpenDocument, recovered: number) {
  closeRecoveredNotice();
  const id = toastManager.add(
    stackedToast({
      type: "info",
      title: `Restored ${plural(recovered, "unsaved edit", "unsaved edits")}`,
      description: `${document.name} had edits that were not saved.`,
      timeout: 0,
      actionProps: {
        children: "Keep",
        onClick: () => toastManager.close(id),
      },
      data: {
        secondaryActionProps: {
          children: "Discard",
          onClick: () => {
            toastManager.close(id);
            void document.reopenWithoutJournal();
          },
        },
      },
    }),
  );
  recoveredNotice = { documentId: document.documentId, toastId: id };
}

function onProgress(progress: IndexProgress) {
  if (!progress.done) return;
  finished.add(progress.documentId);
  const { session } = useDocumentSession.getState();
  if (session.phase !== "open" || session.document.documentId !== progress.documentId) return;
  const { document } = session;
  void (document.tree?.refresh() ?? Promise.resolve()).finally(() => {
    const now = useDocumentSession.getState().session;
    if (now.phase === "open" && now.document.documentId === document.documentId) {
      // The current document, not the one captured above: its problem may have arrived meanwhile.
      useDocumentSession.setState({
        session: { phase: "open", document: { ...now.document, indexing: false } },
      });
    }
  });
}

/** The file as it is now: the handle's, when there is one, else the `File` the document opened from. */
const currentFile = async (file: File, handle: FileHandle | null) =>
  handle === null ? file : await handle.getFile().catch(() => file);

/** Asks whether the document is valid JSON (the engine answers once its index is complete) and records it. */
async function loadProblem(transport: EngineTransport, documentId: number) {
  const problem = await transport.request("problem", { documentId }).catch(() => null);
  if (problem === null) return;
  const now = useDocumentSession.getState().session;
  if (now.phase !== "open" || now.document.documentId !== documentId) return;
  useDocumentSession.setState({
    session: { phase: "open", document: { ...now.document, problem } },
  });
  // The engine now leaves out what it read past the problem: the outline drops it.
  void now.document.tree?.refresh();
}

export const useDocumentSession = create<SessionState>((set, get) => {
  const open = async ({
    source: bytes,
    name,
    fileKey,
    journalKey: keyOf,
    reopenWithoutJournal,
    reopen,
    reopenAs,
    origin,
    opened,
    options,
  }: Opening) => {
    const mine = ++generation;
    // A port that never reaches the engine is closed here: nothing else would.
    const drop = () => {
      if (!(bytes instanceof Blob)) bytes.port.close();
    };
    if (options.force !== true && !(await settleUnsavedEdits(get().session))) return drop();
    if (mine !== generation) return drop();
    // Started while the previous document closes: the identity reads the file's first and last MiB.
    const journalKey = keyOf().catch(() => null);
    const previous = get().session;
    set({ session: { phase: "opening", name } });
    const transport = getEngine();
    let sent = false;
    /** The document whose recovered journal is being replayed, while it opens. */
    let restoring: number | null = null;
    try {
      if (previous.phase === "open") {
        await transport.request("close", { documentId: previous.document.documentId });
      }
      // Edits are journaled under the file's identity, so the same file opened later gets them back.
      const key = await journalKey;
      sent = true;
      const info = await transport.request("open", {
        source: bytes,
        name,
        ...(key === null ? {} : { journalKey: key }),
        ...(options.discardJournal === true ? { discardJournal: true } : {}),
        ...(options.asFormat === undefined ? {} : { asFormat: options.asFormat }),
      });
      if (mine !== generation) {
        await transport.request("close", { documentId: info.documentId });
        return;
      }
      const source = sourceClientFor(transport, info.documentId);
      const queries = queryClientFor(transport, info.documentId);
      if (info.journalUnavailable !== null) reportJournalUnavailable(name, info.journalUnavailable);
      const replaying = info.recovered > 0;
      if (replaying) {
        pendingRestores.set(info.documentId, info.recovered);
        restoring = info.documentId;
      }
      const shared = {
        documentId: info.documentId,
        name: info.name,
        size: info.size,
        format: info.format,
        fileKey,
        structure: info.structure,
        editable: info.editable,
        note: info.note,
        ...origin,
        problem: null,
        source,
        queries,
        revision: 0,
        edit: { undoDepth: 0, redoDepth: 0, dirty: replaying, replaying },
        edits: editClientFor(transport, info.documentId),
        reopenWithoutJournal,
        reopen,
        reopenAs,
      };
      let document: OpenDocument;
      if (info.structure === "none") {
        document = { ...shared, tree: null, indexing: false };
      } else {
        const root = await transport.request("root", { documentId: info.documentId });
        const tree = new TreeModel(sourceFor(transport), root);
        await tree.setExpanded(tree.rootId, true);
        if (finished.has(info.documentId)) void tree.refresh();
        document = { ...shared, tree, indexing: !finished.has(info.documentId) };
      }
      if (mine !== generation) return;
      useSelectionStore.getState().clear();
      preloadSourceView();
      set({ session: { phase: "open", document } });
      if (replaying) {
        // The replay may have finished before the session listened for it.
        void transport
          .request("editState", { documentId: info.documentId })
          .then(onEditState)
          .catch(() => undefined);
      }
      opened();
      if (info.structure !== "none") void loadProblem(transport, info.documentId);
    } catch (error) {
      if (!sent) drop();
      // Opening failed with a journal being replayed: the file opens again without it, as it is on disk.
      if (restoring !== null && options.discardJournal !== true && mine === generation) {
        pendingRestores.delete(restoring);
        await transport.request("close", { documentId: restoring }).catch(() => null);
        reportRestoreFailed(name);
        await reopenWithoutJournal();
        return;
      }
      if (mine !== generation) return;
      set({
        session: {
          phase: "error",
          name,
          message: error instanceof Error ? error.message : "The file could not be opened.",
          recentId: options.recentId ?? null,
        },
      });
    }
  };
  const openFile = (
    file: File,
    handle: FileHandle | null = null,
    options: OpenFileOptions = {},
  ): Promise<void> =>
    open({
      source: file,
      name: file.name,
      fileKey: fileKeyOf(file),
      origin: { file, handle, desktopId: null },
      journalKey: () => journalKeyOf(file),
      // After a save in place the `File` above can no longer be read: the handle has the file now.
      reopenWithoutJournal: async () =>
        openFile(await currentFile(file, handle), handle, { discardJournal: true, force: true }),
      reopen: async () => openFile(await currentFile(file, handle), handle, { fromHistory: true }),
      reopenAs: async (format) =>
        openFile(await currentFile(file, handle), handle, { asFormat: format }),
      opened: () =>
        void useRecentDocuments
          .getState()
          .record(file, handle, { keepOrder: options.fromHistory === true }),
      options,
    });
  return {
    session: { phase: "empty" },
    openFile,
    openDesktopDocument: (document, port) => {
      const key = desktopJournalKey(document);
      // Discard asked the desktop to open this file again: it opens without its journal.
      const discarding = discardOnArrival.delete(key);
      const asFormat = formatOnArrival.get(key);
      formatOnArrival.delete(key);
      return open({
        source: { _tag: "DocumentPort", port, size: document.size },
        name: document.name,
        fileKey: fileKeyOf(document),
        origin: { file: null, handle: null, desktopId: document.id },
        journalKey: async () => key,
        reopenWithoutJournal: async () => {
          discardOnArrival.add(key);
          await window.desktopBridge?.openRecentDocument(document.id);
        },
        reopen: async () => {
          await window.desktopBridge?.openRecentDocument(document.id);
        },
        reopenAs: async (format) => {
          formatOnArrival.set(key, format);
          await window.desktopBridge?.openRecentDocument(document.id);
        },
        // A reload asks the main process to open it again (`documentsReady`).
        opened: () => markOpenDocument(document.id),
        options: {
          ...(discarding ? { discardJournal: true, force: true } : {}),
          ...(asFormat === undefined ? {} : { asFormat }),
          recentId: document.id,
        },
      });
    },
    openPastedText: (text) => openFile(new File([text], "Pasted text"), null),
    closeDocument: async () => {
      const mine = ++generation;
      const session = get().session;
      // A file that failed to open leaves only its message, which closing clears.
      if (session.phase === "error") set({ session: { phase: "empty" } });
      if (session.phase !== "open") return true;
      if (!(await settleUnsavedEdits(session))) return false;
      if (mine !== generation) return false;
      useSelectionStore.getState().clear();
      set({ session: { phase: "empty" } });
      await getEngine()
        .request("close", { documentId: session.document.documentId })
        .catch(() => null);
      return true;
    },
  };
});

/**
 * A file the desktop opened: the main process's recent id (a hash of its path)
 * with its size and modification time, so the same file, unchanged, finds its edits.
 */
/** The journal key of a desktop file: its recent id, size and modification time. */
export const desktopJournalKey = (
  document: Pick<DesktopOpenedDocument, "id" | "size" | "lastModified">,
) => `desktop:${document.id}-${document.size}-${document.lastModified}`;

/** Journal keys of desktop files being opened again as another format, and the format. */
const formatOnArrival = new Map<string, DocumentFormat>();

/** Journal keys of desktop files being opened again by Discard. */
const discardOnArrival = new Set<string>();

// The desktop asks before it closes the window or quits: the same question as replacing the document.
if (typeof window !== "undefined") {
  window.desktopBridge?.onCloseRequest?.(() =>
    settleUnsavedEdits(useDocumentSession.getState().session),
  );
}

// The browser can only offer its own question when the tab closes; the journal keeps the edits either way.
if (typeof window !== "undefined" && window.desktopBridge === undefined) {
  window.addEventListener("beforeunload", (event) => {
    const { session } = useDocumentSession.getState();
    if (session.phase === "open" && session.document.edit.dirty) event.preventDefault();
  });
}

// The restore notice is about one document: it goes when that document is no longer shown.
useDocumentSession.subscribe((state) => {
  if (recoveredNotice === null) return;
  const shown = state.session.phase === "open" ? state.session.document.documentId : null;
  if (shown !== recoveredNotice.documentId) closeRecoveredNotice();
});
