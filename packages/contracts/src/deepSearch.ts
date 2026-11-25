import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import {
  ByteOffset,
  ByteRange,
  DocumentId,
  MAX_QUERY_CHARS,
  NodeRef,
  SearchMode,
  SearchStatus,
} from "./enginePrimitives.ts";

export const MAX_DECODE_CHAIN_DEPTH = 16;
export const MAX_DEEP_ANNOTATIONS = 16_384;
export const MAX_DEEP_SNIPPET_CHARS = 320;
export const MAX_TRACE_OCCURRENCES = 2_000;
const MAX_TRACE_POINTER_CHARS = 4_096;
const MAX_TRACE_URL_CHARS = 4_096;
const MAX_SLICE_TRACE_CHARS = 65_536;
export const MAX_TRACE_VALUE_CHARS = MAX_SLICE_TRACE_CHARS;
const QueryText = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_QUERY_CHARS));

export const DecodeStepName = Schema.Literals([
  "base64",
  "base64url",
  "gzip",
  "jwt",
  "data-url",
  "json-string",
  "json",
  "ndjson",
  "form",
]);
export type DecodeStepName = typeof DecodeStepName.Type;

export const DeepHitAnnotation = Schema.Struct({
  /** Byte range of the outer string in the document's logical bytes. */
  range: ByteRange,
  /** Decode pipeline steps from outer payload to the matched value. */
  decodeChain: Schema.Array(DecodeStepName).check(Schema.isMaxLength(MAX_DECODE_CHAIN_DEPTH)),
  /** Bounded decoded snippet around the match. */
  snippet: Schema.String.check(Schema.isMaxLength(MAX_DEEP_SNIPPET_CHARS)),
  /** Optional JSON Pointer inside the decoded structure. */
  pointer: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_TRACE_POINTER_CHARS))),
});
export type DeepHitAnnotation = typeof DeepHitAnnotation.Type;

export const DeepSearchQuery = Schema.Struct({
  mode: SearchMode,
  text: QueryText,
  caseSensitive: Schema.Boolean,
  deep: Schema.Boolean,
});
export type DeepSearchQuery = typeof DeepSearchQuery.Type;

export const DeepSearchSummary = Schema.Struct({
  searchId: PositiveInt,
  count: NonNegativeInt,
  retained: NonNegativeInt,
  retainedUntil: ByteOffset,
  skipped: Schema.Array(ByteRange),
  limited: NonNegativeInt,
  status: SearchStatus,
  /** Retained deep-decode hit metadata in file order. */
  annotations: Schema.Array(DeepHitAnnotation).check(Schema.isMaxLength(MAX_DEEP_ANNOTATIONS)),
});
export type DeepSearchSummary = typeof DeepSearchSummary.Type;

export const DeepSearchAnnotationsResult = Schema.Struct({
  annotations: Schema.Array(DeepHitAnnotation).check(Schema.isMaxLength(MAX_DEEP_ANNOTATIONS)),
});
export type DeepSearchAnnotationsResult = typeof DeepSearchAnnotationsResult.Type;

export const TraceSectionKind = Schema.Literals([
  "request.headers",
  "request.queryString",
  "request.postData",
  "response.headers",
  "response.content",
  "cookies",
  "other",
]);
export type TraceSectionKind = typeof TraceSectionKind.Type;

export const TraceValueRequest = Schema.Struct({
  /** Exact decoded scalar text to trace across the document. */
  value: Schema.String.check(Schema.isMaxLength(MAX_TRACE_VALUE_CHARS)),
  /** Optional origin node reference (used as the origin anchor for Map trace arcs). */
  originRef: Schema.optional(NodeRef),
  /** Optional origin byte range. */
  originRange: Schema.optional(ByteRange),
});
export type TraceValueRequest = typeof TraceValueRequest.Type;

export const TraceOccurrence = Schema.Struct({
  /** Outer node range in the document's logical bytes. */
  range: ByteRange,
  /** Containing node reference when resolved. */
  ref: Schema.NullOr(NodeRef),
  /** JSON Pointer inside the document (or entry-relative pointer for HAR), including decoded hops. */
  pointer: Schema.String.check(Schema.isMaxLength(MAX_TRACE_POINTER_CHARS)),
  /** Decode chain if the value sat inside an encoded/stringified payload. */
  decodeChain: Schema.Array(DecodeStepName).check(Schema.isMaxLength(MAX_DECODE_CHAIN_DEPTH)),
  /** HAR entry index (0-based) when the document is a HAR capture, else null. */
  entryIndex: Schema.NullOr(NonNegativeInt),
  /** HAR section when the document is a HAR capture, else null. */
  section: Schema.NullOr(TraceSectionKind),
  /** Short context snippet around the traced value. */
  snippet: Schema.String.check(Schema.isMaxLength(MAX_DEEP_SNIPPET_CHARS)),
});
export type TraceOccurrence = typeof TraceOccurrence.Type;

export const TraceEntryGroup = Schema.Struct({
  entryIndex: NonNegativeInt,
  method: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
  url: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_TRACE_URL_CHARS))),
  status: Schema.NullOr(Schema.Int),
  occurrences: Schema.Array(TraceOccurrence).check(Schema.isMaxLength(MAX_TRACE_OCCURRENCES)),
});
export type TraceEntryGroup = typeof TraceEntryGroup.Type;

export const TraceResult = Schema.Struct({
  value: Schema.String.check(Schema.isMaxLength(MAX_TRACE_VALUE_CHARS)),
  total: NonNegativeInt,
  truncated: Schema.Boolean,
  isHar: Schema.Boolean,
  occurrences: Schema.Array(TraceOccurrence).check(Schema.isMaxLength(MAX_TRACE_OCCURRENCES)),
  harGroups: Schema.Array(TraceEntryGroup).check(Schema.isMaxLength(MAX_TRACE_OCCURRENCES)),
});
export type TraceResult = typeof TraceResult.Type;

export const DeepSearchEngineRequests = Schema.Union([
  Schema.TaggedStruct("deepSearch", { documentId: DocumentId, query: DeepSearchQuery }),
  Schema.TaggedStruct("deepSearchAnnotations", {
    documentId: DocumentId,
    searchId: PositiveInt,
    from: ByteOffset,
    to: ByteOffset,
  }),
  Schema.TaggedStruct("traceValue", { documentId: DocumentId, request: TraceValueRequest }),
]);
export type DeepSearchEngineRequests = typeof DeepSearchEngineRequests.Type;

export interface DeepSearchEngineResults {
  readonly deepSearch: DeepSearchSummary;
  readonly deepSearchAnnotations: DeepSearchAnnotationsResult;
  readonly traceValue: TraceResult;
}
