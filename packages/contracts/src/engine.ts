import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

/**
 * The engine RPC: what the UI thread may ask the document engine, and what comes
 * back. The engine runs in workers; every request crosses `postMessage`, so each
 * side decodes with these schemas. Offsets are UTF-8 byte
 * offsets into the original file, as JS numbers: exact to 2^53, which
 * no file reaches. Design and traps: docs/internals/document-engine.md.
 */

export const DocumentId = PositiveInt;
export type DocumentId = typeof DocumentId.Type;

/** 0 is the document's own tape; child tapes hold on-demand buckets and nested documents. */
export const TapeId = NonNegativeInt;
export type TapeId = typeof TapeId.Type;

export const TokenIndex = NonNegativeInt;
export type TokenIndex = typeof TokenIndex.Type;

export const ByteOffset = NonNegativeInt;
export type ByteOffset = typeof ByteOffset.Type;

/** `[start, end)` in bytes of the tape's source; `end` is never before `start`. */
export const ByteRange = Schema.Struct({ start: ByteOffset, end: ByteOffset }).check(
  Schema.makeFilter((range: { readonly start: number; readonly end: number }) =>
    range.end >= range.start
      ? true
      : `a byte range whose end (${range.end}) is before its start (${range.start})`,
  ),
);
export type ByteRange = typeof ByteRange.Type;

/**
 * Every collection and string the engine returns, and every count the UI may
 * ask for, has a maximum in the schema, so an oversized reply or request fails
 * to decode instead of materializing a document on the UI thread.
 */

/** The largest value the engine decodes into one JS value or string: a 64 MiB slice. */
export const MAX_SLICE_BYTES = 64 * 1024 * 1024;
export const SliceBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_SLICE_BYTES }),
);
/** Bytes that crossed the boundary as a slice: at most `MAX_SLICE_BYTES` of them. */
export const SliceBytesArray = Schema.Uint8Array.check(Schema.isMaxLength(MAX_SLICE_BYTES));
/** A decoded value's text: never more UTF-16 units than the slice it came from had bytes. */
export const SliceText = Schema.String.check(Schema.isMaxLength(MAX_SLICE_BYTES));

/** Member keys are decoded whole; the engine refuses a key past 1 MiB. */
export const MAX_KEY_BYTES = 1024 * 1024;
export const KeyText = Schema.String.check(Schema.isMaxLength(MAX_KEY_BYTES));

/** A file name as the picker or the OS hands it over. */
export const MAX_NAME_LENGTH = 4096;
export const DocumentName = Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH));

/** The text of a worker failure, cut by the engine before it is sent. */
export const MAX_ERROR_DETAIL_LENGTH = 4096;
export const ErrorDetail = Schema.String.check(Schema.isMaxLength(MAX_ERROR_DETAIL_LENGTH));

export const NodeRef = Schema.Struct({ documentId: DocumentId, tapeId: TapeId, token: TokenIndex });
export type NodeRef = typeof NodeRef.Type;

export const NodeKind = Schema.Literals([
  "object",
  "array",
  "string",
  "number",
  "true",
  "false",
  "null",
]);
export type NodeKind = typeof NodeKind.Type;

export const NodeSummary = Schema.Struct({
  ref: NodeRef,
  kind: NodeKind,
  /** The token's bytes in its tape's source; `slice` reads them. */
  range: ByteRange,
  /**
   * The node's bytes in the edited document it belongs to (the nested document
   * for a child tape): what the source view shows. Equal to `range` until an
   * edit shifts or resizes bytes under or before the node.
   */
  span: ByteRange,
  /** Byte offset of the member key's opening quote; null for array elements and roots. `keyText` decodes it. */
  key: Schema.NullOr(ByteOffset),
  childCount: NonNegativeInt,
  /**
   * False when the children are not on the tape (the eager index stopped at this
   * container); `children` then indexes them on demand, one bucket at a time.
   */
  childrenIndexed: Schema.Boolean,
  /**
   * False while the index is still running and a later region can change this
   * node: a container's `range.end` and `childCount` are then a lower bound.
   * Every node is settled once `indexProgress` says `done`.
   */
  settled: Schema.Boolean,
});
export type NodeSummary = typeof NodeSummary.Type;

/** Children are served in buckets of at most this many nodes, so a big array arrives in chunks. */
export const CHILDREN_PAGE_LIMIT = 1024;
export const ChildrenCount = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: CHILDREN_PAGE_LIMIT }),
);

export const ChildrenPage = Schema.Struct({
  from: NonNegativeInt,
  total: NonNegativeInt,
  nodes: Schema.Array(NodeSummary).check(Schema.isMaxLength(CHILDREN_PAGE_LIMIT)),
});
export type ChildrenPage = typeof ChildrenPage.Type;

export const EngineCapabilities = Schema.Struct({
  crossOriginIsolated: Schema.Boolean,
  workers: PositiveInt,
});
export type EngineCapabilities = typeof EngineCapabilities.Type;

/**
 * What the engine decided a file is from its first bytes and its name. `text`
 * is everything it could not place (no file is refused); a
 * file of a known format can still open as text, and `DocumentInfo.note` says why.
 */
export const DocumentFormat = Schema.Literals([
  "json",
  "jsonc",
  "har",
  "ndjson",
  "yaml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "text",
]);
export type DocumentFormat = typeof DocumentFormat.Type;

/** How the app names each format to the user. */
export const DOCUMENT_FORMAT_LABELS: Readonly<Record<DocumentFormat, string>> = {
  json: "JSON",
  jsonc: "JSONC",
  har: "HAR",
  ndjson: "NDJSON",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
  text: "Text",
};

/**
 * The formats the engine indexes over the file's own bytes and so accepts
 * edits for; every other format with a structure opens read-only.
 */
export const EDITABLE_FORMATS: ReadonlyArray<DocumentFormat> = ["json", "har"];

/** The formats that open with a structure (a tree and a map); everything else is text. */
export const STRUCTURED_FORMATS: ReadonlyArray<DocumentFormat> = DocumentFormat.literals.filter(
  (format) => format !== "text",
);

