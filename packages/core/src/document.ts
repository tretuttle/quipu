/**
 * The engine coordinator: owns the open documents, their tapes, their edits and
 * the pool of scan workers, and answers the RPC in @quipu/contracts/engine. It
 * runs inside a worker in the product (apps/web/src/engine/engine.worker.ts) and
 * in-process in tests; nothing here touches the DOM.
 *
 * Node references are `{ documentId, tapeId, token }`: tape 0 is the document's
 * own tape; a bucket of on-demand children, a nested document or a re-indexed
 * edit region gets its own tape id, and its byte offsets refer to its own source.
 *
 * Edits (docs/internals/document-engine.md, "Edits"):
 * every document, nested ones included, is a `Doc` with a piece table over its
 * original bytes plus an append buffer. The main tape keeps file offsets; an
 * edit re-indexes the smallest enclosing value into a side tape over a frozen
 * window of the pieces (edits.ts). A dirty nested document is an overlay on its
 * parent: the parent's bytes stay put and the child is re-escaped where the
 * parent is read as a whole or saved.
 */
import {
  CHILDREN_PAGE_LIMIT,
  ConvertError,
  type ConvertFormat,
  type ConvertSettings,
  type DecoderKind,
  DOCUMENT_FORMAT_LABELS,
  type DocumentFormat,
  EDITABLE_FORMATS,
  type DocumentStructure,
  DocumentNotOpenError,
  type DocumentSource,
  type EditResult,
  type EditState,
  EngineError,
  type EngineEvent,
  type EngineRequest,
  type EngineResult,
  EngineWorkerError,
  type ExportTarget,
  type HarEntrySummary,
  type HarPageSummary,
  InvalidPathError,
  InvalidSearchPatternError,
  JQ_OUTPUT_LIMIT_BYTES,
  JqSubtreeTooLargeError,
  MAX_HIT_RANGES,
  MAX_RETAINED_HITS,
  EditRefusedError,
  InvalidEditError,
  MAX_PATH_TEXT_LENGTH,
  MAX_SLICE_BYTES,
  MAX_SORT_CHILDREN,
  type NodeKind,
  type NestedDocument,
  NodeNotFoundError,
  type NodePath,
  type NodeRef,
  type NodeSummary,
  NotNestedJsonError,
  NothingToUndoError,
  type RowSummary,
  type SaveSink,
  SearchNotFoundError,
  type SearchQuery,
  SOURCE_PATH_LIMIT,
  SliceTooLargeError,
  type SourceRows,
  type SourceSpan,
  type TextValue,
  type Transform,
  type WebSocketFrame,
} from "@quipu/contracts/engine";
import * as Schema from "effect/Schema";

import { AppendBuffer } from "./appendBuffer.ts";
import { checkedLimit, decodeUtf8, parseJsonSlice } from "./boundedSlice.ts";
import { BYTE_CLASS, CLASS_WS, COMMA } from "./bytes.ts";
import { DETECT_HEAD_BYTES, detectFormat } from "./detect.ts";
import {
  decodeString,
  isCleanIndex,
  looksLikeJson,
  MAX_KEY_BYTES,
  PIECE_LOOKBEHIND,
  PIECE_TAIL,
  stringEnd,
  unescapeBytes,
  unescapePiece,
} from "./decode.ts";
import {
  base64Summary,
  decodeAccess,
  detectAccess,
  previewAccess,
  type StringAccess,
} from "./decoders.ts";
import type { StringContext } from "./detectString.ts";
import { enclosingToken, type Region, Regions, regionStart, widerToken } from "./edits.ts";
import { escapedLength, escapeInto, rawBytesFitting } from "./escape.ts";
import { ByteWriter, formatChunk, type FormatState, INITIAL_FORMAT_STATE } from "./format.ts";
import { indexBytes } from "./indexBuffer.ts";
import { DEFAULT_REGION_BYTES, DEFAULT_TOKEN_BUDGET, indexDocument } from "./indexDocument.ts";
import { Journal, type JournalRecord } from "./journal.ts";
import type { JournalStore } from "./journalStore.ts";
import type { BucketAnchors } from "./merge.ts";
import type {
  JqElementRequest,
  JqElementResult,
  JqSuggestedPath,
} from "@quipu/contracts/elementMap";
import {
  elementBatchMap,
  elementMap,
  type ElementBatch,
  type ElementDescriptor,
  type ElementMapOptions,
  type ElementMapResult,
  type ElementSlice,
  type ElementSource,
} from "./elementMap.ts";
import {
  evalFilterSelector,
  evalPathExpression,
  type PathFilterHost,
  type PathNodeInfo,
} from "./pathFilter.ts";
import {
  parsePath,
  PathSyntaxError,
  type FilterLiteral,
  type Segment,
  type Selector,
} from "./pathParse.ts";
import { packPieces, pieceSource } from "./pieceSource.ts";
import {
  ORIGINAL_BUFFER,
  type Piece,
  PieceTable,
  piecesLength,
  type Splice,
} from "./pieceTable.ts";
import { BudgetExceededError, type Pool } from "./pool.ts";
import type { Base64PieceResult, IndexRangeResult, Unescaped } from "./protocol.ts";
import { INITIAL_ENTRY } from "./resolve.ts";
import { copyRange, formatThroughPool, openSink, type Sink } from "./save.ts";
import { mirrorSourceToSpillBlob, openSpillScratch, teeSink } from "./spillReadable.ts";
import { FULL_DEPTH, type EntryState, type SyntaxCode, type SyntaxProblem } from "./scan.ts";
import { SegmentedTape } from "./segmentedTape.ts";
import {
  type ChunkOptions,
  type ChunkResult,
  compileRegex,
  DEFAULT_CHUNK_OPTIONS,
  type SearchSpec,
} from "./search.ts";
import type {
  DeepHitAnnotation,
  DeepSearchQuery,
  DeepSearchSummary,
  TraceResult,
  TraceValueRequest,
} from "@quipu/contracts/deepSearch";
import { runDeepSearch } from "./deepSearch.ts";
import { runSearch, type SearchOutcome } from "./searchRun.ts";
import { traceExactValue } from "./trace.ts";
import {
  DiffTooLargeError,
  MAX_STRUCTURAL_DIFF_BYTES,
  type HarDiffSummary,
  type StructuralDiffResult,
} from "@quipu/contracts/diff";
import {
  DEFAULT_MAX_ENUM,
  DEFAULT_MAX_INFER_DEPTH,
  MAX_SCHEMA_FAILURES,
  type CodegenOptions,
  type CodegenResult,
  type FieldShape,
  type HarValidationFilter,
  type InferOptions,
  type SchemaFailure,
  type Shape,
  type ValidationResult,
} from "@quipu/contracts/schema";
import { generateFromShape } from "./codegen/index.ts";
import {
  diffHarCaptures,
  diffHarEntryBodies,
  diffJsonBytes,
  extractHarEntryPrintFromSlice,
  extractHarPrintsStreaming,
  type HarEntryPrint,
} from "./diff/index.ts";
import type {
  HarPrintWindowResult,
  HarTableColumnarWindowResult,
  HarTableWindowResult,
  HashSourceRangeResult,
} from "./protocol.ts";
import {
  emptyShape,
  inferJsonSlice,
  mergeShape,
  parseSchema,
  SchemaParseError,
  validateHarEntries,
  validateJsonSlice,
  type HarEntryInput,
  type LocalSchema,
} from "./schema/index.ts";
import {
  createTableDocAccessFromHandle,
  HAR_COL_STRIDE,
  type HarEntryCellRefs,
  type HarTableColumnarData,
  type HarTableRawRow,
  type ResolvedHarRowBatchItem,
  TableIndexHost,
  type TableDocAccess,
} from "./tableIndex.ts";
import {
  type ByteSource,
  blobSource,
  type DocumentBytes,
  documentBytes,
  memorySource,
} from "./source.ts";
import { type PaintToken, paintJson } from "./sourcePaint.ts";
import { type LineCounts, createLineCounts, layoutRows } from "./sourceRows.ts";
import {
  firstChild,
  isContainer,
  KIND_ARRAY,
  KIND_FALSE,
  KIND_NULL,
  KIND_NUMBER,
  KIND_OBJECT,
  KIND_STRING,
  KIND_TRUE,
  MAX_TAPE_SOURCE_BYTES,
  NO_KEY,
  needsExpand,
  type Tape,
  tapeFromBuffers,
} from "./tape.ts";

/** What a jq run came to; the host adds the size of its input. */
export interface JqOutcome {
  readonly status: "ok" | "error" | "timeout";
  readonly output: string;
  readonly truncated: boolean;
  readonly message: string;
}

export interface HostPlatform {
  readonly workers: number;
  readonly crossOriginIsolated: boolean;
  createPool(workers: number): Pool | Promise<Pool>;
  /**
   * Runs a jq program over one JSON text in its own worker and stops it at the
   * time budget. Absent where the host has no jq (the engine then says so).
   */
  readonly runJq?: (
    input: Uint8Array,
    program: string,
    timeoutMs: number,
    outputLimit: number,
  ) => Promise<JqOutcome>;
  /** When true, `jqElement` packs contiguous element batches as JSON arrays to amortize worker/WASM overhead. */
  readonly runJqBatch?: boolean;
  /** Where edit journals live; without one, edits are not journaled. Set late by the desktop's port. */
  journalStore?: JournalStore | undefined;
  /**
   * Detection and conversion for the formats the engine does not index itself
   * (YAML, TOML, XML, CSV, TSV, NDJSON, JSONC). Without it every file the engine
   * cannot index opens as text, and only JSON exports.
   */
  readonly formats?: FormatPlatform;
}

/** What a file is, as the format platform detected it. `delimiter` is a CSV or TSV field separator, else 0. */
export interface FormatDetection {
  readonly format: DocumentFormat;
  readonly delimiter: number;
  /** The format the file's name says (`text` for a plain-text extension); null when it says nothing. */
  readonly named: DocumentFormat | null;
}

/** A document shown through JSON bytes the engine indexes in place of the file's own. */
export type JsonView =
  | {
      readonly kind: "json";
      readonly blob: Blob;
      /**
       * `same`: every value sits at the byte offsets it has in the file (JSONC with
       * its comments blanked), so the index paints and selects the file's text.
       */
      readonly offsets: "same" | "converted";
      /** Frees the JSON bytes; called when the document closes. */
      readonly release: () => Promise<void>;
    }
  | {
      readonly kind: "text";
      readonly note: string;
      /** The bytes did not read as the format (rather than being past a size limit). */
      readonly invalid: boolean;
    };

/** Bytes written somewhere the engine can read back as a Blob (OPFS in the browser, memory in tests). */
export interface ScratchFile {
  readonly sink: Sink;
  finish(): Promise<Blob>;
  release(): Promise<void>;
}

export interface FormatPlatform {
  /** How much of the file's head `detect` reads. */
  readonly prefixBytes: number;
  detect(prefix: Uint8Array, name: string, truncated: boolean): FormatDetection;
  /** The file as JSON the engine can index, or the reason it opens as text. */
  jsonView(file: ByteSource, detection: FormatDetection): Promise<JsonView>;
  /** Streams JSON bytes converted to `to` into the sink; a refusal is a `ConvertError`. Answers bytes written. */
  convert(json: Blob, to: ConvertFormat, settings: ConvertSettings, sink: Sink): Promise<number>;
  scratch(): Promise<ScratchFile>;
}

/** The file's own bytes, when the engine indexes other bytes in their place: what the Source view shows. */
interface Display {
  readonly source: ByteSource;
  lineCounts: LineCounts;
  /** Node offsets are offsets in the file too (JSONC); otherwise the index cannot paint the file's text. */
  readonly sameOffsets: boolean;
}

const FORMAT_LABELS = DOCUMENT_FORMAT_LABELS;

export interface HostOptions {
  readonly regionBytes?: number;
  readonly tokenBudget?: number;
  /** Bucket tapes kept alive across pages before the oldest is dropped. */
  readonly bucketCache?: number;
  /** Where the Source view cuts long lines; tests shrink it to put cuts in small files. */
  readonly sourceBlockBytes?: number;
  /** Search chunking; tests shrink it to put chunk edges inside small files. */
  readonly search?: {
    readonly literalChunkBytes?: number;
    readonly regexChunkBytes?: number;
    readonly chunk?: Partial<ChunkOptions>;
    /** Time one regex chunk may take before its worker is stopped. */
    readonly regexBudgetMs?: number;
    readonly regexWorkers?: number;
  };
  /** Edit regions up to this many bytes re-index in the coordinator; bigger ones go through the pool. */
  readonly inProcessRegionBytes?: number;
  /** Chunk size of the append buffer (small in tests so inserts straddle chunks). */
  readonly appendChunkBytes?: number;
}

interface DecodedHead {
  readonly bytes: Uint8Array;
  /** True when `bytes` is the whole value rather than a prefix of it. */
  readonly complete: boolean;
}

/**
 * A byte space with regions of its own: the document's main tape, or the side
 * tape of a region (edits.ts). A side tape is a level below the level whose
 * region it re-indexed, so regions nest. Bucket tapes share their owner's level.
 */
interface Level {
  /** The tape whose offsets this level's regions are in. */
  readonly tapeId: number;
  readonly regions: Regions;
  /** region token → side tape id; that tape's record is the level below. */
  readonly sideTapes: Map<number, number>;
  /** The level this one is a region of, or null for a document's main tape. */
  readonly host: { readonly level: Level; readonly region: Region } | null;
}

const newLevel = (tapeId: number, host: Level["host"]): Level => ({
  tapeId,
  regions: new Regions(),
  sideTapes: new Map(),
  host,
});

interface TapeRecord {
  readonly doc: Doc;
  readonly tape: Tape;
  /** Coordinator-side reads of the tape's source. */
  readonly source: ByteSource;
  /** The worker-side source id the tape's offsets refer to. */
  readonly sourceId: number;
  readonly size: number;
  readonly level: Level;
  anchors: ReadonlyMap<number, BucketAnchors>;
  bigStrings: ReadonlyArray<number>;
  /** container token → bucket index → tape id. */
  readonly buckets: Map<number, Map<number, number>>;
  /** container token → tokens of every CHILDREN_PAGE_LIMIT-th on-tape child, built on demand. */
  readonly childSkips: Map<number, number[]>;
  /** object token → its `mimeType` and `encoding` members, read once for detection. */
  readonly hints: Map<number, Pick<StringContext, "mimeType" | "encoding">>;
}

/** A nested document and the string it was expanded from. */
interface ChildLink {
  readonly parent: Doc;
  readonly tapeId: number;
  readonly token: number;
  readonly child: Doc;
  /** Escaped length of the child's current bytes and per-block prefix, computed when the parent needs them. */
  escaped: { readonly length: number; readonly blocks: number[] } | null;
}

/** One editable byte space: the top-level document or a nested one. */
interface Doc {
  readonly owner: OpenDocument;
  readonly rootTapeId: number;
  readonly original: ByteSource;
  readonly originalSourceId: number;
  readonly pieces: PieceTable;
  readonly append: AppendBuffer;
  readonly appendSourceId: number;
  /** The main tape's level; side tapes hang below it. */
  readonly top: Level;
  /** `${tapeId}:${token}` of a string in this doc → the nested document under it. */
  readonly children: Map<string, ChildLink>;
  readonly parentLink: ChildLink | null;
  /** How many append chunks, and bytes, the workers have been given. */
  sharedChunks: number;
  sharedLength: number;
  /** Buffers 2 and up: a transform's output, in the journal directory or in memory. */
  readonly spills: Spill[];
}

interface Spill {
  readonly source: ByteSource;
  readonly sourceId: number;
  readonly release?: (() => Promise<void>) | undefined;
}

/** Collects a transform's output; `finish` turns it into pieces of a new buffer. */
interface SpillWriter {
  readonly sink: Sink;
  finish(): Promise<{
    readonly pieces: Piece[];
    readonly length: number;
    readonly src: string | undefined;
  }>;
  abort(): Promise<void>;
}

interface HistoryEntry {
  readonly docTapeId: number;
  readonly splice: Splice;
}

interface OpenDocument {
  readonly id: number;
  readonly name: string;
  /** The size of the bytes the index is over; an edited document's size is `docSize(doc)`. */
  readonly size: number;
  /** What the index is over: JSON (or HAR) bytes, or nothing for text. */
  readonly format: "json" | "har" | "text";
  /** The file's own bytes when the index is over a conversion of them; null when it is over the file. */
  readonly display: Display | null;
  readonly editable: boolean;
  /** Frees a conversion's bytes. */
  readonly release: (() => Promise<void>) | null;
  /** The index's first syntax problem, once it is complete; null for valid JSON. */
  syntax: SyntaxProblem | null;
  /** Frees the private copy `detach` made of the file; null until one is made. */
  detached: (() => Promise<void>) | null;
  problemText: Promise<EngineResult["problem"]> | null;
  /** Newline counts the Source view's line numbers are cut from. */
  lineCounts: LineCounts;
  readonly source: ByteSource;
  /** How each scan worker opens the indexed bytes (the file, or a conversion of it). */
  readonly bytes: DocumentBytes;
  /** The indexed bytes as a Blob when they are one; an export reads JSON from it without a copy. */
  readonly indexedBlob: Blob | null;
  readonly pool: Pool;
  /** Workers regular expressions run in, so one that backtracks cannot stall indexing. Made on first use. */
  regexPool: Promise<Pool> | null;
  readonly searches: Map<number, SearchRecord>;
  /** Path queries in flight; while there are any, bucket tapes their results refer to stay. */
  bucketPins: number;
  /** Chain of window scans for lighting, so they run one at a time. */
  localScans: Promise<void>;
  /** The newest search; an older one still running stops at its next chunk. */
  currentSearch: number;
  readonly tapes: Map<number, TapeRecord>;
  nextTapeId: number;
  nextSourceId: number;
  readonly firstRegion: Promise<void>;
  /** The structural index is complete. */
  readonly structured: Promise<void>;
  /** The index is complete and a recovered journal has been replayed; queries wait for this. */
  readonly indexed: Promise<void>;
  /**
   * `done` once the whole index has merged; until then only the merged prefix
   * answers, minus `unsettled`, the tokens a later region can still change.
   */
  readonly live: { done: boolean; unsettled: ReadonlySet<number> };
  /** Decodes and expansions already done, so selecting a row twice indexes its value once. */
  readonly memo: Map<string, Promise<unknown>>;
  /** tape ids of bucket tapes, oldest first. */
  readonly bucketOrder: Array<{
    readonly tapeId: number;
    readonly ownerTapeId: number;
    readonly owner: TapeRecord;
    readonly token: number;
    readonly bucket: number;
  }>;
  readonly undoStack: HistoryEntry[];
  readonly redoStack: HistoryEntry[];
  /** The top of the undo stack when the document was opened or last saved: it is dirty while the top differs. */
  savedTop: HistoryEntry | null;
  /** Bumped whenever the document's bytes change, so a view knows to read them again. */
  revision: number;
  /**
   * A recovered journal has records still to replay. Until they are, nothing is
   * answered from the index prefix: it would show the document as it was before.
   */
  replayPending: boolean;
  /** The recovered journal could not be replayed; the document was rolled back to the file and the journal dropped. */
  restoreFailed: boolean;
  /** Cached unedited HAR entry comparison prints, invalidated on any edit/replay/close. */
  harPrintsCache: Promise<ReadonlyArray<HarEntryPrint>> | null;
  /** Edits are serialized; a save waits for the edit in flight and blocks edits. */
  mutex: Promise<unknown>;
  doc: Doc;
  /** The crash log, when the document was opened with a journal key. */
  journal: Journal | null;
  /**
   * The top of the undo stack the journal's records start from: null for the
   * file as opened, the save point after a save in place. Records replay onto
   * the file, so they can only describe states built on that point.
   */
  journalFrom: HistoryEntry | null;
  /**
   * Undo went below `journalFrom`: no record can describe that against the
   * file, so the journal was emptied and records nothing until Redo returns to it.
   */
  journalOff: boolean;
  /** Journals the document moved off by a save in place; their spill files are read until it closes. */
  retiredJournals: Journal[];
  /** Journal replay is running: edits are applied, not re-recorded. */
  replaying: boolean;
}

interface SearchRecord {
  readonly id: number;
  readonly spec: SearchSpec;
  readonly decode: boolean;
  readonly outcome: SearchOutcome;
  readonly view: SearchView;
  readonly annotations?: ReadonlyArray<DeepHitAnnotation>;
}

/** The bytes a search ran over: the file, or an edited document's composed window. */
interface SearchView {
  readonly sourceId: number;
  readonly size: number;
  /** An edited document's window holds sources open on the main pool until the search closes. */
  readonly close: (() => void) | null;
}

const SEARCH_RECORDS_KEPT = 4;
const LITERAL_CHUNK_BYTES = 8 * 1024 * 1024;
const REGEX_CHUNK_BYTES = 1024 * 1024;
const REGEX_BUDGET_MS = 1500;
const REGEX_MAX_SKIPPED = 8;
const REGEX_WORKERS = 8;
/** A local scan for lighting never reads more than this. */
const LOCAL_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/** Up to this many input nodes, a name step searches inside each node instead of the whole file. */
const PATH_SMALL_SET = 16;
const PATH_MAX_SET = 1_000_000;
const PATH_PREVIEW_BYTES = 80;
const PATH_CANDIDATE_CHUNK = 8 * 1024 * 1024;
const TAPE_ID_SPAN = 2 ** 32;

const KIND_NAMES: Record<number, NodeKind> = {
  [KIND_OBJECT]: "object",
  [KIND_ARRAY]: "array",
  [KIND_STRING]: "string",
  [KIND_NUMBER]: "number",
  [KIND_TRUE]: "true",
  [KIND_FALSE]: "false",
  [KIND_NULL]: "null",
};

/**
 * `rows` reads this much of a container in one slice and decodes every key and
 * preview that falls inside it; only rows past the window cost a read each. A
 * node's first rows are what a map shows, so one read answers most nodes.
 */
const ROWS_WINDOW_BYTES = 16 * 1024;
const HAR_ENTRY_REF_KEYS = new Set(["request", "response", "time"]);
const HAR_REQ_REF_KEYS = new Set(["method", "url"]);
const HAR_RESP_REF_KEYS = new Set(["status", "bodySize", "content"]);
const HAR_CONTENT_REF_KEYS = new Set(["mimeType", "size"]);
const EMPTY_HAR_CELL_REFS: HarEntryCellRefs = {
  methodRef: null,
  urlRef: null,
  statusRef: null,
  mimeTypeRef: null,
  bodySizeRef: null,
  timeMsRef: null,
};
/** How far into an entry the HAR grouping looks for `pageref` and `request.url` before reading per row. */
const HAR_ENTRY_WINDOW_BYTES = 8 * 1024;
const HAR_REQUEST_WINDOW_BYTES = 4 * 1024;
const HAR_TEXT_PREVIEW_BYTES = 2048;
/** Entries whose fields are read at once while grouping. */
const HAR_ENTRY_CONCURRENCY = 32;
/** Bytes read before a range of rows, so an escape that straddles its start is paired right. */
const SOURCE_LOOKBACK_BYTES = 4096;

interface GatheredToken extends PaintToken {
  readonly tapeId: number;
  readonly token: number;
}

interface Gathered {
  readonly chain: GatheredToken[];
  readonly tokens: GatheredToken[];
  /** The merged prefix cannot answer this range yet. */
  needsIndex: boolean;
  /** Child index of the first element of each bucket tape the walk went through. */
  readonly bucketBase: Map<number, number>;
}

const isAscii = (bytes: Uint8Array) => {
  for (const byte of bytes) if (byte >= 0x80) return false;
  return true;
};
const NESTED_HEAD_BYTES = 64;
/** The most string content one piece covers, so its read (lookbehind, piece, tail) stays within MAX_SLICE_BYTES. */
const PIECE_BYTES = MAX_SLICE_BYTES - PIECE_LOOKBEHIND - PIECE_TAIL;
/** Decoded bytes per base64 job: a multiple of 3, so every job starts on a quad and reads 4 MiB of text. */
const BASE64_JOB_BYTES = 3 * 1024 * 1024;
const FRAME_PREVIEW_BYTES = 200;
const DOCUMENT_SOURCE_ID = 1;
const APPEND_SOURCE_ID = 2;
const FIRST_FREE_SOURCE_ID = 3;
const DEFAULT_INPROCESS_REGION_BYTES = 4 * 1024 * 1024;
/** Raw bytes per escaped-length prefix block of a dirty nested document. */
const ESCAPE_BLOCK_BYTES = 64 * 1024;
/** How far a region's leading or trailing whitespace is looked through for the clean check. */
const WS_PROBE_BYTES = 4096;
const OVERLAY_CHUNK_BYTES = 4 * 1024 * 1024;
/** Rows of the root the export check reads to decide whether it is a list of records. */
const EXPORT_SAMPLE_ROWS = 64;
/** Rows a CSV header is read from by default (`columns: "first"` in @quipu/formats). */
const EXPORT_HEADER_ROWS = 1024;
/** The export check reads a whole document up to this size to look for keys past those rows. */
const EXPORT_SCAN_BYTES = 16 * 1024 * 1024;
/** And walks a tape of up to this many tokens to look for a null. */
const EXPORT_SCAN_TOKENS = 8_000_000;
/** A key written bare in a path. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** An XML element name, as far as the export check tests one (the writer has the full rule). */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** The requests that change a document, and where each names it. */
const EDIT_TAGS = new Map<EngineRequest["_tag"], (request: EngineRequest) => number>([
  ["setValue", (r) => (r as { ref: NodeRef }).ref.documentId],
  ["setKey", (r) => (r as { ref: NodeRef }).ref.documentId],
  ["transform", (r) => (r as { ref: NodeRef }).ref.documentId],
  ["replaceBytes", (r) => (r as { documentId: number }).documentId],
  ["undo", (r) => (r as { documentId: number }).documentId],
  ["redo", (r) => (r as { documentId: number }).documentId],
]);

const readOnlyNote = (format: DocumentFormat) =>
  `${FORMAT_LABELS[format]} opens read-only. Export converts it to another format.`;

const isEngineError = Schema.is(EngineError);
const isNotNested = Schema.is(NotNestedJsonError);
const isContainerKind = (kind: NodeKind) => kind === "object" || kind === "array";

/** A re-index would cover dirty nested documents: their bytes go into the parent first (`edit`). */
class CommitFirst {
  readonly links: ReadonlyArray<ChildLink>;
  constructor(links: ReadonlyArray<ChildLink>) {
    this.links = links;
  }
}
const utf8 = new TextEncoder();

/** Entry state for indexing inside a container, right after a comma: a bucket of children, or one edited member. */
const insideEntry = (kind: number): EntryState => ({
  depth: 1,
  inString: false,
  escaped: false,
  prevSig: COMMA,
  lastByte: COMMA,
  kinds: Uint8Array.of(kind),
  openStringStart: -1,
  openStringPrevSig: 0,
});

const hasKey = (keyStart: number) => keyStart !== NO_KEY && keyStart < MAX_TAPE_SOURCE_BYTES - 1;

/** A node a path step selected over an edited document, with the key or `[index]` it sits under. */
interface PathFound {
  readonly node: NodeSummary;
  readonly label: string;
}

/** The array indexes an `[n]` or `[a:b:c]` selector picks from `count` elements, in selection order (RFC 9535). */
const selectedIndexes = (
  selector: Extract<Selector, { kind: "index" | "slice" }>,
  count: number,
): number[] => {
  if (selector.kind === "index") {
    const at = selector.index < 0 ? count + selector.index : selector.index;
    return at >= 0 && at < count ? [at] : [];
  }
  const step = selector.step ?? 1;
  if (step === 0) return [];
  const normalize = (value: number) => (value >= 0 ? value : count + value);
  const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
  const out: number[] = [];
  if (step > 0) {
    const lower = clamp(selector.start === null ? 0 : normalize(selector.start), 0, count);
    const upper = clamp(selector.end === null ? count : normalize(selector.end), 0, count);
    for (let i = lower; i < upper; i += step) out.push(i);
    return out;
  }
  const upper = clamp(
    selector.start === null ? count - 1 : normalize(selector.start),
    -1,
    count - 1,
  );
  const lower = clamp(selector.end === null ? -count - 1 : normalize(selector.end), -1, count - 1);
  for (let i = upper; lower < i; i += step) out.push(i);
  return out;
};

/**
 * The deepest token of a tape whose value (with its key) covers [fileStart,
 * fileEnd], or -1 when none does: a bucket tape has several roots, and a span
 * between two of them is in no value of the tape.
 */
const coveringToken = (tape: Tape, fileStart: number, fileEnd: number) => {
  let lo = 0;
  let hi = tape.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tape.start(mid) <= fileStart) lo = mid + 1;
    else hi = mid;
  }
  let token = lo - 1;
  // The span may sit in the key of the next member, which comes before its value.
  if (
    lo < tape.count &&
    hasKey(tape.keyStart(lo)) &&
    tape.keyStart(lo) <= fileStart &&
    fileEnd <= tape.end(lo)
  ) {
    token = lo;
  }
  while (token >= 0 && !(regionStart(tape, token) <= fileStart && fileEnd <= tape.end(token))) {
    token = tape.parent(token);
  }
  return token;
};

/** Some region overlaps [start, end) without lying inside it. */
const crossesRegion = (regions: Regions, start: number, end: number) =>
  regions
    .all()
    .some(
      (region) =>
        region.fileStart < end &&
        region.fileEnd > start &&
        (region.fileStart < start || region.fileEnd > end),
    );

export class EngineHost {
  private readonly platform: HostPlatform;
  private readonly regionBytes: number;
  private readonly tokenBudget: number;
  private readonly bucketCache: number;
  private readonly sourceBlockBytes: number | undefined;
  private readonly searchOptions: NonNullable<HostOptions["search"]>;
  private nextSearchId = 1;
  private readonly inProcessRegionBytes: number;
  private readonly appendChunkBytes: number | undefined;
  private readonly documents = new Map<number, OpenDocument>();
  private nextDocumentId = 1;
  private readonly tableIndex = new TableIndexHost();
  private readonly tableAccess: TableDocAccess = {
    ...createTableDocAccessFromHandle(
      (req) => this.handle(req as EngineRequest),
      (id) => this.document(id).format,
    ),
    readHarEntriesFast: (documentId, targetRef, totalRows) =>
      this.readHarEntriesFast(documentId, targetRef, totalRows),
    resolveHarRowsBatch: (targetRef, rowIndices) => this.resolveHarRowsBatch(targetRef, rowIndices),
  };
  onEvent: ((event: EngineEvent) => void) | undefined;

  constructor(platform: HostPlatform, options: HostOptions = {}) {
    this.platform = platform;
    this.regionBytes = options.regionBytes ?? DEFAULT_REGION_BYTES;
    this.tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.bucketCache = options.bucketCache ?? 256;
    this.sourceBlockBytes = options.sourceBlockBytes;
    this.searchOptions = options.search ?? {};
    this.inProcessRegionBytes = options.inProcessRegionBytes ?? DEFAULT_INPROCESS_REGION_BYTES;
    this.appendChunkBytes = options.appendChunkBytes;
  }

  /** Answers one request; every failure is one of the contract's errors. */
  async handle<R extends EngineRequest>(request: R): Promise<EngineResult[R["_tag"]]> {
    try {
      return (await this.dispatch(request)) as EngineResult[R["_tag"]];
    } catch (error) {
      if (isEngineError(error)) throw error;
      throw new EngineWorkerError({
        detail: error instanceof Error ? error.message : `${error as string}`,
      });
    }
  }

