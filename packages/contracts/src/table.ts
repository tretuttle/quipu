import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import {
  ByteRange,
  CHILDREN_PAGE_LIMIT,
  ChildrenCount,
  DocumentId,
  MAX_SORT_CHILDREN,
  NodeKind,
  NodeRef,
} from "./enginePrimitives.ts";

export const TABLE_COLUMN_SAMPLE_ROWS = 1024;
export const TABLE_MAX_ROWS = MAX_SORT_CHILDREN;
export const TABLE_CELL_PREVIEW_BYTES = 512;
export const TABLE_TIMELINE_BUCKETS = 96;

export const TableTargetKind = Schema.Literals(["root", "harEntries", "array"]);
export type TableTargetKind = typeof TableTargetKind.Type;

export const TableTarget = Schema.Struct({
  ref: NodeRef,
  path: Schema.String,
  label: Schema.String,
  kind: TableTargetKind,
  rowCount: NonNegativeInt,
  isHarEntries: Schema.Boolean,
});
export type TableTarget = typeof TableTarget.Type;

export const TableTargetsResult = Schema.Struct({
  targets: Schema.Array(TableTarget),
  recommendedPath: Schema.NullOr(Schema.String),
});
export type TableTargetsResult = typeof TableTargetsResult.Type;

export const TableColumnKind = Schema.Literals([
  "string",
  "number",
  "boolean",
  "null",
  "container",
  "mixed",
]);
export type TableColumnKind = typeof TableColumnKind.Type;

export const TableColumn = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  index: NonNegativeInt,
  kind: TableColumnKind,
  late: Schema.Boolean,
});
export type TableColumn = typeof TableColumn.Type;

export const TableSortDirection = Schema.Literals(["asc", "desc"]);
export type TableSortDirection = typeof TableSortDirection.Type;

export const TableSortSpec = Schema.Struct({
  column: Schema.String,
  direction: TableSortDirection,
});
export type TableSortSpec = typeof TableSortSpec.Type;

export const TableFilterSpec = Schema.Struct({
  column: Schema.String,
  query: Schema.String,
});
export type TableFilterSpec = typeof TableFilterSpec.Type;

export const HarTimeWindow = Schema.Struct({
  startMs: Schema.Number,
  endMs: Schema.Number,
});
export type HarTimeWindow = typeof HarTimeWindow.Type;

export const HarTimings = Schema.Struct({
  blocked: Schema.Number,
  dns: Schema.Number,
  connect: Schema.Number,
  ssl: Schema.Number,
  send: Schema.Number,
  wait: Schema.Number,
  receive: Schema.Number,
});
export type HarTimings = typeof HarTimings.Type;

export const HarStatusClass = Schema.Literals(["1xx", "2xx", "3xx", "4xx", "5xx", "other"]);
export type HarStatusClass = typeof HarStatusClass.Type;

export const HarRequestRowSummary = Schema.Struct({
  entryIndex: NonNegativeInt,
  ref: NodeRef,
  method: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  host: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Number),
  statusClass: HarStatusClass,
  mimeType: Schema.NullOr(Schema.String),
  bodySize: Schema.NullOr(Schema.Number),
  timeMs: Schema.NullOr(Schema.Number),
  startedDateTime: Schema.NullOr(Schema.String),
  startOffsetMs: Schema.Number,
  timings: HarTimings,
});
export type HarRequestRowSummary = typeof HarRequestRowSummary.Type;

export const HarTimelineBucket = Schema.Struct({
  startMs: Schema.Number,
  endMs: Schema.Number,
  total: NonNegativeInt,
  c1xx: NonNegativeInt,
  c2xx: NonNegativeInt,
  c3xx: NonNegativeInt,
  c4xx: NonNegativeInt,
  c5xx: NonNegativeInt,
  cOther: NonNegativeInt,
});
export type HarTimelineBucket = typeof HarTimelineBucket.Type;

export const HarTimelineSummary = Schema.Struct({
  minStartMs: Schema.Number,
  maxEndMs: Schema.Number,
  totalSpanMs: Schema.Number,
  buckets: Schema.Array(HarTimelineBucket),
});
export type HarTimelineSummary = typeof HarTimelineSummary.Type;

export const TableCellValue = Schema.Struct({
  ref: Schema.NullOr(NodeRef),
  kind: Schema.NullOr(NodeKind),
  text: Schema.String,
  truncated: Schema.Boolean,
  editable: Schema.Boolean,
  numericValue: Schema.NullOr(Schema.Number),
});
export type TableCellValue = typeof TableCellValue.Type;

export const TableRow = Schema.Struct({
  rowIndex: NonNegativeInt,
  displayIndex: NonNegativeInt,
  ref: NodeRef,
  span: ByteRange,
  cells: Schema.Record(Schema.String, TableCellValue),
  har: Schema.NullOr(HarRequestRowSummary),
});
export type TableRow = typeof TableRow.Type;

export const TableQuerySpec = Schema.Struct({
  documentId: DocumentId,
  targetPath: Schema.NullOr(Schema.String),
  revision: Schema.optionalKey(NonNegativeInt),
  sort: Schema.NullOr(TableSortSpec),
  filters: Schema.Array(TableFilterSpec),
  timeWindow: Schema.NullOr(HarTimeWindow),
  filteredRowIndices: Schema.NullOr(
    Schema.Array(NonNegativeInt).check(Schema.isMaxLength(TABLE_MAX_ROWS)),
  ),
});
export type TableQuerySpec = typeof TableQuerySpec.Type;

export const TableQueryResult = Schema.Struct({
  target: TableTarget,
  columns: Schema.Array(TableColumn),
  totalRows: NonNegativeInt,
  matchedRows: NonNegativeInt,
  queryId: PositiveInt,
  harTimeline: Schema.NullOr(HarTimelineSummary),
});
export type TableQueryResult = typeof TableQueryResult.Type;

export const TableRowsPageRequest = Schema.Struct({
  documentId: DocumentId,
  queryId: PositiveInt,
  from: NonNegativeInt,
  count: ChildrenCount,
});
export type TableRowsPageRequest = typeof TableRowsPageRequest.Type;

export const TableRowsPage = Schema.Struct({
  queryId: PositiveInt,
  from: NonNegativeInt,
  total: NonNegativeInt,
  columns: Schema.Array(TableColumn),
  rows: Schema.Array(TableRow).check(Schema.isMaxLength(CHILDREN_PAGE_LIMIT)),
});
export type TableRowsPage = typeof TableRowsPage.Type;

export const TableQueryCloseRequest = Schema.Struct({
  documentId: DocumentId,
  queryId: PositiveInt,
});
export type TableQueryCloseRequest = typeof TableQueryCloseRequest.Type;