/**
 * How the tree relates to the file. `native`: the index is over the file's own
 * bytes, so a node's range is where the Source view shows it. `converted`: the
 * engine converted the file to JSON in its workers and indexed that; the Source
 * view shows the file, and node ranges are not positions in it. `none`: text,
 * with no tree.
 */
export const DocumentStructure = Schema.Literals(["native", "converted", "none"]);
export type DocumentStructure = typeof DocumentStructure.Type;

/** A short sentence for the user, as the engine words it. */
export const MAX_NOTE_LENGTH = 512;
export const NoteText = Schema.String.check(Schema.isMaxLength(MAX_NOTE_LENGTH));

export const DocumentInfo = Schema.Struct({
  documentId: DocumentId,
  name: DocumentName,
  /** The file's size in bytes, which is what the Source view shows. */
  size: ByteOffset,
  format: DocumentFormat,
  structure: DocumentStructure,
  /** Edits are accepted. False for every format but JSON and HAR, and for a document shown as text. */
  editable: Schema.Boolean,
  /** Why a document of a known format opens as text or read-only; null when nothing needs saying. */
  note: Schema.NullOr(NoteText),
  /** Journal records found for `journalKey` and being replayed; 0 without a journal. */
  recovered: NonNegativeInt,
  /**
   * The document was opened with a `journalKey` whose journal could not be
   * opened: it shows the file as it is on disk, and its edits are not journaled.
   * `busy` means another tab or window holds that journal.
   */
  journalUnavailable: Schema.NullOr(Schema.Literals(["busy", "unreadable"])),
});
export type DocumentInfo = typeof DocumentInfo.Type;

/**
 * Where a document stops being valid JSON: the first offending byte, its
 * 1-based line and column (in characters), and what is wrong there. The tree
 * and map still show what the index read around it.
 */
export const DocumentProblem = Schema.Struct({
  offset: ByteOffset,
  line: PositiveInt,
  column: PositiveInt,
  message: NoteText,
  /** The problem is a comment or a trailing comma, so the file reads as JSONC (`open` with `asFormat`). */
  readsAsJsonc: Schema.Boolean,
});
export type DocumentProblem = typeof DocumentProblem.Type;

/** Pushed by the engine while a document indexes; `done` is true on the last one. */
export const IndexProgress = Schema.Struct({
  documentId: DocumentId,
  regions: PositiveInt,
  regionsMerged: NonNegativeInt,
  tokens: NonNegativeInt,
  done: Schema.Boolean,
});
export type IndexProgress = typeof IndexProgress.Type;

/** A decoded scalar: strings are unescaped, numbers and literals are their source text. */
export const TextValue = Schema.Struct({
  text: SliceText,
  /** The source held more than `limit` bytes and `text` is a prefix. */
  truncated: Schema.Boolean,
  bytes: NonNegativeInt,
});
export type TextValue = typeof TextValue.Type;

/** Where a save streams to: a File System Access handle (OPFS or a picked file) or any writable stream (download, desktop IPC). */
// `FileSystemFileHandle` exists in browsers and workers, not in Node, so the guard looks the global up at check time.
const FileHandle = Schema.declare<FileSystemFileHandle>(
  (u): u is FileSystemFileHandle =>
    typeof FileSystemFileHandle === "function" && u instanceof FileSystemFileHandle,
  { title: "FileSystemFileHandle" },
);
export const SaveSink = Schema.Union([
  Schema.TaggedStruct("fileHandle", { handle: FileHandle }),
  Schema.TaggedStruct("writable", { stream: Schema.instanceOf(WritableStream<Uint8Array>) }),
]);
export type SaveSink = typeof SaveSink.Type;

/** null writes the bytes as they are; 0 minifies; 2 is `JSON.stringify(x, null, 2)`. */
export const SaveIndent = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
);

export const SaveResult = Schema.Struct({
  /** Bytes handed to the sink. */
  bytes: NonNegativeInt,
});
export type SaveResult = typeof SaveResult.Type;

/** What every edit, undo and redo answers: the node whose subtree was re-indexed, and the history depth. */
export const EditResult = Schema.Struct({
  /** The re-indexed node; refs under the previous one are stale. */
  node: NodeSummary,
  /** The document's logical size after the edit. */
  size: ByteOffset,
  undoDepth: NonNegativeInt,
  redoDepth: NonNegativeInt,
  /** The document differs from what was last opened or saved. */
  dirty: Schema.Boolean,
});
export type EditResult = typeof EditResult.Type;

/**
 * A document's history as the views show it: what undo and redo can do, whether
 * there is anything to save, and `revision`, which changes whenever the
 * document's bytes do (an edit, an undo or redo, a replayed journal), so a view
 * knows to read them again. Pushed as an `editState` event after every change
 * and every save; `editState` asks for it.
 */
export const EditState = Schema.Struct({
  documentId: DocumentId,
  undoDepth: NonNegativeInt,
  redoDepth: NonNegativeInt,
  dirty: Schema.Boolean,
  /** The document's logical size. */
  size: ByteOffset,
  revision: NonNegativeInt,
  /** A recovered journal is still being replayed; the other fields describe the state before it. */
  replaying: Schema.Boolean,
  /**
   * The journal the last session left could not be replayed onto this file: the
   * document is as it is on disk and the journal was dropped.
   */
  restoreFailed: Schema.Boolean,
});
export type EditState = typeof EditState.Type;

/** The formats a document converts to. HAR and JSONC are JSON on the way out. */
const CONVERT_FORMATS = ["json", "yaml", "toml", "xml", "csv", "tsv", "ndjson"] as const;
export const ConvertFormat = Schema.Literals(CONVERT_FORMATS);
export type ConvertFormat = typeof ConvertFormat.Type;

/**
 * The converter's options. `indent` applies to JSON output (0 is minified);
 * `columns` and `nested` to CSV and TSV: the header from the first 1,024 rows
 * or from every row, and nested values written as JSON text or refused.
 */