  private dispatch(request: EngineRequest): Promise<EngineResult[keyof EngineResult]> {
    const edited = EDIT_TAGS.get(request._tag);
    if (edited !== undefined) this.refuseReadOnly(edited(request));
    switch (request._tag) {
      case "capabilities":
        return Promise.resolve({
          crossOriginIsolated: this.platform.crossOriginIsolated,
          workers: this.platform.workers,
        });
      case "open":
        return this.open(
          request.source,
          request.name,
          request.journalKey,
          request.discardJournal === true,
          request.asFormat,
        );
      case "close":
        return this.close(request.documentId);
      case "root":
        return this.root(request.documentId);
      case "node":
        return this.node(request.ref);
      case "children":
        return this.children(request.ref, request.from, request.count);
      case "rows":
        return this.rows(request.ref, request.from, request.count, request.previewBytes);
      case "harEntries":
        return this.harEntries(request.documentId, request.from, request.count);
      case "text":
        return this.text(request.ref, request.limit);
      case "keyText":
        return this.keyText(request.ref);
      case "headText":
        return this.headText(request.documentId, request.bytes);
      case "slice":
        return this.slice(
          request.documentId,
          request.tapeId,
          request.range.start,
          request.range.end,
        );
      case "search":
        return this.search(request.documentId, request.query);
      case "searchHits":
        return this.searchHits(
          request.documentId,
          request.searchId,
          request.from,
          request.to,
          request.limit,
        );
      case "searchLit":
        return this.searchLit(request.documentId, request.searchId, request.ranges);
      case "searchHit":
        return this.searchHit(request.documentId, request.searchId, request.index);
      case "searchSeek":
        return this.searchSeek(request.documentId, request.searchId, request.offset);
      case "searchClose":
        this.dropSearch(this.document(request.documentId), request.searchId);
        return Promise.resolve(null);
      case "pathQuery":
        return this.pathQuery(request.documentId, request.path, request.limit);
      case "jq":
        return this.jq(request.ref, request.program, request.timeoutMs);
      case "expandNested":
        return this.expandNested(request.ref);
      case "largestStrings":
        return this.largestStrings(request.documentId, request.limit);
      case "stringHead":
        return this.stringHead(request.ref, request.bytes);
      case "decodeBase64Head":
        return this.decodeBase64Head(request.ref, request.decodedBytes);
      case "sourceRows":
        return this.sourceRows(
          request.documentId,
          request.offset,
          request.before,
          request.rows,
          request.wrapBytes,
        );
      case "nodeAt":
        return this.nodeAt(request.documentId, request.offset);
      case "detect":
        return this.detect(request.ref);
      case "decode":
        return this.decode(request.ref, request.kind);
      case "preview":
        return this.preview(request.ref);
      case "frames":
        return this.frames(request.ref, request.from, request.count);
      case "setValue":
        return this.setValue(request.ref, request.json);
      case "setKey":
        return this.setKey(request.ref, request.key);
      case "replaceBytes":
        return this.replaceBytes(
          request.documentId,
          request.tapeId,
          request.range.start,
          request.range.end,
          request.bytes,
        );
      case "undo":
        return this.undo(request.documentId, "undo");
      case "redo":
        return this.undo(request.documentId, "redo");
      case "editState":
        return this.editState(request.documentId);
      case "dropJournal":
        return this.dropJournal(request.documentId);
      case "logicalSlice":
        return this.logicalSlice(
          request.documentId,
          request.tapeId,
          request.range.start,
          request.range.end,
        );
      case "save":
        return this.save(
          request.documentId,
          request.sink,
          request.indent,
          request.inPlace === true,
        );
      case "rekeyJournal":
        return this.rekeyJournal(request.documentId, request.journalKey);
      case "transform":
        return this.transform(request.ref, request.transform);
      case "problem":
        return this.problem(request.documentId);
      case "detach":
        return this.detach(request.documentId);
      case "exportTargets":
        return this.exportTargets(request.documentId);
      case "convert":
        return this.convert(request.documentId, request.to, request.settings, request.sink);
      case "jqSuggestPath":
        return this.suggestJqElementPath(request.ref);
      case "jqElement":
        return this.jqElement(request);
      case "deepSearch":
        return this.deepSearch(request.documentId, request.query);
      case "deepSearchAnnotations":
        return Promise.resolve({
          annotations: this.deepSearchAnnotations(
            request.documentId,
            request.searchId,
            request.from,
            request.to,
          ),
        });
      case "traceValue":
        return this.traceValue(request.documentId, request.request);
      case "tableTargets":
        return this.tableIndex.targets(this.tableAccess, request.documentId);
      case "tableQuery":
        return this.tableIndex.query(this.tableAccess, request);
      case "tableRows":
        return this.tableIndex.rows(this.tableAccess, request.queryId, request.from, request.count);
      case "tableQueryClose":
        return Promise.resolve(this.tableIndex.closeQuery(request.queryId));
      case "compareStructural":
        return this.compareStructural(request.aDocumentId, request.bDocumentId);
      case "compareHar":
        return this.compareHar(request.aDocumentId, request.bDocumentId, request.reference);
      case "compareHarEntryBody":
        return this.compareHarEntryBody(
          request.aDocumentId,
          request.aEntryIndex,
          request.bDocumentId,
          request.bEntryIndex,
        );
      case "inferSchema":
        return this.inferSchema(request.ref, request.options);
      case "validateSchema":
        return this.validateSchema(request.documentId, request.schemaText, request.filter);
      case "codegen":
        return this.codegen(request.ref, request.options, request.shape);
    }
  }

  /** Edits to a document that opened read-only are refused before they reach the pieces. */
  private refuseReadOnly(documentId: number) {
    const document = this.documents.get(documentId);
    if (document === undefined || document.editable) return;
    throw new InvalidEditError({
      detail:
        document.format === "text"
          ? "this document is shown as text and cannot be edited"
          : "this document opened read-only",
    });
  }

  private async open(
    input: DocumentSource,
    name: string,
    journalKey?: string,
    discardJournal = false,
    asFormat?: DocumentFormat,
  ): Promise<EngineResult["open"]> {
    const bytes = documentBytes(input);
    try {
      return await this.openBytes(bytes, name, journalKey, discardJournal, asFormat);
    } catch (error) {
      bytes.source.close();
      throw error;
    }
  }

  private async openBytes(
    bytes: DocumentBytes,
    name: string,
    journalKey: string | undefined,
    discardJournal: boolean,
    asFormat?: DocumentFormat,
  ): Promise<EngineResult["open"]> {
    const size = bytes.source.size;
    if (size > MAX_TAPE_SOURCE_BYTES) {
      throw new EngineWorkerError({
        detail: `${name} is ${size} bytes; files over 4 GiB are not supported`,
      });
    }
    const id = this.nextDocumentId++;
    const opened = await this.openAs(bytes, name, asFormat);
    const { format, display } = opened;
    const indexedBytes = opened.bytes;
    const source = indexedBytes.source;
    const indexedSize = source.size;
    const editable = EDITABLE_FORMATS.includes(format) && display === null;
    const pool = await this.platform.createPool(this.platform.workers);
    await pool.openEach(DOCUMENT_SOURCE_ID, indexedBytes.workerSpec);
    const tape = new SegmentedTape();
    let firstRegionMerged!: () => void;
    const firstRegion = new Promise<void>((resolve) => {
      firstRegionMerged = resolve;
    });
    const document: OpenDocument = {
      id,
      name,
      size: indexedSize,
      format,
      display,
      editable,
      release: opened.release,
      syntax: null,
      detached: null,
      problemText: null,
      lineCounts: createLineCounts(),
      source,
      bytes: indexedBytes,
      indexedBlob: opened.blob,
      pool,
      regexPool: null,
      searches: new Map(),
      localScans: Promise.resolve(),
      bucketPins: 0,
      currentSearch: 0,
      live: { done: format === "text", unsettled: new Set() },
      memo: new Map(),
      tapes: new Map(),
      nextTapeId: 1,
      nextSourceId: FIRST_FREE_SOURCE_ID,
      firstRegion: Promise.resolve(),
      structured: Promise.resolve(),
      indexed: Promise.resolve(),
      bucketOrder: [],
      undoStack: [],
      redoStack: [],
      savedTop: null,
      revision: 0,
      replayPending: false,
      restoreFailed: false,
      journalFrom: null,
      journalOff: false,
      retiredJournals: [],
      harPrintsCache: null,
      mutex: Promise.resolve(),
      doc: undefined as unknown as Doc,
      journal: null,
      replaying: false,
    };
    const doc = this.createDoc(document, 0, source, DOCUMENT_SOURCE_ID, APPEND_SOURCE_ID, null);
    document.doc = doc;
    const record: TapeRecord = {
      doc,
      tape,
      source: doc.original,
      sourceId: DOCUMENT_SOURCE_ID,
      size: indexedSize,
      level: doc.top,
      anchors: new Map(),
      bigStrings: [],
      buckets: new Map(),
      childSkips: new Map(),
      hints: new Map(),
    };
    document.tapes.set(0, record);
    const live = document.live;
    // A text document has no structure to index; its bytes stay reachable as slices.
    const structured =
      format === "text"
        ? Promise.resolve()
        : indexDocument(pool, DOCUMENT_SOURCE_ID, indexedSize, {
            target: tape,
            regionBytes: this.regionBytes,
            tokenBudget: this.tokenBudget,
            onUnsettled: (tokens) => {
              live.unsettled = new Set(tokens);
            },
            onRegionMerged: (region, regions) => {
              if (region === 0) firstRegionMerged();
              this.onEvent?.({
                _tag: "indexProgress",
                progress: {
                  documentId: id,
                  regions,
                  regionsMerged: region + 1,
                  tokens: tape.count,
                  done: region + 1 === regions,
                },
              });
            },
          }).then((stats) => {
            record.anchors = stats.anchors;
            record.bigStrings = stats.bigStrings;
            document.syntax = stats.problem;
            live.done = true;
            live.unsettled = new Set();
          });
    // A failed index surfaces on the first query, not as an unhandled rejection.
    structured.catch(() => {});
    // The journal opens while the workers index: a journal left by a killed session replays onto
    // the fresh index once it is complete.
    let records: ReadonlyArray<JournalRecord> = [];
    let journalUnavailable: EngineResult["open"]["journalUnavailable"] = null;
    const store = this.platform.journalStore;
    if (store && journalKey !== undefined) {
      try {
        const opened = await Journal.open(store, journalKey);
        document.journal = opened.journal;
        records = opened.records;
        if (discardJournal && records.length > 0) {
          await opened.journal.reset();
          records = [];
        }
      } catch (error) {
        // A journal that cannot be opened never keeps the file from opening: it opens as it is
        // on disk, unjournaled, and the page says why. Nothing in the journal is touched.
        await document.journal?.close().catch(() => {});
        document.journal = null;
        records = [];
        journalUnavailable =
          error instanceof DOMException &&
          (error.name === "TimeoutError" || error.name === "NoModificationAllowedError")
            ? "busy"
            : "unreadable";
      }
    }
    document.replayPending = records.length > 0;
    const indexed = structured.then(() => this.replay(document, records));
    indexed.catch(() => {});
    // With a journal to replay, the first paint waits for it: the prefix would show the bytes before the edits.
    (document as { firstRegion: Promise<void> }).firstRegion = document.replayPending
      ? indexed
      : Promise.race([firstRegion, structured]);
    (document as { structured: Promise<void> }).structured = structured;
    (document as { indexed: Promise<void> }).indexed = indexed;
    this.documents.set(id, document);
    const structure: DocumentStructure =
      format === "text" ? "none" : display === null || display.sameOffsets ? "native" : "converted";
    return {
      documentId: id,
      name,
      size,
      format: opened.fileFormat,
      structure,
      editable,
      note: opened.note ?? (editable || format === "text" ? null : readOnlyNote(opened.fileFormat)),
      recovered: records.length,
      journalUnavailable,
    };
  }

  /**
   * What to index for a file: the file itself (JSON, HAR), JSON bytes the
   * format platform made from it, or nothing (text). A file the platform cannot
   * show as structure opens as text with the platform's reason.
   */
  private async openAs(
    file: DocumentBytes,
    name: string,
    asFormat?: DocumentFormat,
  ): Promise<{
    readonly format: OpenDocument["format"];
    readonly fileFormat: DocumentFormat;
    readonly bytes: DocumentBytes;
    /** The indexed bytes as a Blob, when they are one (a web file, a conversion). */
    readonly blob: Blob | null;
    readonly display: Display | null;
    readonly release: (() => Promise<void>) | null;
    readonly note: string | null;
  }> {
    const formats = this.platform.formats;
    const size = file.source.size;
    const fileBlob = file.blob ?? null;
    const head = await file.source.read(0, Math.min(size, DETECT_HEAD_BYTES));
    const engineFormat = detectFormat(head);
    const asText = (fileFormat: DocumentFormat, note: string | null) => ({
      format: "text" as const,
      fileFormat,
      bytes: file,
      blob: fileBlob,
      display: null,
      release: null,
      note,
    });
    if (formats === undefined) {
      return {
        format: engineFormat,
        fileFormat: engineFormat,
        bytes: file,
        blob: fileBlob,
        display: null,
        release: null,
        note: null,
      };
    }
    const prefix = await file.source.read(0, Math.min(size, formats.prefixBytes));
    const detected = formats.detect(prefix, name, size > prefix.byteLength);
    const detection = chooseFormat(detected, engineFormat, asFormat);
    const fileFormat = detection.format;
    if (fileFormat === "json" || fileFormat === "har") {
      // Named JSON that does not open with a brace or a bracket has no tree to show.
      if (engineFormat === "text") {
        return asText(
          fileFormat,
          size === 0
            ? null
            : `This ${FORMAT_LABELS[fileFormat]} file does not start with an object or a list, so it opens as text.`,
        );
      }
      return {
        format: engineFormat,
        fileFormat,
        bytes: file,
        blob: fileBlob,
        display: null,
        release: null,
        note: null,
      };
    }
    if (fileFormat === "text") return asText("text", null);
    const view = await formats.jsonView(file.source, detection);
    if (view.kind === "text") {
      // A format guessed from the bytes alone that does not read is just text: free text with a
      // line like `Action items:` is not a broken YAML file. A named one says what is wrong.
      if (view.invalid && detection.named !== fileFormat && asFormat === undefined) {
        return asText("text", null);
      }
      return asText(fileFormat, view.note);
    }
    if (view.blob.size > MAX_TAPE_SOURCE_BYTES) {
      await view.release();
      return asText(
        fileFormat,
        `This ${FORMAT_LABELS[fileFormat]} file is too large to show as a tree, so it opens as text.`,
      );
    }
    return {
      format: "json",
      fileFormat,
      bytes: documentBytes(view.blob),
      blob: view.blob,
      display: {
        source: file.source,
        lineCounts: createLineCounts(),
        sameOffsets: view.offsets === "same",
      },
      release: view.release,
      note: null,
    };
  }

  /** Applies a recovered journal through the same edit path the user took, without re-recording it. */
  private async replay(document: OpenDocument, records: ReadonlyArray<JournalRecord>) {
    if (records.length === 0) return;
    document.replaying = true;
    try {
      for (const record of records) {
        if (record.op === "edit") {
          const doc = await this.docAtPath(document, record.path);
          if (record.src !== undefined) {
            // A transform's output stays in its spill file; it becomes a buffer again, not bytes in memory.
            const pieces = await this.attachSpill(doc, record.src, record.len);
            await this.editPieces(doc, record.at, record.del, () => pieces, record.len, record.src);
          } else {
            const bytes = await (document.journal as Journal).inserted(record);
            await this.edit(doc, record.at, record.del, bytes);
          }
        } else await this.undoUnlocked(document, record.op);
      }
    } catch {
      // A journal this file cannot take (written against other bytes, or by a session whose history
      // no longer fits it) never keeps the file from opening: what was replayed is undone, the
      // journal is dropped, and the views say the edits could not be restored.
      await this.rollBack(document);
      document.restoreFailed = true;
      await document.journal?.reset().catch(() => {});
    } finally {
      document.replaying = false;
      document.replayPending = false;
      document.harPrintsCache = null;
      document.revision++;
      this.emitEditState(document);
    }
  }

  /** Undoes every edit on the history, newest first, and forgets the history: the document is the file again. */
  private async rollBack(document: OpenDocument) {
    while (document.undoStack.length > 0) {
      const before = document.undoStack.length;
      await this.undoUnlocked(document, "undo").catch(() => {
        // An entry whose document is gone is popped by undo itself; anything else stops here.
        if (document.undoStack.length === before) document.undoStack.pop();
      });
    }
    document.redoStack.length = 0;
    document.savedTop = null;
  }

  /** The nested document reached by expanding the string tokens at these document-logical offsets, top down. */
  private async docAtPath(document: OpenDocument, path: ReadonlyArray<number>): Promise<Doc> {
    let doc = document.doc;
    for (const offset of path) {
      const ref = this.nodeAtLogical(document, doc, offset);
      if (!ref) {
        throw new EngineWorkerError({
          detail: `the recovered edits refer to a string at byte ${offset} that is not in the document`,
        });
      }
      // The index is complete here; `settled` would wait for the replay this call is part of.
      const base = document.tapes.get(ref.tapeId);
      if (!base) throw new NodeNotFoundError({ ref });
      const { record, token, tapeId } = this.resolve(document, base, ref.token, ref);
      const existing = record.doc.children.get(`${tapeId}:${token}`);
      if (existing) doc = existing.child;
      else {
        const nested = await this.expandNestedResolved(document, record, token, tapeId, ref);
        doc = (document.tapes.get(nested.root.ref.tapeId) as TapeRecord).doc;
      }
    }
    return doc;
  }

  /** The ref of the token whose bytes start at document-logical `offset` in `doc`, on the main tape or a region's side tape. */
  private nodeAtLogical(document: OpenDocument, doc: Doc, offset: number): NodeRef | null {
    const pieceAt = this.toPieceLogical(doc, offset).at;
    let level = doc.top;
    for (;;) {
      const local = pieceAt - this.levelBase(level);
      const region = level.regions.containingLogical(local);
      if (!region) {
        const token = tokenStartingAt(
          this.levelRoot(document, level).tape,
          level.regions.fileOf(local),
        );
        return token < 0 ? null : { documentId: document.id, tapeId: level.tapeId, token };
      }
      const side = this.sideRecord(document, level, region);
      if (!side) return null;
      level = side.level;
    }
  }

  /** The journal path of a doc: the document-logical start of each parent string token, top down. */
  private docPath(doc: Doc): number[] {
    const path: number[] = [];
    for (let link = doc.parentLink; link; link = link.parent.parentLink) {
      const record = doc.owner.tapes.get(link.tapeId) as TapeRecord;
      path.unshift(
        this.docLogical(link.parent, this.pieceLogical(record, record.tape.start(link.token))),
      );
    }
    return path;
  }

  private createDoc(
    owner: OpenDocument,
    rootTapeId: number,
    original: ByteSource,
    originalSourceId: number,
    appendSourceId: number,
    parentLink: ChildLink | null,
  ): Doc {
    return {
      owner,
      rootTapeId,
      original,
      originalSourceId,
      pieces: new PieceTable(original.size),
      append: new AppendBuffer(this.appendChunkBytes),
      appendSourceId,
      top: newLevel(rootTapeId, null),
      children: new Map(),
      parentLink,
      sharedChunks: 0,
      sharedLength: 0,
      spills: [],
    };
  }

  private async close(documentId: number): Promise<null> {
    const document = this.document(documentId);
    document.harPrintsCache = null;
    this.tableIndex.closeDocument(documentId);
    this.documents.delete(documentId);
    document.currentSearch = -1;
    await document.indexed.catch(() => {});
    await document.pool.terminate();
    if (document.regexPool !== null) await (await document.regexPool).terminate();
    // Nothing unsaved: there is nothing to restore, so the journal goes (a save changes the file's
    // key, which would leave it an orphan). Unsaved edits keep theirs for the next open to offer.
    if (this.isUnsaved(document)) await document.journal?.close();
    else await document.journal?.remove();
    for (const retired of document.retiredJournals) await retired.remove().catch(() => {});
    document.source.close();
    // A converted document reads the file for its Source view too: that reader holds the file open.
    document.display?.source.close();
    await this.releaseSpills(document.doc);
    await document.release?.();
    await document.detached?.();
    return null;
  }

  private async releaseSpills(doc: Doc): Promise<void> {
    for (const spill of doc.spills) await spill.release?.().catch(() => {});
    for (const link of doc.children.values()) await this.releaseSpills(link.child);
  }

  /** Queries wait for the index and the journal replay; replay itself never calls this. */
  private ready(document: OpenDocument) {
    return document.indexed;
  }

  private document(documentId: number) {
    const document = this.documents.get(documentId);
    if (!document) throw new DocumentNotOpenError({ documentId });
    return document;
  }

  /** A tape offset as a position in its doc's piece-logical bytes (edits applied, overlays not). */
  private pieceLogical(record: TapeRecord, offset: number) {
    return this.levelBase(record.level) + record.level.regions.logical(offset);
  }

  /** Piece-logical position of a level's first byte: its region's logical start at the host, recursively. */
  private levelBase(level: Level): number {
    return level.host
      ? this.levelBase(level.host.level) + level.host.level.regions.logicalStart(level.host.region)
      : 0;
  }

  private levelRoot(document: OpenDocument, level: Level) {
    return document.tapes.get(level.tapeId) as TapeRecord;
  }

  private sideRecord(document: OpenDocument, level: Level, region: Region) {
    const tapeId = level.sideTapes.get(region.token);
    return tapeId === undefined ? undefined : document.tapes.get(tapeId);
  }

  /** Drops every side tape below a level, deepest first. */
  private dropLevel(document: OpenDocument, level: Level) {
    for (const tapeId of level.sideTapes.values()) {
      const record = document.tapes.get(tapeId);
      if (!record) continue;
      this.dropLevel(document, record.level);
      this.dropTape(document, tapeId);
      this.closeSource(document, record.sourceId);
    }
    level.sideTapes.clear();
  }

  /** Dirty nested documents of `doc` as overlays in piece-logical order: the parent string's content span and its escaped length. */
  private overlays(doc: Doc) {
    const list: Array<{
      readonly link: ChildLink;
      readonly start: number;
      readonly end: number;
      readonly escaped: number;
    }> = [];
    for (const link of doc.children.values()) {
      if (!this.isDirty(link.child)) continue;
      const record = doc.owner.tapes.get(link.tapeId);
      if (!record) continue;
      const start = this.pieceLogical(record, record.tape.start(link.token)) + 1;
      const end = this.pieceLogical(record, record.tape.end(link.token)) - 1;
      list.push({ link, start, end, escaped: this.escapedOf(link).length });
    }
    list.sort((a, b) => a.start - b.start);
    return list;
  }

  /**
   * The main tape no longer describes the document by itself: an edit left a
   * region (an undo back to the original bytes leaves one too), or a nested
   * document is dirty. Reads by offset then go through `gatherLogical`.
   */
  private indexMoved(document: OpenDocument): boolean {
    return document.doc.top.regions.count > 0 || this.isDirty(document.doc);
  }

  /** A doc is dirty when its own pieces changed or a nested document under it did. */
  private isDirty(doc: Doc): boolean {
    const pieces = doc.pieces.snapshot();
    const own = !(
      pieces.length === (doc.original.size > 0 ? 1 : 0) &&
      (pieces.length === 0 ||
        ((pieces[0] as { buffer: number }).buffer === ORIGINAL_BUFFER &&
          (pieces[0] as { start: number }).start === 0))
    );
    if (own) return true;
    for (const link of doc.children.values()) if (this.isDirty(link.child)) return true;
    return false;
  }

  /** Piece-logical → document-logical: the overlays ending at or before `at` have grown the document. */
  private docLogical(doc: Doc, at: number) {
    let shift = 0;
    for (const overlay of this.overlays(doc)) {
      if (overlay.end <= at) shift += overlay.escaped - (overlay.end - overlay.start);
    }
    return at + shift;
  }

  /** The document's size as the views see it. */
  private docSize(doc: Doc) {
    return this.docLogical(doc, doc.pieces.size);
  }

  /** The coordinator-side reader of one piece buffer. */
  private buffer(doc: Doc, index: number): ByteSource {
    if (index === ORIGINAL_BUFFER) return doc.original;
    if (index >= 2) return (doc.spills[index - 2] as Spill).source;
    return doc.append.asSource();
  }

  /** Whether every buffer the pieces of piece-logical [start, end) touch has a worker-side source. */
  private workersCanRead(doc: Doc, start: number, end: number) {
    return doc.pieces
      .slices(start, end)
      .every((piece) => piece.buffer < 2 || (doc.spills[piece.buffer - 2] as Spill).sourceId >= 0);
  }

  /** Piece-logical bytes [start, end) of a doc (no overlays). */
  private readPieces(doc: Doc, start: number, end: number) {
    if (end - start > MAX_SLICE_BYTES)
      throw new SliceTooLargeError({ bytes: end - start, limit: MAX_SLICE_BYTES });
    return pieceSource(doc.pieces.slices(start, end), (i) => this.buffer(doc, i)).read(
      0,
      end - start,
    );
  }

  /** Escaped length and per-block prefix of a dirty child's document-logical bytes. */
  private escapedOf(link: ChildLink) {
    if (link.escaped) return link.escaped;
    const child = link.child;
    const size = this.docSize(child);
    const blocks: number[] = [0];
    let total = 0;
    for (let at = 0; at < size; at += ESCAPE_BLOCK_BYTES) {
      const bytes = this.readLogicalSync(child, at, Math.min(size, at + ESCAPE_BLOCK_BYTES));
      total += escapedLength(bytes);
      blocks.push(total);
    }
    link.escaped = { length: total, blocks };
    return link.escaped;
  }

