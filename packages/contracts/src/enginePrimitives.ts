import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

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

/** Children are served in buckets of at most this many nodes, so a big array arrives in chunks. */
export const CHILDREN_PAGE_LIMIT = 1024;
export const ChildrenCount = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: CHILDREN_PAGE_LIMIT }),
);

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

export const SearchMode = Schema.Literals(["literal", "regex"]);
export type SearchMode = typeof SearchMode.Type;

/** The longest search text, path or jq program the engine accepts. */
export const MAX_QUERY_CHARS = 4096;
export const QueryText = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_QUERY_CHARS));

/** How a search ended: `partial` when too many chunks overran the regex time budget. */
export const SearchStatus = Schema.Literals(["complete", "partial", "cancelled"]);
export type SearchStatus = typeof SearchStatus.Type;

/** The most output the jq bar returns. */
export const JQ_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** Sort reads every child; a container past this many is refused. */
export const MAX_SORT_CHILDREN = 1_000_000;