export const ConvertSettings = Schema.Struct({
  indent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
  columns: Schema.Literals(["first", "full"]),
  nested: Schema.Literals(["json", "error"]),
});
export type ConvertSettings = typeof ConvertSettings.Type;

/** Whether a document's shape fits a target, from its root and first rows; the conversion has the last word. */
export const ExportTarget = Schema.Struct({
  format: ConvertFormat,
  available: Schema.Boolean,
  /** Why the target cannot hold this document; null when it is available. */
  reason: Schema.NullOr(NoteText),
  /** What to choose for the target to hold it (CSV: read the header from every row); null when nothing. */
  advice: Schema.NullOr(NoteText),
});
export type ExportTarget = typeof ExportTarget.Type;

/**
 * A child with what a view draws for it: the decoded key of an object member
 * and a bounded preview of a scalar, so a node's rows arrive in one request
 * instead of one per row (the map paints thousands of nodes at once).
 */
export const RowSummary = Schema.Struct({
  node: NodeSummary,
  /** The member key, decoded; null for array elements. */
  key: Schema.NullOr(KeyText),
  /** The first bytes of a scalar; null for a container. */
  preview: Schema.NullOr(TextValue),
});
export type RowSummary = typeof RowSummary.Type;

export const RowsPage = Schema.Struct({
  from: NonNegativeInt,
  total: NonNegativeInt,
  rows: Schema.Array(RowSummary).check(Schema.isMaxLength(CHILDREN_PAGE_LIMIT)),
});
export type RowsPage = typeof RowsPage.Type;

/** A preview decodes at most this many bytes of a value. */
export const MAX_PREVIEW_BYTES = 4096;
export const PreviewBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_PREVIEW_BYTES }),
);
/** Text the engine cut to a preview's bytes: never more UTF-16 units than that. */
const PreviewText = Schema.String.check(Schema.isMaxLength(MAX_PREVIEW_BYTES));

/**
 * One HAR entry as the map groups it (capture → host → page →
 * entry): the entry object's node, the host of `request.url` and its
 * `pageref`. Null when the entry lacks the field.
 */
export const HarEntrySummary = Schema.Struct({
  ref: NodeRef,
  host: Schema.NullOr(PreviewText),
  pageref: Schema.NullOr(PreviewText),
  /** `request.method`, `request.url` (its first bytes) and `response.status`, for the entry's row. */
  method: Schema.NullOr(PreviewText),
  url: Schema.NullOr(PreviewText),
  status: Schema.NullOr(Schema.Number),
});
export type HarEntrySummary = typeof HarEntrySummary.Type;

export const HarPageSummary = Schema.Struct({
  ref: NodeRef,
  id: Schema.NullOr(PreviewText),
  title: Schema.NullOr(PreviewText),
});
export type HarPageSummary = typeof HarPageSummary.Type;

/** A page of `log.entries`, with `log.pages` on every page so the caller needs no second request. */
export const HarEntriesPage = Schema.Struct({
  /** The `log.entries` array itself, or null when the document has none. */
  entries: Schema.NullOr(NodeRef),
  from: NonNegativeInt,
  total: NonNegativeInt,
  pages: Schema.Array(HarPageSummary).check(Schema.isMaxLength(CHILDREN_PAGE_LIMIT)),
  items: Schema.Array(HarEntrySummary).check(Schema.isMaxLength(CHILDREN_PAGE_LIMIT)),
});
export type HarEntriesPage = typeof HarEntriesPage.Type;

export const SearchMode = Schema.Literals(["literal", "regex"]);
export type SearchMode = typeof SearchMode.Type;

/** The longest search text, path or jq program the engine accepts. */
export const MAX_QUERY_CHARS = 4096;
const QueryText = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_QUERY_CHARS));

/**
 * What to find. The text is matched against the
 * text the user sees, which is the file's text with the escapes inside JSON
 * strings replaced by the characters they stand for; hits are non-overlapping,
 * leftmost first, and reported as byte ranges of the file.
 */
export const SearchQuery = Schema.Struct({
  mode: SearchMode,
  text: QueryText,
  caseSensitive: Schema.Boolean,
});
export type SearchQuery = typeof SearchQuery.Type;

/** How a search ended: `partial` when too many chunks overran the regex time budget. */
export const SearchStatus = Schema.Literals(["complete", "partial", "cancelled"]);
export type SearchStatus = typeof SearchStatus.Type;

/** The most hits one search keeps for next/previous and lighting; the count stays exact. */
export const MAX_RETAINED_HITS = 262_144;

export const SearchSummary = Schema.Struct({
  searchId: PositiveInt,
  /** Every hit in the searched text, exactly. */
  count: NonNegativeInt,
  /** Hits kept for next and previous: the first `retained` in file order. */
  retained: NonNegativeInt,
  /** Every hit that starts before this offset is among the retained ones. */
  retainedUntil: ByteOffset,
  /** Parts of the file the regex did not finish in time, in bytes of the file. */
  skipped: Schema.Array(ByteRange),
  /** Matches that may have been cut where a chunk's lookahead ended (regex). */
  limited: NonNegativeInt,
  status: SearchStatus,
});
export type SearchSummary = typeof SearchSummary.Type;

export const MAX_HIT_RANGES = 4096;

/** Hits that overlap a byte range, in order, with the index of the first one in the whole list. */
export const SearchRanges = Schema.Struct({
  firstIndex: NonNegativeInt,
  ranges: Schema.Array(ByteRange).check(Schema.isMaxLength(MAX_HIT_RANGES)),
});
export type SearchRanges = typeof SearchRanges.Type;

export const SearchHit = Schema.NullOr(Schema.Struct({ index: NonNegativeInt, range: ByteRange }));
export type SearchHit = typeof SearchHit.Type;

export const MAX_PATH_RESULTS = 10_000;