  /**
   * Document-logical bytes [start, end) of a doc with its overlays applied. Reads
   * are synchronous here because every buffer behind a nested document is in
   * memory; the top-level document's file is read through `readLogical`.
   */
  private readLogicalSync(doc: Doc, start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start);
    let written = 0;
    for (const segment of this.segments(doc, start, end)) {
      if (segment.kind === "pieces") {
        const slices = doc.pieces.slices(segment.from, segment.to);
        let o = written;
        for (const piece of slices) {
          const bytes = this.readBufferSync(
            doc,
            piece.buffer,
            piece.start,
            piece.start + piece.length,
          );
          out.set(bytes, o);
          o += bytes.byteLength;
        }
        written = o;
      } else {
        written = this.escapeOverlayInto(segment.link, segment.from, segment.to, out, written);
      }
    }
    return out.subarray(0, written);
  }

  private readBufferSync(doc: Doc, buffer: number, start: number, end: number): Uint8Array {
    if (buffer !== ORIGINAL_BUFFER) return doc.append.read(start, end);
    const source = doc.original as ByteSource & { readonly bytes?: Uint8Array };
    if (!source.bytes) throw new Error("a nested document's original bytes are not in memory");
    return source.bytes.subarray(start, end);
  }

  /** Writes escaped bytes [from, to) (escaped coordinates) of the child into `out`; returns the new offset. */
  private escapeOverlayInto(
    link: ChildLink,
    from: number,
    to: number,
    out: Uint8Array,
    at: number,
  ) {
    const escaped = this.escapedOf(link);
    // The block whose escaped prefix reaches `from`, then a scan inside it.
    let block = 0;
    while (block + 1 < escaped.blocks.length && (escaped.blocks[block + 1] as number) <= from)
      block++;
    let rawAt = block * ESCAPE_BLOCK_BYTES;
    let escapedAt = escaped.blocks[block] as number;
    const size = this.docSize(link.child);
    let o = at;
    while (escapedAt < to && rawAt < size) {
      const raw = this.readLogicalSync(
        link.child,
        rawAt,
        Math.min(size, rawAt + ESCAPE_BLOCK_BYTES),
      );
      // Skip the raw bytes whose escaped form ends before `from`.
      let skip = 0;
      if (escapedAt < from) {
        const fit = rawBytesFitting(raw, 0, raw.byteLength, from - escapedAt);
        skip = fit.raw;
        escapedAt += fit.escaped;
        if (escapedAt < from) {
          // `from` splits an escape sequence: emit the tail of that sequence.
          const one = new Uint8Array(6);
          const n = escapeInto(raw, skip, skip + 1, one, 0);
          const cut = from - escapedAt;
          const take = Math.min(n - cut, to - from);
          out.set(one.subarray(cut, cut + take), o);
          o += take;
          escapedAt += n;
          skip++;
        }
      }
      const fit = rawBytesFitting(raw, skip, raw.byteLength, to - escapedAt);
      o = escapeInto(raw, skip, skip + fit.raw, out, o);
      escapedAt += fit.escaped;
      if (skip + fit.raw < raw.byteLength && escapedAt < to) {
        // `to` splits an escape sequence: emit its head.
        const one = new Uint8Array(6);
        escapeInto(raw, skip + fit.raw, skip + fit.raw + 1, one, 0);
        const take = to - escapedAt;
        out.set(one.subarray(0, take), o);
        o += take;
        escapedAt += take;
        break;
      }
      rawAt += raw.byteLength;
    }
    return o;
  }

  /** Document-logical [start, end) cut into piece runs and overlay runs, in order. */
  private *segments(
    doc: Doc,
    start: number,
    end: number,
  ): Generator<
    | { readonly kind: "pieces"; readonly from: number; readonly to: number }
    | {
        readonly kind: "overlay";
        readonly link: ChildLink;
        readonly from: number;
        readonly to: number;
      }
  > {
    let docAt = 0; // document-logical position reached
    let pieceAt = 0; // piece-logical position reached
    for (const overlay of this.overlays(doc)) {
      // Plain pieces up to the overlay's content start.
      const plainDocEnd = docAt + (overlay.start - pieceAt);
      const from = Math.max(start, docAt);
      const to = Math.min(end, plainDocEnd);
      if (to > from)
        yield { kind: "pieces", from: pieceAt + (from - docAt), to: pieceAt + (to - docAt) };
      docAt = plainDocEnd;
      pieceAt = overlay.start;
      // The overlay, in escaped coordinates.
      const overlayDocEnd = docAt + overlay.escaped;
      const oFrom = Math.max(start, docAt);
      const oTo = Math.min(end, overlayDocEnd);
      if (oTo > oFrom)
        yield { kind: "overlay", link: overlay.link, from: oFrom - docAt, to: oTo - docAt };
      docAt = overlayDocEnd;
      pieceAt = overlay.end;
    }
    const tailDocEnd = docAt + (doc.pieces.size - pieceAt);
    const from = Math.max(start, docAt);
    const to = Math.min(end, tailDocEnd);
    if (to > from)
      yield { kind: "pieces", from: pieceAt + (from - docAt), to: pieceAt + (to - docAt) };
  }

  /** Document-logical bytes of any doc, reading the top-level file through its source. */
  private async readLogical(doc: Doc, start: number, end: number): Promise<Uint8Array> {
    if (end - start > MAX_SLICE_BYTES)
      throw new SliceTooLargeError({ bytes: end - start, limit: MAX_SLICE_BYTES });
    const out = new Uint8Array(end - start);
    let written = 0;
    for (const segment of this.segments(doc, start, end)) {
      if (segment.kind === "pieces") {
        const bytes = await this.readPieces(doc, segment.from, segment.to);
        out.set(bytes, written);
        written += bytes.byteLength;
      } else written = this.escapeOverlayInto(segment.link, segment.from, segment.to, out, written);
    }
    return out.subarray(0, written);
  }

  /** Document-logical offset → piece-logical offset; an offset inside an overlay reports which. */
  private toPieceLogical(doc: Doc, at: number): { at: number; inside: ChildLink | null } {
    let docAt = 0;
    let pieceAt = 0;
    for (const overlay of this.overlays(doc)) {
      const plainLen = overlay.start - pieceAt;
      if (at <= docAt + plainLen) return { at: pieceAt + (at - docAt), inside: null };
      docAt += plainLen;
      pieceAt = overlay.start;
      if (at < docAt + overlay.escaped) return { at: overlay.start, inside: overlay.link };
      docAt += overlay.escaped;
      pieceAt = overlay.end;
    }
    return { at: pieceAt + (at - docAt), inside: null };
  }

  /** Gives the workers the doc's append buffer when it has grown past what they hold. */
  private async syncAppend(doc: Doc) {
    const append = doc.append;
    // Shared chunks are live once handed over; copied ones go stale with every append.
    const shared = typeof SharedArrayBuffer === "function";
    const stale =
      doc.sharedChunks !== append.chunks.length || (!shared && doc.sharedLength !== append.length);
    if (!stale) return;
    await doc.owner.pool.broadcast({
      type: "open",
      sourceId: doc.appendSourceId,
      spec: {
        kind: "append",
        chunks: append.chunks.map((chunk) => chunk.buffer),
        chunkBytes: append.chunkBytes,
        length: append.length,
      },
    });
    doc.sharedChunks = append.chunks.length;
    doc.sharedLength = append.length;
  }

  /** Opens a worker-side source over piece-logical [start, end) of the doc; the caller closes it. */
  private async openWindow(doc: Doc, start: number, end: number) {
    await this.syncAppend(doc);
    const sourceId = doc.owner.nextSourceId++;
    await doc.owner.pool.broadcast({
      type: "open",
      sourceId,
      spec: {
        kind: "pieces",
        pieces: packPieces(doc.pieces.slices(start, end)),
        buffers: [doc.appendSourceId, doc.originalSourceId, ...doc.spills.map((s) => s.sourceId)],
      },
    });
    return sourceId;
  }

  /**
   * Opens a worker-side source over the document-logical bytes of a doc: its
   * pieces, with every dirty nested document re-escaped in place, so a job over
   * it reads exactly what a save would write. The caller closes the window.
   */
  private async openLogicalWindow(doc: Doc) {
    await this.syncAppend(doc);
    const document = doc.owner;
    const buffers = [
      doc.appendSourceId,
      doc.originalSourceId,
      ...doc.spills.map((s) => s.sourceId),
    ];
    const pieces: Piece[] = [];
    const opened: number[] = [];
    for (const segment of this.segments(doc, 0, this.docSize(doc))) {
      if (segment.kind === "pieces") {
        for (const piece of doc.pieces.slices(segment.from, segment.to)) pieces.push(piece);
        continue;
      }
      // The whole escaped child, in memory: a dirty child is bounded by MAX_SLICE_BYTES of raw bytes.
      const length = this.escapedOf(segment.link).length;
      const escaped = new Uint8Array(
        typeof SharedArrayBuffer === "function"
          ? new SharedArrayBuffer(length)
          : new ArrayBuffer(length),
      );
      this.escapeOverlayInto(segment.link, 0, length, escaped, 0);
      const sourceId = document.nextSourceId++;
      await document.pool.broadcast({
        type: "open",
        sourceId,
        spec: { kind: "memory", buffer: escaped.buffer, byteOffset: 0, byteLength: length },
      });
      opened.push(sourceId);
      pieces.push({
        buffer: buffers.length,
        start: segment.from,
        length: segment.to - segment.from,
      });
      buffers.push(sourceId);
    }
    const sourceId = document.nextSourceId++;
    await document.pool.broadcast({
      type: "open",
      sourceId,
      spec: { kind: "pieces", pieces: packPieces(pieces), buffers },
    });
    opened.push(sourceId);
    return {
      sourceId,
      close: () => {
        for (const id of opened.toReversed()) this.closeSource(document, id);
      },
    };
  }

  /**
   * Where a transform's output goes: a journal spill file backed by a worker-readable
   * Blob (directly from OPFS when the store provides one, or mirrored to an OPFS
   * scratch file with memory fallback), or an OPFS/memory scratch Blob when unjournaled.
   */
  private async createSpill(doc: Doc): Promise<SpillWriter> {
    const document = doc.owner;
    const journal = document.journal;
    if (journal && journal.store.blob) {
      const name = journal.newSpill();
      let length = 0;
      return {
        sink: {
          write: async (bytes) => {
            await journal.appendSpill(name, bytes);
            length += bytes.byteLength;
          },
          close: () => Promise.resolve(),
          abort: () => journal.store.remove(journal.spillPath(name)),
        },
        finish: async () => ({
          pieces: await this.attachSpill(doc, name, length),
          length,
          src: name,
        }),
        abort: () => journal.store.remove(journal.spillPath(name)),
      };
    }
    const scratch = await openSpillScratch();
    const name = journal ? journal.newSpill() : undefined;
    let length = 0;
    const journalSink: Sink | null =
      journal && name !== undefined
        ? {
            write: (bytes) => journal.appendSpill(name, bytes),
            close: () => journal.store.close(journal.spillPath(name)),
            abort: () => journal.store.remove(journal.spillPath(name)),
          }
        : null;
    const rawSink = journalSink ? teeSink(journalSink, scratch.sink) : scratch.sink;
    return {
      sink: {
        write: async (bytes) => {
          await rawSink.write(bytes);
          length += bytes.byteLength;
        },
        close: () => rawSink.close(),
        abort: () => rawSink.abort(),
      },
      finish: async () => {
        await rawSink.close();
        const blob = await scratch.finish();
        const sourceId = document.nextSourceId++;
        await document.pool.broadcast({ type: "open", sourceId, spec: { kind: "blob", blob } });
        const index = 2 + doc.spills.length;
        doc.spills.push({ source: blobSource(blob), sourceId, release: scratch.release });
        return {
          pieces: length > 0 ? [{ buffer: index, start: 0, length }] : [],
          length,
          src: name,
        };
      },
      abort: async () => {
        await rawSink.abort().catch(() => {});
        await scratch.release().catch(() => {});
      },
    };
  }

  /** Registers a journal spill file as a worker-readable buffer of the doc and returns its piece. */
  private async attachSpill(doc: Doc, name: string, length: number): Promise<Piece[]> {
    const document = doc.owner;
    const journal = document.journal as Journal;
    const path = journal.spillPath(name);
    await journal.store.close(path);
    let blob = journal.store.blob ? await journal.store.blob(path) : null;
    let release: (() => Promise<void>) | undefined;
    if (!blob) {
      const store = journal.store;
      const mirrored = await mirrorSourceToSpillBlob(
        { read: (start, end) => store.read(path, start, end) },
        length,
      );
      blob = mirrored.blob;
      release = mirrored.release;
    }
    const source = blobSource(blob);
    const sourceId = document.nextSourceId++;
    await document.pool.broadcast({ type: "open", sourceId, spec: { kind: "blob", blob } });
    const index = 2 + doc.spills.length;
    doc.spills.push({ source, sourceId, release });
    return length > 0 ? [{ buffer: index, start: 0, length }] : [];
  }

  private closeSource(document: OpenDocument, sourceId: number) {
    void document.pool.broadcast({ type: "closeSource", sourceId }).catch(() => {});
  }

  /**
   * The document and tape a request reads. While the index runs, a token already
   * on the tape answers from the merged prefix: always when the caller takes a
   * container as it stands (`partial`, its end and child count are a lower
   * bound), and otherwise only when no later region can still change it.
   */
  private async settled(ref: NodeRef, partial = false) {
    const document = this.document(ref.documentId);
    const live = document.live;
    const onPrefix =
      !document.replayPending &&
      !live.done &&
      ref.tapeId === 0 &&
      ref.token < (document.tapes.get(0) as TapeRecord).tape.count &&
      (partial || !live.unsettled.has(ref.token));
    if (!onPrefix) await this.ready(document);
    const record = document.tapes.get(ref.tapeId);
    if (!record || ref.token >= record.tape.count) throw new NodeNotFoundError({ ref });
    return this.resolve(document, record, ref.token, ref);
  }

  /**
   * A token under an edited region of its level is dead; the region's own token
   * is answered from its side tape, so a view may keep the ref of a node it
   * edited, at any level.
   */
  private resolve(document: OpenDocument, record: TapeRecord, token: number, ref: NodeRef) {
    let tapeId = ref.tapeId;
    for (;;) {
      const level = record.level;
      const region =
        tapeId === level.tapeId
          ? level.regions.regionOf(token)
          : this.bucketRegionOf(level, record.tape, token);
      if (region) {
        const side = this.sideRecord(document, level, region);
        if (!side) break;
        // The side tape's root may itself have been re-indexed below: keep descending.
        tapeId = level.sideTapes.get(region.token) as number;
        record = side;
        token = 0;
        continue;
      }
      if (level.regions.containing(record.tape.start(token))) throw new NodeNotFoundError({ ref });
      break;
    }
    return { document, record, token, tapeId };
  }

  /** The region a bucket tape's token stands for: the one whose span is exactly the token's. */
  private bucketRegionOf(level: Level, tape: Tape, token: number): Region | undefined {
    const start = regionStart(tape, token);
    const inside = level.regions.containing(start);
    return inside !== undefined &&
      inside.token < 0 &&
      inside.fileStart === start &&
      inside.fileEnd === tape.end(token)
      ? inside
      : undefined;
  }

  private summary(
    document: OpenDocument,
    tapeId: number,
    record: TapeRecord,
    token: number,
  ): NodeSummary {
    const resolved = this.resolve(document, record, token, {
      documentId: document.id,
      tapeId,
      token,
    });
    const tape = resolved.record.tape;
    const t = resolved.token;
    const kind = tape.kind(t);
    const keyStart = tape.keyStart(t);
    const childCount = this.visibleChildren(document, resolved.record, t, tape.childCount(t));
    const start = tape.start(t);
    // A container still open while the index runs has no end on the tape yet; its start is
    // the lower bound the contract allows for an unsettled node (end is never before start).
    const end = Math.max(tape.end(t), start);
    const doc = resolved.record.doc;
    const live = document.live;
    return {
      ref: { documentId: document.id, tapeId: resolved.tapeId, token: t },
      kind: KIND_NAMES[kind] as NodeKind,
      range: { start, end },
      span: {
        start: this.docLogical(doc, this.pieceLogical(resolved.record, start)),
        end: this.docLogical(doc, this.pieceLogical(resolved.record, end)),
      },
      key: hasKey(keyStart) ? keyStart : null,
      childCount,
      childrenIndexed: !isContainer(kind) || childCount === 0 || firstChild(tape, t) >= 0,
      settled: resolved.tapeId !== 0 || live.done || !live.unsettled.has(t),
    };
  }

  /**
   * Where the document's own tape stops being trusted: the first byte that is not
   * JSON. What the recovering scan read past it is guesswork (fragments of a
   * quoted word as keys), so nodes that start there are left out of every
   * listing. Only the main tape and its buckets are in file offsets; side tapes
   * and nested documents have their own.
   */
  private cutOf(document: OpenDocument, record: TapeRecord): number | null {
    if (document.syntax === null || record.doc !== document.doc) return null;
    return record.level === document.doc.top ? document.syntax.offset : null;
  }

  private readonly visibleCounts = new WeakMap<TapeRecord, Map<number, number>>();

  /** A container's children that start before the cut; `total` when there is no cut. */
  private visibleChildren(
    document: OpenDocument,
    record: TapeRecord,
    token: number,
    total: number,
  ): number {
    const cut = this.cutOf(document, record);
    const tape = record.tape;
    if (cut === null || total === 0 || tape.end(token) <= cut) return total;
    if (tape.start(token) >= cut) return 0;
    let counts = this.visibleCounts.get(record);
    if (counts === undefined) {
      counts = new Map();
      this.visibleCounts.set(record, counts);
    }
    const known = counts.get(token);
    if (known !== undefined) return known;
    let visible = 0;
    if (firstChild(tape, token) >= 0) {
      for (let c = firstChild(tape, token); c >= 0 && tape.start(c) < cut; c = tape.next(c)) {
        visible++;
      }
    } else {
      // Children in on-demand buckets: count to the last bucket that starts before the cut.
      const anchors = record.anchors.get(token);
      if (anchors !== undefined) {
        for (let b = 0; b < anchors.offset.length && (anchors.offset[b] as number) < cut; b++) {
          visible = anchors.index[b] as number;
        }
      }
    }
    counts.set(token, Math.min(visible, total));
    return Math.min(visible, total);
  }

  /**
   * The root as soon as region 0 is on the tape, so the first paint does not wait
   * for the whole index: its `end` and `childCount` keep growing until the
   * `indexProgress` event says `done`, and `node` on the same ref then returns
   * the settled summary.
   */
  private async root(documentId: number): Promise<NodeSummary> {
    const document = this.document(documentId);
    await document.firstRegion;
    const record = document.tapes.get(0) as TapeRecord;
    if (record.tape.count === 0)
      throw new NodeNotFoundError({ ref: { documentId, tapeId: 0, token: 0 } });
    return this.summary(document, 0, record, 0);
  }

  private async node(ref: NodeRef): Promise<NodeSummary> {
    const { document, record, token, tapeId } = await this.settled(ref);
    return this.summary(document, tapeId, record, token);
  }

  private async children(
    ref: NodeRef,
    from: number,
    count: number,
  ): Promise<EngineResult["children"]> {
    const page = await this.childrenUncut(ref, from, count);
    const { document, record, token } = await this.settled(ref, true);
    const cut = this.cutOf(document, record);
    if (cut === null) return page;
    const visible = this.visibleChildren(document, record, token, page.total);
    return {
      from,
      total: visible,
      nodes: page.nodes.filter((node, k) => from + k < visible && node.range.start < cut),
    };
  }

  private async childrenUncut(
    ref: NodeRef,
    from: number,
    count: number,
  ): Promise<EngineResult["children"]> {
    const { document, record, token, tapeId } = await this.settled(ref, true);
    const tape = record.tape;
    let total = isContainer(tape.kind(token)) ? tape.childCount(token) : 0;
    // Children cut off the tape are served from anchors that only exist once the index is done.
    if (total > 0 && !document.live.done && firstChild(tape, token) < 0) {
      await this.ready(document);
      total = tape.childCount(token);
    }
    const nodes: NodeSummary[] = [];
    if (from >= total) return { from, total, nodes };
    const wanted = Math.min(count, total - from);
    if (firstChild(tape, token) >= 0) {
      const gather = () => {
        const page: NodeSummary[] = [];
        let child = this.skipTo(record, token, from);
        while (child >= 0 && page.length < wanted) {
          page.push(this.summary(document, tapeId, record, child));
          child = tape.next(child);
        }
        return page;
      };
      let page = gather();
      // A container may be served short and still growing (it says so), but the byte
      // range of a string or number the boundary cut is not an answer yet.
      if (!document.live.done && page.some((n) => !n.settled && !isContainerKind(n.kind))) {
        await this.ready(document);
        page = gather();
      }
      return { from, total: Math.max(total, tape.childCount(token)), nodes: page };
    }
    const anchors = record.anchors.get(token);
    if (!anchors || anchors.index.length === 0) return { from, total, nodes };
    let bucket = upperBound(anchors.index, from) - 1;
    let skip = from - (anchors.index[bucket] as number);
    while (nodes.length < wanted && bucket < anchors.index.length) {
      const bucketTapeId = await this.bucketTape(document, tapeId, record, token, bucket);
      const bucketRecord = document.tapes.get(bucketTapeId) as TapeRecord;
      let root = bucketRecord.tape.count > 0 ? 0 : -1;
      for (let s = 0; s < skip && root >= 0; s++) root = bucketRecord.tape.next(root);
      while (root >= 0 && nodes.length < wanted) {
        nodes.push(this.summary(document, bucketTapeId, bucketRecord, root));
        root = bucketRecord.tape.next(root);
      }
      bucket++;
      skip = 0;
    }
    return { from, total, nodes };
  }

  /** The `from`-th on-tape child of `token`, through a skip list of every page-sized step. */
  private skipTo(record: TapeRecord, token: number, from: number) {
    const tape = record.tape;
    let skips = record.childSkips.get(token);
    if (!skips) {
      skips = [firstChild(tape, token)];
      record.childSkips.set(token, skips);
    }
    const step = Math.floor(from / CHILDREN_PAGE_LIMIT);
    while (skips.length <= step) {
      let child = skips[skips.length - 1] as number;
      for (let s = 0; s < CHILDREN_PAGE_LIMIT && child >= 0; s++) child = tape.next(child);
      if (child < 0) break;
      skips.push(child);
    }
    let child = skips[Math.min(step, skips.length - 1)] as number;
    let at = Math.min(step, skips.length - 1) * CHILDREN_PAGE_LIMIT;
    while (at < from && child >= 0) {
      child = tape.next(child);
      at++;
    }
    return child;
  }

  private async bucketTape(
    document: OpenDocument,
    ownerTapeId: number,
    record: TapeRecord,
    token: number,
    bucket: number,
  ) {
    let perContainer = record.buckets.get(token);
    const cached = perContainer?.get(bucket);
    if (cached !== undefined) return cached;
    const anchors = record.anchors.get(token) as BucketAnchors;
    const tape = record.tape;
    const start = anchors.offset[bucket] as number;
    const end =
      bucket + 1 < anchors.offset.length
        ? (anchors.offset[bucket + 1] as number)
        : tape.end(token) - 1;
    const result = await document.pool.call<IndexRangeResult>(bucket % document.pool.size, {
      type: "indexRange",
      sourceId: record.sourceId,
      start,
      end,
      entry: insideEntry(tape.kind(token)),
      maxDepth: FULL_DEPTH,
    });
    const tapeId = document.nextTapeId++;
    document.tapes.set(tapeId, {
      doc: record.doc,
      tape: tapeFromBuffers(result.buffers),
      source: record.source,
      sourceId: record.sourceId,
      size: record.size,
      level: record.level,
      anchors: new Map(),
      bigStrings: result.bigStrings,
      buckets: new Map(),
      childSkips: new Map(),
      hints: new Map(),
    });
    if (!perContainer) {
      perContainer = new Map();
      record.buckets.set(token, perContainer);
    }
    perContainer.set(bucket, tapeId);
    document.bucketOrder.push({ tapeId, ownerTapeId, owner: record, token, bucket });
    this.trimBuckets(document);
    return tapeId;
  }

  /** Drops the oldest bucket tapes past the cache size, unless a path query holds them. */
  private trimBuckets(document: OpenDocument) {
    while (document.bucketPins === 0 && document.bucketOrder.length > this.bucketCache) {
      const oldest = document.bucketOrder.shift();
      if (!oldest) break;
      this.dropTape(document, oldest.tapeId);
      oldest.owner.buckets.get(oldest.token)?.delete(oldest.bucket);
    }
  }

  /** Forgets a tape and every nested document expanded from one of its strings. */
  private dropTape(document: OpenDocument, tapeId: number) {
    const record = document.tapes.get(tapeId);
    if (!record) return;
    document.tapes.delete(tapeId);
    for (const [key, link] of record.doc.children) {
      if (link.tapeId === tapeId) {
        record.doc.children.delete(key);
        this.dropDoc(link.child);
      }
    }
    for (const perContainer of record.buckets.values()) {
      for (const bucketId of perContainer.values()) this.dropTape(document, bucketId);
    }
  }

  /** A nested document is gone: its tapes, sources and history entries with it. */
  private dropDoc(doc: Doc) {
    const document = doc.owner;
    this.dropLevel(document, doc.top);
    this.dropTape(document, doc.rootTapeId);
    for (const link of doc.children.values()) this.dropDoc(link.child);
    this.closeSource(document, doc.originalSourceId);
    this.closeSource(document, doc.appendSourceId);
    const keep = (entry: HistoryEntry) => entry.docTapeId !== doc.rootTapeId;
    document.undoStack.splice(0, document.undoStack.length, ...document.undoStack.filter(keep));
    document.redoStack.splice(0, document.redoStack.length, ...document.redoStack.filter(keep));
  }

  private read(record: TapeRecord, start: number, end: number) {
    if (end - start > MAX_SLICE_BYTES)
      throw new SliceTooLargeError({ bytes: end - start, limit: MAX_SLICE_BYTES });
    return record.source.read(start, Math.min(end, record.size));
  }

  private scalar(ref: NodeRef, record: TapeRecord, token: number) {
    const kind = record.tape.kind(token);
    if (isContainer(kind)) throw new NodeNotFoundError({ ref });
    return kind;
  }

  /**
   * A page of children with their keys and previews. One slice from the
   * container's start covers the rows inside the window; a row whose key or
   * value lies beyond it is read on its own, bounded by `previewBytes`.
   */
  private async rows(
    ref: NodeRef,
    from: number,
    count: number,
    previewBytes: number,
    windowBytes = ROWS_WINDOW_BYTES,
  ): Promise<EngineResult["rows"]> {
    const page = await this.children(ref, from, count);
    const { document, record, token } = await this.settled(ref, true);
    const base = record.tape.start(token);
    const containerEnd = record.tape.end(token);
    const windowEnd = Math.min(containerEnd, base + windowBytes, record.size);
    const window = windowEnd > base ? await this.read(record, base, windowEnd) : null;
    const rows: RowSummary[] = [];
    for (const node of page.nodes) {
      const childRecord = document.tapes.get(node.ref.tapeId) ?? record;
      // An edited member lives on its region's side tape, in that tape's own offsets: the
      // container's window only answers children in the container's byte space.
      const shared = childRecord.sourceId === record.sourceId ? window : null;
      let key: string | null = null;
      if (node.key !== null) {
        const keyEnd =
          shared !== null && node.key >= base && node.key < windowEnd
            ? stringEnd(shared, node.key - base)
            : -1;
        key =
          shared !== null && keyEnd >= 0
            ? decodeString(shared, node.key - base, keyEnd, MAX_KEY_BYTES)
            : await this.keyAt(document, childRecord, node.key);
      }
      const preview = isContainerKind(node.kind)
        ? null
        : await this.previewOf(document, childRecord, node, previewBytes, shared, base, windowEnd);
      rows.push({ node, key, preview });
    }
    return { from: page.from, total: page.total, rows };
  }

  /**
   * A scalar's preview, from the window when the value (or a string's first
   * `previewBytes`) lies inside it, else from its own bounded read.
   */
  private async previewOf(
    document: OpenDocument,
    record: TapeRecord,
    node: NodeSummary,
    previewBytes: number,
    window: Uint8Array | null,
    base: number,
    windowEnd: number,
  ): Promise<TextValue> {
    const { start, end } = node.range;
    if (node.kind === "string") {
      const contentLength = end - start - 2;
      if (window !== null && start >= base) {
        if (end <= windowEnd && contentLength <= previewBytes) {
          return {
            text: decodeString(window, start - base, end - base, previewBytes),
            truncated: false,
            bytes: contentLength,
          };
        }
        if (start + 1 + previewBytes + PIECE_TAIL <= windowEnd) {
          const contentStart = start + 1;
          const decoded = unescapePiece(window, base, contentStart, contentStart + previewBytes);
          return {
            text: decodeUtf8(decoded.subarray(0, utf8Boundary(decoded, previewBytes))),
            truncated: true,
            bytes: contentLength,
          };
        }
      }
      return this.textOf(record, node.ref.tapeId, node.ref.token, previewBytes);
    }
    const length = end - start;
    const cut = Math.min(end, start + previewBytes);
    const bytes =
      window !== null && start >= base && cut <= windowEnd
        ? window.subarray(start - base, cut - base)
        : await this.read(record, start, cut);
    return { text: decodeUtf8(bytes, previewBytes), truncated: cut < end, bytes: length };
  }

  /** `log.entries` grouped the way the map draws a capture: each entry's host and page. */
  private async harEntries(
    documentId: number,
    from: number,
    count: number,
  ): Promise<EngineResult["harEntries"]> {
    const doc = this.document(documentId);
    const root = await this.root(documentId);
    const empty = { entries: null, from, total: 0, pages: [], items: [] };
    if (root.kind !== "object") return empty;
    const log = await this.member(root.ref, "log");
    if (log === null || log.node.kind !== "object") return empty;
    const pagesNode = await this.member(log.node.ref, "pages");
    const entriesNode = await this.member(log.node.ref, "entries");
    const pages: HarPageSummary[] = [];
    if (pagesNode !== null && pagesNode.node.kind === "array") {
      const list = await this.rows(pagesNode.node.ref, 0, CHILDREN_PAGE_LIMIT, 1);
      for (const page of list.rows) {
        if (page.node.kind !== "object") continue;
        const fields = await this.rows(
          page.node.ref,
          0,
          CHILDREN_PAGE_LIMIT,
          HAR_TEXT_PREVIEW_BYTES,
        );
        pages.push({
          ref: page.node.ref,
          id: stringField(fields.rows, "id"),
          title: stringField(fields.rows, "title"),
        });
      }
    }
    if (entriesNode === null || entriesNode.node.kind !== "array") {
      return { ...empty, pages };
    }
    const entries = await this.rows(entriesNode.node.ref, from, count, 1);
    // When clean and settled, extract the whole page in worker slices to avoid stalling Table opens.
    if (entries.rows.length > 0 && !this.isDirty(doc.doc) && doc.display?.sameOffsets !== true) {
      const slices: Array<{
        readonly index: number;
        readonly start: number;
        readonly end: number;
      }> = [];
      for (let i = 0; i < entries.rows.length; i++) {
        const r = entries.rows[i]!;
        if (r.node.kind !== "object" || !r.node.settled) continue;
        const len = r.node.span.end - r.node.span.start;
        if (len > 0 && len <= MAX_SLICE_BYTES) {
          slices.push({ index: i, start: r.node.span.start, end: r.node.span.end });
        }
      }
      if (slices.length > 0) {
        const shardCount = Math.min(Math.max(1, doc.pool.size), 4, slices.length);
        const perShard = Math.ceil(slices.length / shardCount);
        const byRowIdx = new Map<number, HarTableRawRow | null>();
        await Promise.all(
          Array.from({ length: shardCount }, async (_, workerId) => {
            const part = slices.slice(workerId * perShard, (workerId + 1) * perShard);
            if (part.length === 0) return;
            const res = await doc.pool.call<HarTableWindowResult>(workerId, {
              type: "harTableSlices",
              sourceId: DOCUMENT_SOURCE_ID,
              items: part,
            });
            for (let k = 0; k < part.length; k++) {
              byRowIdx.set(part[k]!.index, res.rows[k] ?? null);
            }
          }),
        );
        const fastItems: HarEntrySummary[] = [];
        for (let i = 0; i < entries.rows.length; i++) {
          const entry = entries.rows[i]!;
          const raw = byRowIdx.get(i) ?? null;
          if (raw !== null) {
            fastItems.push({
              ref: entry.node.ref,
              host: hostOf(raw.url),
              pageref: raw.pageref,
              method: raw.method,
              url: raw.url,
              status: raw.status,
            });
          } else {
            fastItems.push(await this.harEntry(entry));
          }
        }
        return {
          entries: entriesNode.node.ref,
          from: entries.from,
          total: entries.total,
          pages,
          items: fastItems,
        };
      }
    }
    // Fallback for incremental indexing, JSONC, or edited captures.
    const items: HarEntrySummary[] = [];
    for (let at = 0; at < entries.rows.length; at += HAR_ENTRY_CONCURRENCY) {
      const batch = entries.rows.slice(at, at + HAR_ENTRY_CONCURRENCY);
      items.push(...(await Promise.all(batch.map((entry) => this.harEntry(entry)))));
    }
    return {
      entries: entriesNode.node.ref,
      from: entries.from,
      total: entries.total,
      pages,
      items,
    };
  }

  private async harEntry(entry: RowSummary): Promise<HarEntrySummary> {
    if (entry.node.kind !== "object") {
      return {
        ref: entry.node.ref,
        host: null,
        pageref: null,
        method: null,
        url: null,
        status: null,
      };
    }
    const fields = await this.rows(
      entry.node.ref,
      0,
      CHILDREN_PAGE_LIMIT,
      HAR_TEXT_PREVIEW_BYTES,
      HAR_ENTRY_WINDOW_BYTES,
    );
    const request = fields.rows.find((row) => row.key === "request" && row.node.kind === "object");
    const response = fields.rows.find(
      (row) => row.key === "response" && row.node.kind === "object",
    );
    let url: string | null = null;
    let method: string | null = null;
    let status: number | null = null;
    if (request) {
      const requestFields = await this.rows(
        request.node.ref,
        0,
        CHILDREN_PAGE_LIMIT,
        HAR_TEXT_PREVIEW_BYTES,
        HAR_REQUEST_WINDOW_BYTES,
      );
      url = stringField(requestFields.rows, "url");
      method = stringField(requestFields.rows, "method");
    }
    if (response) {
      const responseFields = await this.rows(
        response.node.ref,
        0,
        CHILDREN_PAGE_LIMIT,
        HAR_TEXT_PREVIEW_BYTES,
        HAR_REQUEST_WINDOW_BYTES,
      );
      const row = responseFields.rows.find((candidate) => candidate.key === "status");
      if (row && row.node.kind === "number" && row.preview !== null) {
        status = Number(row.preview.text);
      }
    }
    return {
      ref: entry.node.ref,
      host: hostOf(url),
      pageref: stringField(fields.rows, "pageref"),
      method,
      url,
      status,
    };
  }

  /** The member of an object named `key`, or null. */
  private async member(ref: NodeRef, key: string): Promise<RowSummary | null> {
    let from = 0;
    for (;;) {
      const page = await this.rows(ref, from, CHILDREN_PAGE_LIMIT, 1);
      const hit = page.rows.find((row) => row.key === key);
      if (hit) return hit;
      from += page.rows.length;
      if (page.rows.length === 0 || from >= page.total) return null;
    }
  }

  /** A member key read on its own: a small window first, widened while the closing quote is missing. */
  private async keyAt(document: OpenDocument, record: TapeRecord, keyStart: number) {
    let span = 256;
    for (;;) {
      const bytes = await this.read(record, keyStart, Math.min(record.size, keyStart + span + 2));
      const end = stringEnd(bytes, 0);
      if (end >= 0) return decodeString(bytes, 0, end, MAX_KEY_BYTES);
      if (span >= MAX_KEY_BYTES || keyStart + span + 2 >= record.size) {
        throw new SliceTooLargeError({ bytes: bytes.byteLength, limit: MAX_KEY_BYTES });
      }
      span = Math.min(MAX_KEY_BYTES, span * 16);
    }
  }

  /** The nested document expanded from this string, when it has been edited: its bytes are the string's content now. */
  private dirtyChild(record: TapeRecord, tapeId: number, token: number) {
    const link = record.doc.children.get(`${tapeId}:${token}`);
    return link && this.isDirty(link.child) ? link : undefined;
  }

  private async text(ref: NodeRef, limit: number): Promise<EngineResult["text"]> {
    checkedLimit(limit);
    const { record, token, tapeId } = await this.settled(ref);
    if (!isContainer(record.tape.kind(token))) return this.textOf(record, tapeId, token, limit);
    // A container's text, as the edits made inside it have left it.
    const span = this.logicalSpan(record, token);
    const size = span.end - span.start;
    const head = await this.readLogical(
      record.doc,
      span.start,
      Math.min(span.end, span.start + limit),
    );
    const cut = size > limit ? utf8Boundary(head, limit) : head.byteLength;
    return { text: decodeUtf8(head.subarray(0, cut), limit), truncated: size > limit, bytes: size };
  }

  /**
   * A node's span in its doc's document-logical bytes: where its text is with
   * every edit applied, including edits inside it and in nested documents under it.
   */
  private logicalSpan(record: TapeRecord, token: number) {
    const doc = record.doc;
    return {
      start: this.docLogical(doc, this.pieceLogical(record, record.tape.start(token))),
      end: this.docLogical(doc, this.pieceLogical(record, record.tape.end(token))),
    };
  }

  private async textOf(
    record: TapeRecord,
    tapeId: number,
    token: number,
    limit: number,
  ): Promise<EngineResult["text"]> {
    const kind = record.tape.kind(token);
    const start = record.tape.start(token);
    const end = record.tape.end(token);
    if (kind !== KIND_STRING) {
      const bytes = await this.read(record, start, Math.min(end, start + limit));
      return { text: decodeUtf8(bytes, limit), truncated: end - start > limit, bytes: end - start };
    }
    const dirty = this.dirtyChild(record, tapeId, token);
    if (dirty) {
      const size = this.docSize(dirty.child);
      const head = this.readLogicalSync(dirty.child, 0, Math.min(size, limit));
      const cut = size > limit ? utf8Boundary(head, limit) : head.byteLength;
      return {
        text: decodeUtf8(head.subarray(0, cut), limit),
        truncated: size > limit,
        bytes: size,
      };
    }
    const head = await this.unescapedHead(record, start + 1, end - 1, limit);
    return {
      text: decodeUtf8(head.bytes, limit),
      truncated: !head.complete,
      bytes: end - start - 2,
    };
  }

  /**
   * The first `limit` decoded bytes of a string's content, cut on a UTF-8
   * boundary, and whether that is all of it. The content is unescaped piece by
   * piece under the parallel-unescape rules: each piece's read (lookbehind,
   * piece, tail) stays within MAX_SLICE_BYTES, and only `limit` decoded bytes
   * are kept, however far the escapes shrink.
   */
  private async unescapedHead(
    record: TapeRecord,
    contentStart: number,
    contentEnd: number,
    limit: number,
  ): Promise<DecodedHead> {
    const pieces: Uint8Array[] = [];
    let decoded = 0;
    let at = contentStart;
    let from = contentStart;
    let held: Uint8Array = new Uint8Array(0);
    while (decoded < limit && at < contentEnd) {
      const pieceEnd = Math.min(contentEnd, at + Math.min(limit - decoded, PIECE_BYTES));
      from = Math.max(contentStart, at - PIECE_LOOKBEHIND);
      held = await this.read(record, from, Math.min(contentEnd, pieceEnd + PIECE_TAIL));
      const piece = unescapePiece(held, from, at, pieceEnd);
      pieces.push(piece);
      decoded += piece.byteLength;
      at = pieceEnd;
    }
    // What follows the last piece may be only the tail of an escape that piece already finished.
    const complete =
      decoded <= limit &&
      (at >= contentEnd ||
        (contentEnd - at <= PIECE_TAIL &&
          unescapePiece(held, from, at, contentEnd).byteLength === 0));
    const kept = Math.min(decoded, limit);
    const bytes = concat(pieces, kept);
    return { bytes: complete ? bytes : bytes.subarray(0, utf8Boundary(bytes, kept)), complete };
  }

  private async headText(documentId: number, bytes: number): Promise<EngineResult["headText"]> {
    const document = this.document(documentId);
    await this.ready(document);
    // An edited document shows its edits: the head is read through its pieces. A converted one shows the file.
    const display = document.display;
    const size = display ? display.source.size : this.docSize(document.doc);
    const end = Math.min(bytes, size);
    const head =
      end === 0
        ? new Uint8Array()
        : display
          ? await display.source.read(0, end)
          : await this.readLogical(document.doc, 0, end);
    return { text: decodeUtf8(head, bytes), truncated: size > end, bytes: size };
  }

  /** The byte range of a member's key in its tape's source: the quote through the closing quote. */
  private async keyRange(record: TapeRecord, token: number, ref: NodeRef) {
    const keyStart = record.tape.keyStart(token);
    if (!hasKey(keyStart)) throw new NodeNotFoundError({ ref });
    const bytes = await this.read(
      record,
      keyStart,
      Math.min(record.size, keyStart + MAX_KEY_BYTES + 2),
    );
    const end = stringEnd(bytes, 0);
    if (end < 0) throw new SliceTooLargeError({ bytes: bytes.byteLength, limit: MAX_KEY_BYTES });
    return { keyStart, keyEnd: keyStart + end, bytes: bytes.subarray(0, end) };
  }

  private async keyText(ref: NodeRef): Promise<string> {
    // A member's key is final as soon as its token is on the tape, whatever its value is doing.
    const { record, token } = await this.settled(ref, true);
    const key = await this.keyRange(record, token, ref);
    return decodeString(key.bytes, 0, key.bytes.byteLength, MAX_KEY_BYTES);
  }

  private async slice(
    documentId: number,
    tapeId: number,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    const document = this.document(documentId);
    await this.ready(document);
    const record = document.tapes.get(tapeId);
    if (!record) throw new NodeNotFoundError({ ref: { documentId, tapeId, token: 0 } });
    return (await this.read(record, start, end)).slice();
  }

  private async logicalSlice(
    documentId: number,
    tapeId: number,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    const document = this.document(documentId);
    await this.ready(document);
    const record = document.tapes.get(tapeId);
    if (!record) throw new NodeNotFoundError({ ref: { documentId, tapeId, token: 0 } });
    const size = this.docSize(record.doc);
    return (await this.readLogical(record.doc, Math.min(start, size), Math.min(end, size))).slice();
  }

  private searchSpec(query: SearchQuery): SearchSpec {
    if (query.mode === "literal") {
      let ascii = true;
      for (let i = 0; i < query.text.length && ascii; i++) ascii = query.text.charCodeAt(i) < 0x80;
      if (query.caseSensitive || ascii) {
        return {
          kind: "literal",
          needle: utf8.encode(query.text),
          caseSensitive: query.caseSensitive,
        };
      }
      // Non-ASCII text with case folded: the regex engine knows Unicode case folding.
      return { kind: "regex", source: escapeRegExp(query.text), flags: "iu" };
    }
    const spec: SearchSpec = {
      kind: "regex",
      source: query.text,
      flags: query.caseSensitive ? "u" : "iu",
    };
    try {
      compileRegex(spec);
    } catch (error) {
      throw new InvalidSearchPatternError({
        pattern: query.text,
        detail: error instanceof Error ? error.message : `${error as string}`,
      });
    }
    return spec;
  }

  private regexPool(document: OpenDocument): Promise<Pool> {
    document.regexPool ??= (async () => {
      const wanted = this.searchOptions.regexWorkers ?? REGEX_WORKERS;
      // One more than the search uses: the spare answers lighting requests meanwhile.
      const count = Math.max(2, Math.min(wanted, this.platform.workers) + 1);
      const pool = await this.platform.createPool(count);
      await pool.openEach(DOCUMENT_SOURCE_ID, document.bytes.workerSpec);
      return pool;
    })();
    return document.regexPool;
  }

  private chunkOptions(): ChunkOptions {
    return {
      ...DEFAULT_CHUNK_OPTIONS,
      maxHits: MAX_RETAINED_HITS,
      ...this.searchOptions.chunk,
    };
  }

  /**
   * What a search reads: the file, or for an edited document its logical bytes,
   * edits and dirty nested documents composed, so hits are where a save would put
   * them (docs/internals/document-engine.md, "Edits"). A recovered journal is
   * replayed before anything is searched.
   */
  private async searchView(document: OpenDocument): Promise<SearchView> {
    if (document.replayPending) await this.ready(document);
    const doc = document.doc;
    if (!this.isDirty(doc)) {
      return { sourceId: DOCUMENT_SOURCE_ID, size: document.size, close: null };
    }

    const window = await this.openLogicalWindow(doc);
    return { sourceId: window.sourceId, size: this.docSize(doc), close: window.close };
  }

  private dropSearch(document: OpenDocument, searchId: number) {
    document.searches.get(searchId)?.view.close?.();
    document.searches.delete(searchId);
  }

  private async search(documentId: number, query: SearchQuery): Promise<EngineResult["search"]> {
    const document = this.document(documentId);
    const spec = this.searchSpec(query);
    const regex = spec.kind === "regex";
    const view = await this.searchView(document);
    // An edited document's window is open on the main pool only, so a regex over it runs there.
    const onRegexPool = regex && view.close === null;
    const pool = onRegexPool ? await this.regexPool(document) : document.pool;
    const decode = document.format !== "text";
    const id = this.nextSearchId++;
    document.currentSearch = id;
    const outcome = await runSearch(
      pool,
      { sourceId: view.sourceId, size: view.size, decode },
      spec,
      {
        chunkBytes: regex
          ? (this.searchOptions.regexChunkBytes ?? REGEX_CHUNK_BYTES)
          : (this.searchOptions.literalChunkBytes ?? LITERAL_CHUNK_BYTES),
        chunk: this.chunkOptions(),
        budgetMs: regex ? (this.searchOptions.regexBudgetMs ?? REGEX_BUDGET_MS) : null,
        maxSkipped: REGEX_MAX_SKIPPED,
        maxRetained: MAX_RETAINED_HITS,
        // The spare worker of the regex pool is not part of the search.
        workers: onRegexPool ? pool.size - 1 : pool.size,
        isCancelled: () => document.currentSearch !== id,
      },
    );
    document.searches.set(id, { id, spec, decode, outcome, view });
    while (document.searches.size > SEARCH_RECORDS_KEPT) {
      const oldest = document.searches.keys().next();
      if (oldest.done) break;
      this.dropSearch(document, oldest.value);
    }
    return {
      searchId: id,
      count: outcome.count,
      retained: outcome.hits.length / 2,
      retainedUntil: outcome.retainedUntil,
      skipped: outcome.skipped.map((range) => ({ start: range.start, end: range.end })),
      limited: outcome.limited,
      status: outcome.status,
    };
  }

  /** Deep-decode search over `documentId`; keeps plain search zero-regression when off. */
  async deepSearch(documentId: number, query: DeepSearchQuery): Promise<DeepSearchSummary> {
    if (!query.deep) {
      const plain = await this.search(documentId, {
        mode: query.mode,
        text: query.text,
        caseSensitive: query.caseSensitive,
      });
      return { ...plain, annotations: [] };
    }
    const document = this.document(documentId);
    const spec = this.searchSpec({
      mode: query.mode,
      text: query.text,
      caseSensitive: query.caseSensitive,
    });
    const regex = spec.kind === "regex";
    const view = await this.searchView(document);
    const onRegexPool = regex && view.close === null;
    const pool = onRegexPool ? await this.regexPool(document) : document.pool;
    const decode = document.format !== "text";
    const id = this.nextSearchId++;
    document.currentSearch = id;
    const outcome = await runDeepSearch(
      pool,
      { sourceId: view.sourceId, size: view.size, decode },
      spec,
      {
        chunkBytes: regex
          ? (this.searchOptions.regexChunkBytes ?? REGEX_CHUNK_BYTES)
          : (this.searchOptions.literalChunkBytes ?? LITERAL_CHUNK_BYTES),
        chunk: this.chunkOptions(),
        budgetMs: regex ? (this.searchOptions.regexBudgetMs ?? REGEX_BUDGET_MS) : null,
        maxSkipped: REGEX_MAX_SKIPPED,
        maxRetained: MAX_RETAINED_HITS,
        workers: onRegexPool ? pool.size - 1 : pool.size,
        isCancelled: () => document.currentSearch !== id,
      },
    );
    document.searches.set(id, {
      id,
      spec,
      decode,
      outcome,
      view,
      annotations: outcome.annotations,
    });
    while (document.searches.size > SEARCH_RECORDS_KEPT) {
      const oldest = document.searches.keys().next();
      if (oldest.done) break;
      this.dropSearch(document, oldest.value);
    }
    return {
      searchId: id,
      count: outcome.count,
      retained: outcome.hits.length / 2,
      retainedUntil: outcome.retainedUntil,
      skipped: outcome.skipped.map((range) => ({ start: range.start, end: range.end })),
      limited: outcome.limited,
      status: outcome.status,
      annotations: outcome.annotations,
    };
  }

  /** Deep-search annotations overlapping `[from, to)`. */
  deepSearchAnnotations(
    documentId: number,
    searchId: number,
    from: number,
    to: number,
  ): ReadonlyArray<DeepHitAnnotation> {
    const { record } = this.searchRecord(documentId, searchId);
    const all = record.annotations ?? [];
    return all.filter((ann) => ann.range.end > from && ann.range.start < to);
  }

  /** Traces every exact whole-value occurrence of `request.value` across `documentId`. */
  async traceValue(documentId: number, request: TraceValueRequest): Promise<TraceResult> {
    const document = this.document(documentId);
    await document.indexed;
    const format = document.format === "har" ? "har" : document.format === "text" ? "text" : "json";
    return traceExactValue(
      {
        format,
        runDeepSearch: async (text) => {
          const spec = this.searchSpec({ mode: "literal", text, caseSensitive: true });
          const view = await this.searchView(document);
          try {
            return await runDeepSearch(
              document.pool,
              { sourceId: view.sourceId, size: view.size, decode: format !== "text" },
              spec,
              {
                chunkBytes: this.searchOptions.literalChunkBytes ?? LITERAL_CHUNK_BYTES,
                chunk: this.chunkOptions(),
                budgetMs: null,
                maxSkipped: REGEX_MAX_SKIPPED,
                maxRetained: MAX_RETAINED_HITS,
                workers: document.pool.size,
                isCancelled: () => false,
              },
            );
          } finally {
            view.close?.();
          }
        },
        nodeAt: (offset) => this.nodeAt(documentId, offset),
        readLogicalRange: async (start, end) =>
          (await this.readLogical(document.doc, start, end)).slice(),
        keyText: (ref) => this.keyText(ref),
        entryMeta: async (entryRef) => {
          const node = await this.node(entryRef);
          const summary = await this.harEntry({ node, key: null, preview: null });
          return { method: summary.method, url: summary.url, status: summary.status };
        },
      },
      request.value,
    );
  }

  private searchRecord(documentId: number, searchId: number) {
    const document = this.document(documentId);
    const record = document.searches.get(searchId);
    if (!record) throw new SearchNotFoundError({ searchId });
    return { document, record };
  }

  /** Index of the first retained hit that ends after `offset`. */
  private firstHitAfter(hits: Float64Array, offset: number) {
    let lo = 0;
    let hi = hits.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((hits[mid * 2 + 1] as number) <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Hits in `[from, to)` that lie past what the search retained, found by
   * scanning just that window. Serialized on the pool's spare worker, so a
   * burst of lighting requests cannot queue behind a running time budget.
   */
  private localHits(document: OpenDocument, record: SearchRecord, from: number, to: number) {
    const outcome = record.outcome;
    const end = Math.min(record.view.size, to, from + LOCAL_SCAN_MAX_BYTES);
    if (end <= from) return Promise.resolve<Array<readonly [number, number]>>([]);
    if (outcome.skipped.some((range) => range.start < end && range.end > from)) {
      return Promise.resolve<Array<readonly [number, number]>>([]);
    }
    const regex = record.spec.kind === "regex";
    const run = async () => {
      const pool =
        regex && record.view.close === null ? await this.regexPool(document) : document.pool;
      const worker = pool.size - 1;
      try {
        const result = await pool.call<ChunkResult>(
          worker,
          {
            type: "search",
            sourceId: record.view.sourceId,
            start: from,
            end,
            size: record.view.size,
            decode: record.decode,
            spec: record.spec,
            options: { ...this.chunkOptions(), maxHits: MAX_HIT_RANGES },
            resumeAt: null,
          },
          [],
          regex ? (this.searchOptions.regexBudgetMs ?? REGEX_BUDGET_MS) : null,
        );
        const found: Array<readonly [number, number]> = [];
        for (let i = 0; i < result.hits.length; i += 2) {
          found.push([result.hits[i] as number, result.hits[i + 1] as number]);
        }
        return found;
      } catch (error) {
        if (error instanceof BudgetExceededError) return [];
        throw error;
      }
    };
    const queued = document.localScans.then(run, run);
    document.localScans = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async searchHits(
    documentId: number,
    searchId: number,
    from: number,
    to: number,
    limit: number,
  ): Promise<EngineResult["searchHits"]> {
    const { document, record } = this.searchRecord(documentId, searchId);
    const { hits, retainedUntil } = record.outcome;
    const first = this.firstHitAfter(hits, from);
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = first; i < hits.length / 2 && ranges.length < limit; i++) {
      const start = hits[i * 2] as number;
      if (start >= to) break;
      ranges.push({ start, end: hits[i * 2 + 1] as number });
    }
    if (to > retainedUntil && ranges.length < limit) {
      const past = await this.localHits(document, record, Math.max(from, retainedUntil), to);
      for (const [start, end] of past) {
        if (ranges.length >= limit) break;
        if (end > from && start < to) ranges.push({ start, end });
      }
    }
    return { firstIndex: first, ranges };
  }

  private async searchLit(
    documentId: number,
    searchId: number,
    ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  ): Promise<ReadonlyArray<boolean>> {
    const { document, record } = this.searchRecord(documentId, searchId);
    const { hits, retainedUntil } = record.outcome;
    return Promise.all(
      ranges.map(async (range) => {
        if (range.end <= range.start) return false;
        const i = this.firstHitAfter(hits, range.start);
        if (i < hits.length / 2 && (hits[i * 2] as number) < range.end) return true;
        if (range.end <= retainedUntil) return false;
        const past = await this.localHits(
          document,
          record,
          Math.max(range.start, retainedUntil),
          range.end,
        );
        return past.some(([start, end]) => end > range.start && start < range.end);
      }),
    );
  }

  private searchHit(
    documentId: number,
    searchId: number,
    index: number,
  ): Promise<EngineResult["searchHit"]> {
    const { record } = this.searchRecord(documentId, searchId);
    const { hits } = record.outcome;
    const n = hits.length / 2;
    if (n === 0) return Promise.resolve(null);
    const at = ((index % n) + n) % n;
    return Promise.resolve({
      index: at,
      range: { start: hits[at * 2] as number, end: hits[at * 2 + 1] as number },
    });
  }

  private searchSeek(documentId: number, searchId: number, offset: number): Promise<number> {
    const { record } = this.searchRecord(documentId, searchId);
    const { hits } = record.outcome;
    const i = this.firstHitAfter(hits, offset);
    return Promise.resolve(i >= hits.length / 2 ? 0 : i);
  }

  private async pathQuery(
    documentId: number,
    path: string,
    limit: number,
  ): Promise<EngineResult["pathQuery"]> {
    const document = this.document(documentId);
    let expression: ReadonlyArray<Segment>;
    try {
      expression = parsePath(path);
    } catch (error) {
      if (error instanceof PathSyntaxError) {
        throw new InvalidPathError({ path, detail: error.message, at: error.at });
      }
      throw error;
    }
    await document.firstRegion;
    if (document.format === "text") {
      throw new NodeNotFoundError({ ref: { documentId, tapeId: 0, token: 0 } });
    }
    // Every step reads the finished tape; a path is not a first-paint query.
    await document.indexed;
    const state = { complete: true };
    if (this.indexMoved(document)) return this.pathQueryEdited(document, expression, limit, state);
    document.bucketPins++;
    try {
      let current: number[] = [packRef(0, 0)];
      for (const segment of expression) {
        current = await this.pathSegment(document, current, segment, state);
        if (current.length === 0) break;
      }
      const total = current.length;
      const results: EngineResult["pathQuery"]["results"][number][] = [];
      for (const packed of current.slice(0, limit)) {
        const { tapeId, token } = unpackRef(packed);
        const record = document.tapes.get(tapeId) as TapeRecord;
        const node = this.summary(document, tapeId, record, token);
        const scalar = node.kind !== "object" && node.kind !== "array";
        const preview = scalar ? (await this.text(node.ref, PATH_PREVIEW_BYTES)).text : "";
        results.push({
          node,
          label: await this.labelOf(node),
          preview,
          path: await this.pathTextOf(node),
        });
      }
      return { total, complete: state.complete, results };
    } finally {
      document.bucketPins--;
      this.trimBuckets(document);
    }
  }

  /**
   * A path over an edited document. The fast path finds `.name` candidates with
   * a text search of the file, which knows nothing of the edits, so here every
   * step lists children through the edit-aware `rows` instead, within the same
   * set limit.
   */
  private async pathQueryEdited(
    document: OpenDocument,
    expression: ReadonlyArray<Segment>,
    limit: number,
    state: { complete: boolean },
  ): Promise<EngineResult["pathQuery"]> {
    const root = await this.node({ documentId: document.id, tapeId: 0, token: 0 });
    let current: PathFound[] = [{ node: root, label: "" }];
    for (const segment of expression) {
      const inputs = segment.descendant ? await this.descendantsEdited(current, state) : current;
      const out: PathFound[] = [];
      for (const input of inputs) {
        for (const selector of segment.selectors) {
          if (out.length >= PATH_MAX_SET) state.complete = false;
          else await this.selectEdited(input.node, selector, out, state);
        }
      }
      current = out;
      if (current.length === 0) break;
    }
    const results: EngineResult["pathQuery"]["results"][number][] = [];
    for (const { node, label } of current.slice(0, limit)) {
      const preview = isContainerKind(node.kind)
        ? ""
        : (await this.text(node.ref, PATH_PREVIEW_BYTES)).text;
      results.push({ node, label, preview, path: await this.pathTextOf(node) });
    }
    return { total: current.length, complete: state.complete, results };
  }

  /** Children `[from, to)` of a container with their labels, a page at a time. */
  private async childrenFound(node: NodeSummary, from: number, to: number): Promise<PathFound[]> {
    const out: PathFound[] = [];
    for (let at = from; at < to;) {
      const page = await this.rows(node.ref, at, Math.min(CHILDREN_PAGE_LIMIT, to - at), 1);
      if (page.rows.length === 0) break;
      page.rows.forEach((row, i) => {
        out.push({ node: row.node, label: row.key ?? `[${at + i}]` });
      });
      at += page.rows.length;
    }
    return out;
  }

  private async selectEdited(
    node: NodeSummary,
    selector: Selector,
    out: PathFound[],
    state: { complete: boolean },
  ) {
    if (!isContainerKind(node.kind)) return;
    const count = node.childCount;
    switch (selector.kind) {
      case "filter": {
        const matched: NodeRef[] = [];
        await evalFilterSelector(
          this.pathFilterHost(node.ref.documentId),
          node.ref,
          selector.expr,
          matched,
          state,
          PATH_MAX_SET - out.length,
        );
        for (const ref of matched) {
          const child = await this.node(ref);
          out.push({ node: child, label: await this.labelOf(child) });
        }
        return;
      }
      case "wildcard":
        out.push(...(await this.childrenFound(node, 0, count)));
        return;
      case "name":
        if (node.kind !== "object") return;
        for (const child of await this.childrenFound(node, 0, count)) {
          if (child.label === selector.name) out.push(child);
        }
        return;
      case "index":
      case "slice": {
        if (node.kind !== "array") return;
        const wanted = selectedIndexes(selector, count);
        if (wanted.length === 0) return;
        const lo = Math.min(...wanted);
        const hi = Math.max(...wanted) + 1;
        const listed = await this.childrenFound(node, lo, hi);
        for (const index of wanted) {
          const child = listed[index - lo];
          if (child !== undefined) out.push(child);
        }
      }
    }
  }

  private async descendantsEdited(
    set: ReadonlyArray<PathFound>,
    state: { complete: boolean },
  ): Promise<PathFound[]> {
    const out: PathFound[] = [];
    const stack = set.toReversed();
    while (stack.length > 0) {
      if (out.length >= PATH_MAX_SET) {
        state.complete = false;
        break;
      }
      const found = stack.pop() as PathFound;
      out.push(found);
      if (!isContainerKind(found.node.kind) || found.node.childCount === 0) continue;
      const kids = await this.childrenFound(found.node, 0, found.node.childCount);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as PathFound);
    }
    return out;
  }

  /**
   * Where a node sits, as a path query would write it: `$.log.entries[3]['a b']`.
   * A path deeper than a node path can hold ends in `…`.
   */
  private async pathTextOf(node: NodeSummary): Promise<string> {
    const found = await this.nodeAt(node.ref.documentId, node.span.start);
    const at = found.path.findIndex(
      (step) => step.node.ref.tapeId === node.ref.tapeId && step.node.ref.token === node.ref.token,
    );
    const chain = at >= 0 ? found.path.slice(0, at + 1) : found.path;
    let text = "$";
    for (const step of chain.slice(1)) {
      if (step.node.key !== null) text += pathMember(await this.keyText(step.node.ref));
      else if (step.index !== null) text += `[${step.index}]`;
      else text += "[*]";
    }
    const whole = at >= 0 ? text : `${text}…`;
    return whole.length > MAX_PATH_TEXT_LENGTH
      ? `${whole.slice(0, MAX_PATH_TEXT_LENGTH - 1)}…`
      : whole;
  }

  /** The member key or `[index]` a node sits under; empty for a root. */
  private async labelOf(node: NodeSummary): Promise<string> {
    if (node.key !== null) return this.keyText(node.ref);
    if (node.range.start === 0 && node.ref.tapeId === 0 && node.ref.token === 0) return "";
    const path = await this.nodeAt(node.ref.documentId, node.range.start);
    const step = path.path.find(
      (candidate) =>
        candidate.node.ref.tapeId === node.ref.tapeId &&
        candidate.node.ref.token === node.ref.token,
    );
    return step?.index === null || step?.index === undefined ? "" : `[${step.index}]`;
  }

  private async pathSegment(
    document: OpenDocument,
    set: number[],
    segment: Segment,
    state: { complete: boolean },
  ): Promise<number[]> {
    const only = segment.selectors.length === 1 ? segment.selectors[0] : undefined;
    if (only !== undefined && only.kind === "name") {
      return this.nameStep(document, set, only.name, segment.descendant, state);
    }
    const inputs = segment.descendant ? await this.descendantsOrSelf(document, set, state) : set;
    const out: number[] = [];
    for (const node of inputs) {
      for (const selector of segment.selectors) {
        if (out.length >= PATH_MAX_SET) {
          state.complete = false;
          return out;
        }
        if (selector.kind === "name") {
          out.push(...(await this.nameStep(document, [node], selector.name, false, state)));
        } else {
          await this.selectChildren(document, node, selector, out, state);
        }
      }
    }
    return out;
  }

  private containerOf(document: OpenDocument, packed: number) {
    const { tapeId, token } = unpackRef(packed);
    const record = document.tapes.get(tapeId);
    if (!record) return null;
    const kind = record.tape.kind(token);
    return isContainer(kind) ? { tapeId, token, kind, record } : null;
  }

  /** Every child of a container, in pages. */
  private async allChildren(
    document: OpenDocument,
    node: { tapeId: number; token: number },
    from: number,
    to: number,
    out: number[],
    state: { complete: boolean },
  ) {
    const ref = { documentId: document.id, tapeId: node.tapeId, token: node.token };
    for (let at = from; at < to;) {
      if (out.length >= PATH_MAX_SET) {
        state.complete = false;
        return;
      }
      const page = await this.children(ref, at, Math.min(CHILDREN_PAGE_LIMIT, to - at));
      if (page.nodes.length === 0) return;
      for (const child of page.nodes) out.push(packRef(child.ref.tapeId, child.ref.token));
      at += page.nodes.length;
    }
  }

  private async descendantsOrSelf(
    document: OpenDocument,
    set: number[],
    state: { complete: boolean },
  ): Promise<number[]> {
    const out: number[] = [];
    const stack = set.toReversed();
    while (stack.length > 0) {
      if (out.length >= PATH_MAX_SET) {
        state.complete = false;
        break;
      }
      const node = stack.pop() as number;
      out.push(node);
      const container = this.containerOf(document, node);
      if (container === null) continue;
      const count = container.record.tape.childCount(container.token);
      if (count === 0) continue;
      const kids: number[] = [];
      await this.allChildren(document, container, 0, count, kids, state);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as number);
    }
    return out;
  }

  private pathFilterHost(documentId: number): PathFilterHost {
    return {
      rootRef: { documentId, tapeId: 0, token: 0 },
      nodeInfo: async (ref): Promise<PathNodeInfo> => {
        const n = await this.node(ref);
        return { ref: n.ref, kind: n.kind, childCount: n.childCount, key: null };
      },
      listChildren: async (ref, from, count, includeKeys): Promise<ReadonlyArray<PathNodeInfo>> => {
        if (includeKeys) {
          const page = await this.rows(ref, from, count, 1);
          return page.rows.map((r) => ({
            ref: r.node.ref,
            kind: r.node.kind,
            childCount: r.node.childCount,
            key: r.key,
          }));
        }
        const page = await this.children(ref, from, count);
        return page.nodes.map((n) => ({
          ref: n.ref,
          kind: n.kind,
          childCount: n.childCount,
          key: null,
        }));
      },
      member: async (ref, name): Promise<PathNodeInfo | null> => {
        const hit = await this.member(ref, name);
        return hit === null
          ? null
          : {
              ref: hit.node.ref,
              kind: hit.node.kind,
              childCount: hit.node.childCount,
              key: hit.key,
            };
      },
      readScalar: async (ref): Promise<FilterLiteral | null> => {
        const { record, token, tapeId } = await this.settled(ref);
        const kind = record.tape.kind(token);
        if (isContainer(kind)) return null;
        if (kind === KIND_NULL) return { kind: "null" };
        if (kind === KIND_TRUE) return { kind: "boolean", value: true };
        if (kind === KIND_FALSE) return { kind: "boolean", value: false };
        if (kind === KIND_NUMBER) {
          const res = await this.textOf(record, tapeId, token, 256);
          const value = Number(res.text);
          return Number.isFinite(value) ? { kind: "number", value } : null;
        }
        if (kind === KIND_STRING) {
          const res = await this.textOf(record, tapeId, token, MAX_SLICE_BYTES);
          return { kind: "string", value: res.text };
        }
        return null;
      },
    };
  }

  private async selectChildren(
    document: OpenDocument,
    node: number,
    selector: Exclude<Selector, { kind: "name" }>,
    out: number[],
    state: { complete: boolean },
  ) {
    if (selector.kind === "filter") {
      const { tapeId, token } = unpackRef(node);
      const matched: NodeRef[] = [];
      await evalFilterSelector(
        this.pathFilterHost(document.id),
        { documentId: document.id, tapeId, token },
        selector.expr,
        matched,
        state,
        PATH_MAX_SET - out.length,
      );
      for (const ref of matched) out.push(packRef(ref.tapeId, ref.token));
      return;
    }
    const container = this.containerOf(document, node);
    if (container === null) return;
    const count = container.record.tape.childCount(container.token);
    const isArray = container.kind === KIND_ARRAY;
    switch (selector.kind) {
      case "wildcard":
        await this.allChildren(document, container, 0, count, out, state);
        return;
      case "index": {
        if (!isArray) return;
        const at = selector.index < 0 ? count + selector.index : selector.index;
        if (at >= 0 && at < count)
          await this.allChildren(document, container, at, at + 1, out, state);
        return;
      }
      case "slice": {
        if (!isArray) return;
        const step = selector.step ?? 1;
        if (step === 0) return;
        const normalize = (value: number) => (value >= 0 ? value : count + value);
        const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
        let lower: number;
        let upper: number;
        if (step > 0) {
          const start = selector.start === null ? 0 : normalize(selector.start);
          const end = selector.end === null ? count : normalize(selector.end);
          lower = clamp(start, 0, count);
          upper = clamp(end, 0, count);
          if (step === 1) {
            if (upper > lower)
              await this.allChildren(document, container, lower, upper, out, state);
            return;
          }
          const wanted: number[] = [];
          for (let i = lower; i < upper; i += step) wanted.push(i);
          for (const i of wanted) await this.allChildren(document, container, i, i + 1, out, state);
          return;
        }
        const start = selector.start === null ? count - 1 : normalize(selector.start);
        const end = selector.end === null ? -count - 1 : normalize(selector.end);
        upper = clamp(start, -1, count - 1);
        lower = clamp(end, -1, count - 1);
        const wanted: number[] = [];
        for (let i = upper; lower < i; i += step) wanted.push(i);
        for (const i of wanted) await this.allChildren(document, container, i, i + 1, out, state);
      }
    }
  }

  /**
   * `.name` and `..name`: the members called `name` of the nodes in `set` (or of
   * their descendants). The candidates are the occurrences of `"name"` in the
   * text, found by the parallel search over the nodes' bytes (or the whole file
   * when there are many nodes); the tape then says which of them are keys, and
   * of which object. Nothing is listed child by child, so a key lookup in an
   * object of hundreds of MiB reads its bytes once, in parallel, and never
   * decodes a key it does not need.
   */
  private async nameStep(
    document: OpenDocument,
    set: number[],
    name: string,
    descendant: boolean,
    state: { complete: boolean },
  ): Promise<number[]> {
    const nodes = set.flatMap((packed) => {
      const container = this.containerOf(document, packed);
      if (container === null) return [];
      const { tape } = container.record;
      return [
        {
          packed,
          tapeId: container.tapeId,
          start: tape.start(container.token),
          end: tape.end(container.token),
        },
      ];
    });
    if (nodes.length === 0) return [];
    const ranges =
      nodes.length <= PATH_SMALL_SET ? disjointRanges(nodes) : [{ start: 0, end: document.size }];
    const needle = utf8.encode(`"${name}"`);
    const spec: SearchSpec = { kind: "literal", needle, caseSensitive: true };
    const candidates: number[] = [];
    for (const range of ranges) {
      if (range.end <= range.start) continue;
      const outcome = await runSearch(
        document.pool,
        {
          sourceId: DOCUMENT_SOURCE_ID,
          size: document.size,
          decode: true,
          start: range.start,
          end: range.end,
        },
        spec,
        {
          chunkBytes: PATH_CANDIDATE_CHUNK,
          chunk: { ...this.chunkOptions(), maxHits: PATH_MAX_SET },
          budgetMs: null,
          maxSkipped: 1,
          maxRetained: PATH_MAX_SET,
          workers: document.pool.size,
          isCancelled: () => false,
        },
      );
      if (outcome.count > outcome.hits.length / 2) state.complete = false;
      for (let i = 0; i < outcome.hits.length; i += 2) candidates.push(outcome.hits[i] as number);
    }

    // The candidates that are members, in file order (candidates arrive sorted).
    const tape0 = (document.tapes.get(0) as TapeRecord).tape;
    const members: Array<{ packed: number; parent: number; parentStart: number; key: number }> = [];
    for (const p of candidates) {
      const member = await this.memberAtKey(document, tape0, p);
      if (member === null) continue;
      const parent = this.parentOf(document, member.tapeId, member.token);
      if (parent === null) continue;
      const parentRecord = document.tapes.get(parent.tapeId) as TapeRecord;
      if (parentRecord.tape.kind(parent.token) !== KIND_OBJECT) continue;
      members.push({
        packed: packRef(member.tapeId, member.token),
        parent: packRef(parent.tapeId, parent.token),
        parentStart: parentRecord.tape.start(parent.token),
        key: p,
      });
    }
    const out: number[] = [];
    if (!descendant) {
      const byParent = new Map<number, number[]>();
      for (const member of members) {
        const list = byParent.get(member.parent);
        if (list === undefined) byParent.set(member.parent, [member.packed]);
        else list.push(member.packed);
      }
      for (const packed of set) {
        const list = byParent.get(packed);
        if (list !== undefined) out.push(...list);
      }
      return out;
    }
    // RFC 9535 order: input node by input node (a node nested in another is visited
    // again, as the RFC has it), and inside one, the descendants in document order.
    for (const node of nodes) {
      let lo = 0;
      let hi = members.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((members[mid] as { key: number }).key < node.start) lo = mid + 1;
        else hi = mid;
      }
      const inside: typeof members = [];
      for (let i = lo; i < members.length && (members[i] as { key: number }).key < node.end; i++) {
        inside.push(members[i] as (typeof members)[number]);
      }
      inside.sort((x, y) => x.parentStart - y.parentStart || x.key - y.key);
      for (const member of inside) out.push(member.packed);
    }
    return out;
  }

  /**
   * The container a token is a child of. A token with no parent on its own tape
   * is a root of a bucket tape, and its parent is the container the bucket was
   * cut from.
   */
  private parentOf(document: OpenDocument, tapeId: number, token: number) {
    const record = document.tapes.get(tapeId) as TapeRecord;
    const parent = record.tape.parent(token);
    if (parent >= 0) return { tapeId, token: parent };
    const entry = document.bucketOrder.find((candidate) => candidate.tapeId === tapeId);
    return entry === undefined ? null : { tapeId: entry.ownerTapeId, token: entry.token };
  }

  /** The value token of the member whose key's opening quote is at byte `p`, if there is one. */
  private async memberAtKey(document: OpenDocument, tape: Tape, p: number) {
    const n = tape.count;
    let lo = 0;
    let hi = n - 1;
    let j = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tape.start(mid) <= p) {
        j = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (j + 1 < n && tape.keyStart(j + 1) === p) return { tapeId: 0, token: j + 1 };
    // Inside a container the eager index cut: its members live on bucket tapes.
    let cut = false;
    for (let t = j; t >= 0; t = tape.parent(t)) {
      if (tape.end(t) > p && needsExpand(tape, t)) {
        cut = true;
        break;
      }
    }
    if (!cut) return null;
    const gathered = await this.gather(document, p, p + 1);
    const hit = gathered.tokens.find((token) => token.keyStart === p);
    return hit === undefined ? null : { tapeId: hit.tapeId, token: hit.token };
  }

  private async jq(ref: NodeRef, program: string, timeoutMs: number): Promise<EngineResult["jq"]> {
    const { record, token } = await this.settled(ref);
    // The value as it stands, edits applied: jq answers about what the views show.
    const { start, end } = this.logicalSpan(record, token);
    const bytes = end - start;
    if (bytes > MAX_SLICE_BYTES) {
      const suggested = await this.suggestJqElementPath(ref).catch(() => null);
      throw new JqSubtreeTooLargeError({
        bytes,
        limit: MAX_SLICE_BYTES,
        suggestedPath: suggested?.path ?? null,
      });
    }
    const run = this.platform.runJq;
    if (run === undefined) throw new EngineWorkerError({ detail: "jq is not available here" });
    const input = (await this.readLogical(record.doc, start, end)).slice();
    const result = await run(input, program, timeoutMs, JQ_OUTPUT_LIMIT_BYTES);
    return { ...result, inputBytes: bytes };
  }

  /** Creates a 2 GB-safe ElementSource over a container node (buckets + logical reads). */
  async elementSource(ref: NodeRef): Promise<ElementSource> {
    const { document, record, token, tapeId } = await this.settled(ref);
    await document.indexed;
    const summary = this.summary(document, tapeId, record, token);
    return {
      containerRef: summary.ref,
      containerKind: summary.kind,
      total: summary.childCount,
      list: async (from, count, includeKeys): Promise<ReadonlyArray<ElementDescriptor>> => {
        if (includeKeys) {
          const page = await this.rows(summary.ref, from, count, 1);
          return page.rows.map((row, idx) => ({
            index: from + idx,
            ref: row.node.ref,
            kind: row.node.kind,
            key: row.key,
            start: row.node.span.start,
            end: row.node.span.end,
          }));
        }
        const page = await this.children(summary.ref, from, count);
        return page.nodes.map((node, idx) => ({
          index: from + idx,
          ref: node.ref,
          kind: node.kind,
          key: null,
          start: node.span.start,
          end: node.span.end,
        }));
      },
      readLogical: (start, end) => this.readLogical(record.doc, start, end),
    };
  }

  /** Streams a container's children in <= 64 MiB logical batches via elementMap. */
  async mapElements<T>(
    ref: NodeRef,
    mapper: (element: ElementSlice, signal: AbortSignal) => Promise<T> | T,
    options?: ElementMapOptions<T>,
  ): Promise<ElementMapResult<T>> {
    const source = await this.elementSource(ref);
    return elementMap(source, mapper, options);
  }

  /** Streams a container's children in <= 64 MiB logical batches via elementBatchMap. */
  async mapElementBatches<T>(
    ref: NodeRef,
    mapper: (
      batch: ElementBatch,
      signal: AbortSignal,
    ) => Promise<ReadonlyArray<T>> | ReadonlyArray<T>,
    options?: ElementMapOptions<T>,
  ): Promise<ElementMapResult<T>> {
    const source = await this.elementSource(ref);
    return elementBatchMap(source, mapper, options);
  }

  /** Suggests the default array path for element-mode jq (`.log.entries` for HAR, largest top-level array for JSON). */
  async suggestJqElementPath(ref: NodeRef): Promise<JqSuggestedPath | null> {
    const { document } = await this.settled(ref);
    await document.indexed;
    const target = await this.node(ref);
    if (target.kind === "array") {
      return {
        path: ".",
        count: target.childCount,
        bytes: Math.max(0, target.span.end - target.span.start),
      };
    }
    if (target.kind !== "object") return null;
    if (document.format === "har" && ref.tapeId === 0 && ref.token === 0) {
      const log = await this.member(target.ref, "log");
      if (log !== null && log.node.kind === "object") {
        const entries = await this.member(log.node.ref, "entries");
        if (entries !== null && entries.node.kind === "array") {
          return {
            path: ".log.entries",
            count: entries.node.childCount,
            bytes: Math.max(0, entries.node.span.end - entries.node.span.start),
          };
        }
      }
    }
    let best: { key: string; count: number; bytes: number } | null = null;
    const scanCount = Math.min(target.childCount, CHILDREN_PAGE_LIMIT);
    if (scanCount > 0) {
      const page = await this.rows(target.ref, 0, scanCount, 1);
      for (const row of page.rows) {
        if (row.node.kind !== "array" || row.key === null) continue;
        const bytes = Math.max(0, row.node.span.end - row.node.span.start);
        if (
          best === null ||
          row.node.childCount > best.count ||
          (row.node.childCount === best.count && bytes > best.bytes)
        ) {
          best = { key: row.key, count: row.node.childCount, bytes };
        }
      }
    }
    if (best === null) return null;
    const isSimple = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(best.key);
    const escaped = best.key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      path: isSimple ? `.${best.key}` : `.["${escaped}"]`,
      count: best.count,
      bytes: best.bytes,
    };
  }

  /** Runs a jq program per element of a container path via elementMap without whole-doc materialization. */
  async jqElement(request: Omit<JqElementRequest, "_tag">): Promise<JqElementResult> {
    const run = this.platform.runJq;
    if (run === undefined) throw new EngineWorkerError({ detail: "jq is not available here" });

    let effectivePath = request.path?.trim() ?? "";
    if (effectivePath === "") {
      const suggested = await this.suggestJqElementPath(request.ref);
      effectivePath = suggested?.path ?? ".";
    }

    let containerRef = request.ref;
    if (effectivePath !== "." && effectivePath !== "$") {
      const jsonPath = effectivePath.startsWith("$")
        ? effectivePath
        : effectivePath.startsWith(".") || effectivePath.startsWith("[")
          ? `$${effectivePath}`
          : `$.${effectivePath}`;
      let segments: ReadonlyArray<Segment>;
      try {
        segments = parsePath(jsonPath);
      } catch (error) {
        if (error instanceof PathSyntaxError) {
          throw new InvalidPathError({ path: jsonPath, detail: error.message, at: error.at });
        }
        throw error;
      }
      const matches = await evalPathExpression(
        this.pathFilterHost(request.ref.documentId),
        request.ref,
        segments,
        { complete: true },
        1,
      );
      const first = matches[0];
      if (first === undefined) {
        throw new NodeNotFoundError({ ref: request.ref });
      }
      containerRef = first;
    }

    const containerMeta = await this.node(containerRef);
    const trimmedProgram = request.program.trim();
    const elementProgram =
      containerMeta.kind === "array"
        ? trimmedProgram.replace(/^\.\[\]\s*\|\s*(?=\S)/, "")
        : trimmedProgram;

    const source = await this.elementSource(containerRef);
    const controller = new AbortController();
    const chunks: string[] = [];
    let outputBytes = 0;
    let truncated = false;
    let inputBytes = 0;

    if (this.platform.runJqBatch === true) {
      const batchProgram = `.[] | (${elementProgram})`;
      const mapped = await elementBatchMap(
        source,
        async (batch, signal) => {
          const out: Array<
            | { readonly ok: true; readonly output: string; readonly byteLength: number }
            | { readonly ok: false; readonly message: string; readonly byteLength: number }
          > = [];
          if (signal.aborted || batch.items.length === 0) return out;
          let totalBytes = 2 + Math.max(0, batch.items.length - 1);
          for (const item of batch.items) totalBytes += item.bytes.byteLength;
          const packed = new Uint8Array(totalBytes);
          packed[0] = 0x5b; // '['
          let offset = 1;
          for (let i = 0; i < batch.items.length; i++) {
            if (i > 0) packed[offset++] = 0x2c; // ','
            const bytes = batch.items[i]!.bytes;
            packed.set(bytes, offset);
            offset += bytes.byteLength;
          }
          packed[offset] = 0x5d; // ']'

          const batchOutcome = await run(
            packed,
            batchProgram,
            request.timeoutMs,
            JQ_OUTPUT_LIMIT_BYTES,
          );
          if (batchOutcome.status === "ok") {
            if (batchOutcome.truncated) truncated = true;
            // Emit batch output once on slot 0 and account byte lengths cleanly across items.
            for (let i = 0; i < batch.items.length; i++) {
              out.push({
                ok: true,
                output: i === 0 ? batchOutcome.output : "",
                byteLength: batch.items[i]!.bytes.byteLength,
              });
            }
            return out;
          }

          // Batch hit an error (e.g. mixed-type element): fall back item-by-item for exact isolation.
          for (const item of batch.items) {
            if (signal.aborted) break;
            const single = await run(
              item.bytes.slice(),
              elementProgram,
              request.timeoutMs,
              JQ_OUTPUT_LIMIT_BYTES,
            );
            if (single.status !== "ok") {
              out.push({
                ok: false,
                message: single.message || `jq stopped with status ${single.status}.`,
                byteLength: item.bytes.byteLength,
              });
            } else {
              if (single.truncated) truncated = true;
              out.push({
                ok: true,
                output: single.output,
                byteLength: item.bytes.byteLength,
              });
            }
          }
          return out;
        },
        {
          batchBytes: 1024 * 1024,
          concurrency: Math.min(4, request.concurrency ?? 4),
          includeKeys: false,
          signal: controller.signal,
        },
      );

      const errors: Array<{
        readonly index: number;
        readonly key: string | null;
        readonly bytes: number;
        readonly message: string;
      }> = [];
      let processed = 0;
      for (const outcome of mapped.results) {
        if (!outcome.ok) {
          errors.push(outcome.error);
          continue;
        }
        const item = outcome.value;
        processed++;
        inputBytes += item.byteLength;
        if (!item.ok) {
          errors.push({
            index: processed - 1,
            key: null,
            bytes: item.byteLength,
            message: item.message,
          });
          continue;
        }
        if (item.output.length === 0) continue;
        const text = item.output.endsWith("\n") ? item.output : `${item.output}\n`;
        if (outputBytes + text.length <= JQ_OUTPUT_LIMIT_BYTES) {
          chunks.push(text);
          outputBytes += text.length;
        } else {
          const room = JQ_OUTPUT_LIMIT_BYTES - outputBytes;
          if (room > 0) {
            chunks.push(text.slice(0, room));
            outputBytes += room;
          }
          truncated = true;
          controller.abort();
          break;
        }
      }

      const allErrors = errors.length > 0 ? errors : mapped.errors;
      const status =
        allErrors.length === 0
          ? "ok"
          : allErrors.length >= processed && chunks.length === 0
            ? "error"
            : "partial";
      const message =
        allErrors.length === 0
          ? ""
          : `${allErrors.length} element${allErrors.length === 1 ? "" : "s"} failed (${allErrors[0]?.message ?? "error"})`;

      return {
        status,
        output: chunks.join(""),
        truncated,
        message,
        path: effectivePath,
        processed,
        total: mapped.summary.total,
        errors: allErrors,
        inputBytes,
      };
    }

    const mapped = await elementMap(
      source,
      async (slice, signal) => {
        if (signal.aborted) return "";
        const outcome = await run(
          slice.bytes.slice(),
          elementProgram,
          request.timeoutMs,
          JQ_OUTPUT_LIMIT_BYTES,
        );
        if (outcome.status !== "ok") {
          throw new Error(outcome.message || `jq stopped with status ${outcome.status}.`);
        }
        if (outcome.truncated) truncated = true;
        return outcome.output;
      },
      {
        concurrency: request.concurrency ?? 4,
        includeKeys: false,
        collectResults: false,
        signal: controller.signal,
        onOrderedResult: (outcome) => {
          if (!outcome.ok) return;
          inputBytes += outcome.byteLength;
          const rawOut = outcome.value;
          if (rawOut.length === 0) return;
          const out = rawOut.endsWith("\n") ? rawOut : `${rawOut}\n`;
          if (outputBytes + out.length <= JQ_OUTPUT_LIMIT_BYTES) {
            chunks.push(out);
            outputBytes += out.length;
          } else {
            const room = JQ_OUTPUT_LIMIT_BYTES - outputBytes;
            if (room > 0) {
              chunks.push(out.slice(0, room));
              outputBytes += room;
            }
            truncated = true;
            controller.abort();
          }
        },
      },
    );

    const status =
      mapped.errors.length === 0
        ? "ok"
        : mapped.errors.length === mapped.summary.processed && chunks.length === 0
          ? "error"
          : "partial";
    const message =
      mapped.errors.length === 0
        ? ""
        : `${mapped.errors.length} element${mapped.errors.length === 1 ? "" : "s"} failed (${mapped.errors[0]?.message ?? "error"})`;

    return {
      status,
      output: chunks.join(""),
      truncated,
      message,
      path: effectivePath,
      processed: mapped.summary.processed,
      total: mapped.summary.total,
      errors: mapped.errors,
      inputBytes,
    };
  }

  /** Packs a contiguous ElementBatch slice into a fresh transferable buffer for scan workers. */
  private packBatchBuffer(batch: ElementBatch): {
    readonly buffer: ArrayBuffer;
    readonly items: ReadonlyArray<{
      readonly index: number;
      readonly start: number;
      readonly end: number;
    }>;
  } {
    const first = batch.items[0];
    const last = batch.items[batch.items.length - 1];
    if (first === undefined || last === undefined) {
      return { buffer: new ArrayBuffer(0), items: [] };
    }
    const spanStart = first.bytes.byteOffset;
    const spanEnd = last.bytes.byteOffset + last.bytes.byteLength;
    const copy = new Uint8Array(Math.max(0, spanEnd - spanStart));
    copy.set(new Uint8Array(first.bytes.buffer, spanStart, copy.byteLength));
    return {
      buffer: copy.buffer,
      items: batch.items.map((item) => ({
        index: item.index,
        start: item.bytes.byteOffset - spanStart,
        end: item.bytes.byteOffset + item.bytes.byteLength - spanStart,
      })),
    };
  }

  private async readLogicalBounded(doc: Doc, limit: number): Promise<Uint8Array> {
    const size = this.docSize(doc);
    if (size > limit) throw new SliceTooLargeError({ bytes: size, limit });
    const out = new Uint8Array(size);
    for (let at = 0; at < size; at += MAX_SLICE_BYTES) {
      const end = Math.min(size, at + MAX_SLICE_BYTES);
      out.set(await this.readLogical(doc, at, end), at);
    }
    return out;
  }

  private async findHarEntriesRef(documentId: number): Promise<NodeRef | null> {
    const rootRef: NodeRef = { documentId, tapeId: 0, token: 0 };
    const rootNode = await this.node(rootRef);
    if (rootNode.kind !== "object") return null;
    const log = await this.member(rootRef, "log");
    if (log === null || log.node.kind !== "object") return null;
    const entries = await this.member(log.node.ref, "entries");
    if (entries === null || entries.node.kind !== "array") return null;
    return entries.node.ref;
  }

  private async compareStructural(
    aDocumentId: number,
    bDocumentId: number,
  ): Promise<StructuralDiffResult> {
    const docA = this.document(aDocumentId);
    const docB = this.document(bDocumentId);
    await Promise.all([this.ready(docA), this.ready(docB)]);
    const sizeA = this.docSize(docA.doc);
    const sizeB = this.docSize(docB.doc);
    if (sizeA > MAX_STRUCTURAL_DIFF_BYTES) {
      throw new DiffTooLargeError({
        bytes: sizeA,
        limit: MAX_STRUCTURAL_DIFF_BYTES,
        detail: `Document A (${sizeA} bytes) exceeds the 256 MiB structural diff limit. Use HAR entry diff for multi-GB HAR captures.`,
      });
    }
    if (sizeB > MAX_STRUCTURAL_DIFF_BYTES) {
      throw new DiffTooLargeError({
        bytes: sizeB,
        limit: MAX_STRUCTURAL_DIFF_BYTES,
        detail: `Document B (${sizeB} bytes) exceeds the 256 MiB structural diff limit. Use HAR entry diff for multi-GB HAR captures.`,
      });
    }
    const [bytesA, bytesB] = await Promise.all([
      this.readLogicalBounded(docA.doc, MAX_STRUCTURAL_DIFF_BYTES),
      this.readLogicalBounded(docB.doc, MAX_STRUCTURAL_DIFF_BYTES),
    ]);
    return diffJsonBytes(bytesA, bytesB);
  }

  /**
   * Builds bounded byte-window tasks (`<= 8 MiB` step chunks) over `.log.entries` for a
   * clean unedited tape-0 container using its eager `BucketAnchors` (or inline children).
   * Returns `null` when the container is empty or not cleanly anchor/tape-0 accessible.
   */
  private planHarArrayWindows(
    doc: OpenDocument,
    entriesRef: NodeRef,
    maxRows?: number,
  ): Array<{
    readonly baseIndex: number;
    readonly expectedCount: number;
    readonly start: number;
    readonly end: number;
  }> | null {
    if (doc.syntax !== null || this.isDirty(doc.doc) || doc.display?.sameOffsets === true)
      return null;
    if (entriesRef.tapeId !== 0) return null;
    const record = doc.tapes.get(0);
    if (!record) return null;
    const token = entriesRef.token;
    if (record.tape.kind(token) !== KIND_ARRAY) return null;
    const totalChildren = record.tape.childCount(token);
    const limit = maxRows !== undefined ? Math.min(totalChildren, maxRows) : totalChildren;
    if (limit <= 0) return [];

    const anchors = record.anchors.get(token);
    const windows: Array<{
      readonly baseIndex: number;
      readonly expectedCount: number;
      readonly start: number;
      readonly end: number;
    }> = [];
    const targetWindowBytes = 10 * 1024 * 1024;

    if (anchors && anchors.index.length > 0) {
      const arrayEnd = Math.max(0, record.tape.end(token) - 1);
      let b = 0;
      while (b < anchors.index.length) {
        const baseIndex = anchors.index[b] as number;
        if (baseIndex >= limit) break;
        const start = anchors.offset[b] as number;
        let endBucket = b;
        while (endBucket + 1 < anchors.index.length) {
          const nextIdx = anchors.index[endBucket + 1] as number;
          if (nextIdx >= limit) break;
          const nextOffset = anchors.offset[endBucket + 1] as number;
          if (nextOffset - start > targetWindowBytes && endBucket >= b) break;
          endBucket++;
        }
        const nextBucket = endBucket + 1;
        const nextIdx =
          nextBucket < anchors.index.length ? (anchors.index[nextBucket] as number) : totalChildren;
        if (nextIdx > limit) {
          // Partial last bucket capped at `maxRows`: stop cleanly via exact children if ever clipped.
          return null;
        }
        const end =
          nextBucket < anchors.offset.length ? (anchors.offset[nextBucket] as number) : arrayEnd;
        windows.push({
          baseIndex,
          expectedCount: nextIdx - baseIndex,
          start,
          end,
        });
        b = nextBucket;
      }
      // LPT scheduling: start largest byte-span buckets first so stragglers never tail the pool.
      windows.sort((a, b) => b.end - b.start - (a.end - a.start));
      return windows;
    }

    // Inline children on tape 0 (smaller captures without anchors)
    let c = firstChild(record.tape, token);
    let idx = 0;
    while (c >= 0 && idx < limit) {
      const baseIndex = idx;
      const start = record.tape.start(c);
      let end = record.tape.end(c);
      let count = 1;
      c = record.tape.next(c);
      idx++;
      while (c >= 0 && idx < limit) {
        const nextEnd = record.tape.end(c);
        if (nextEnd - start > targetWindowBytes) break;
        end = nextEnd;
        count++;
        c = record.tape.next(c);
        idx++;
      }
      windows.push({ baseIndex, expectedCount: count, start, end });
    }
    return windows;
  }

  private async findObjectMembers(
    ref: NodeRef,
    wantedKeys: ReadonlySet<string>,
    sharedSlice?: { readonly bytes: Uint8Array; readonly base: number; readonly sourceId: number },
  ): Promise<Map<string, NodeSummary> | null> {
    const { document, record, token, tapeId } = await this.settled(ref, true);
    if (this.cutOf(document, record) !== null || record.tape.kind(token) !== KIND_OBJECT) {
      return null;
    }
    const childCount = record.tape.childCount(token);
    if (childCount === 0) return new Map();
    if (firstChild(record.tape, token) < 0) return null;

    const base = record.tape.start(token);
    const containerEnd = record.tape.end(token);
    let windowStart = base;
    let windowEnd = Math.min(containerEnd, base + ROWS_WINDOW_BYTES, record.size);
    let window: Uint8Array | null = null;
    if (
      sharedSlice !== undefined &&
      record.sourceId === sharedSlice.sourceId &&
      base >= sharedSlice.base &&
      base < sharedSlice.base + sharedSlice.bytes.byteLength
    ) {
      window = sharedSlice.bytes;
      windowStart = sharedSlice.base;
      windowEnd = sharedSlice.base + sharedSlice.bytes.byteLength;
    } else if (windowEnd > base) {
      window = await this.read(record, base, windowEnd);
    }

    const found = new Map<string, NodeSummary>();
    const deferred: Array<{ readonly node: NodeSummary; readonly childRecord: TapeRecord }> = [];

    let c = firstChild(record.tape, token);
    while (c >= 0) {
      const node = this.summary(document, tapeId, record, c);
      c = record.tape.next(c);
      if (node.key === null) continue;
      const childRecord = document.tapes.get(node.ref.tapeId) ?? record;
      if (
        window !== null &&
        childRecord.sourceId === record.sourceId &&
        node.key >= windowStart &&
        node.key < windowEnd
      ) {
        const keyEnd = stringEnd(window, node.key - windowStart);
        if (keyEnd >= 0) {
          const key = decodeString(window, node.key - windowStart, keyEnd, MAX_KEY_BYTES);
          if (wantedKeys.has(key) && !found.has(key)) {
            found.set(key, node);
            if (found.size === wantedKeys.size) return found;
          }
          continue;
        }
      }
      deferred.push({ node, childRecord });
    }

    if (deferred.length > 0 && found.size < wantedKeys.size) {
      const resolved = await Promise.all(
        deferred.map(async ({ node, childRecord }) => {
          const keyStart = node.key as number;
          const miniEnd = Math.min(childRecord.size, keyStart + 64);
          const mini = await this.read(childRecord, keyStart, miniEnd);
          const end = stringEnd(mini, 0);
          const key =
            end >= 0
              ? decodeString(mini, 0, end, MAX_KEY_BYTES)
              : await this.keyAt(document, childRecord, keyStart);
          return { key, node };
        }),
      );
      for (const { key, node } of resolved) {
        if (wantedKeys.has(key) && !found.has(key)) {
          found.set(key, node);
        }
      }
    }
    return found;
  }

  private async resolveOneHarEntryCellRefs(
    document: OpenDocument,
    entryNode: NodeSummary,
    docClean: boolean,
    batchSlice?: { readonly bytes: Uint8Array; readonly base: number; readonly sourceId: number },
  ): Promise<HarEntryCellRefs | null> {
    let slice = batchSlice;
    if (slice === undefined && docClean) {
      const entryRecord = document.tapes.get(entryNode.ref.tapeId);
      const len = entryNode.range.end - entryNode.range.start;
      if (entryRecord && len > 0 && len <= 512 * 1024) {
        const bytes = await this.read(entryRecord, entryNode.range.start, entryNode.range.end);
        slice = { bytes, base: entryNode.range.start, sourceId: entryRecord.sourceId };
      }
    }

    const top = await this.findObjectMembers(entryNode.ref, HAR_ENTRY_REF_KEYS, slice);
    if (top === null) return null;
    const reqNode = top.get("request");
    const respNode = top.get("response");
    const timeNode = top.get("time");

    const [reqMap, respMap] = await Promise.all([
      reqNode && reqNode.kind === "object"
        ? this.findObjectMembers(reqNode.ref, HAR_REQ_REF_KEYS, slice)
        : Promise.resolve(new Map<string, NodeSummary>()),
      respNode && respNode.kind === "object"
        ? this.findObjectMembers(respNode.ref, HAR_RESP_REF_KEYS, slice)
        : Promise.resolve(new Map<string, NodeSummary>()),
    ]);
    if (reqMap === null || respMap === null) return null;

    const contentNode = respMap.get("content");
    const contentMap =
      contentNode && contentNode.kind === "object"
        ? await this.findObjectMembers(contentNode.ref, HAR_CONTENT_REF_KEYS, slice)
        : new Map<string, NodeSummary>();
    if (contentMap === null) return null;

    const scalarRef = (n: NodeSummary | undefined): NodeRef | null =>
      n && n.kind !== "object" && n.kind !== "array" ? n.ref : null;

    return {
      methodRef: scalarRef(reqMap.get("method")),
      urlRef: scalarRef(reqMap.get("url")),
      statusRef: scalarRef(respMap.get("status")),
      mimeTypeRef: scalarRef(contentMap.get("mimeType")),
      bodySizeRef: scalarRef(contentMap.get("size")) ?? scalarRef(respMap.get("bodySize")),
      timeMsRef: scalarRef(timeNode),
    };
  }

  private async resolveHarRowsBatch(
    targetRef: NodeRef,
    rowIndices: ReadonlyArray<number>,
  ): Promise<ReadonlyArray<ResolvedHarRowBatchItem | null> | null> {
    if (rowIndices.length === 0) return [];
    const { document, record, token, tapeId } = await this.settled(targetRef, true);
    if (this.cutOf(document, record) !== null || record.tape.kind(token) !== KIND_ARRAY) {
      return null;
    }
    let total = record.tape.childCount(token);
    if (total > 0 && !document.live.done && firstChild(record.tape, token) < 0) {
      await this.ready(document);
      total = record.tape.childCount(token);
    }
    total = this.visibleChildren(document, record, token, total);

    const entryNodes: Array<NodeSummary | undefined> = Array.from({ length: rowIndices.length });
    if (firstChild(record.tape, token) >= 0) {
      const wanted = new Map<number, number[]>();
      for (let i = 0; i < rowIndices.length; i++) {
        const idx = rowIndices[i] as number;
        if (idx >= 0 && idx < total) {
          let list = wanted.get(idx);
          if (!list) {
            list = [];
            wanted.set(idx, list);
          }
          list.push(i);
        }
      }
      const sortedTargets = [...wanted.keys()].sort((a, b) => a - b);
      if (sortedTargets.length > 0) {
        let cursor = 0;
        let child = this.skipTo(record, token, sortedTargets[0] as number);
        let at = sortedTargets[0] as number;
        while (child >= 0 && cursor < sortedTargets.length) {
          const targetIdx = sortedTargets[cursor] as number;
          if (at === targetIdx) {
            const summary = this.summary(document, tapeId, record, child);
            for (const slot of wanted.get(targetIdx) as number[]) {
              entryNodes[slot] = summary;
            }
            cursor++;
          }
          child = record.tape.next(child);
          at++;
        }
      }
    } else {
      const anchors = record.anchors.get(token);
      if (!anchors || anchors.index.length === 0) return null;
      const byBucket = new Map<
        number,
        Array<{ readonly rowIndex: number; readonly slot: number }>
      >();
      for (let slot = 0; slot < rowIndices.length; slot++) {
        const rowIndex = rowIndices[slot] as number;
        if (rowIndex < 0 || rowIndex >= total) continue;
        const b = upperBound(anchors.index, rowIndex) - 1;
        let list = byBucket.get(b);
        if (!list) {
          list = [];
          byBucket.set(b, list);
        }
        list.push({ rowIndex, slot });
      }
      const distinctBuckets = [...byBucket.keys()];
      const bucketIds = await Promise.all(
        distinctBuckets.map((b) => this.bucketTape(document, tapeId, record, token, b)),
      );
      for (let bi = 0; bi < distinctBuckets.length; bi++) {
        const b = distinctBuckets[bi] as number;
        const bTapeId = bucketIds[bi] as number;
        const bRecord = document.tapes.get(bTapeId) as TapeRecord;
        const bucketBase = anchors.index[b] as number;
        const items = byBucket.get(b)!;
        items.sort((a, c) => a.rowIndex - c.rowIndex);
        let root = bRecord.tape.count > 0 ? 0 : -1;
        let pos = 0;
        for (const item of items) {
          const wantSkip = item.rowIndex - bucketBase;
          while (pos < wantSkip && root >= 0) {
            root = bRecord.tape.next(root);
            pos++;
          }
          if (root < 0) break;
          entryNodes[item.slot] = this.summary(document, bTapeId, bRecord, root);
        }
      }
    }

    const docClean = !this.isDirty(document.doc) && document.syntax === null;
    let batchSlice:
      | { readonly bytes: Uint8Array; readonly base: number; readonly sourceId: number }
      | undefined;
    if (docClean) {
      let minStart = Number.POSITIVE_INFINITY;
      let maxEnd = 0;
      for (const node of entryNodes) {
        if (!node || node.kind !== "object") continue;
        const rec = document.tapes.get(node.ref.tapeId);
        if (!rec || rec.sourceId !== record.sourceId) continue;
        if (node.range.start < minStart) minStart = node.range.start;
        if (node.range.end > maxEnd) maxEnd = node.range.end;
      }
      if (maxEnd > minStart && maxEnd - minStart <= 4 * 1024 * 1024) {
        const bytes = await this.read(record, minStart, maxEnd);
        batchSlice = { bytes, base: minStart, sourceId: record.sourceId };
      }
    }

    return Promise.all(
      entryNodes.map(async (node) => {
        if (!node) return null;
        if (node.kind !== "object") {
          return { node, refs: EMPTY_HAR_CELL_REFS };
        }
        const refs = await this.resolveOneHarEntryCellRefs(document, node, docClean, batchSlice);
        return refs === null ? null : { node, refs };
      }),
    );
  }

  private async readHarEntriesFast(
    documentId: number,
    targetRef: NodeRef,
    totalRows: number,
  ): Promise<HarTableColumnarData | null> {
    const doc = this.document(documentId);
    await this.ready(doc);
    const windows = this.planHarArrayWindows(doc, targetRef, totalRows);
    if (windows === null) return null;
    if (windows.length === 0) {
      return {
        count: 0,
        nums: new Float64Array(0),
        methods: [],
        urls: [],
        mimeTypes: [],
        startedDateTimes: [],
      };
    }

    const nums = new Float64Array(totalRows * HAR_COL_STRIDE);
    nums.fill(Number.NaN);
    const methods = Array.from<string | null>({ length: totalRows }).fill(null);
    const urls = Array.from<string | null>({ length: totalRows }).fill(null);
    const mimeTypes = Array.from<string | null>({ length: totalRows }).fill(null);
    const startedDateTimes = Array.from<string | null>({ length: totalRows }).fill(null);
    const workers = Math.max(1, doc.pool.size);
    const workerCount = Math.min(workers, windows.length);
    let nextWindow = 0;

    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerId) => {
        const wid = workers - 1 - (workerId % workers);
        while (nextWindow < windows.length) {
          const w = windows[nextWindow++]!;
          const res = await doc.pool.call<HarTableColumnarWindowResult>(wid, {
            type: "harTableWindow",
            sourceId: DOCUMENT_SOURCE_ID,
            start: w.start,
            end: w.end,
            baseIndex: w.baseIndex,
            expectedCount: w.expectedCount,
            stepBytes: 8 * 1024 * 1024,
          });
          if (res.count !== w.expectedCount) continue;
          const copyCount = Math.min(res.count, totalRows - w.baseIndex);
          if (copyCount <= 0) continue;
          nums.set(res.nums.subarray(0, copyCount * HAR_COL_STRIDE), w.baseIndex * HAR_COL_STRIDE);
          for (let k = 0; k < copyCount; k++) {
            const dst = w.baseIndex + k;
            methods[dst] = res.methods[k] ?? null;
            urls[dst] = res.urls[k] ?? null;
            mimeTypes[dst] = res.mimeTypes[k] ?? null;
            startedDateTimes[dst] = res.startedDateTimes[k] ?? null;
          }
        }
      }),
    );

    return { count: totalRows, nums, methods, urls, mimeTypes, startedDateTimes };
  }

  private async hashRangeInWorker(
    doc: OpenDocument,
    sourceId: number,
    workerId: number,
    range: { readonly start: number; readonly end: number },
  ): Promise<bigint> {
    const res = await doc.pool.call<HashSourceRangeResult>(workerId, {
      type: "hashSourceRange",
      sourceId,
      start: range.start,
      end: range.end,
      stepBytes: 8 * 1024 * 1024,
    });
    return res.hash;
  }

  private async extractOversizedHarPrint(
    documentId: number,
    doc: OpenDocument,
    entriesRef: NodeRef,
    sourceId: number,
    entryIndex: number,
    spanStart: number,
    spanEnd: number,
  ): Promise<HarEntryPrint> {
    const readTextSmall = async (ref: NodeRef): Promise<string> => {
      const tv = await this.text(ref, 65536);
      return tv.text;
    };
    const page = await this.children(entriesRef, entryIndex, 1);
    const entryNode = page.nodes[0];
    if (entryNode === undefined || entryNode.kind !== "object") {
      const fallbackDigest = await this.hashRangeInWorker(
        doc,
        sourceId,
        entryIndex % Math.max(1, doc.pool.size),
        {
          start: spanStart,
          end: spanEnd,
        },
      );
      return {
        entryIndex,
        matchKey: "",
        method: "",
        url: "",
        resourceType: "",
        status: 0,
        headersHash: 0n,
        queryHash: 0n,
        postDataHash: 0n,
        bodyHash: fallbackDigest,
      };
    }

    const fallbackDigest = await this.hashRangeInWorker(
      doc,
      sourceId,
      entryIndex % Math.max(1, doc.pool.size),
      { start: spanStart, end: spanEnd },
    );
    const [reqRow, respRow] = await Promise.all([
      this.member(entryNode.ref, "request"),
      this.member(entryNode.ref, "response"),
    ]);
    let method = "";
    let url = "";
    let status = 0;
    if (reqRow && reqRow.node.kind === "object") {
      const [mRow, uRow] = await Promise.all([
        this.member(reqRow.node.ref, "method"),
        this.member(reqRow.node.ref, "url"),
      ]);
      if (mRow && mRow.node.kind === "string") method = await readTextSmall(mRow.node.ref);
      if (uRow && uRow.node.kind === "string") url = await readTextSmall(uRow.node.ref);
    }
    if (respRow && respRow.node.kind === "object") {
      const sRow = await this.member(respRow.node.ref, "status");
      if (sRow && sRow.node.kind === "number") {
        const n = Number(await readTextSmall(sRow.node.ref));
        if (Number.isFinite(n) && n >= 0) status = Math.trunc(n);
      }
    }
    return {
      entryIndex,
      matchKey: `${method}\0${url}`,
      method,
      url,
      resourceType: "",
      status,
      headersHash: 0n,
      queryHash: 0n,
      postDataHash: 0n,
      bodyHash: fallbackDigest,
    };
  }

  private async extractHarPrints(documentId: number): Promise<ReadonlyArray<HarEntryPrint>> {
    const doc = this.document(documentId);
    await this.ready(doc);

    if (!this.isDirty(doc.doc) && doc.harPrintsCache !== null) {
      return doc.harPrintsCache;
    }

    const compute = async (): Promise<ReadonlyArray<HarEntryPrint>> => {
      const entriesRef = await this.findHarEntriesRef(documentId);
      if (entriesRef === null) {
        return this.isDirty(doc.doc) ? [] : extractHarPrintsStreaming(doc.source);
      }

      const workers = Math.max(1, doc.pool.size);
      const windows = this.planHarArrayWindows(doc, entriesRef);
      if (windows !== null) {
        if (windows.length === 0) return [];
        const entryMeta = await this.node(entriesRef);
        const total = entryMeta.childCount;
        const prints = Array.from<HarEntryPrint | null>({ length: total }).fill(null);
        const oversizedList: Array<{
          readonly entryIndex: number;
          readonly start: number;
          readonly end: number;
        }> = [];
        const fallbackWindows: Array<{
          readonly baseIndex: number;
          readonly expectedCount: number;
        }> = [];

        let nextWindow = 0;
        const workerCount = Math.min(workers, windows.length);
        await Promise.all(
          Array.from({ length: workerCount }, async (_, workerId) => {
            while (nextWindow < windows.length) {
              const w = windows[nextWindow++]!;
              const res = await doc.pool.call<HarPrintWindowResult>(workerId, {
                type: "harPrintWindow",
                sourceId: DOCUMENT_SOURCE_ID,
                start: w.start,
                end: w.end,
                baseIndex: w.baseIndex,
                stepBytes: 8 * 1024 * 1024,
              });
              if (res.prints.length !== w.expectedCount) {
                fallbackWindows.push({ baseIndex: w.baseIndex, expectedCount: w.expectedCount });
                continue;
              }
              for (let k = 0; k < res.prints.length && w.baseIndex + k < total; k++) {
                prints[w.baseIndex + k] = res.prints[k] ?? null;
              }
              for (const ov of res.oversized) oversizedList.push(ov);
            }
          }),
        );

        for (const fw of fallbackWindows) {
          for (let offset = 0; offset < fw.expectedCount; offset++) {
            const idx = fw.baseIndex + offset;
            const p = await this.children(entriesRef, idx, 1);
            const node = p.nodes[0];
            if (!node) continue;
            oversizedList.push({ entryIndex: idx, start: node.span.start, end: node.span.end });
          }
        }

        if (oversizedList.length > 0) {
          await Promise.all(
            oversizedList.map(async (ov) => {
              const len = ov.end - ov.start;
              if (len <= MAX_SLICE_BYTES && len > 0) {
                const slice = await this.readLogical(doc.doc, ov.start, ov.end);
                prints[ov.entryIndex] = extractHarEntryPrintFromSlice(slice, ov.entryIndex);
              } else {
                prints[ov.entryIndex] = await this.extractOversizedHarPrint(
                  documentId,
                  doc,
                  entriesRef,
                  DOCUMENT_SOURCE_ID,
                  ov.entryIndex,
                  ov.start,
                  ov.end,
                );
              }
            }),
          );
        }

        return prints.filter((p): p is HarEntryPrint => p !== null);
      }

      // Edited/JSONC/partial captures: stream via openLogicalWindow (or file source) + element spans.
      const dirty = this.isDirty(doc.doc);
      const win = dirty ? await this.openLogicalWindow(doc.doc) : null;
      const sourceId = win ? win.sourceId : DOCUMENT_SOURCE_ID;
      try {
        const entryMeta = await this.node(entriesRef);
        const total = entryMeta.childCount;
        if (total === 0) return [];
        const spans: Array<{
          readonly index: number;
          readonly start: number;
          readonly end: number;
        }> = [];
        for (let from = 0; from < total; from += CHILDREN_PAGE_LIMIT) {
          const page = await this.children(
            entriesRef,
            from,
            Math.min(CHILDREN_PAGE_LIMIT, total - from),
          );
          for (let k = 0; k < page.nodes.length; k++) {
            const n = page.nodes[k]!;
            spans.push({ index: from + k, start: n.span.start, end: n.span.end });
          }
        }
        const prints = Array.from<HarEntryPrint | null>({ length: spans.length }).fill(null);
        const batchTargetBytes = 4 * 1024 * 1024;
        const sliceBatches: Array<
          Array<{ readonly index: number; readonly start: number; readonly end: number }>
        > = [];
        let cur: Array<{ readonly index: number; readonly start: number; readonly end: number }> =
          [];
        let curStart = 0;
        for (const s of spans) {
          if (cur.length > 0 && (s.end - curStart > batchTargetBytes || cur.length >= 256)) {
            sliceBatches.push(cur);
            cur = [];
          }
          if (cur.length === 0) curStart = s.start;
          cur.push(s);
        }
        if (cur.length > 0) sliceBatches.push(cur);

        const oversizedList: Array<{
          readonly entryIndex: number;
          readonly start: number;
          readonly end: number;
        }> = [];
        let nextBatch = 0;
        const workerCount = Math.min(workers, sliceBatches.length);
        await Promise.all(
          Array.from({ length: workerCount }, async (_, workerId) => {
            while (nextBatch < sliceBatches.length) {
              const items = sliceBatches[nextBatch++]!;
              const res = await doc.pool.call<HarPrintWindowResult>(workerId, {
                type: "harPrintSlices",
                sourceId,
                items,
              });
              for (let k = 0; k < items.length; k++) {
                prints[items[k]!.index] = res.prints[k] ?? null;
              }
              for (const ov of res.oversized) oversizedList.push(ov);
            }
          }),
        );
        for (const ov of oversizedList) {
          prints[ov.entryIndex] = await this.extractOversizedHarPrint(
            documentId,
            doc,
            entriesRef,
            sourceId,
            ov.entryIndex,
            ov.start,
            ov.end,
          );
        }
        return prints.filter((p): p is HarEntryPrint => p !== null);
      } finally {
        win?.close();
      }
    };

    if (!this.isDirty(doc.doc)) {
      const promise = compute().catch((err) => {
        if (doc.harPrintsCache === promise) doc.harPrintsCache = null;
        throw err;
      });
      doc.harPrintsCache = promise;
      return promise;
    }
    return compute();
  }

  private async compareHar(
    aDocumentId: number,
    bDocumentId: number,
    reference: "a" | "b",
  ): Promise<HarDiffSummary> {
    // Wait for both captures to settle, then fingerprint sequentially so 2 pools don't double-allocate buffers or contend.
    await this.ready(this.document(aDocumentId));
    await this.ready(this.document(bDocumentId));
    const aPrints = await this.extractHarPrints(aDocumentId);
    const bPrints = await this.extractHarPrints(bDocumentId);
    return diffHarCaptures(aPrints, bPrints, { reference });
  }

  private async readHarEntrySlice(
    documentId: number,
    entryIndex: number | null,
  ): Promise<Uint8Array | null> {
    if (entryIndex === null) return null;
    const doc = this.document(documentId);
    await this.ready(doc);
    const entriesRef = await this.findHarEntriesRef(documentId);
    if (entriesRef === null) return null;
    const page = await this.children(entriesRef, entryIndex, 1);
    const entry = page.nodes[0];
    if (entry === undefined) return null;
    const size = Math.max(0, entry.span.end - entry.span.start);
    if (size > MAX_SLICE_BYTES) return null;
    return this.readLogical(doc.doc, entry.span.start, entry.span.end);
  }

  private async compareHarEntryBody(
    aDocumentId: number,
    aEntryIndex: number | null,
    bDocumentId: number,
    bEntryIndex: number | null,
  ): Promise<StructuralDiffResult> {
    const [aSlice, bSlice] = await Promise.all([
      this.readHarEntrySlice(aDocumentId, aEntryIndex),
      this.readHarEntrySlice(bDocumentId, bEntryIndex),
    ]);
    return diffHarEntryBodies(aSlice, bSlice);
  }

  private async inferSchema(ref: NodeRef, options?: Partial<InferOptions>): Promise<Shape> {
    const opts: InferOptions = {
      maxEnum: options?.maxEnum ?? DEFAULT_MAX_ENUM,
      maxDepth: options?.maxDepth ?? DEFAULT_MAX_INFER_DEPTH,
    };
    return this.inferNodeShape(ref, opts, 0);
  }

  private async inferNodeShape(ref: NodeRef, options: InferOptions, depth: number): Promise<Shape> {
    const { document, record, token } = await this.settled(ref);
    await this.ready(document);
    const { start, end } = this.logicalSpan(record, token);
    const bytes = Math.max(0, end - start);
    if (bytes <= MAX_SLICE_BYTES) {
      const slice = await this.readLogical(record.doc, start, end);
      return inferJsonSlice(slice, options);
    }
    if (depth >= options.maxDepth) return emptyShape();
    const node = await this.node(ref);
    if (node.kind === "array") {
      let itemsShape = emptyShape();
      let workerCursor = 0;
      const workers = Math.max(1, document.pool.size);
      const mapped = await this.mapElementBatches<Shape | null>(
        ref,
        async (batch) => {
          if (batch.items.length === 0) return [];
          const packed = this.packBatchBuffer(batch);
          const worker = workerCursor++ % workers;
          const batchShape = await document.pool.call<Shape>(
            worker,
            {
              type: "inferBatch",
              buffer: packed.buffer,
              items: packed.items.map(({ start: s, end: e }) => ({ start: s, end: e })),
              options,
            },
            [packed.buffer],
          );
          const out: Array<Shape | null> = Array.from({ length: batch.items.length }, () => null);
          out[0] = batchShape;
          return out;
        },
        {
          concurrency: workers,
          includeKeys: false,
          collectResults: false,
          onOrderedResult: (outcome) => {
            if (outcome.ok && outcome.value !== null) {
              itemsShape = mergeShape(itemsShape, outcome.value, options);
            }
          },
        },
      );
      for (const err of mapped.errors) {
        const page = await this.children(ref, err.index, 1);
        const oversized = page.nodes[0];
        if (oversized !== undefined) {
          itemsShape = mergeShape(
            itemsShape,
            await this.inferNodeShape(oversized.ref, options, depth + 1),
            options,
          );
        }
      }
      return {
        samples: 1,
        nulls: 0,
        bools: 0,
        integers: 0,
        floats: 0,
        string: null,
        array: {
          count: 1,
          minLen: node.childCount,
          maxLen: node.childCount,
          items: itemsShape,
        },
        object: null,
      };
    }
    if (node.kind === "object") {
      const fields: FieldShape[] = [];
      for (let from = 0; from < node.childCount; from += CHILDREN_PAGE_LIMIT) {
        const count = Math.min(CHILDREN_PAGE_LIMIT, node.childCount - from);
        const page = await this.rows(ref, from, count, 1);
        for (const row of page.rows) {
          if (row.key === null) continue;
          const childShape = await this.inferNodeShape(row.node.ref, options, depth + 1);
          fields.push({ name: row.key, present: 1, shape: childShape });
        }
      }
      return {
        samples: 1,
        nulls: 0,
        bools: 0,
        integers: 0,
        floats: 0,
        string: null,
        array: null,
        object: { count: 1, fields },
      };
    }
    throw new SliceTooLargeError({ bytes, limit: MAX_SLICE_BYTES });
  }

  private async validateSchema(
    documentId: number,
    schemaText: string,
    filter?: HarValidationFilter | null,
  ): Promise<ValidationResult> {
    let schema: LocalSchema;
    try {
      schema = parseSchema(schemaText);
    } catch (error) {
      if (error instanceof SchemaParseError) throw error.toContractError();
      throw error;
    }
    const doc = this.document(documentId);
    await this.ready(doc);

    if (doc.format === "har" && filter !== null && filter !== undefined) {
      const entriesRef = await this.findHarEntriesRef(documentId);
      if (entriesRef === null) {
        return { valid: true, failures: [], truncated: false, checkedEntries: 0 };
      }
      const failures: SchemaFailure[] = [];
      let checkedEntries = 0;
      const controller = new AbortController();
      await this.mapElementBatches<ValidationResult>(
        entriesRef,
        (batch) => {
          const inputs: HarEntryInput[] = [];
          for (const item of batch.items) {
            let parsed: unknown;
            try {
              parsed = parseJsonSlice(item.bytes, MAX_SLICE_BYTES);
            } catch {
              continue;
            }
            if (typeof parsed !== "object" || parsed === null) continue;
            const entry = parsed as {
              request?: { url?: unknown; postData?: { text?: unknown } };
              response?: { content?: { text?: unknown; encoding?: unknown } };
            };
            inputs.push({
              entryIndex: item.index,
              url: typeof entry.request?.url === "string" ? entry.request.url : "",
              bodyText:
                typeof entry.response?.content?.text === "string"
                  ? entry.response.content.text
                  : null,
              encoding:
                typeof entry.response?.content?.encoding === "string"
                  ? entry.response.content.encoding
                  : null,
              requestBodyText:
                typeof entry.request?.postData?.text === "string"
                  ? entry.request.postData.text
                  : null,
            });
          }
          const res = validateHarEntries(schema, inputs, filter);
          const out: ValidationResult[] = Array.from({ length: batch.items.length }, () => ({
            valid: true,
            failures: [],
            truncated: false,
            checkedEntries: 0,
          }));
          out[0] = res;
          return out;
        },
        {
          concurrency: Math.max(1, doc.pool.size),
          includeKeys: false,
          collectResults: false,
          signal: controller.signal,
          onOrderedResult: (outcome) => {
            if (!outcome.ok) return;
            checkedEntries += outcome.value.checkedEntries;
            for (const f of outcome.value.failures) {
              if (failures.length >= MAX_SCHEMA_FAILURES) break;
              failures.push(f);
            }
            if (failures.length >= MAX_SCHEMA_FAILURES) controller.abort();
          },
        },
      );
      return {
        valid: failures.length === 0,
        failures,
        truncated: failures.length >= MAX_SCHEMA_FAILURES,
        checkedEntries,
      };
    }

    const size = this.docSize(doc.doc);
    if (size > MAX_SLICE_BYTES) {
      throw new SliceTooLargeError({ bytes: size, limit: MAX_SLICE_BYTES });
    }
    const slice = await this.readLogical(doc.doc, 0, size);
    return validateJsonSlice(schema, slice);
  }

  private async codegen(
    ref: NodeRef,
    options: CodegenOptions,
    shape?: Shape,
  ): Promise<CodegenResult> {
    const resolved =
      shape ??
      (await this.inferSchema(ref, {
        maxEnum: options.maxEnum,
        maxDepth: DEFAULT_MAX_INFER_DEPTH,
      }));
    return generateFromShape(resolved, options);
  }

  /** Runs `make` once per document and key; a failure is not remembered. */
  private memo<T>(document: OpenDocument, key: string, make: () => Promise<T>): Promise<T> {
    const known = document.memo.get(key) as Promise<T> | undefined;
    if (known) return known;
    const started = make();
    document.memo.set(key, started);
    started.catch(() => document.memo.delete(key));
    return started;
  }

  private async expandNested(ref: NodeRef): Promise<EngineResult["expandNested"]> {
    const { document, record, token, tapeId } = await this.settled(ref);
    return this.expandNestedResolved(document, record, token, tapeId, ref);
  }

  /**
   * Indexes a string that holds JSON as a nested document over its unescaped
   * bytes, editable on its own. A string already expanded
   * answers with the same document; two expansions in flight index it once.
   */
  private async expandNestedResolved(
    document: OpenDocument,
    record: TapeRecord,
    token: number,
    tapeId: number,
    ref: NodeRef,
  ): Promise<EngineResult["expandNested"]> {
    if (record.tape.kind(token) !== KIND_STRING) throw new NotNestedJsonError({ ref });
    const existing = record.doc.children.get(`${tapeId}:${token}`);
    if (existing) {
      const root = document.tapes.get(existing.child.rootTapeId) as TapeRecord;
      return {
        root: this.summary(document, existing.child.rootTapeId, root, 0),
        bytes: this.docSize(existing.child),
      };
    }
    const key = `${tapeId}:${token}:nested`;
    const expanding = this.memo(document, key, async () => {
      const contentStart = record.tape.start(token) + 1;
      const contentEnd = record.tape.end(token) - 1;
      const length = contentEnd - contentStart;
      if (length > MAX_SLICE_BYTES)
        throw new SliceTooLargeError({ bytes: length, limit: MAX_SLICE_BYTES });
      const head = await this.unescapedHead(record, contentStart, contentEnd, NESTED_HEAD_BYTES);
      if (!looksLikeJson(head.bytes)) throw new NotNestedJsonError({ ref });
      const { shared, total } = await this.unescapeShared(
        document,
        record,
        contentStart,
        contentEnd,
      );
      const nested = await this.indexMemory(document, shared, total, { record, tapeId, token });
      if (!nested) throw new NotNestedJsonError({ ref });
      return nested;
    });
    // Only the expansion in flight is shared: once done, the link above answers, and a
    // dropped link must index again rather than hand back a tape that is gone.
    void expanding.then(
      () => document.memo.delete(key),
      () => {},
    );
    return expanding;
  }

  /** Unescapes a string's content in parallel pieces into one buffer every worker can open. */
  private async unescapeShared(
    document: OpenDocument,
    record: TapeRecord,
    contentStart: number,
    contentEnd: number,
  ) {
    const length = contentEnd - contentStart;
    if (length > MAX_SLICE_BYTES)
      throw new SliceTooLargeError({ bytes: length, limit: MAX_SLICE_BYTES });
    if (typeof SharedArrayBuffer !== "function") {
      throw new EngineWorkerError({
        detail: "SharedArrayBuffer is unavailable: the page is not cross-origin isolated",
      });
    }
    const pool = document.pool;
    // One piece per worker, more when a piece would otherwise read past MAX_SLICE_BYTES.
    const parts = Math.max(pool.size, Math.ceil(length / PIECE_BYTES));
    const pieceBytes = Math.max(1, Math.ceil(length / parts));
    // Every worker writes its piece into one shared buffer, each in its own padded slot (an escape
    // that straddles the end of a piece writes a few bytes past it); the slots are then closed up.
    const slot = (w: number) => w * (pieceBytes + 8);
    const shared = new SharedArrayBuffer(parts * (pieceBytes + 8) + 8);
    const lengths = await Promise.all(
      Array.from({ length: parts }, async (_, w) => {
        const start = contentStart + w * pieceBytes;
        const end = Math.min(contentEnd, start + pieceBytes);
        if (start >= end) return 0;
        const result = await pool.call<Unescaped>(w % pool.size, {
          type: "unescape",
          sourceId: record.sourceId,
          contentStart,
          contentEnd,
          start,
          end,
          target: shared,
          targetOffset: slot(w),
        });
        return result.length;
      }),
    );
    const view = new Uint8Array(shared);
    let total = 0;
    lengths.forEach((n, w) => {
      if (n > 0 && slot(w) !== total) view.copyWithin(total, slot(w), slot(w) + n);
      total += n;
    });
    return { shared, total };
  }

  /** Indexes bytes held in a shared buffer as a child tape; null when they are not one JSON value. */
  private async indexMemory(
    document: OpenDocument,
    shared: SharedArrayBuffer,
    total: number,
    /** The string the bytes were unescaped from; null for bytes a decoder generated. */
    from: { readonly record: TapeRecord; readonly tapeId: number; readonly token: number } | null,
  ): Promise<NestedDocument | null> {
    if (total === 0) return null;
    const pool = document.pool;
    const sourceId = document.nextSourceId++;
    await pool.broadcast({
      type: "open",
      sourceId,
      spec: { kind: "memory", buffer: shared, byteOffset: 0, byteLength: total },
    });
    const tape = new SegmentedTape();
    const stats = await indexDocument(pool, sourceId, total, {
      target: tape,
      regionBytes: Math.max(64 * 1024, Math.ceil(total / pool.size)),
      tokenBudget: this.tokenBudget,
    });
    const view = new Uint8Array(shared, 0, total);
    if (!isCleanIndex(tape, view)) {
      this.closeSource(document, sourceId);
      return null;
    }
    const childTapeId = document.nextTapeId++;
    const original = Object.assign(memorySource(view), { bytes: view });
    const link: ChildLink | null =
      from === null
        ? null
        : {
            parent: from.record.doc,
            tapeId: from.tapeId,
            token: from.token,
            child: undefined as unknown as Doc,
            escaped: null,
          };
    const child = this.createDoc(
      document,
      childTapeId,
      original,
      sourceId,
      document.nextSourceId++,
      link,
    );
    const childRecord: TapeRecord = {
      doc: child,
      tape,
      source: original,
      sourceId,
      size: total,
      level: child.top,
      anchors: stats.anchors,
      bigStrings: stats.bigStrings,
      buckets: new Map(),
      childSkips: new Map(),
      hints: new Map(),
    };
    document.tapes.set(childTapeId, childRecord);
    if (link !== null && from !== null) {
      (link as { child: Doc }).child = child;
      from.record.doc.children.set(`${from.tapeId}:${from.token}`, link);
    }
    return { root: this.summary(document, childTapeId, childRecord, 0), bytes: total };
  }

  /** The members of an object that say what its strings are: `mimeType` and `encoding`. */
  private async hintsOf(document: OpenDocument, record: TapeRecord, parent: number) {
    const known = record.hints.get(parent);
    if (known) return known;
    const hints: { mimeType: string | null; encoding: string | null } = {
      mimeType: null,
      encoding: null,
    };
    const tape = record.tape;
    if (tape.kind(parent) === KIND_OBJECT && tape.childCount(parent) <= 32) {
      let child = firstChild(tape, parent);
      for (let seen = 0; child >= 0 && seen < 32; seen++, child = tape.next(child)) {
        const keyStart = tape.keyStart(child);
        if (tape.kind(child) !== KIND_STRING || keyStart === NO_KEY) continue;
        const end = tape.end(child);
        if (end - keyStart > 512) continue;
        const bytes = await this.read(record, keyStart, end);
        const keyEnd = stringEnd(bytes, 0);
        if (keyEnd < 0) continue;
        const key = decodeString(bytes, 0, keyEnd, MAX_KEY_BYTES);
        if (key !== "mimeType" && key !== "encoding") continue;
        const valueStart = tape.start(child) - keyStart;
        const value = decodeString(bytes, valueStart, bytes.byteLength, MAX_KEY_BYTES);
        if (key === "mimeType") hints.mimeType = value;
        else hints.encoding = value;
      }
    }
    record.hints.set(parent, hints);
    return hints;
  }

  private async stringAccess(ref: NodeRef): Promise<StringAccess> {
    const { document, record, token } = await this.settled(ref);
    const tape = record.tape;
    if (tape.kind(token) !== KIND_STRING) throw new NodeNotFoundError({ ref });
    const start = tape.start(token) + 1;
    const end = tape.end(token) - 1;
    const keyStart = tape.keyStart(token);
    let key: string | null = null;
    if (keyStart !== NO_KEY && keyStart < MAX_TAPE_SOURCE_BYTES - 1) {
      const bytes = await this.read(record, keyStart, Math.min(tape.start(token), keyStart + 258));
      const keyEnd = stringEnd(bytes, 0);
      if (keyEnd > 0) key = decodeString(bytes, 0, keyEnd, MAX_KEY_BYTES);
    }
    const parent = tape.parent(token);
    const hints =
      parent >= 0 && parent < tape.count
        ? await this.hintsOf(document, record, parent)
        : { mimeType: null, encoding: null };
    const pool = document.pool;
    const sourceId = record.sourceId;
    // The string from a raw byte on: the whole string, or the payload after a `data:` URL's comma.
    const accessFrom = (start: number): StringAccess => {
      const rawLength = end - start;
      const pieces = async (limit: number) => {
        // Alignment: every piece but the last is a multiple of 4 raw bytes.
        const raw = end - start;
        if (Math.ceil(raw / 4) * 3 > limit + Math.ceil(raw / 8) + 64) {
          throw new SliceTooLargeError({ bytes: Math.ceil(raw / 4) * 3, limit });
        }
        const step = Math.max(4, Math.ceil(raw / pool.size / 4) * 4);
        const results = await Promise.all(
          Array.from({ length: pool.size }, (_, w) => {
            const from = start + w * step;
            const to = Math.min(end, from + step);
            return from < to
              ? pool.call<Base64PieceResult>(w, {
                  type: "base64Piece",
                  sourceId,
                  start: from,
                  end: to,
                })
              : Promise.resolve<Base64PieceResult>({
                  bytes: new Uint8Array(0),
                  invalid: 0,
                  shifted: 0,
                });
          }),
        );
        const aligned = results.every((r) => r.shifted === 0 && r.invalid === 0);
        const parts = aligned
          ? results
          : [await pool.call<Base64PieceResult>(0, { type: "base64Piece", sourceId, start, end })];
        let total = 0;
        for (const part of parts) total += part.bytes.byteLength;
        if (total > limit) throw new SliceTooLargeError({ bytes: total, limit });
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          out.set(part.bytes, offset);
          offset += part.bytes.byteLength;
        }
        return out;
      };
      return {
        ref,
        rawLength,
        context: { key, mimeType: hints.mimeType, encoding: hints.encoding },
        head: async (bytes) => (await this.unescapedHead(record, start, end, bytes)).bytes,
        unescaped: async (limit) => {
          if (rawLength > limit) throw new SliceTooLargeError({ bytes: rawLength, limit });
          const raw = await this.read(record, start, end);
          const out = new Uint8Array(raw.byteLength);
          return out.subarray(0, unescapeBytes(raw, 0, raw.byteLength, out, 0));
        },
        unescapedShared: async () => {
          const { shared, total } = await this.unescapeShared(document, record, start, end);
          return { view: new Uint8Array(shared, 0, total) };
        },
        base64Head: (decodedBytes) =>
          pool.call<Uint8Array>(0, {
            type: "base64Head",
            sourceId,
            start,
            end,
            decodedBytes,
          }),
        rawTail: (bytes) => this.read(record, Math.max(start, end - bytes), end),
        rawHead: (bytes) => this.read(record, start, Math.min(end, start + bytes)),
        from: (rawOffset) => accessFrom(Math.min(end, start + rawOffset)),
        base64All: pieces,
        base64Blob: (mime, stepBytes) => {
          if (Math.ceil(rawLength / 4) * 3 > MAX_SLICE_BYTES + Math.ceil(rawLength / 8) + 64) {
            throw new SliceTooLargeError({
              bytes: Math.ceil(rawLength / 4) * 3,
              limit: MAX_SLICE_BYTES,
            });
          }
          return pool.call<Blob>(0, { type: "base64Blob", sourceId, start, end, mime, stepBytes });
        },
        adopt: async (bytes) => {
          if (bytes.byteLength > MAX_SLICE_BYTES)
            throw new SliceTooLargeError({ bytes: bytes.byteLength, limit: MAX_SLICE_BYTES });
          if (typeof SharedArrayBuffer !== "function") return null;
          const shared = new SharedArrayBuffer(bytes.byteLength);
          new Uint8Array(shared).set(bytes);
          return this.indexMemory(document, shared, bytes.byteLength, null);
        },
        expandNested: async () => {
          try {
            return await this.expandNested(ref);
          } catch (error) {
            if (isNotNested(error)) return null;
            throw error;
          }
        },
      };
    };
    return accessFrom(start);
  }

  private async detect(ref: NodeRef): Promise<EngineResult["detect"]> {
    return detectAccess(await this.stringAccess(ref));
  }

  private async decode(ref: NodeRef, kind: DecoderKind): Promise<EngineResult["decode"]> {
    const access = await this.stringAccess(ref);
    const { document } = await this.settled(ref);
    return this.memo(document, `${ref.tapeId}:${ref.token}:${kind}`, () =>
      decodeAccess(access, kind),
    );
  }

  private async preview(ref: NodeRef): Promise<EngineResult["preview"]> {
    const access = await this.stringAccess(ref);
    const { document } = await this.settled(ref);
    return this.memo(document, `${ref.tapeId}:${ref.token}:preview`, () => previewAccess(access));
  }

  /** The frames [from, from + count) of a HAR `_webSocketMessages` array, read by their members. */
  private async frames(ref: NodeRef, from: number, count: number): Promise<EngineResult["frames"]> {
    const page = await this.children(ref, from, count);
    const frames: WebSocketFrame[] = [];
    let index = from;
    for (const node of page.nodes) {
      frames.push(await this.frame(node, index++));
    }
    return { from, total: page.total, frames };
  }

  private async frame(node: NodeSummary, index: number): Promise<WebSocketFrame> {
    const members = await this.children(node.ref, 0, 16);
    let direction: WebSocketFrame["direction"] = "unknown";
    let time: number | null = null;
    let opcode: number | null = null;
    let dataRef: NodeRef | null = null;
    for (const member of members.nodes) {
      const key = await this.keyText(member.ref);
      if (key === "data" && member.kind === "string") dataRef = member.ref;
      else if (key === "type" && member.kind === "string") {
        const value = (await this.text(member.ref, 16)).text;
        direction = value === "send" || value === "receive" ? value : "unknown";
      } else if (key === "time" && member.kind === "number") {
        const value = Number((await this.text(member.ref, 32)).text);
        time = Number.isFinite(value) ? value : null;
      } else if (key === "opcode" && member.kind === "number") {
        const value = Number((await this.text(member.ref, 8)).text);
        opcode = Number.isInteger(value) ? value : null;
      }
    }
    const base = { index, ref: node.ref, direction, time, opcode };
    if (!dataRef) {
      return { ...base, size: 0, preview: "", mime: null, dataRef: null, detections: [] };
    }
    const access = await this.stringAccess(dataRef);
    if (opcode === 2) {
      const summary = await base64Summary(access, 256);
      const printable =
        summary.sniffed.kind === "text" ? decodeUtf8(summary.head.subarray(0, 120)) : "";
      return {
        ...base,
        size: summary.bytes,
        preview: printable,
        mime: summary.sniffed.mime,
        dataRef,
        detections: [],
      };
    }
    const head = await access.head(FRAME_PREVIEW_BYTES);
    const preview = decodeUtf8(head.subarray(0, utf8Boundary(head, FRAME_PREVIEW_BYTES)));
    return {
      ...base,
      size: access.rawLength,
      preview,
      mime: null,
      dataRef,
      detections: await detectAccess(access),
    };
  }

  /** The skip list's biggest strings as nodes (large bodies and nested documents), found in O(1). */
  private async largestStrings(documentId: number, limit: number): Promise<NodeSummary[]> {
    const document = this.document(documentId);
    await this.ready(document);
    const record = document.tapes.get(0) as TapeRecord;
    const big = record.bigStrings;
    const ranges = Array.from({ length: big.length >> 1 }, (_, i) => ({
      start: big[2 * i] as number,
      end: big[2 * i + 1] as number,
    }));
    ranges.sort((a, b) => b.end - b.start - (a.end - a.start));
    const nodes: NodeSummary[] = [];
    for (const range of ranges) {
      if (nodes.length >= limit) break;
      const token = tokenStartingAt(record.tape, range.start);
      if (
        token >= 0 &&
        record.tape.kind(token) === KIND_STRING &&
        !record.doc.top.regions.containing(range.start)
      ) {
        nodes.push(this.summary(document, 0, record, token));
      }
    }
    return nodes;
  }

  private async stringHead(ref: NodeRef, bytes: number): Promise<Uint8Array> {
    checkedLimit(bytes);
    const { record, token, tapeId } = await this.settled(ref);
    if (this.scalar(ref, record, token) !== KIND_STRING) throw new NodeNotFoundError({ ref });
    const dirty = this.dirtyChild(record, tapeId, token);
    if (dirty) {
      const size = this.docSize(dirty.child);
      const head = this.readLogicalSync(dirty.child, 0, Math.min(size, bytes));
      return head.slice(0, size > bytes ? utf8Boundary(head, bytes) : head.byteLength);
    }
    const head = await this.unescapedHead(
      record,
      record.tape.start(token) + 1,
      record.tape.end(token) - 1,
      bytes,
    );
    return head.bytes.slice();
  }

  private async decodeBase64Head(ref: NodeRef, decodedBytes: number): Promise<Uint8Array> {
    checkedLimit(decodedBytes);
    const { document, record, token } = await this.settled(ref);
    if (this.scalar(ref, record, token) !== KIND_STRING) throw new NodeNotFoundError({ ref });
    const start = record.tape.start(token) + 1;
    const end = record.tape.end(token) - 1;
    const available = Math.floor((end - start) / 4) * 3;
    const total = Math.min(decodedBytes, available);
    const pool = document.pool;
    // Each job decodes a run of whole quads, so no job reads more than 4 MiB of the string.
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(total / BASE64_JOB_BYTES) }, (_, i) =>
        pool.call<Uint8Array>(i % pool.size, {
          type: "base64Head",
          sourceId: record.sourceId,
          start: start + (i * BASE64_JOB_BYTES * 4) / 3,
          end,
          decodedBytes: Math.min(BASE64_JOB_BYTES, total - i * BASE64_JOB_BYTES),
        }),
      ),
    );
    return concat(parts, total);
  }

  /**
   * The rows around `offset`, colored from the index. The bytes read are the
   * rows' own plus a short lookback, so the cost follows the screen, not the
   * file.
   */
  private async sourceRows(
    documentId: number,
    offset: number,
    before: number,
    rows: number,
    wrapBytes: number,
  ): Promise<SourceRows> {
    const document = this.document(documentId);
    if (document.replayPending) await this.ready(document);
    // An edited document shows its edits: rows are cut from its logical bytes, and colored from
    // the index moved into those coordinates (`gatherLogical`).
    const edited = this.isDirty(document.doc);
    // A converted document shows the file; the index colors it only when its offsets are the file's.
    const display = document.display;
    const moved = this.indexMoved(document);
    const size = display
      ? display.source.size
      : edited
        ? this.docSize(document.doc)
        : document.size;
    const read = (start: number, end: number) =>
      display
        ? display.source.read(start, end)
        : edited
          ? this.readLogical(document.doc, start, end)
          : document.source.read(start, end);
    const paints = document.format !== "text" && (display === null || display.sameOffsets);
    const layout = await layoutRows({ size, read }, display?.lineCounts ?? document.lineCounts, {
      offset,
      before,
      rows,
      wrapBytes,
      ...(this.sourceBlockBytes === undefined ? {} : { blockBytes: this.sourceBlockBytes }),
    });
    const first = layout.rows[0];
    const last = layout.rows[layout.rows.length - 1];
    if (first === undefined || last === undefined) {
      return { rows: [], size, atStart: layout.atStart, atEnd: layout.atEnd };
    }
    const lookback = Math.max(0, first.start - SOURCE_LOOKBACK_BYTES);
    const bytes = await read(lookback, last.end);
    let spans: ReadonlyArray<{
      readonly from: number;
      readonly to: number;
      readonly kind: SourceSpan["kind"];
      readonly depth: number;
      readonly container: SourceSpan["container"];
    }> = [];
    if (paints && last.end > first.start) {
      await document.firstRegion;
      const gathered = moved
        ? await this.gatherLogical(document, first.start, last.end)
        : await this.gather(document, first.start, last.end);
      spans = paintJson({
        bytes,
        base: lookback,
        from: first.start,
        to: last.end,
        chain: gathered.chain,
        tokens: gathered.tokens,
      });
    }
    let cursor = 0;
    const out = layout.rows.map((row) => {
      const rowBytes = bytes.subarray(row.start - lookback, row.textEnd - lookback);
      const ascii = isAscii(rowBytes);
      while (cursor < spans.length && (spans[cursor] as { to: number }).to <= row.start) cursor++;
      const rowSpans: SourceSpan[] = [];
      let u16Bytes = 0;
      let u16Units = 0;
      const toUnits = (byteOffset: number) => {
        if (ascii) return byteOffset;
        if (byteOffset > u16Bytes) {
          u16Units += decodeUtf8(rowBytes.subarray(u16Bytes, byteOffset)).length;
          u16Bytes = byteOffset;
        }
        return u16Units;
      };
      for (let i = cursor; i < spans.length; i++) {
        const span = spans[i] as (typeof spans)[number];
        if (span.from >= row.textEnd) break;
        const from = Math.max(span.from, row.start) - row.start;
        const to = Math.min(span.to, row.textEnd) - row.start;
        if (from >= to) continue;
        rowSpans.push({
          from: toUnits(from),
          to: toUnits(to),
          kind: span.kind,
          depth: span.depth,
          container: span.container,
        });
      }
      return {
        start: row.start,
        end: row.end,
        text: decodeUtf8(rowBytes),
        line: row.line,
        column: row.column,
        indent: row.indent,
        spans: rowSpans,
      };
    });
    return { rows: out, size, atStart: layout.atStart, atEnd: layout.atEnd };
  }

  /**
   * The tokens the painter needs for `[a, b)`: those that contain `a`, then those
   * that start in the range, descending into cut containers through their
   * on-demand buckets. While the index runs, a range the merged prefix does not
   * cover waits for the index, as every other query does.
   */
  private async gather(document: OpenDocument, a: number, b: number): Promise<Gathered> {
    for (;;) {
      const out: Gathered = { chain: [], tokens: [], needsIndex: false, bucketBase: new Map() };
      const record = document.tapes.get(0) as TapeRecord;
      await this.collect(document, 0, record, a, b, out, true);
      if (!out.needsIndex) return out;
      await document.indexed;
    }
  }

  /**
   * `gather` for an edited document, in its document-logical coordinates. The
   * tapes keep the offsets they were scanned with, so each level is walked in its
   * own coordinates and every token it yields is moved by the regions before it;
   * a region's token is replaced by its side tape's tokens, and tokens under a
   * region are dropped. Dirty nested documents grow their strings: positions
   * past one move by the growth (`docLogical`).
   */
  private async gatherLogical(document: OpenDocument, a: number, b: number): Promise<Gathered> {
    await this.ready(document);
    const doc = document.doc;
    const out: Gathered = { chain: [], tokens: [], needsIndex: false, bucketBase: new Map() };
    const record = document.tapes.get(0) as TapeRecord;
    await this.collectLogical(
      document,
      0,
      record,
      0,
      this.pieceOfDocLogical(doc, a),
      Math.max(this.pieceOfDocLogical(doc, a), this.pieceOfDocLogical(doc, b)),
      out,
      true,
    );
    return out;
  }

  /** One level of `gatherLogical`: `base` is the level's first byte, `[a, b)` is piece-logical. */
  private async collectLogical(
    document: OpenDocument,
    tapeId: number,
    record: TapeRecord,
    base: number,
    a: number,
    b: number,
    out: Gathered,
    seed: boolean,
  ): Promise<void> {
    const doc = record.doc;
    const level = record.level;
    const regions = level.regions;
    const from = regions.fileOf(Math.max(0, a - base));
    const to = Math.max(from, regions.fileOf(Math.max(0, b - base), true));
    const found: Gathered = {
      chain: [],
      tokens: [],
      needsIndex: false,
      bucketBase: out.bucketBase,
    };
    await this.collect(document, tapeId, record, from, to, found, seed);
    const move = (offset: number) => this.docLogical(doc, base + regions.logical(offset));
    const moved = (token: GatheredToken): GatheredToken => ({
      ...token,
      start: move(token.start),
      end: move(token.end),
      keyStart: token.keyStart < 0 ? -1 : move(token.keyStart),
    });
    const regionOf = (token: GatheredToken) =>
      token.tapeId === level.tapeId
        ? regions.regionOf(token.token)
        : this.bucketRegionOf(
            level,
            (document.tapes.get(token.tapeId) as TapeRecord).tape,
            token.token,
          );
    const dead = (token: GatheredToken) =>
      regions.containing(token.keyStart < 0 ? token.start : token.keyStart) !== undefined;
    const descend = async (region: Region) => {
      const side = this.sideRecord(document, level, region);
      const sideTapeId = level.sideTapes.get(region.token);
      if (side === undefined || sideTapeId === undefined) return;
      const sideBase = base + regions.logicalStart(region);
      const holdsA = a >= sideBase && a < sideBase + region.length;
      await this.collectLogical(document, sideTapeId, side, sideBase, a, b, out, seed && holdsA);
    };
    for (const token of found.chain) {
      const region = regionOf(token);
      if (region !== undefined) {
        // Everything deeper on this tape is under the region: its side tape continues the chain.
        await descend(region);
        break;
      }
      if (dead(token)) break;
      out.chain.push(moved(token));
    }
    for (const token of found.tokens) {
      const region = regionOf(token);
      if (region !== undefined) await descend(region);
      else if (!dead(token)) out.tokens.push(moved(token));
    }
  }

  /** Document-logical → piece-logical; a position inside a dirty nested document's string maps into that string. */
  private pieceOfDocLogical(doc: Doc, at: number) {
    let shift = 0;
    for (const overlay of this.overlays(doc)) {
      const start = overlay.start + shift;
      if (at < start) break;
      if (at < start + overlay.escaped) return Math.min(overlay.end, overlay.start + (at - start));
      shift += overlay.escaped - (overlay.end - overlay.start);
    }
    return at - shift;
  }

  /**
   * A node's position among its parent's children: on its tape, or for the root
   * of a bucket tape from the bucket's first index, or for the root of a side
   * tape, the position of the region's token it stands for.
   */
  private rankInParent(
    document: OpenDocument,
    tapeId: number,
    token: number,
    bucketBase: ReadonlyMap<number, number>,
  ): number | null {
    const record = document.tapes.get(tapeId) as TapeRecord;
    const parent = record.tape.parent(token);
    if (parent >= 0) return this.childRank(record, parent, token);
    const level = record.level;
    if (level.tapeId === tapeId) {
      if (level.host === null) return null;
      const region = level.host.region;
      if (region.token < 0) return region.ordinal ?? null;
      return this.rankInParent(document, level.host.level.tapeId, region.token, bucketBase);
    }
    let rank = 0;
    for (let root = 0; root >= 0 && root !== token; root = record.tape.next(root)) rank++;
    return (bucketBase.get(tapeId) ?? 0) + rank;
  }

  private descriptor(
    document: OpenDocument,
    tapeId: number,
    tape: Tape,
    token: number,
    out: Gathered,
  ): GatheredToken {
    const keyStart = tape.keyStart(token);
    const kind = tape.kind(token);
    if (
      tapeId === 0 &&
      !document.live.done &&
      !isContainer(kind) &&
      document.live.unsettled.has(token)
    ) {
      out.needsIndex = true;
    }
    return {
      kind,
      start: tape.start(token),
      end: tape.end(token),
      keyStart: keyStart >= MAX_TAPE_SOURCE_BYTES - 1 ? -1 : keyStart,
      tapeId,
      token,
    };
  }

  private async collect(
    document: OpenDocument,
    tapeId: number,
    record: TapeRecord,
    a: number,
    b: number,
    out: Gathered,
    seed: boolean,
  ): Promise<void> {
    const tape = record.tape;
    const n = tape.count;
    const prefix = tapeId === 0 && !document.live.done;
    if (prefix && n > 0 && b > tape.start(n - 1)) out.needsIndex = true;
    let j = -1;
    if (seed && n > 0) {
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tape.start(mid) <= a) {
          j = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const up: number[] = [];
      for (let t = j; t >= 0; t = tape.parent(t)) {
        if (tape.end(t) > a || (prefix && document.live.unsettled.has(t))) up.push(t);
      }
      for (let k = up.length - 1; k >= 0; k--) {
        out.chain.push(this.descriptor(document, tapeId, tape, up[k] as number, out));
      }
      const deepest = up[0];
      if (deepest !== undefined && needsExpand(tape, deepest)) {
        await this.expandCut(document, tapeId, record, deepest, a, b, out, true);
      }
    }
    for (let i = j + 1; i < n; i++) {
      const keyStart = tape.keyStart(i);
      const region = keyStart >= MAX_TAPE_SOURCE_BYTES - 1 ? tape.start(i) : keyStart;
      if (region >= b) break;
      out.tokens.push(this.descriptor(document, tapeId, tape, i, out));
      if (needsExpand(tape, i)) {
        await this.expandCut(document, tapeId, record, i, tape.start(i) + 1, b, out, false);
      }
    }
  }

  /** Runs `work` after every earlier edit or save of the document has finished. */
  private serialized<T>(document: OpenDocument, work: () => Promise<T>): Promise<T> {
    const run = document.mutex.then(work, work);
    document.mutex = run.catch(() => {});
    return run;
  }

  /** Called after every change to a document's bytes: bumps the revision and tells the views. */
  private editResult(document: OpenDocument, node: NodeSummary, doc: Doc): EditResult {
    document.harPrintsCache = null;
    this.tableIndex.invalidateDocument(document.id);
    document.revision++;
    if (!document.replaying) this.emitEditState(document);
    return {
      node,
      size: this.docSize(doc),
      undoDepth: document.undoStack.length,
      redoDepth: document.redoStack.length,
      dirty: this.isUnsaved(document),
    };
  }

  /**
   * Copies the file the document reads into scratch storage and reads the copy
   * from then on: the document (pieces, tapes, history, the Source view) stands
   * on the file's bytes as they were opened, and a save in place is about to
   * replace them. Done once; a document already reading a copy is left alone.
   */
  private async detach(documentId: number): Promise<null> {
    const document = this.document(documentId);
    if (document.detached !== null) return null;
    await this.ready(document);
    return this.serialized(document, async () => {
      const display = document.display;
      const file = display === null ? document.source : display.source;
      const scratch = this.platform.formats
        ? await this.platform.formats.scratch()
        : memoryScratchFile();
      try {
        await copyRange(file, 0, file.size, scratch.sink);
        await scratch.sink.close();
      } catch (error) {
        await scratch.sink.abort().catch(() => {});
        await scratch.release();
        throw error;
      }
      const copy = await scratch.finish();
      const bytes = documentBytes(copy);
      if (display !== null) {
        // A converted document indexes its own JSON; only the Source view reads the file.
        (display as { source: ByteSource }).source = bytes.source;
      } else {
        await document.pool.openEach(DOCUMENT_SOURCE_ID, bytes.workerSpec);
        if (document.regexPool !== null) {
          await (await document.regexPool).openEach(DOCUMENT_SOURCE_ID, bytes.workerSpec);
        }
        for (const record of document.tapes.values()) {
          if (record.source === file) (record as { source: ByteSource }).source = bytes.source;
        }
        (document.doc as { original: ByteSource }).original = bytes.source;
        (document as { source: ByteSource }).source = bytes.source;
        (document as { bytes: DocumentBytes }).bytes = bytes;
        (document as { indexedBlob: Blob | null }).indexedBlob = copy;
      }
      file.close();
      document.detached = () => scratch.release();
      return null;
    });
  }

  /**
   * The first byte the index found not to be JSON, as a line, a column and a
   * sentence. Lines are counted once, on request, in bounded reads up to the byte.
   */
  private problem(documentId: number): Promise<EngineResult["problem"]> {
    const document = this.document(documentId);
    document.problemText ??= document.structured.then(
      async () => {
        const found = document.syntax;
        if (found === null) return null;
        // JSONC's index is over its blanked copy, at the file's offsets; the file has the text.
        const source = document.display?.sameOffsets ? document.display.source : document.source;
        const { line, column } = await lineAndColumn(source, found.offset);
        const label = document.display?.sameOffsets ? "JSONC" : "JSON";
        const near =
          found.offset < source.size ? await source.read(found.offset, found.offset + 1) : null;
        return {
          offset: found.offset,
          line,
          column,
          message: `Not valid ${label}: ${describeProblem(found.code, near?.[0])} at line ${line}, column ${column}`,
          readsAsJsonc:
            label === "JSON" &&
            (found.code === "trailing-comma" ||
              (found.code === "unexpected" && near?.[0] === 0x2f)),
        };
      },
      () => null,
    );
    return document.problemText;
  }

  /** The history differs from what was opened or last saved. */
  private isUnsaved(document: OpenDocument) {
    return (document.undoStack[document.undoStack.length - 1] ?? null) !== document.savedTop;
  }

  private editStateOf(document: OpenDocument): EditState {
    return {
      documentId: document.id,
      undoDepth: document.undoStack.length,
      redoDepth: document.redoStack.length,
      dirty: this.isUnsaved(document),
      size: this.docSize(document.doc),
      revision: document.revision,
      replaying: document.replayPending,
      restoreFailed: document.restoreFailed,
    };
  }

  private emitEditState(document: OpenDocument) {
    if (!this.documents.has(document.id)) return;
    this.onEvent?.({ _tag: "editState", state: this.editStateOf(document) });
  }

  private async dropJournal(documentId: number): Promise<null> {
    const document = this.document(documentId);
    await this.ready(document).catch(() => {});
    await this.serialized(document, () => document.journal?.reset() ?? Promise.resolve());
    return null;
  }

  private async editState(documentId: number): Promise<EditState> {
    const document = this.document(documentId);
    await this.ready(document).catch(() => {});
    return this.editStateOf(document);
  }

  private async setValue(ref: NodeRef, json: string): Promise<EditResult> {
    const { document, record, token } = await this.settled(ref);
    return this.serialized(document, async () => {
      const tape = record.tape;
      const start = this.docLogical(record.doc, this.pieceLogical(record, tape.start(token)));
      const end = this.docLogical(record.doc, this.pieceLogical(record, tape.end(token)));
      const node = await this.edit(record.doc, start, end - start, utf8.encode(json));
      return this.editResult(document, node, record.doc);
    });
  }

  private async setKey(ref: NodeRef, key: string): Promise<EditResult> {
    const { document, record, token, tapeId } = await this.settled(ref);
    return this.serialized(document, async () => {
      await this.refuseDuplicateKey(document, { record, token, tapeId }, key);
      const range = await this.keyRange(record, token, ref);
      const start = this.docLogical(record.doc, this.pieceLogical(record, range.keyStart));
      const node = await this.edit(
        record.doc,
        start,
        range.keyEnd - range.keyStart,
        utf8.encode(JSON.stringify(key)),
      );
      return this.editResult(document, node, record.doc);
    });
  }

  /**
   * Refuses a rename to a key another member of the same object has: the edit
   * would write an object with the key twice, which most readers resolve by
   * dropping one of the values. Objects over the sort cap are not checked.
   */
  private async refuseDuplicateKey(
    document: OpenDocument,
    member: { readonly record: TapeRecord; readonly token: number; readonly tapeId: number },
    key: string,
  ) {
    const parent = this.parentRef(document, member.tapeId, member.record, member.token);
    if (parent === null) return;
    const parentRef = { documentId: document.id, tapeId: parent.tapeId, token: parent.token };
    const { childCount } = await this.node(parentRef);
    if (childCount > MAX_SORT_CHILDREN) return;
    for (let from = 0; from < childCount; from += CHILDREN_PAGE_LIMIT) {
      const page = await this.children(
        parentRef,
        from,
        Math.min(CHILDREN_PAGE_LIMIT, childCount - from),
      );
      for (const sibling of page.nodes) {
        if (sibling.ref.tapeId === member.tapeId && sibling.ref.token === member.token) continue;
        if ((await this.keyText(sibling.ref)) !== key) continue;
        const shown =
          key.length > 60
            ? `${JSON.stringify(key.slice(0, 60)).slice(0, -1)}…"`
            : JSON.stringify(key);
        throw new EditRefusedError({
          detail: `This object already has a key named ${shown}. Rename that one first, or pick another name.`,
        });
      }
    }
  }

  /**
   * The container a token belongs to, across the tapes the index and the edits
   * made: its parent on its own tape; for the root of a bucket tape, the container
   * the bucket was cut from; for the root of a region's side tape, the parent of
   * the token the region replaced, or the container a bucket region recorded.
   * Null at a document's root.
   */
  private parentRef(
    document: OpenDocument,
    tapeId: number,
    record: TapeRecord,
    token: number,
  ): { readonly tapeId: number; readonly token: number } | null {
    const parent = record.tape.parent(token);
    if (parent >= 0) return { tapeId, token: parent };
    const bucket = document.bucketOrder.find((entry) => entry.tapeId === tapeId);
    if (bucket !== undefined) return { tapeId: bucket.ownerTapeId, token: bucket.token };
    const host = record.level.host;
    if (host === null) return null;
    if (host.region.token < 0) return host.region.parent ?? null;
    return this.parentRef(
      document,
      host.level.tapeId,
      this.levelRoot(document, host.level),
      host.region.token,
    );
  }

  private async replaceBytes(
    documentId: number,
    tapeId: number,
    start: number,
    end: number,
    bytes: Uint8Array,
  ): Promise<EditResult> {
    const document = this.document(documentId);
    await this.ready(document);
    const record = document.tapes.get(tapeId);
    if (!record) throw new NodeNotFoundError({ ref: { documentId, tapeId, token: 0 } });
    return this.serialized(document, async () => {
      const size = this.docSize(record.doc);
      if (start > end || end > size) {
        throw new InvalidEditError({
          detail: `range [${start}, ${end}) is outside the ${size}-byte document`,
        });
      }
      const node = await this.edit(record.doc, start, end - start, bytes);
      return this.editResult(document, node, record.doc);
    });
  }

  /**
   * One edit: splice the pieces, re-index the smallest enclosing value, record
   * the splice for undo. A dirty nested document in the range, or under the
   * value being re-indexed, is committed first: its re-escaped bytes become a
   * parent edit of their own (one more undo entry) and the child is dropped, so
   * the range still means the bytes the views showed. An edit that leaves no
   * value clean up to the root is rolled back and refused.
   */
  private edit(
    doc: Doc,
    at: number,
    deleteLength: number,
    bytes: Uint8Array,
  ): Promise<NodeSummary> {
    return this.editPieces(
      doc,
      at,
      deleteLength,
      () => doc.append.append(bytes),
      bytes.byteLength,
      undefined,
      bytes,
    );
  }

  /**
   * One edit, with the inserted bytes already in a buffer (the append buffer, or
   * a spill): commit the dirty nested documents in the way, splice the pieces,
   * re-index the smallest enclosing value, record the splice for undo and the
   * journal. A commit is not journaled: replaying the edit makes it again.
   */
  private async editPieces(
    doc: Doc,
    at: number,
    deleteLength: number,
    insert: () => Piece[],
    insertedLength: number,
    src: string | undefined,
    bytes?: Uint8Array,
  ): Promise<NodeSummary> {
    const document = doc.owner;
    for (;;) {
      const from = this.toPieceLogical(doc, at);
      const to = this.toPieceLogical(doc, at + deleteLength);
      const inside = from.inside ?? to.inside ?? this.overlayBetween(doc, from.at, to.at);
      if (inside) {
        await this.commitChild(doc, inside);
        continue;
      }
      try {
        const node = await this.splice(doc, from.at, to.at, insert(), insertedLength);
        if (document.journal && !document.replaying && !document.journalOff) {
          await document.journal.commit(
            {
              op: "edit",
              path: this.docPath(doc),
              at,
              del: deleteLength,
              off: src === undefined ? document.journal.nextAppendOffset : 0,
              len: insertedLength,
              ...(src === undefined ? {} : { src }),
            },
            bytes ? [bytes] : [],
          );
        }
        return node;
      } catch (error) {
        if (!(error instanceof CommitFirst)) throw error;
        for (const link of error.links) await this.commitChild(doc, link);
      }
    }
  }

  /** A container at the eager depth: its children come from the buckets that overlap `[lo, hi)`. */
  private async expandCut(
    document: OpenDocument,
    tapeId: number,
    record: TapeRecord,
    container: number,
    lo: number,
    hi: number,
    out: Gathered,
    seed: boolean,
  ): Promise<void> {
    if (!document.live.done) {
      out.needsIndex = true;
      return;
    }
    const anchors = record.anchors.get(container);
    if (!anchors || anchors.offset.length === 0) return;
    let bucket = Math.max(0, upperBound(anchors.offset, lo) - 1);
    for (let first = true; bucket < anchors.offset.length; bucket++, first = false) {
      if ((anchors.offset[bucket] as number) >= hi) break;
      const bucketTapeId = await this.bucketTape(document, tapeId, record, container, bucket);
      const bucketRecord = document.tapes.get(bucketTapeId) as TapeRecord;
      out.bucketBase.set(bucketTapeId, anchors.index[bucket] as number);
      await this.collect(document, bucketTapeId, bucketRecord, lo, hi, out, seed && first);
    }
  }

  /** The position of `token` among its parent's children, from the page-sized skip list. */
  private childRank(record: TapeRecord, parent: number, token: number): number {
    const tape = record.tape;
    let skips = record.childSkips.get(parent);
    if (!skips) {
      skips = [firstChild(tape, parent)];
      record.childSkips.set(parent, skips);
    }
    for (;;) {
      const last = skips[skips.length - 1] as number;
      if (last < 0 || last >= token) break;
      let child = last;
      for (let s = 0; s < CHILDREN_PAGE_LIMIT && child >= 0; s++) child = tape.next(child);
      if (child < 0) break;
      skips.push(child);
    }
    let lo = 0;
    let hi = skips.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((skips[mid] as number) <= token) lo = mid;
      else hi = mid - 1;
    }
    let child = skips[lo] as number;
    let rank = lo * CHILDREN_PAGE_LIMIT;
    while (child >= 0 && child !== token) {
      child = tape.next(child);
      rank++;
    }
    return child === token ? rank : 0;
  }

  /** The nodes that contain a byte offset, outermost first. */
  private async nodeAt(documentId: number, offset: number): Promise<NodePath> {
    const document = this.document(documentId);
    await document.firstRegion;
    if (document.format === "text") return { path: [] };
    if (this.indexMoved(document)) {
      // Offsets are the edited document's: walk the index through its regions.
      const gathered = await this.gatherLogical(document, offset, offset + 1);
      const path = gathered.chain.slice(0, SOURCE_PATH_LIMIT).map((step) => {
        const record = document.tapes.get(step.tapeId) as TapeRecord;
        return {
          node: this.summary(document, step.tapeId, record, step.token),
          index: this.rankInParent(document, step.tapeId, step.token, gathered.bucketBase),
        };
      });
      return { path };
    }
    const gathered = await this.gather(document, offset, offset + 1);
    const path = gathered.chain.slice(0, SOURCE_PATH_LIMIT).map((step) => {
      const record = document.tapes.get(step.tapeId) as TapeRecord;
      const parent = record.tape.parent(step.token);
      let index: number | null = null;
      if (parent >= 0) index = this.childRank(record, parent, step.token);
      else if (step.tapeId !== 0) {
        let rank = 0;
        for (let root = 0; root >= 0 && root !== step.token; root = record.tape.next(root)) rank++;
        index = (gathered.bucketBase.get(step.tapeId) ?? 0) + rank;
      }
      return { node: this.summary(document, step.tapeId, record, step.token), index };
    });
    // A click past the first problem lands in nothing the views list.
    const cut = document.syntax?.offset ?? null;
    const shown = cut === null ? path : path.filter((step) => step.node.range.start < cut);
    return { path: shown.length === path.length ? path : path.slice(0, shown.length) };
  }

  /** Replaces piece-logical [from, to) with `inserted`, re-indexes, and records the splice; rolled back on failure. */
  private async splice(doc: Doc, from: number, to: number, inserted: Piece[], length: number) {
    const document = doc.owner;
    const removed = doc.pieces.replaceRange(from, to - from, inserted);
    const splice: Splice = { at: from, removed, inserted };
    try {
      const node = await this.reindex(doc, from, from + length, length - (to - from));
      document.undoStack.push({ docTapeId: doc.rootTapeId, splice });
      document.redoStack.length = 0;
      this.invalidateEscaped(doc);
      return node;
    } catch (error) {
      doc.pieces.revert(splice);
      throw error;
    }
  }

  /** Writes a dirty nested document's re-escaped bytes into its parent's pieces as one edit, and drops it. */
  private async commitChild(doc: Doc, link: ChildLink) {
    const overlay = this.overlays(doc).find((o) => o.link === link);
    if (!overlay) {
      this.detachChild(link);
      return;
    }
    // Escape before dropping: the child's own dirty children are read through its tapes.
    const escaped = new Uint8Array(overlay.escaped);
    this.escapeOverlayInto(link, 0, overlay.escaped, escaped, 0);
    this.detachChild(link);
    await this.splice(
      doc,
      overlay.start,
      overlay.end,
      doc.append.append(escaped),
      escaped.byteLength,
    );
  }

  /** Dirty nested documents whose content span lies inside piece-logical [from, to). */
  private dirtyChildrenWithin(doc: Doc, from: number, to: number) {
    return this.overlays(doc)
      .filter((overlay) => overlay.start >= from && overlay.end <= to)
      .map((overlay) => overlay.link);
  }

  /** A dirty nested document whose content span lies inside piece-logical [from, to), if any. */
  private overlayBetween(doc: Doc, from: number, to: number) {
    for (const overlay of this.overlays(doc))
      if (overlay.start >= from && overlay.end <= to) return overlay.link;
    return null;
  }

  private detachChild(link: ChildLink) {
    link.parent.children.delete(`${link.tapeId}:${link.token}`);
    this.dropDoc(link.child);
  }

  /** A doc's bytes changed: its parent's escaped view of it is stale, all the way up. */
  private invalidateEscaped(doc: Doc) {
    for (let link = doc.parentLink; link; link = link.parent.parentLink) link.escaped = null;
    // The source view counts lines over the logical bytes, which just changed.
    doc.owner.lineCounts = createLineCounts();
  }

  /**
   * Re-indexes the smallest value enclosing piece-logical [from, to) after the
   * pieces changed by `delta` bytes inside it, at the deepest level whose one
   * region holds the whole span. Climbs to the parent whenever the re-scan does
   * not come out as exactly one value, and to the host level past a level's root.
   */
  private async reindex(doc: Doc, from: number, to: number, delta: number): Promise<NodeSummary> {
    const document = doc.owner;
    // Before the splice, the span occupied [from, to - delta) of the old logical bytes.
    const oldTo = Math.max(from, to - delta);
    let level = doc.top;
    for (;;) {
      const base = this.levelBase(level);
      const inside = level.regions.containingLogical(from - base);
      if (!inside) break;
      if (oldTo > from && level.regions.containingLogical(oldTo - 1 - base) !== inside) break;
      const side = this.sideRecord(document, level, inside);
      if (!side) break;
      level = side.level;
    }
    let base = this.levelBase(level);
    let tape = this.levelRoot(document, level).tape;
    let regions = level.regions;
    const fileStart = regions.fileOf(from - base);
    const fileEnd = oldTo > from ? regions.fileOf(oldTo - base, true) : fileStart;
    let token = enclosingToken(tape, regions, fileStart, fileEnd);
    const detail: string[] = [];
    // Inside a container the eager index cut, the value is on a bucket tape: re-index that value, not the container.
    if (
      token >= 0 &&
      needsExpand(tape, token) &&
      fileStart > tape.start(token) &&
      fileEnd < tape.end(token)
    ) {
      const element = await this.reindexInBucket(
        doc,
        level,
        token,
        fileStart,
        fileEnd,
        delta,
        detail,
      );
      if (element !== null) return element;
    }
    for (;;) {
      while (token >= 0) {
        const rs = regionStart(tape, token);
        const re = tape.end(token);
        const logicalStart = base + regions.logical(rs);
        const logicalEnd = base + regions.logical(re);
        // Positions here predate the splice, as the overlays' do; the caller commits these and retries.
        const pending = this.dirtyChildrenWithin(doc, logicalStart, logicalEnd);
        if (pending.length > 0) throw new CommitFirst(pending);
        const length = logicalEnd - logicalStart + delta;
        const built = await this.indexRegion(
          doc,
          logicalStart,
          length,
          this.entryFor(document, level, token),
          hasKey(tape.keyStart(token)),
        );
        if (built.clean) {
          return this.commitRegion(doc, level, token, rs, re, length, delta, built);
        }
        detail.push(built.reason);
        if (built.sourceId !== undefined) this.closeSource(document, built.sourceId);
        token = widerToken(tape, regions, token);
      }
      const host = level.host;
      if (!host) break;
      // Nothing at this level came out clean, its root (the region itself) included: widen at the host.
      level = host.level;
      base = this.levelBase(level);
      tape = this.levelRoot(document, level).tape;
      regions = level.regions;
      token =
        host.region.token < 0
          ? enclosingToken(tape, regions, host.region.fileStart, host.region.fileEnd)
          : widerToken(tape, regions, host.region.token);
    }
    throw new InvalidEditError({ detail: detail[detail.length - 1] ?? "empty document" });
  }

  /**
   * Re-indexes a value inside a container the eager index cut, which has no
   * token on the level's tape: the value is found on the bucket tape that holds
   * the edited span, and the smallest one there that re-scans clean becomes a
   * region of its own. Null when no value in the bucket covers the span (it
   * crosses elements) or none comes out clean: the caller re-indexes the container.
   */
  private async reindexInBucket(
    doc: Doc,
    level: Level,
    container: number,
    fileStart: number,
    fileEnd: number,
    delta: number,
    detail: string[],
  ): Promise<NodeSummary | null> {
    const document = doc.owner;
    const record = this.levelRoot(document, level);
    const anchors = record.anchors.get(container);
    if (anchors === undefined || anchors.offset.length === 0) return null;
    const bucket = Math.max(0, upperBound(anchors.offset, fileStart) - 1);
    const next = anchors.offset[bucket + 1];
    if (next !== undefined && fileEnd > next) return null;
    const bucketTapeId = await this.bucketTape(document, level.tapeId, record, container, bucket);
    const bucketRecord = document.tapes.get(bucketTapeId) as TapeRecord;
    const tape = bucketRecord.tape;
    const regions = level.regions;
    const base = this.levelBase(level);
    for (
      let token = coveringToken(tape, fileStart, fileEnd);
      token >= 0;
      token = tape.parent(token)
    ) {
      const rs = regionStart(tape, token);
      const re = tape.end(token);
      // A region crossing the value's edge cannot nest under it: try the parent.
      if (crossesRegion(regions, rs, re)) continue;
      const logicalStart = base + regions.logical(rs);
      const logicalEnd = base + regions.logical(re);
      const pending = this.dirtyChildrenWithin(doc, logicalStart, logicalEnd);
      if (pending.length > 0) throw new CommitFirst(pending);
      const length = logicalEnd - logicalStart + delta;
      const parent = tape.parent(token);
      const parentKind = parent >= 0 ? tape.kind(parent) : record.tape.kind(container);
      const built = await this.indexRegion(
        doc,
        logicalStart,
        length,
        insideEntry(parentKind),
        hasKey(tape.keyStart(token)),
      );
      if (!built.clean) {
        detail.push(built.reason);
        if (built.sourceId !== undefined) this.closeSource(document, built.sourceId);
        continue;
      }
      let ordinal: number;
      if (parent >= 0) ordinal = this.childRank(bucketRecord, parent, token);
      else {
        ordinal = anchors.index[bucket] ?? 0;
        for (let root = 0; root >= 0 && root !== token; root = tape.next(root)) ordinal++;
      }
      const depth = this.depthOf(document, bucketTapeId, bucketRecord, token);
      return this.commitRegion(doc, level, -(rs + 1), rs, re, length, delta, built, {
        ordinal,
        parentKind,
        depth,
        parent:
          parent >= 0
            ? { tapeId: bucketTapeId, token: parent }
            : { tapeId: level.tapeId, token: container },
      });
    }
    return null;
  }

  /** The scanner's state at a token's first byte: inside its parent container, across levels. */
  private entryFor(document: OpenDocument, level: Level, token: number): EntryState {
    const tape = this.levelRoot(document, level).tape;
    const parent = tape.parent(token);
    if (parent >= 0) return insideEntry(tape.kind(parent));
    return level.host
      ? level.host.region.token < 0
        ? insideEntry(level.host.region.parentKind ?? KIND_ARRAY)
        : this.entryFor(document, level.host.level, level.host.region.token)
      : INITIAL_ENTRY;
  }

  /** Indexes piece-logical [start, start + length) of the doc as a value (with its key when `keyed`) and checks it is exactly one. */
  private async indexRegion(
    doc: Doc,
    start: number,
    length: number,
    entry: EntryState,
    keyed: boolean,
  ) {
    const document = doc.owner;
    const slices = doc.pieces.slices(start, start + length);
    const source = pieceSource(slices, (i) => this.buffer(doc, i));
    let tape: Tape;
    let anchors: ReadonlyMap<number, BucketAnchors> = new Map();
    let bigStrings: ReadonlyArray<number> = [];
    // A worker-side window: the side tape's buckets, nested bodies and base64 heads read through it.
    const sourceId = await this.openWindow(doc, start, start + length);
    if (length <= this.inProcessRegionBytes) {
      const bytes = await source.read(0, length);
      const result = indexBytes(bytes, 0, {
        maxDepth: FULL_DEPTH,
        chunkBytes: Math.max(1, length),
        entry,
      });
      tape = result.tape;
      anchors = result.anchors;
      bigStrings = result.bigStrings;
    } else {
      const target = new SegmentedTape();
      const stats = await indexDocument(document.pool, sourceId, length, {
        target,
        regionBytes: this.regionBytes,
        tokenBudget: this.tokenBudget,
        initialEntry: entry,
      });
      tape = target;
      anchors = stats.anchors;
      bigStrings = stats.bigStrings;
    }
    const head = await source.read(0, Math.min(length, WS_PROBE_BYTES));
    const tail = await source.read(Math.max(0, length - WS_PROBE_BYTES), length);
    let first = 0;
    while (first < head.byteLength && BYTE_CLASS[head[first] as number] === CLASS_WS) first++;
    let last = tail.byteLength;
    while (last > 0 && BYTE_CLASS[tail[last - 1] as number] === CLASS_WS) last--;
    const trimmedEnd = length - (tail.byteLength - last);
    let roots = 0;
    for (let i = 0; i < tape.count && roots < 2; i++) if (tape.parent(i) === -1) roots++;
    const reason =
      tape.count === 0 || roots !== 1
        ? `${roots === 0 ? "no" : "more than one"} value in the edited bytes`
        : keyed && !hasKey(tape.keyStart(0))
          ? "the member has no key"
          : !keyed && hasKey(tape.keyStart(0))
            ? "a key where a value was expected"
            : (keyed ? tape.keyStart(0) : tape.start(0)) !== first
              ? "bytes before the value"
              : tape.end(0) !== trimmedEnd
                ? "bytes after the value"
                : null;
    return reason === null
      ? ({ clean: true, tape, anchors, bigStrings, source, sourceId, length } as const)
      : ({ clean: false, reason, sourceId } as const);
  }

  private commitRegion(
    doc: Doc,
    level: Level,
    token: number,
    fileStart: number,
    fileEnd: number,
    length: number,
    delta: number,
    built: {
      tape: Tape;
      anchors: ReadonlyMap<number, BucketAnchors>;
      bigStrings: ReadonlyArray<number>;
      source: ByteSource;
      sourceId: number;
    },
    bucket?: Required<Pick<Region, "ordinal" | "parentKind" | "depth" | "parent">>,
  ): NodeSummary {
    const document = doc.owner;
    const region: Region = { token, fileStart, fileEnd, length, ...bucket };
    const absorbed = level.regions.add(region);
    for (const old of absorbed) {
      const tapeId = level.sideTapes.get(old.token);
      level.sideTapes.delete(old.token);
      if (tapeId === undefined) continue;
      const record = document.tapes.get(tapeId);
      if (!record) continue;
      this.dropLevel(document, record.level);
      this.dropTape(document, tapeId);
      this.closeSource(document, record.sourceId);
    }
    // Nested documents under this level's strings (on its tape or its bucket tapes) now inside the
    // region are dead with their tokens.
    for (const [key, link] of doc.children) {
      const linkRecord = document.tapes.get(link.tapeId);
      if (linkRecord?.level !== level) continue;
      const start = linkRecord.tape.start(link.token);
      if (start >= fileStart && start < fileEnd) {
        doc.children.delete(key);
        this.dropDoc(link.child);
      }
    }
    // The bytes grew inside every region above.
    for (let host = level.host; host; host = host.level.host) {
      host.level.regions.resized(host.region, host.region.length + delta);
    }
    const tapeId = document.nextTapeId++;
    const record: TapeRecord = {
      doc,
      tape: built.tape,
      source: built.source,
      sourceId: built.sourceId,
      size: length,
      level: newLevel(tapeId, { level, region }),
      anchors: built.anchors,
      bigStrings: built.bigStrings,
      buckets: new Map(),
      childSkips: new Map(),
      hints: new Map(),
    };
    document.tapes.set(tapeId, record);
    level.sideTapes.set(token, tapeId);
    return this.summary(document, tapeId, record, 0);
  }

  /**
   * Sort, format or minify a subtree as one undoable edit. The output streams
   * into a spill buffer (never one string) and replaces the node's bytes; undo
   * is the inverse splice.
   */
  private async transform(ref: NodeRef, transform: Transform): Promise<EditResult> {
    const { document, record, token, tapeId } = await this.settled(ref);
    return this.serialized(document, async () => {
      const doc = record.doc;
      const kind = record.tape.kind(token);
      const start = this.docLogical(doc, this.pieceLogical(record, record.tape.start(token)));
      const end = this.docLogical(doc, this.pieceLogical(record, record.tape.end(token)));
      if (transform._tag === "sortKeys" && kind !== KIND_OBJECT) {
        throw new InvalidEditError({ detail: "only an object's keys can be sorted" });
      }
      if (transform._tag === "sortArray" && kind !== KIND_ARRAY) {
        throw new InvalidEditError({ detail: "only an array can be sorted" });
      }
      const spill = await this.createSpill(doc);
      try {
        const nodeRef = { documentId: document.id, tapeId, token };
        switch (transform._tag) {
          case "format":
          case "minify": {
            const depth = this.depthOf(document, tapeId, record, token);
            const state: FormatState = { depth, inString: false, escaped: false, lastSig: 0 };
            const indent = transform._tag === "format" ? transform.indent : 0;
            await this.streamDoc(doc, spill.sink, indent, state, start, end);
            break;
          }
          case "sortKeys":
            await this.sortMembers(nodeRef, doc, transform.descending, spill.sink);
            break;
          case "sortArray":
            await this.sortElements(
              nodeRef,
              doc,
              transform.field,
              transform.descending,
              spill.sink,
            );
            break;
        }
        const done = await spill.finish();
        const node = await this.editPieces(
          doc,
          start,
          end - start,
          () => done.pieces,
          done.length,
          done.src,
        );
        return this.editResult(document, node, doc);
      } catch (error) {
        await spill.abort().catch(() => {});
        throw error;
      }
    });
  }

  /** How many containers enclose the token, across bucket tapes, its region's and its doc's tapes. */
  private depthOf(
    document: OpenDocument,
    tapeId: number,
    record: TapeRecord,
    token: number,
  ): number {
    let depth = 0;
    for (let t = record.tape.parent(token); t >= 0; t = record.tape.parent(t)) depth++;
    if (record.level.tapeId !== tapeId) {
      // A bucket tape's roots are children of the container it was cut from.
      const owner = document.bucketOrder.find((entry) => entry.tapeId === tapeId);
      return owner === undefined
        ? depth
        : depth + 1 + this.depthOf(document, owner.ownerTapeId, owner.owner, owner.token);
    }
    const host = record.level.host;
    if (host) {
      depth +=
        host.region.token < 0
          ? (host.region.depth ?? 0)
          : this.depthOf(
              document,
              host.level.tapeId,
              this.levelRoot(document, host.level),
              host.region.token,
            );
    }
    return depth;
  }

  /** Every child of a container as summaries, refusing containers past the sort cap. */
  private async childrenToSort(ref: NodeRef, total: number): Promise<NodeSummary[]> {
    if (total > MAX_SORT_CHILDREN) {
      throw new InvalidEditError({
        detail: `sorting ${total} children is above the ${MAX_SORT_CHILDREN} limit`,
      });
    }
    const nodes: NodeSummary[] = [];
    for (let from = 0; from < total; from += CHILDREN_PAGE_LIMIT) {
      const page = await this.children(ref, from, Math.min(CHILDREN_PAGE_LIMIT, total - from));
      nodes.push(...page.nodes);
    }
    return nodes;
  }

  /** A ByteSource over a doc's document-logical bytes, for streaming copies of members and elements. */
  private logicalSource(doc: Doc): ByteSource {
    return {
      size: this.docSize(doc),
      read: (start, end) => this.readLogical(doc, start, end),
      readInto: async (start, end, buffer) => ({
        bytes: await this.readLogical(doc, start, end),
        buffer,
      }),
      close: () => {},
    };
  }

  /** Writes `{` members `,` … `}` with the members' own bytes (key through value) in key order. */
  private async sortMembers(ref: NodeRef, doc: Doc, descending: boolean, sink: Sink) {
    const node = await this.node(ref);
    const members = await this.childrenToSort(ref, node.childCount);
    const keyed = await Promise.all(
      members.map(async (member) => ({
        key: await this.keyText(member.ref),
        from: member.span.start - (member.range.start - (member.key as number)),
        to: member.span.end,
      })),
    );
    const order = keyed.map((_, i) => i);
    order.sort((a, b) => {
      const x = (keyed[a] as { key: string }).key;
      const y = (keyed[b] as { key: string }).key;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (descending ? -c : c) || a - b;
    });
    await this.writeContainer(
      doc,
      sink,
      0x7b,
      0x7d,
      order.map((i) => keyed[i] as { from: number; to: number }),
    );
  }

  /** Writes `[` elements `,` … `]` sorted by value or by a field; unsortable elements keep their order at the end. */
  private async sortElements(
    ref: NodeRef,
    doc: Doc,
    field: string | null,
    descending: boolean,
    sink: Sink,
  ) {
    const node = await this.node(ref);
    const elements = await this.childrenToSort(ref, node.childCount);
    // Containers have no value of their own to sort by: an array of them would move for no visible reason.
    if (field === null && elements.length > 0 && elements.every((e) => isContainerKind(e.kind))) {
      throw elements.every((e) => e.kind === "object")
        ? new EditRefusedError({
            detail: "Its elements are objects. Sort it by one of their fields instead.",
            remedy: "sortArrayByField",
          })
        : new EditRefusedError({
            detail: "Its elements are arrays and objects, which have no value to sort by.",
          });
    }
    let withField = 0;
    const keys = await Promise.all(
      elements.map(async (element) => {
        let target: NodeSummary | undefined = element;
        if (field !== null) {
          target = undefined;
          if (element.kind === "object" && element.childCount <= MAX_SORT_CHILDREN) {
            for (const member of await this.childrenToSort(element.ref, element.childCount)) {
              if ((await this.keyText(member.ref)) === field) {
                target = member;
                withField++;
                break;
              }
            }
          }
        }
        return this.sortKey(target);
      }),
    );
    if (field !== null && elements.length > 0 && withField === 0) {
      throw new EditRefusedError({
        detail: `No element has a field named ${JSON.stringify(field)}.`,
      });
    }
    const order = elements.map((_, i) => i);
    order.sort((a, b) => {
      const ka = keys[a] as SortKey;
      const kb = keys[b] as SortKey;
      const c = compareSortKeys(ka, kb);
      // Unsortable elements (rank 4) stay in document order whatever the direction.
      const sortable = ka.rank < 4 && kb.rank < 4;
      return (sortable && descending ? -c : c) || a - b;
    });
    await this.writeContainer(
      doc,
      sink,
      0x5b,
      0x5d,
      order.map((i) => ({
        from: (elements[i] as NodeSummary).span.start,
        to: (elements[i] as NodeSummary).span.end,
      })),
    );
  }

  private async sortKey(node: NodeSummary | undefined): Promise<SortKey> {
    if (!node) return { rank: 4, value: 0 };
    switch (node.kind) {
      case "null":
        return { rank: 0, value: 0 };
      case "false":
        return { rank: 1, value: 0 };
      case "true":
        return { rank: 1, value: 1 };
      case "number": {
        const text = await this.text(node.ref, 1 << 16);
        return { rank: 2, value: Number(text.text) };
      }
      case "string": {
        const text = await this.text(node.ref, MAX_SLICE_BYTES);
        return { rank: 3, value: text.text };
      }
      default:
        return { rank: 4, value: 0 };
    }
  }

  /** `open` ranges-joined-by-commas `close`, each range copied from the doc's logical bytes in chunks. */
  private async writeContainer(
    doc: Doc,
    sink: Sink,
    open: number,
    close: number,
    ranges: ReadonlyArray<{ readonly from: number; readonly to: number }>,
  ) {
    const source = this.logicalSource(doc);
    await sink.write(Uint8Array.of(open));
    for (const [i, range] of ranges.entries()) {
      if (i > 0) await sink.write(Uint8Array.of(COMMA));
      await copyRange(source, range.from, range.to, sink, MAX_SLICE_BYTES);
    }
    await sink.write(Uint8Array.of(close));
  }

  private async undo(documentId: number, direction: "undo" | "redo"): Promise<EditResult> {
    const document = this.document(documentId);
    await this.ready(document);
    return this.serialized(document, () => this.undoUnlocked(document, direction));
  }

  private async undoUnlocked(
    document: OpenDocument,
    direction: "undo" | "redo",
  ): Promise<EditResult> {
    const [from, to] =
      direction === "undo"
        ? [document.undoStack, document.redoStack]
        : [document.redoStack, document.undoStack];
    const entry = from[from.length - 1];
    if (!entry) throw new NothingToUndoError({ direction });
    const doc = this.docByRoot(document, entry.docTapeId);
    if (!doc) {
      from.pop();
      throw new NothingToUndoError({ direction });
    }
    const splice = entry.splice;
    const removedLength = piecesLength(splice.removed);
    const insertedLength = piecesLength(splice.inserted);
    // Undo puts `removed` back where `inserted` sits; redo the reverse.
    const [undoLength, redoLength] =
      direction === "undo" ? [insertedLength, removedLength] : [removedLength, insertedLength];
    if (direction === "undo") doc.pieces.revert(splice);
    else doc.pieces.apply(splice);
    try {
      const node = await this.reindex(
        doc,
        splice.at,
        splice.at + redoLength,
        redoLength - undoLength,
      );
      from.pop();
      to.push(entry);
      this.invalidateEscaped(doc);
      if (document.journal && !document.replaying) await this.journalStep(document, direction);
      return this.editResult(document, node, doc);
    } catch (error) {
      if (direction === "undo") doc.pieces.apply(splice);
      else doc.pieces.revert(splice);
      throw error;
    }
  }

  private docByRoot(document: OpenDocument, rootTapeId: number): Doc | undefined {
    return document.tapes.get(rootTapeId)?.doc;
  }

  private async save(
    documentId: number,
    sinkSpec: SaveSink,
    indent: number | null,
    inPlace: boolean,
  ): Promise<EngineResult["save"]> {
    const document = this.document(documentId);
    await this.ready(document);
    return this.serialized(document, async () => {
      const sink = await openSink(
        sinkSpec._tag === "fileHandle"
          ? { kind: "fileHandle", handle: sinkSpec.handle }
          : { kind: "writable", stream: sinkSpec.stream },
      );
      try {
        // A read-only document shown through a conversion saves the file it came from, unchanged.
        const display = document.display;
        const written = display
          ? await copyRange(display.source, 0, display.source.size, sink)
          : (await this.streamDoc(document.doc, sink, indent, INITIAL_FORMAT_STATE)).written;
        await sink.close();
        document.savedTop = document.undoStack[document.undoStack.length - 1] ?? null;
        // A save elsewhere (a download, Save As) leaves the file the journal is about unchanged, so
        // its edits stay journaled against it. A save in place makes the saved bytes that file: the
        // journal starts over from here, and moves to the file's key once `rekeyJournal` names it.
        if (inPlace) {
          const journal = document.journal;
          // A journal that cannot start over would replay edits the saved file already has.
          if (
            journal !== null &&
            !(await journal.reset().then(
              () => true,
              () => false,
            ))
          ) {
            document.journal = null;
            document.retiredJournals.push(journal);
          }
          document.journalFrom = document.savedTop;
          document.journalOff = false;
        }
        this.emitEditState(document);
        return { bytes: written };
      } catch (error) {
        await sink.abort().catch(() => {});
        throw error;
      }
    });
  }

  /**
   * After a save in place: moves the journal (the edits made since the save) to
   * the saved file's key, so reopening that file offers them back. The old
   * journal goes when the document closes, since its spill files may still back
   * pieces. Without a key the edits are not journaled from here on.
   */
  private async rekeyJournal(documentId: number, journalKey: string | null): Promise<null> {
    const document = this.document(documentId);
    await this.ready(document).catch(() => {});
    return this.serialized(document, async () => {
      const current = document.journal;
      if (current === null || current.documentId === journalKey) return null;
      // A copy that fails leaves the edits unjournaled rather than failing a save that happened.
      document.journal =
        journalKey === null ? null : await current.copyTo(journalKey).catch(() => null);
      document.retiredJournals.push(current);
      await current.reset().catch(() => {});
      await current.close().catch(() => {});
      return null;
    });
  }

  /**
   * Journals an undo or redo that has just moved the history. Records replay onto
   * the file from `journalFrom`; an undo below it has no record that would, so the
   * journal empties and stays quiet until Redo comes back to that point.
   */
  private async journalStep(document: OpenDocument, direction: "undo" | "redo") {
    const journal = document.journal as Journal;
    const from = document.journalFrom;
    const covered = from === null || document.undoStack.includes(from);
    if (!covered) {
      if (!document.journalOff) {
        document.journalOff = true;
        await journal.reset();
      }
      return;
    }
    // Back at the point the emptied journal starts from: it describes this state again.
    if (document.journalOff) {
      document.journalOff = false;
      return;
    }
    await journal.commit({ op: direction });
  }

  /**
   * Converts the document as it stands (edits applied) into the sink. JSON is
   * the engine's own formatter; every other target goes through the format
   * platform from JSON bytes: the indexed file when it is unedited, else a
   * scratch copy of the edited bytes.
   */
  private async convert(
    documentId: number,
    to: ConvertFormat,
    settings: ConvertSettings,
    sinkSpec: SaveSink,
  ): Promise<EngineResult["convert"]> {
    const document = this.document(documentId);
    await this.ready(document);
    const formats = this.platform.formats;
    if (document.format === "text") {
      throw new ConvertError({
        to,
        reason: "no-structure",
        pointer: null,
        line: null,
        detail: "This document is shown as text, so it cannot be converted.",
      });
    }
    if (to !== "json" && formats === undefined) {
      throw new ConvertError({
        to,
        reason: "unsupported",
        pointer: null,
        line: null,
        detail: `Converting to ${FORMAT_LABELS[to]} is not available here.`,
      });
    }
    const sink = await openSink(
      sinkSpec._tag === "fileHandle"
        ? { kind: "fileHandle", handle: sinkSpec.handle }
        : { kind: "writable", stream: sinkSpec.stream },
    );
    let scratch: ScratchFile | null = null;
    try {
      let bytes: number;
      if (to === "json") {
        bytes = await this.serialized(document, async () => {
          const result = await this.streamDoc(
            document.doc,
            sink,
            settings.indent,
            INITIAL_FORMAT_STATE,
          );
          return result.written;
        });
      } else {
        const platform = formats as FormatPlatform;
        const json = await this.serialized(document, async () => {
          if (!this.isDirty(document.doc) && document.indexedBlob !== null) {
            return document.indexedBlob;
          }
          scratch = await platform.scratch();
          await this.streamDoc(document.doc, scratch.sink, null, INITIAL_FORMAT_STATE);
          await scratch.sink.close();
          return scratch.finish();
        });
        bytes = await platform.convert(json, to, settings, sink);
      }
      await sink.close();
      return { bytes };
    } catch (error) {
      await sink.abort().catch(() => {});
      throw error;
    } finally {
      await (scratch as ScratchFile | null)?.release();
    }
  }

  /**
   * Which formats can hold the document, decided from its root and first rows:
   * the rules each converter refuses on first (docs/internals/formats.md). A
   * document that passes can still be refused deeper down; the conversion says where.
   */
  private async exportTargets(documentId: number): Promise<ReadonlyArray<ExportTarget>> {
    const document = this.document(documentId);
    await this.ready(document);
    const all: ReadonlyArray<ConvertFormat> = [
      "json",
      "yaml",
      "toml",
      "xml",
      "csv",
      "tsv",
      "ndjson",
    ];
    const formats = this.platform.formats !== undefined;
    if (document.format === "text") {
      return all.map((format) => ({
        format,
        available: false,
        reason: "This document is shown as text.",
        advice: null,
      }));
    }
    const root = await this.root(documentId);
    const sample =
      root.childCount === 0
        ? []
        : (
            await this.rows(
              root.ref,
              0,
              Math.min(EXPORT_SAMPLE_ROWS, root.childCount),
              NESTED_HEAD_BYTES,
            )
          ).rows;
    // What only the whole document can tell, where reading it is cheap.
    const nullAt = formats && root.kind === "object" ? await this.firstNullPath(document) : null;
    const laterKey =
      formats && root.kind === "array" ? await this.keyPastFirstRows(document) : null;
    const reasonFor = (format: ConvertFormat): string | null => {
      if (format === "json") return null;
      if (!formats) return `Converting to ${FORMAT_LABELS[format]} is not available here.`;
      switch (format) {
        case "yaml":
          return null;
        case "toml":
          if (root.kind !== "object") return "TOML needs an object at the top level.";
          return nullAt === null ? null : `TOML has no null, and the value at ${nullAt} is null.`;
        case "ndjson":
          return root.kind === "array" ? null : "NDJSON needs a list at the top level.";
        case "csv":
        case "tsv": {
          const label = FORMAT_LABELS[format];
          if (root.kind !== "array") return `${label} needs a list of records at the top level.`;
          return sample.every((row) => row.node.kind === "object")
            ? null
            : `${label} needs every item of the list to be a record.`;
        }
        case "xml": {
          if (root.kind !== "object" || root.childCount !== 1) {
            return "XML needs exactly one member at the top level: the root element.";
          }
          const only = sample[0];
          if (only === undefined || only.key === null || !XML_NAME.test(only.key)) {
            return "XML needs the top-level key to be a valid element name.";
          }
          return only.node.kind === "array" || only.node.kind === "null"
            ? "XML needs the root element to be one value, not a list or null."
            : null;
        }
      }
    };
    return all.map((format) => {
      const reason = reasonFor(format);
      const advice =
        reason === null && laterKey !== null && (format === "csv" || format === "tsv")
          ? `Some records have a key the first ${EXPORT_HEADER_ROWS.toLocaleString("en-US")} do not, such as "${laterKey}": read the columns from every row.`
          : null;
      return { format, available: reason === null, reason, advice };
    });
  }

  /** The main tape answers every question about the document on its own: unedited, nothing left to index on demand. */
  private wholeOnTape(document: OpenDocument) {
    const record = document.tapes.get(0) as TapeRecord;
    return !this.indexMoved(document) && record.anchors.size === 0 && document.syntax === null
      ? record
      : null;
  }

  /** The path of the first null in the document, when the tape holds it all and is not huge; else null. */
  private async firstNullPath(document: OpenDocument): Promise<string | null> {
    const record = this.wholeOnTape(document);
    if (record === null || record.tape.count > EXPORT_SCAN_TOKENS) return null;
    const tape = record.tape;
    for (let t = 0; t < tape.count; t++) {
      if (tape.kind(t) === KIND_NULL) return this.pathText(document, record, t);
    }
    return null;
  }

  /** `$.a.b[1]` for a token of the main tape: keys decoded, indexes counted. */
  private async pathText(document: OpenDocument, record: TapeRecord, token: number) {
    const steps: string[] = [];
    for (let t = token; ;) {
      const parent = record.tape.parent(t);
      if (parent < 0) break;
      if (record.tape.kind(parent) === KIND_ARRAY)
        steps.push(`[${this.childRank(record, parent, t)}]`);
      else {
        const key = await this.keyText({ documentId: document.id, tapeId: 0, token: t });
        steps.push(IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
      }
      t = parent;
    }
    return `$${steps.toReversed().join("")}`;
  }

  /**
   * A key that first appears after the rows a CSV header is read from by default,
   * for a list of records small enough to read at once; null when there is none
   * or the document is too big to tell cheaply.
   */
  private async keyPastFirstRows(document: OpenDocument): Promise<string | null> {
    const record = this.wholeOnTape(document);
    if (record === null || record.size > EXPORT_SCAN_BYTES) return null;
    const tape = record.tape;
    if (tape.childCount(0) <= EXPORT_HEADER_ROWS) return null;
    const bytes = await record.source.read(0, record.size);
    const seen = new Set<string>();
    let row = 0;
    for (let r = firstChild(tape, 0); r >= 0; r = tape.next(r), row++) {
      if (tape.kind(r) !== KIND_OBJECT) continue;
      for (let m = firstChild(tape, r); m >= 0; m = tape.next(m)) {
        const keyStart = tape.keyStart(m);
        if (!hasKey(keyStart)) continue;
        const keyEnd = stringEnd(bytes, keyStart);
        if (keyEnd < 0) continue;
        const key = decodeString(bytes, keyStart, keyEnd, MAX_KEY_BYTES);
        if (row < EXPORT_HEADER_ROWS) seen.add(key);
        else if (!seen.has(key)) return key;
      }
    }
    return null;
  }

  /**
   * Streams a doc's document-logical bytes: plain runs are copied (as-is) or
   * formatted in the workers; a dirty nested document is re-escaped from its own
   * bytes, inside the parent's string, where the formatter is copying anyway.
   */
  private async streamDoc(
    doc: Doc,
    sink: Sink,
    indent: number | null,
    initial: FormatState,
    start = 0,
    end = this.docSize(doc),
  ) {
    const document = doc.owner;
    let state = initial;
    let written = 0;
    for (const segment of this.segments(doc, start, end)) {
      if (segment.kind === "pieces") {
        const length = segment.to - segment.from;
        const source = pieceSource(doc.pieces.slices(segment.from, segment.to), (i) =>
          this.buffer(doc, i),
        );
        if (indent === null) {
          written += await copyRange(source, 0, length, sink);
        } else if (!this.workersCanRead(doc, segment.from, segment.to)) {
          // A spill the workers cannot see (reached over a port): format here, chunk by chunk.
          const result = await formatInCoordinator(source, length, sink, indent, state);
          state = result.state;
          written += result.written;
        } else {
          const sourceId = await this.openWindow(doc, segment.from, segment.to);
          try {
            const result = await formatThroughPool(document.pool, sourceId, length, sink, {
              indent,
              state,
            });
            state = result.state;
            written += result.written;
          } finally {
            this.closeSource(document, sourceId);
          }
        }
      } else {
        // Escaped content of the child, in chunks; the formatter is inside the string, so the bytes pass through.
        const child = segment.link.child;
        const size = this.docSize(child);
        for (let at = 0; at < size; at += OVERLAY_CHUNK_BYTES) {
          const raw = await this.readLogical(child, at, Math.min(size, at + OVERLAY_CHUNK_BYTES));
          const out = new Uint8Array(escapedLength(raw));
          escapeInto(raw, 0, raw.byteLength, out, 0);
          await sink.write(out);
          written += out.byteLength;
        }
        state = { ...state, inString: true, escaped: false };
      }
    }
    return { written, state };
  }
}

