import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { DocumentFormat, DocumentId, NodeKind } from "./enginePrimitives.ts";

/** Maximum byte length supported by whole-document structural JSON diff (256 MiB). */
export const MAX_STRUCTURAL_DIFF_BYTES = 256 * 1024 * 1024;
const MAX_DIFF_CHANGES = 1_000_000;
const MAX_DIFF_MERGED_ROWS = 2_000_000;
export const MAX_DIFF_PREVIEW_BYTES = 256;

export const DiffChangeKind = Schema.Literals(["added", "removed", "changed", "moved"]);
export type DiffChangeKind = typeof DiffChangeKind.Type;

export const DiffMark = Schema.Literals(["same", "added", "removed", "changed", "moved", "inside"]);
export type DiffMark = typeof DiffMark.Type;

export const DiffChange = Schema.Struct({
  kind: DiffChangeKind,
  aToken: Schema.NullOr(NonNegativeInt),
  bToken: Schema.NullOr(NonNegativeInt),
  pathA: Schema.NullOr(Schema.String),
  pathB: Schema.NullOr(Schema.String),
});
export type DiffChange = typeof DiffChange.Type;

export const DiffMergedRow = Schema.Struct({
  id: Schema.String,
  aToken: Schema.NullOr(NonNegativeInt),
  bToken: Schema.NullOr(NonNegativeInt),
  depth: NonNegativeInt,
  mark: DiffMark,
  kind: NodeKind,
  key: Schema.NullOr(Schema.String),
  index: Schema.NullOr(NonNegativeInt),
  value: Schema.String,
  wasValue: Schema.NullOr(Schema.String),
  pointer: Schema.String,
  expandable: Schema.Boolean,
  childCount: NonNegativeInt,
});
export type DiffMergedRow = typeof DiffMergedRow.Type;

export const StructuralDiffCounts = Schema.Struct({
  same: NonNegativeInt,
  added: NonNegativeInt,
  removed: NonNegativeInt,
  changed: NonNegativeInt,
  moved: NonNegativeInt,
});
export type StructuralDiffCounts = typeof StructuralDiffCounts.Type;

export const StructuralDiffResult = Schema.Struct({
  changes: Schema.Array(DiffChange).check(Schema.isMaxLength(MAX_DIFF_CHANGES)),
  counts: StructuralDiffCounts,
  rows: Schema.Array(DiffMergedRow).check(Schema.isMaxLength(MAX_DIFF_MERGED_ROWS)),
});
export type StructuralDiffResult = typeof StructuralDiffResult.Type;

export const HarDiffClass = Schema.Literals(["same", "added", "removed", "changed"]);
export type HarDiffClass = typeof HarDiffClass.Type;

export const HarChangedSection = Schema.Literals([
  "headers",
  "query",
  "postData",
  "status",
  "body",
]);
export type HarChangedSection = typeof HarChangedSection.Type;

export const HarDiffEntry = Schema.Struct({
  matchKey: Schema.String,
  groupId: NonNegativeInt,
  occurrence: NonNegativeInt,
  classification: HarDiffClass,
  method: Schema.String,
  url: Schema.String,
  resourceType: Schema.String,
  statusBefore: Schema.NullOr(NonNegativeInt),
  statusAfter: Schema.NullOr(NonNegativeInt),
  entryIndexBefore: Schema.NullOr(NonNegativeInt),
  entryIndexAfter: Schema.NullOr(NonNegativeInt),
  changedSections: Schema.Array(HarChangedSection),
});
export type HarDiffEntry = typeof HarDiffEntry.Type;

export const HarDiffCounts = Schema.Struct({
  same: NonNegativeInt,
  added: NonNegativeInt,
  removed: NonNegativeInt,
  changed: NonNegativeInt,
});
export type HarDiffCounts = typeof HarDiffCounts.Type;

export const HarDiffSummary = Schema.Struct({
  referenceIndex: NonNegativeInt,
  counts: HarDiffCounts,
  entries: Schema.Array(HarDiffEntry),
});
export type HarDiffSummary = typeof HarDiffSummary.Type;

export const CompareDocumentMeta = Schema.Struct({
  documentId: DocumentId,
  name: Schema.String,
  size: NonNegativeInt,
  format: DocumentFormat,
});
export type CompareDocumentMeta = typeof CompareDocumentMeta.Type;

export class DiffTooLargeError extends Schema.TaggedError<DiffTooLargeError>()(
  "DiffTooLargeError",
  { bytes: NonNegativeInt, limit: PositiveInt, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class DiffCancelledError extends Schema.TaggedError<DiffCancelledError>()(
  "DiffCancelledError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const DiffError = Schema.Union([DiffTooLargeError, DiffCancelledError]);
export type DiffError = typeof DiffError.Type;