/** The longest path text a path result carries; a longer one is cut and ends in `…`. */
export const MAX_PATH_TEXT_LENGTH = 4096;
const PathText = Schema.String.check(Schema.isMaxLength(MAX_PATH_TEXT_LENGTH));

export const PathMatch = Schema.Struct({
  node: NodeSummary,
  /** The member key or `[index]` the node sits under; empty for the root. */
  label: KeyText,
  /** The start of a scalar's text (at most 80 bytes); empty for objects and arrays. */
  preview: PreviewText,
  /** Where the node sits, as a path: `$.log.entries[3].request.url`. */
  path: PathText,
});
export type PathMatch = typeof PathMatch.Type;

export const PathQueryResult = Schema.Struct({
  /** Nodes the path selects; exact when `complete`, else what was found before a limit. */
  total: NonNegativeInt,
  complete: Schema.Boolean,
  results: Schema.Array(PathMatch).check(Schema.isMaxLength(MAX_PATH_RESULTS)),
});
export type PathQueryResult = typeof PathQueryResult.Type;

/** The most output the jq bar returns. */
export const JQ_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const JQ_MIN_TIMEOUT_MS = 100;
const JQ_MAX_TIMEOUT_MS = 60_000;
export const JQ_DEFAULT_TIMEOUT_MS = 10_000;

export const JqResult = Schema.Struct({
  status: Schema.Literals(["ok", "error", "timeout"]),
  /** jq's output, one result per line; at most {@link JQ_OUTPUT_LIMIT_BYTES}. */
  output: Schema.String.check(Schema.isMaxLength(JQ_OUTPUT_LIMIT_BYTES)),
  /** The output was cut at the limit. */
  truncated: Schema.Boolean,
  /** jq's message for `error`, or the budget for `timeout`. */
  message: Schema.String,
  /** Size of the subtree jq ran on. */
  inputBytes: NonNegativeInt,
});
export type JqResult = typeof JqResult.Type;

/** A string that held JSON, indexed as a child document over its unescaped bytes. */
export const NestedDocument = Schema.Struct({
  root: NodeSummary,
  bytes: NonNegativeInt,
});
export type NestedDocument = typeof NestedDocument.Type;

/** A slice request names at most `MAX_SLICE_BYTES` bytes; a bigger one fails to decode. */
export const SliceRange = ByteRange.check(
  Schema.makeFilter((range: { readonly start: number; readonly end: number }) =>
    range.end - range.start <= MAX_SLICE_BYTES
      ? true
      : `a ${range.end - range.start}-byte slice, over the ${MAX_SLICE_BYTES}-byte limit`,
  ),
);

/**
 * The Source view's unit: a row is a line of the file, or a piece of a long one.
 * Rows are cut at newlines and, inside a line, every `wrapBytes` bytes from the
 * line's start, so a 2 GiB single-line HAR is still a column of short rows.
 * A line is also cut where it crosses a multiple of {@link SOURCE_LINE_BLOCK_BYTES},
 * so the start of a row's line is never searched for farther back than that.
 */
export const SOURCE_LINE_BLOCK_BYTES = 1024 * 1024;
export const SOURCE_MAX_ROWS = 256;
export const SOURCE_MIN_WRAP_BYTES = 16;
export const SOURCE_MAX_WRAP_BYTES = 4096;
/** A row is cut `wrapBytes` in, moved forward to a code point: at most 3 bytes more. */
const SourceRowText = Schema.String.check(Schema.isMaxLength(SOURCE_MAX_WRAP_BYTES + 3));
/** Line numbers and columns are counted only this far from the start of the file. */
export const SOURCE_LINE_NUMBER_LIMIT_BYTES = 64 * 1024 * 1024;

/** The kinds of token a JSON document is painted with; the syntax table colors each one. */
export const SourceTokenKind = Schema.Literals([
  "key",
  "keyQuote",
  "string",
  "stringQuote",
  "escape",
  "number",
  "literal",
  "brace",
  "bracket",
  "colon",
  "comma",
  "whitespace",
]);
export type SourceTokenKind = typeof SourceTokenKind.Type;

export const SourceContainerKind = Schema.Literals(["object", "array", "root"]);
export type SourceContainerKind = typeof SourceContainerKind.Type;

/**
 * A colored piece of a row, in UTF-16 units of the row's text. `depth` counts the
 * objects enclosing the token (a key of the top-level object is 1) and
 * `container` is the container the token sits in; the theme's syntax table maps
 * the three to a color.
 */
export const SourceSpan = Schema.Struct({
  from: NonNegativeInt,
  to: NonNegativeInt,
  kind: SourceTokenKind,
  depth: NonNegativeInt,
  container: SourceContainerKind,
});
export type SourceSpan = typeof SourceSpan.Type;

export const SourceRow = Schema.Struct({
  /** `[start, end)` in bytes of the file, without the line break. */
  start: ByteOffset,
  end: ByteOffset,
  text: SourceRowText,
  /** 1-based line number; null farther than {@link SOURCE_LINE_NUMBER_LIMIT_BYTES} from the start. */
  line: Schema.NullOr(PositiveInt),
  /** UTF-16 units from the start of the line to the start of this row; null as `line` is. */
  column: Schema.NullOr(NonNegativeInt),
  /** Columns to draw a wrapped row indented by, under its line's text; 0 for a line's first row. */
  indent: NonNegativeInt,
  /** Empty for a document with no structure. */
  spans: Schema.Array(SourceSpan),
});
export type SourceRow = typeof SourceRow.Type;

export const SourceRows = Schema.Struct({
  /** `before` rows, then `rows` rows: at most twice SOURCE_MAX_ROWS. */
  rows: Schema.Array(SourceRow).check(Schema.isMaxLength(2 * SOURCE_MAX_ROWS)),
  size: ByteOffset,
  /** The first row starts at byte 0. */
  atStart: Schema.Boolean,
  /** The last row ends at the end of the file. */
  atEnd: Schema.Boolean,
});
export type SourceRows = typeof SourceRows.Type;

export const SOURCE_PATH_LIMIT = 1024;