/** Scratch bytes in memory, for a host with no format platform (tests). */
const memoryScratchFile = (): ScratchFile => {
  let parts: Blob[] = [];
  return {
    sink: {
      write: async (bytes) => {
        parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      },
      close: async () => {},
      abort: async () => {
        parts = [];
      },
    },
    finish: async () => new Blob(parts),
    release: async () => {
      parts = [];
    },
  };
};

/**
 * The format a file opens as. An explicit choice wins; then the name (a plain-text
 * extension is text, a data extension is that format, and a `.json` file is
 * JSON even with comments, which the index reports); then the bytes, where an
 * opening brace or bracket means JSON unless the bytes are JSONC or NDJSON.
 */
const chooseFormat = (
  detected: FormatDetection,
  engineFormat: "json" | "har" | "text",
  asFormat: DocumentFormat | undefined,
): FormatDetection => {
  const named = detected.named;
  const as = (format: DocumentFormat): FormatDetection => ({
    format,
    delimiter:
      format === detected.format
        ? detected.delimiter
        : format === "tsv"
          ? 0x09
          : format === "csv"
            ? 0x2c
            : 0,
    named,
  });
  if (asFormat !== undefined) return as(asFormat);
  if (named === "json" || named === "har") return as(engineFormat === "har" ? "har" : named);
  if (named !== null) return as(named);
  const precise =
    detected.format === "jsonc" || detected.format === "ndjson" || detected.format === "har";
  return engineFormat !== "text" && !precise ? as(engineFormat) : detected;
};

