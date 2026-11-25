import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { JQ_OUTPUT_LIMIT_BYTES, KeyText, MAX_QUERY_CHARS, NodeRef } from "./enginePrimitives.ts";

export const ElementMapQueryText = Schema.NonEmptyString.check(Schema.isMaxLength(MAX_QUERY_CHARS));

/** Per-element failure isolated during an `elementMap` or element-mode jq run. */
export const ElementMapItemError = Schema.Struct({
  index: NonNegativeInt,
  key: Schema.NullOr(KeyText),
  bytes: NonNegativeInt,
  message: Schema.String,
});
export type ElementMapItemError = typeof ElementMapItemError.Type;

export const ElementMapProgress = Schema.Struct({
  processed: NonNegativeInt,
  total: NonNegativeInt,
  errors: NonNegativeInt,
  bytesRead: NonNegativeInt,
});
export type ElementMapProgress = typeof ElementMapProgress.Type;

export const ElementMapSummary = Schema.Struct({
  total: NonNegativeInt,
  processed: NonNegativeInt,
  errors: NonNegativeInt,
  cancelled: Schema.Boolean,
});
export type ElementMapSummary = typeof ElementMapSummary.Type;

/** Default container array path offered when whole-document jq exceeds MAX_SLICE_BYTES. */
export const JqSuggestedPath = Schema.Struct({
  path: Schema.String,
  count: NonNegativeInt,
  bytes: NonNegativeInt,
});
export type JqSuggestedPath = typeof JqSuggestedPath.Type;

export const JqElementRequest = Schema.TaggedStruct("jqElement", {
  ref: NodeRef,
  path: Schema.optionalKey(ElementMapQueryText),
  program: ElementMapQueryText,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60_000 })),
  concurrency: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
});
export type JqElementRequest = typeof JqElementRequest.Type;

export const JqElementResult = Schema.Struct({
  status: Schema.Literals(["ok", "partial", "error"]),
  output: Schema.String.check(Schema.isMaxLength(JQ_OUTPUT_LIMIT_BYTES)),
  truncated: Schema.Boolean,
  message: Schema.String,
  path: Schema.String,
  processed: NonNegativeInt,
  total: NonNegativeInt,
  errors: Schema.Array(ElementMapItemError),
  inputBytes: NonNegativeInt,
});
export type JqElementResult = typeof JqElementResult.Type;

export const JqTooLargePayload = Schema.Struct({
  bytes: NonNegativeInt,
  limit: PositiveInt,
  suggestedPath: Schema.NullOr(Schema.String),
});
export type JqTooLargePayload = typeof JqTooLargePayload.Type;

export function formatJqTooLargeMessage(
  bytes: number,
  limit: number,
  suggestedPath: string | null,
): string {
  const mib = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;
  const base = `This node holds ${mib(bytes)}; jq runs on nodes up to ${mib(limit)}.`;
  if (suggestedPath !== null) {
    return `${base} Run per element of ${suggestedPath}, or select a smaller node.`;
  }
  return `${base} Select a smaller node, or use a path query to reach it.`;
}