/** One ancestor of a byte offset, with the node's position among its parent's children. */
export const PathStep = Schema.Struct({
  node: NodeSummary,
  /** Null for the root, and for a node whose parent has no on-tape or on-demand listing. */
  index: Schema.NullOr(NonNegativeInt),
});
export type PathStep = typeof PathStep.Type;

/** The root-first chain of nodes containing a byte offset; empty when the offset is between values. */
export const NodePath = Schema.Struct({
  path: Schema.Array(PathStep).check(Schema.isMaxLength(SOURCE_PATH_LIMIT)),
});
export type NodePath = typeof NodePath.Type;

/**
 * Decoders. `detect` names what a string can be decoded
 * as from its first 4 KiB; `decode` does one of those on demand and answers
 * with the child document the tree shows and the view the Inspector shows.
 */
export const DecoderKind = Schema.Literals([
  "json",
  "base64",
  "jwt",
  "form",
  "graphql",
  "ndjson",
  "svg",
]);
export type DecoderKind = typeof DecoderKind.Type;

export const Detection = Schema.Struct({
  kind: DecoderKind,
  /** What the badge says: `JWT · HS256`, `base64 · image/png`, `GraphQL · query Products`. */
  label: Schema.String,
  /** For base64: the type of the decoded content, when it is known. */
  mime: Schema.NullOr(Schema.String),
  /** The decoded value has rows of its own in the tree; an image or a binary blob has only a preview. */
  structured: Schema.Boolean,
});
export type Detection = typeof Detection.Type;

export const FormField = Schema.Struct({ name: Schema.String, value: Schema.String });
export type FormField = typeof FormField.Type;

export const DecodedView = Schema.Union([
  /** Text: unescaped nested JSON (re-indented), a pretty GraphQL document, a decoded text body. */
  Schema.TaggedStruct("text", { value: TextValue }),
  /** An image the browser can draw; `preview` returns its bytes as a Blob. */
  Schema.TaggedStruct("image", { mime: Schema.String, bytes: NonNegativeInt }),
  /** Anything else decoded from base64: its type, size and the first bytes in hex. */
  Schema.TaggedStruct("binary", {
    mime: Schema.String,
    bytes: NonNegativeInt,
    hex: Schema.String,
  }),
  Schema.TaggedStruct("jwt", {
    header: TextValue,
    payload: TextValue,
    algorithm: Schema.NullOr(Schema.String),
    /** The signature segment as sent. It is never verified. */
    signature: Schema.String,
    signatureBytes: NonNegativeInt,
    verified: Schema.Literal(false),
  }),
  Schema.TaggedStruct("form", {
    fields: Schema.Array(FormField),
    total: NonNegativeInt,
  }),
  /** The first lines of an NDJSON body, as sent. */
  Schema.TaggedStruct("lines", {
    lines: Schema.Array(Schema.String),
    total: NonNegativeInt,
  }),
]);
export type DecodedView = typeof DecodedView.Type;

export const Decoded = Schema.Struct({
  kind: DecoderKind,
  label: Schema.String,
  /** Encodings peeled off on the way, outermost first: `["base64", "gzip"]`. */
  layers: Schema.Array(Schema.String),
  mime: Schema.NullOr(Schema.String),
  /** Size of the decoded value. */
  bytes: NonNegativeInt,
  /** The decoded value as children of the string's row, when it has structure. */
  document: Schema.NullOr(NestedDocument),
  view: DecodedView,
});
export type Decoded = typeof Decoded.Type;

export const ImagePreview = Schema.Struct({
  blob: Schema.instanceOf(Blob),
  mime: Schema.String,
  bytes: NonNegativeInt,
});
export type ImagePreview = typeof ImagePreview.Type;

/** A page of HAR `_webSocketMessages` frames, read by their members (DevTools shape). */
const FRAMES_PAGE_LIMIT = 256;
export const FramesCount = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: FRAMES_PAGE_LIMIT }),
);

export const WebSocketFrame = Schema.Struct({
  index: NonNegativeInt,
  ref: NodeRef,
  direction: Schema.Literals(["send", "receive", "unknown"]),
  /** Seconds since the Unix epoch, as DevTools writes it. */
  time: Schema.NullOr(Schema.Number),
  /** 1 is text, 2 is binary (the data is base64). */
  opcode: Schema.NullOr(Schema.Int),
  /** Bytes of the payload: the text's length, or the decoded length of a binary frame. */
  size: NonNegativeInt,
  /** The first bytes of a text frame, or of a decoded binary one when they are text. */
  preview: PreviewText,
  mime: Schema.NullOr(Schema.String),
  /** The frame's `data` string, so a row can expand it like any other string. */
  dataRef: Schema.NullOr(NodeRef),
  detections: Schema.Array(Detection),
});
export type WebSocketFrame = typeof WebSocketFrame.Type;

export const FramesPage = Schema.Struct({
  from: NonNegativeInt,
  total: NonNegativeInt,
  frames: Schema.Array(WebSocketFrame).check(Schema.isMaxLength(FRAMES_PAGE_LIMIT)),
});
export type FramesPage = typeof FramesPage.Type;

/** How many of the biggest strings `largestStrings` returns at most. */
const LARGEST_STRINGS_LIMIT = 64;
export const LargestStringsLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: LARGEST_STRINGS_LIMIT }),
);

/**
 * Whole-subtree edits (sort and transform): each one is a single
 * undoable edit whose bytes stream through the piece table into a spill buffer
 * (the journal directory when the document has one), never into one string.
 */
export const Transform = Schema.Union([
  /** `JSON.stringify(x, null, indent)` layout for the node, indented for its depth. */
  Schema.TaggedStruct("format", {
    indent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  }),
  Schema.TaggedStruct("minify", {}),
  /** Members of an object by key, code-unit order; stable for equal keys. */
  Schema.TaggedStruct("sortKeys", { descending: Schema.Boolean }),
  /**
   * Elements of an array by their own value (`field: null`) or by the value of
   * `field` in each element object; nulls, booleans, numbers, strings in that
   * order, containers and missing fields last in their original order.
   */
  Schema.TaggedStruct("sortArray", {
    field: Schema.NullOr(KeyText),
    descending: Schema.Boolean,
  }),
]);
export type Transform = typeof Transform.Type;