/** 1-based line and column of a byte: lines counted in 8 MiB reads, the column in characters. */
const lineAndColumn = async (source: ByteSource, offset: number) => {
  const STEP = 8 * 1024 * 1024;
  let line = 1;
  let lineStart = 0;
  for (let at = 0; at < offset; at += STEP) {
    const bytes = await source.read(at, Math.min(offset, at + STEP));
    for (let k = bytes.indexOf(0x0a); k >= 0; k = bytes.indexOf(0x0a, k + 1)) {
      line++;
      lineStart = at + k + 1;
    }
  }
  // Characters, not bytes: every byte that does not continue a UTF-8 sequence starts one.
  let column = 1;
  for (let at = lineStart; at < offset; at += STEP) {
    const bytes = await source.read(at, Math.min(offset, at + STEP));
    for (const byte of bytes) if ((byte & 0xc0) !== 0x80) column++;
  }
  return { line, column };
};

const shown = (byte: number | undefined) =>
  byte === undefined
    ? "the end of the file"
    : byte > 0x20 && byte < 0x7f
      ? `\`${String.fromCharCode(byte)}\``
      : `byte 0x${byte.toString(16).padStart(2, "0")}`;

/** The sentence for a syntax problem, given the byte it is at. */
const describeProblem = (code: SyntaxCode, byte: number | undefined) => {
  switch (code) {
    case "unexpected":
      return `unexpected ${shown(byte)}`;
    case "trailing-comma":
      return "a comma before the end of a list or object";
    case "close-mismatch":
      return `${shown(byte)} closes the wrong bracket`;
    case "trailing-data":
      return `more data after the end of the document, ${shown(byte)}`;
    case "literal":
      return "a value that is not true, false or null";
    case "number":
      return "a number JSON does not allow";
    case "escape":
      return "an escape JSON does not allow";
    case "end":
      return "the file ends before the document does";
    case "unterminated":
      return "a string that is never closed, opened";
  }
};