/** A storage identity (`kind:rest`), no longer than a file name. */
const JournalKey = Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH));

/**
 * A document read through a port that answers bounded reads (`documentSource.ts`):
 * the desktop's main-process file handle. `size` is the file's size when it was opened.
 */
export const DocumentPort = Schema.TaggedStruct("DocumentPort", {
  port: Schema.instanceOf(MessagePort),
  size: NonNegativeInt,
});
export type DocumentPort = typeof DocumentPort.Type;

/** What an opened document's bytes come from: a File or Blob on the web, a port on the desktop. */
export const DocumentSource = Schema.Union([Schema.instanceOf(Blob), DocumentPort]);
export type DocumentSource = typeof DocumentSource.Type;

/** Sort reads every child; a container past this many is refused. */
export const MAX_SORT_CHILDREN = 1_000_000;

export const EngineRequest = Schema.Union([
  Schema.TaggedStruct("capabilities", {}),
  /**
   * `journalKey` is the document's storage identity (`kind:rest`); with it the
   * engine journals every edit under `journals/<kind>/<rest>/` and replays what a
   * previous session left there.
   */
  Schema.TaggedStruct("open", {
    source: DocumentSource,
    name: DocumentName,
    journalKey: Schema.optionalKey(JournalKey),
    /** Starts the journal for `journalKey` over instead of replaying what it holds. */
    discardJournal: Schema.optionalKey(Schema.Boolean),
    /** Reads the file as this format whatever its name and bytes say (a `.json` file as JSONC). */
    asFormat: Schema.optionalKey(DocumentFormat),
  }),
  Schema.TaggedStruct("close", { documentId: DocumentId }),
  Schema.TaggedStruct("root", { documentId: DocumentId }),
  Schema.TaggedStruct("node", { ref: NodeRef }),
  Schema.TaggedStruct("children", { ref: NodeRef, from: NonNegativeInt, count: ChildrenCount }),
  Schema.TaggedStruct("rows", {
    ref: NodeRef,
    from: NonNegativeInt,
    count: ChildrenCount,
    previewBytes: PreviewBytes,
  }),
  Schema.TaggedStruct("harEntries", {
    documentId: DocumentId,
    from: NonNegativeInt,
    count: ChildrenCount,
  }),
  /** A node's text, edits applied: a string's content decoded, any other value as written. */
  Schema.TaggedStruct("text", { ref: NodeRef, limit: SliceBytes }),
  Schema.TaggedStruct("keyText", { ref: NodeRef }),
  /** The first `bytes` of the file as text: how a document with no structure is shown. */
  Schema.TaggedStruct("headText", { documentId: DocumentId, bytes: SliceBytes }),
  Schema.TaggedStruct("slice", { documentId: DocumentId, tapeId: TapeId, range: SliceRange }),
  /** Finds every hit of `query` in the document and keeps them for `searchHits`, `searchHit` and `searchSeek`. */
  Schema.TaggedStruct("search", { documentId: DocumentId, query: SearchQuery }),
  /** The hits that overlap `[from, to)` of a finished search, at most `limit`. */
  Schema.TaggedStruct("searchHits", {
    documentId: DocumentId,
    searchId: PositiveInt,
    from: ByteOffset,
    to: ByteOffset,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HIT_RANGES })),
  }),
  /** For each range, whether a hit overlaps it: how the tree decides which rows to light. */
  Schema.TaggedStruct("searchLit", {
    documentId: DocumentId,
    searchId: PositiveInt,
    ranges: Schema.Array(ByteRange).check(Schema.isMaxLength(MAX_HIT_RANGES)),
  }),
  /** The `index`-th retained hit; the index wraps around the retained list. */
  Schema.TaggedStruct("searchHit", {
    documentId: DocumentId,
    searchId: PositiveInt,
    index: Schema.Int,
  }),
  /** The index of the first retained hit that ends after `offset`, or 0 past the last. */
  Schema.TaggedStruct("searchSeek", {
    documentId: DocumentId,
    searchId: PositiveInt,
    offset: ByteOffset,
  }),
  /** Drops a search's hits. */
  Schema.TaggedStruct("searchClose", { documentId: DocumentId, searchId: PositiveInt }),
  /**
   * Evaluates a JSONPath over the structural index: `$`, `.key`,
   * `['key']`, `[n]`, `[*]`, `..key` and slices `[a:b:c]`; nothing is materialized.
   */
  Schema.TaggedStruct("pathQuery", {
    documentId: DocumentId,
    path: QueryText,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PATH_RESULTS })),
  }),
  /**
   * Runs a jq program on the value of a node, materialized through the bounded
   * slice (at most 64 MiB), in a worker with a time budget.
   */
  Schema.TaggedStruct("jq", {
    ref: NodeRef,
    program: QueryText,
    timeoutMs: Schema.Int.check(
      Schema.isBetween({ minimum: JQ_MIN_TIMEOUT_MS, maximum: JQ_MAX_TIMEOUT_MS }),
    ),
  }),
  Schema.TaggedStruct("expandNested", { ref: NodeRef }),
  Schema.TaggedStruct("largestStrings", { documentId: DocumentId, limit: LargestStringsLimit }),
  Schema.TaggedStruct("stringHead", { ref: NodeRef, bytes: SliceBytes }),
  Schema.TaggedStruct("decodeBase64Head", { ref: NodeRef, decodedBytes: SliceBytes }),
  /**
   * The rows of the file around a byte offset, colored from the structural index:
   * `before` rows above the row that contains `offset`, then that row and `rows - 1`
   * below it. An offset at or past the end of the file anchors on the last row.
   */
  Schema.TaggedStruct("sourceRows", {
    documentId: DocumentId,
    offset: ByteOffset,
    before: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: SOURCE_MAX_ROWS })),
    rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SOURCE_MAX_ROWS })),
    wrapBytes: Schema.Int.check(
      Schema.isBetween({ minimum: SOURCE_MIN_WRAP_BYTES, maximum: SOURCE_MAX_WRAP_BYTES }),
    ),
  }),
  /** The nodes containing a byte offset, root first: how a click in the source finds its node. */
  Schema.TaggedStruct("nodeAt", { documentId: DocumentId, offset: ByteOffset }),
  Schema.TaggedStruct("detect", { ref: NodeRef }),
  Schema.TaggedStruct("decode", { ref: NodeRef, kind: DecoderKind }),
  Schema.TaggedStruct("preview", { ref: NodeRef }),
  Schema.TaggedStruct("frames", { ref: NodeRef, from: NonNegativeInt, count: FramesCount }),
  /** Replaces the node's value with the JSON text `json` (the engine re-indexes and refuses text that is not one value). */
  Schema.TaggedStruct("setValue", { ref: NodeRef, json: SliceText }),
  /** Renames the member the node is the value of. */
  Schema.TaggedStruct("setKey", { ref: NodeRef, key: KeyText }),
  /**
   * The source view's edit: replaces logical byte range `range` of the document
   * the tape belongs to with `bytes`. Refused when no enclosing value re-indexes
   * cleanly afterwards.
   */
  Schema.TaggedStruct("replaceBytes", {
    documentId: DocumentId,
    tapeId: TapeId,
    range: ByteRange,
    bytes: SliceBytesArray,
  }),
  Schema.TaggedStruct("undo", { documentId: DocumentId }),
  Schema.TaggedStruct("redo", { documentId: DocumentId }),
  /** The document's history and dirty flag, once a recovered journal has been replayed. */
  Schema.TaggedStruct("editState", { documentId: DocumentId }),
  /** Forgets the document's unsaved edits for good: its journal starts over, so they are not restored next time. */
  Schema.TaggedStruct("dropJournal", { documentId: DocumentId }),
  /** Logical bytes of the (edited) document the tape belongs to, for the source view. */
  Schema.TaggedStruct("logicalSlice", {
    documentId: DocumentId,
    tapeId: TapeId,
    range: SliceRange,
  }),
  /**
   * Writes the document into the sink. `inPlace` says the sink is the document's
   * own file: its journal then starts over at the save, and `rekeyJournal` moves
   * it to the saved file's identity once the page knows it.
   */
  Schema.TaggedStruct("save", {
    documentId: DocumentId,
    sink: SaveSink,
    indent: SaveIndent,
    inPlace: Schema.optionalKey(Schema.Boolean),
  }),
  /**
   * After a save in place: the saved file's journal key, under which the edits
   * made from the save on are journaled; null when it has none (they are not).
   */
  Schema.TaggedStruct("rekeyJournal", {
    documentId: DocumentId,
    journalKey: Schema.NullOr(JournalKey),
  }),
  Schema.TaggedStruct("transform", { ref: NodeRef, transform: Transform }),
  /** Whether the indexed bytes are valid JSON, once the index is complete: null when they are. */
  Schema.TaggedStruct("problem", { documentId: DocumentId }),
  /**
   * Reads the document's file from a private copy from now on, so the file itself
   * can be written over (a save in place) without losing the bytes the document
   * and its undo history still stand on.
   */
  Schema.TaggedStruct("detach", { documentId: DocumentId }),
  /** Which formats the document can be exported to, and why not where it cannot. */
  Schema.TaggedStruct("exportTargets", { documentId: DocumentId }),
  /** Streams the document (its edits applied) converted to `to` into the sink. The document is unchanged. */
  Schema.TaggedStruct("convert", {
    documentId: DocumentId,
    to: ConvertFormat,
    settings: ConvertSettings,
    sink: SaveSink,
  }),
]);
export type EngineRequest = typeof EngineRequest.Type;
export type EngineRequestTag = EngineRequest["_tag"];