/** The untruncated string value of the row named `key`, or null. */
const stringField = (rows: ReadonlyArray<RowSummary>, key: string): string | null => {
  const row = rows.find((candidate) => candidate.key === key);
  if (!row || row.node.kind !== "string" || row.preview === null) return null;
  return row.preview.text;
};

/** The host of a URL (a truncated one still has its authority), or null when it has none. */
const hostOf = (url: string | null): string | null => {
  if (url === null) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  if (!match) return null;
  const authority = match[1] as string;
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return host.length > 0 ? host : null;
};

interface SortKey {
  /** null 0, booleans 1, numbers 2, strings 3, containers and missing 4. */
  readonly rank: number;
  readonly value: number | string;
}

const compareSortKeys = (a: SortKey, b: SortKey) => {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank >= 4) return 0;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
};

/** The single-threaded formatter over a source, for bytes the workers cannot reach. */
const formatInCoordinator = async (
  source: ByteSource,
  length: number,
  sink: Sink,
  indent: number,
  initial: FormatState,
) => {
  const chunkBytes = 2 * 1024 * 1024;
  let state = initial;
  let written = 0;
  let buffer = new ArrayBuffer(Math.min(chunkBytes, length));
  const writer = new ByteWriter(Math.min(chunkBytes * 2, length + 4096));
  for (let at = 0; at < length; at += chunkBytes) {
    const r = await source.readInto(at, Math.min(length, at + chunkBytes), buffer);
    buffer = r.buffer;
    state = formatChunk(r.bytes, state, { indent }, writer);
    const out = writer.take();
    await sink.write(out);
    written += out.byteLength;
  }
  return { state, written };
};