/** The result schema per request tag; the client decodes replies with these. */
export const EngineResult = {
  capabilities: EngineCapabilities,
  open: DocumentInfo,
  close: Schema.Null,
  root: NodeSummary,
  node: NodeSummary,
  children: ChildrenPage,
  rows: RowsPage,
  harEntries: HarEntriesPage,
  text: TextValue,
  keyText: KeyText,
  headText: TextValue,
  slice: SliceBytesArray,
  search: SearchSummary,
  searchHits: SearchRanges,
  searchLit: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(MAX_HIT_RANGES)),
  searchHit: SearchHit,
  searchSeek: NonNegativeInt,
  searchClose: Schema.Null,
  pathQuery: PathQueryResult,
  jq: JqResult,
  expandNested: NestedDocument,
  /** The document's biggest strings (256 KiB and up, from the eager pass), largest first. */
  largestStrings: Schema.Array(NodeSummary).check(Schema.isMaxLength(LARGEST_STRINGS_LIMIT)),
  stringHead: SliceBytesArray,
  decodeBase64Head: SliceBytesArray,
  sourceRows: SourceRows,
  nodeAt: NodePath,
  detect: Schema.Array(Detection),
  decode: Decoded,
  preview: ImagePreview,
  frames: FramesPage,
  setValue: EditResult,
  setKey: EditResult,
  replaceBytes: EditResult,
  undo: EditResult,
  redo: EditResult,
  editState: EditState,
  dropJournal: Schema.Null,
  rekeyJournal: Schema.Null,
  logicalSlice: SliceBytesArray,
  save: SaveResult,
  transform: EditResult,
  problem: Schema.NullOr(DocumentProblem),
  detach: Schema.Null,
  exportTargets: Schema.Array(ExportTarget).check(Schema.isMaxLength(CONVERT_FORMATS.length)),
  convert: SaveResult,
} as const satisfies Record<EngineRequestTag, Schema.Top>;
export type EngineResult = {
  readonly [Tag in EngineRequestTag]: (typeof EngineResult)[Tag]["Type"];
};

export class DocumentNotOpenError extends Schema.TaggedError<DocumentNotOpenError>()(
  "DocumentNotOpenError",
  { documentId: DocumentId },
) {
  override get message(): string {
    return `Document ${this.documentId} is not open in the engine.`;
  }
}

export class NodeNotFoundError extends Schema.TaggedError<NodeNotFoundError>()(
  "NodeNotFoundError",
  { ref: NodeRef },
) {
  override get message(): string {
    return `Node ${this.ref.token} on tape ${this.ref.tapeId} of document ${this.ref.documentId} does not exist.`;
  }
}

export class SliceTooLargeError extends Schema.TaggedError<SliceTooLargeError>()(
  "SliceTooLargeError",
  { bytes: NonNegativeInt, limit: PositiveInt },
) {
  override get message(): string {
    return `A ${this.bytes}-byte slice exceeds the ${this.limit}-byte limit.`;
  }
}

export class NotNestedJsonError extends Schema.TaggedError<NotNestedJsonError>()(
  "NotNestedJsonError",
  { ref: NodeRef },
) {
  override get message(): string {
    return `Node ${this.ref.token} on tape ${this.ref.tapeId} is not a string holding JSON.`;
  }
}

export class InvalidSearchPatternError extends Schema.TaggedError<InvalidSearchPatternError>()(
  "InvalidSearchPatternError",
  { pattern: QueryText, detail: Schema.String },
) {
  override get message(): string {
    return `Not a valid regular expression: ${this.detail}`;
  }
}

export class SearchNotFoundError extends Schema.TaggedError<SearchNotFoundError>()(
  "SearchNotFoundError",
  { searchId: PositiveInt },
) {
  override get message(): string {
    return `Search ${this.searchId} is no longer open.`;
  }
}

export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()("InvalidPathError", {
  path: Schema.String,
  detail: Schema.String,
  /** UTF-16 index in `path` where it stopped making sense. */
  at: NonNegativeInt,
}) {
  override get message(): string {
    return `Not a valid path: ${this.detail}.`;
  }
}

export class JqSubtreeTooLargeError extends Schema.TaggedError<JqSubtreeTooLargeError>()(
  "JqSubtreeTooLargeError",
  { bytes: NonNegativeInt, limit: PositiveInt },
) {
  override get message(): string {
    const mib = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;
    return `This node holds ${mib(this.bytes)}; jq runs on nodes up to ${mib(this.limit)}. Select a smaller node, or use a path query to reach it.`;
  }
}

export class NotDecodableError extends Schema.TaggedError<NotDecodableError>()(
  "NotDecodableError",
  { ref: NodeRef, kind: DecoderKind },
) {
  override get message(): string {
    return `Node ${this.ref.token} on tape ${this.ref.tapeId} is not ${this.kind}.`;
  }
}

export class EngineWorkerError extends Schema.TaggedError<EngineWorkerError>()(
  "EngineWorkerError",
  { detail: ErrorDetail },
) {
  override get message(): string {
    return `The engine worker failed: ${this.detail}`;
  }
}

/** The edited bytes do not re-index as one JSON value anywhere up to the root; the document is unchanged. */
export class InvalidEditError extends Schema.TaggedError<InvalidEditError>()("InvalidEditError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The edit does not leave valid JSON: ${this.detail}`;
  }
}

/**
 * An edit the engine will not make, and why, in the words the editor shows. The
 * document is unchanged. `remedy` names a command that does what was meant.
 */
export class EditRefusedError extends Schema.TaggedError<EditRefusedError>()("EditRefusedError", {
  detail: Schema.String,
  remedy: Schema.optionalKey(Schema.Literals(["sortArrayByField"])),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Undo with nothing to undo, or redo with nothing to redo. */
export class NothingToUndoError extends Schema.TaggedError<NothingToUndoError>()(
  "NothingToUndoError",
  {
    direction: Schema.Literals(["undo", "redo"]),
  },
) {
  override get message(): string {
    return `Nothing to ${this.direction}.`;
  }
}

/**
 * A conversion that could not finish. `pointer` is the JSON Pointer of the
 * first node the target cannot hold, and `line` the 1-based line of a syntax
 * error in the file; either is null when the converter did not know it.
 */
export class ConvertError extends Schema.TaggedError<ConvertError>()("ConvertError", {
  to: ConvertFormat,
  reason: Schema.String,
  pointer: Schema.NullOr(Schema.String),
  line: Schema.NullOr(PositiveInt),
  detail: ErrorDetail,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const EngineError = Schema.Union([
  DocumentNotOpenError,
  NodeNotFoundError,
  SliceTooLargeError,
  NotNestedJsonError,
  InvalidSearchPatternError,
  SearchNotFoundError,
  InvalidPathError,
  JqSubtreeTooLargeError,
  NotDecodableError,
  EngineWorkerError,
  InvalidEditError,
  EditRefusedError,
  NothingToUndoError,
  ConvertError,
]);
export type EngineError = typeof EngineError.Type;

export const EngineEvent = Schema.Union([
  Schema.TaggedStruct("indexProgress", { progress: IndexProgress }),
  Schema.TaggedStruct("editState", { state: EditState }),
]);
export type EngineEvent = typeof EngineEvent.Type;

/** The `postMessage` envelopes. Replies carry the raw result; the client decodes it by tag. */
export const EngineRequestEnvelope = Schema.Struct({ id: PositiveInt, request: EngineRequest });
export type EngineRequestEnvelope = typeof EngineRequestEnvelope.Type;

export const EngineReplyEnvelope = Schema.Union([
  Schema.Struct({ id: PositiveInt, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ id: PositiveInt, ok: Schema.Literal(false), error: EngineError }),
]);
export type EngineReplyEnvelope = typeof EngineReplyEnvelope.Type;

export const EngineEventEnvelope = Schema.Struct({ event: EngineEvent });
export type EngineEventEnvelope = typeof EngineEventEnvelope.Type;