/** The token that starts at byte `start`, or -1; starts are non-decreasing in document order. */
const tokenStartingAt = (tape: Tape, start: number) => {
  let lo = 0;
  let hi = tape.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tape.start(mid) < start) lo = mid + 1;
    else hi = mid;
  }
  // A container and its first child can share a start only if the child began at the
  // same byte, which JSON forbids; keys sit before values, so the match is unique.
  return lo < tape.count && tape.start(lo) === start ? lo : -1;
};

/** The first `limit` bytes of `pieces` laid end to end (fewer when they hold fewer); a lone piece as is. */
const concat = (pieces: ReadonlyArray<Uint8Array>, limit: number) => {
  const only = pieces[0];
  if (pieces.length === 1 && only && only.byteLength <= limit) return only;
  let total = 0;
  for (const piece of pieces) total += piece.byteLength;
  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const piece of pieces) {
    const take = Math.min(piece.byteLength, out.byteLength - offset);
    out.set(take === piece.byteLength ? piece : piece.subarray(0, take), offset);
    offset += take;
    if (offset >= out.byteLength) break;
  }
  return out;
};

/** The largest cut `≤ limit` of `bytes` that does not end inside a UTF-8 sequence. */
const utf8Boundary = (bytes: Uint8Array, limit: number) => {
  const at = Math.min(limit, bytes.byteLength);
  for (let i = at - 1; i >= 0 && i >= at - 4; i--) {
    const lead = bytes[i] as number;
    if ((lead & 0xc0) === 0x80) continue;
    const length = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    return i + length <= at ? at : i;
  }
  return at;
};

/** Index of the first element greater than `value` in a sorted array. */
const upperBound = (sorted: ReadonlyArray<number>, value: number) => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const packRef = (tapeId: number, token: number) => tapeId * TAPE_ID_SPAN + token;
const unpackRef = (packed: number) => ({
  tapeId: Math.floor(packed / TAPE_ID_SPAN),
  token: packed % TAPE_ID_SPAN,
});

/** The ranges of `nodes` with nested ones dropped, in file order. */
const disjointRanges = (nodes: ReadonlyArray<{ readonly start: number; readonly end: number }>) => {
  const sorted = nodes
    .map((n) => ({ start: n.start, end: n.end }))
    .toSorted((a, b) => a.start - b.start || b.end - a.end);
  const out: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && range.start < last.end) {
      last.end = Math.max(last.end, range.end);
    } else out.push(range);
  }
  return out;
};

/** A member step of a path: `.name` when the key is a plain name, `['…']` otherwise. */
const pathMember = (key: string) =>
  /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\-\u0080-\uffff]*$/.test(key)
    ? `.${key}`
    : `['${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
