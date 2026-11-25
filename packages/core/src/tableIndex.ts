import {
  type ByteRange,
  CHILDREN_PAGE_LIMIT,
  type ChildrenPage,
  type DocumentFormat,
  MAX_SLICE_BYTES,
  type NodeKind,
  type NodeRef,
  type NodeSummary,
  type RowsPage,
  type RowSummary,
  type TextValue,
} from "@quipu/contracts/engine";
import {
  type HarRequestRowSummary,
  type HarStatusClass,
  type HarTimelineBucket,
  type HarTimelineSummary,
  type HarTimeWindow,
  type HarTimings,
  TABLE_CELL_PREVIEW_BYTES,
  TABLE_COLUMN_SAMPLE_ROWS,
  TABLE_MAX_ROWS,
  TABLE_TIMELINE_BUCKETS,
  type TableCellValue,
  type TableColumn,
  type TableColumnKind,
  type TableFilterSpec,
  type TableQueryResult,
  type TableRow,
  type TableRowsPage,
  type TableSortSpec,
  type TableTarget,
  type TableTargetsResult,
} from "@quipu/contracts/table";

import { decodeUtf8, parseJsonSlice, parseJsonStringSlice } from "./boundedSlice.ts";
import { SourceJsonCursor } from "./harWindow.ts";
import type { ByteSource } from "./source.ts";

/** Read-only logical document access needed to index, sort, filter, and page tables. */
/** Resolved scalar cell refs for one HAR entry row (`log.entries[i]`). */
export interface HarEntryCellRefs {
  readonly methodRef: NodeRef | null;
  readonly urlRef: NodeRef | null;
  readonly statusRef: NodeRef | null;
  readonly mimeTypeRef: NodeRef | null;
  readonly bodySizeRef: NodeRef | null;
  readonly timeMsRef: NodeRef | null;
}

/** One HAR entry node summary and its editable cell refs resolved in a batch. */
export interface ResolvedHarRowBatchItem {
  readonly node: NodeSummary;
  readonly refs: HarEntryCellRefs;
}

export interface TableDocAccess {
  readonly format: (documentId: number) => Promise<DocumentFormat> | DocumentFormat;
  readonly root: (documentId: number) => Promise<NodeSummary>;
  readonly node?: (ref: NodeRef) => Promise<NodeSummary>;
  readonly children: (ref: NodeRef, from: number, count: number) => Promise<ChildrenPage>;
  readonly rows: (
    ref: NodeRef,
    from: number,
    count: number,
    previewBytes: number,
  ) => Promise<RowsPage>;
  readonly keyText: (ref: NodeRef) => Promise<string>;
  readonly text: (ref: NodeRef, limit: number) => Promise<TextValue>;
  /** Optional logical byte-range reader for fast batched row extraction. */
  readonly logicalSlice?: (
    documentId: number,
    tapeId: number,
    range: ByteRange,
  ) => Promise<Uint8Array>;
  /**
   * Optional worker-parallel columnar HAR row metadata extractor (`<= 64 MiB` slices per entry).
   * Returns `null` when unavailable or unsupported so callers fall back to `readAllElements`.
   */
  readonly readHarEntriesFast?: (
    documentId: number,
    targetRef: NodeRef,
    totalRows: number,
  ) => Promise<HarTableColumnarData | null>;
  /**
   * Optional batch resolver returning both entry node summaries and HAR cell refs
   * for a visible page of row indices without issuing per-row `access.rows` storms.
   */
  readonly resolveHarRowsBatch?: (
    targetRef: NodeRef,
    rowIndices: ReadonlyArray<number>,
  ) => Promise<ReadonlyArray<ResolvedHarRowBatchItem | null> | null>;
}

const SLICE_BATCH_BYTES = 4 * 1024 * 1024;
const SMALL_ROW_SLICE_CAP = 256 * 1024;
const ROW_FETCH_CONCURRENCY = 32;
const ELEMENT_PAGE_CONCURRENCY = 8;
const DISCOVER_OBJECT_MEMBERS_LIMIT = 128;
const DISCOVER_MAX_TARGETS = 32;
const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC_STRING = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const HAR_PRESET_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "#", label: "#", index: 0, kind: "number", late: false },
  { key: "method", label: "Method", index: 1, kind: "string", late: false },
  { key: "status", label: "Status", index: 2, kind: "number", late: false },
  { key: "url", label: "URL", index: 3, kind: "string", late: false },
  { key: "mimeType", label: "Type", index: 4, kind: "string", late: false },
  { key: "bodySize", label: "Size", index: 5, kind: "number", late: false },
  { key: "timeMs", label: "Time", index: 6, kind: "number", late: false },
];

const pathStep = (parentPath: string, key: string): string =>
  IDENTIFIER_KEY.test(key) ? `${parentPath}.${key}` : `${parentPath}[${JSON.stringify(key)}]`;

const isScalarKind = (kind: NodeKind): boolean => kind !== "object" && kind !== "array";

const columnKindOfNode = (kind: NodeKind): TableColumnKind => {
  switch (kind) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "true":
    case "false":
      return "boolean";
    case "null":
      return "null";
    case "object":
    case "array":
      return "container";
  }
};

const mergeColumnKind = (prev: TableColumnKind, next: TableColumnKind): TableColumnKind => {
  if (prev === next) return prev;
  if (prev === "null") return next;
  if (next === "null") return prev;
  if (prev === "mixed" || next === "mixed") return "mixed";
  return "mixed";
};

const hostOf = (url: string | null): string | null => {
  if (url === null) return null;
  const schemeEnd = url.indexOf("://");
  if (schemeEnd <= 0) return null;
  const c0 = url.charCodeAt(0);
  if (!((c0 >= 0x41 && c0 <= 0x5a) || (c0 >= 0x61 && c0 <= 0x7a))) return null;
  for (let i = 1; i < schemeEnd; i++) {
    const c = url.charCodeAt(i);
    const valid =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2d ||
      c === 0x2e;
    if (!valid) return null;
  }
  const authStart = schemeEnd + 3;
  let authEnd = url.length;
  let lastAt = -1;
  for (let i = authStart; i < authEnd; i++) {
    const c = url.charCodeAt(i);
    if (c === 0x2f || c === 0x3f || c === 0x23) {
      authEnd = i;
      break;
    }
    if (c === 0x40) lastAt = i;
  }
  const hostStart = lastAt >= 0 ? lastAt + 1 : authStart;
  return authEnd > hostStart ? url.slice(hostStart, authEnd) : null;
};

const statusClassOf = (status: number | null): HarStatusClass => {
  if (status === null || !Number.isFinite(status)) return "other";
  if (status >= 100 && status < 200) return "1xx";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
};

const nonNegMs = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const finiteNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Normalizes HAR body size, treating Hark's `-1` missing-body marker as `null`. */
export const normalizeHarBodySize = (
  contentSize: unknown,
  responseBodySize: unknown,
): number | null => {
  if (typeof contentSize === "number" && Number.isFinite(contentSize) && contentSize >= 0) {
    return contentSize;
  }
  if (
    typeof responseBodySize === "number" &&
    Number.isFinite(responseBodySize) &&
    responseBodySize >= 0
  ) {
    return responseBodySize;
  }
  return null;
};

/** Minimal HAR row fields extracted per entry (skipping headers/cookies/bodies). */
export interface HarTableRawRow {
  readonly method: string | null;
  readonly url: string | null;
  readonly pageref: string | null;
  readonly status: number | null;
  readonly mimeType: string | null;
  readonly contentSize: number | null;
  readonly bodySize: number | null;
  readonly startedDateTime: string | null;
  readonly time: number | null;
  readonly timings: {
    readonly blocked: number | null;
    readonly dns: number | null;
    readonly connect: number | null;
    readonly ssl: number | null;
    readonly send: number | null;
    readonly wait: number | null;
    readonly receive: number | null;
  } | null;
}

export const HAR_COL_STRIDE = 13;
const HAR_COL_FLAG_VALID = 1;
const HAR_COL_FLAG_HAS_TIMINGS = 2;

export interface HarTableColumnarData {
  readonly count: number;
  readonly nums: Float64Array;
  readonly methods: Array<string | null>;
  readonly urls: Array<string | null>;
  readonly mimeTypes: Array<string | null>;
  readonly startedDateTimes: Array<string | null>;
}

/** Fast ISO-8601 timestamp parser with `Date.parse` fallback for non-standard formats. */
export function parseIsoDateMsFast(iso: string): number {
  const n = iso.length;
  if (n < 20) return Date.parse(iso);
  if (
    iso.charCodeAt(4) !== 0x2d ||
    iso.charCodeAt(7) !== 0x2d ||
    (iso.charCodeAt(10) !== 0x54 && iso.charCodeAt(10) !== 0x74) ||
    iso.charCodeAt(13) !== 0x3a ||
    iso.charCodeAt(16) !== 0x3a
  ) {
    return Date.parse(iso);
  }
  const d4 = (o: number): number => {
    const a = iso.charCodeAt(o) - 0x30;
    const b = iso.charCodeAt(o + 1) - 0x30;
    const c = iso.charCodeAt(o + 2) - 0x30;
    const d = iso.charCodeAt(o + 3) - 0x30;
    return (a | b | c | d) < 0 || a > 9 || b > 9 || c > 9 || d > 9
      ? -1
      : a * 1000 + b * 100 + c * 10 + d;
  };
  const d2 = (o: number): number => {
    const a = iso.charCodeAt(o) - 0x30;
    const b = iso.charCodeAt(o + 1) - 0x30;
    return (a | b) < 0 || a > 9 || b > 9 ? -1 : a * 10 + b;
  };
  const year = d4(0);
  const month = d2(5);
  const day = d2(8);
  const hour = d2(11);
  const min = d2(14);
  const sec = d2(17);
  if (
    year < 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    min < 0 ||
    min > 59 ||
    sec < 0 ||
    sec > 59
  ) {
    return Number.NaN;
  }
  let pos = 19;
  let ms = 0;
  if (pos < n && iso.charCodeAt(pos) === 0x2e) {
    pos++;
    const f0 = pos < n ? iso.charCodeAt(pos) - 0x30 : -1;
    if (f0 < 0 || f0 > 9) return Date.parse(iso);
    let weight = 100;
    while (pos < n) {
      const ch = iso.charCodeAt(pos);
      if (ch < 0x30 || ch > 0x39) break;
      if (weight >= 1) {
        ms += (ch - 0x30) * weight;
        weight /= 10;
      }
      pos++;
    }
  }
  let tzOffsetMs = 0;
  if (pos < n) {
    const tz = iso.charCodeAt(pos);
    if (tz === 0x5a || tz === 0x7a) {
      if (pos + 1 !== n) return Date.parse(iso);
    } else if (tz === 0x2b || tz === 0x2d) {
      const sign = tz === 0x2b ? 1 : -1;
      pos++;
      let oh = -1;
      let om = -1;
      if (n - pos === 5 && iso.charCodeAt(pos + 2) === 0x3a) {
        oh = d2(pos);
        om = d2(pos + 3);
      } else if (n - pos === 4) {
        oh = d2(pos);
        om = d2(pos + 2);
      } else {
        return Date.parse(iso);
      }
      if (oh < 0 || oh > 23 || om < 0 || om > 59) return Date.parse(iso);
      tzOffsetMs = sign * (oh * 60 + om) * 60_000;
    } else {
      return Date.parse(iso);
    }
  } else {
    return Date.parse(iso);
  }
  const epoch = Date.UTC(year, month - 1, day, hour, min, sec, ms) - tzOffsetMs;
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

/** Converts normalized raw HAR row fields into `HarRequestRowSummary` metadata. */
export function harRawToSummary(
  entryIndex: number,
  ref: NodeRef,
  raw: HarTableRawRow,
): {
  readonly summary: Omit<HarRequestRowSummary, "startOffsetMs">;
  readonly startEpochMs: number;
} {
  const rawTimings = raw.timings;
  const timings: HarTimings = {
    blocked: nonNegMs(rawTimings?.blocked),
    dns: nonNegMs(rawTimings?.dns),
    connect: nonNegMs(rawTimings?.connect),
    ssl: nonNegMs(rawTimings?.ssl),
    send: nonNegMs(rawTimings?.send),
    wait: nonNegMs(rawTimings?.wait),
    receive: nonNegMs(rawTimings?.receive),
  };

  let timeMs = raw.time;
  if (timeMs !== null && timeMs < 0) timeMs = null;
  if (timeMs === null && rawTimings !== null) {
    // HAR 1.2 connect includes ssl; avoid double-counting ssl when summing phases.
    const connectTotal = Math.max(timings.connect, timings.ssl);
    const summed =
      timings.blocked + timings.dns + connectTotal + timings.send + timings.wait + timings.receive;
    if (summed > 0 || rawTimings.wait !== null || rawTimings.receive !== null) {
      timeMs = summed;
    }
  }

  const parsedStart =
    raw.startedDateTime !== null ? parseIsoDateMsFast(raw.startedDateTime) : Number.NaN;

  return {
    summary: {
      entryIndex,
      ref,
      method: raw.method,
      url: raw.url,
      host: hostOf(raw.url),
      status: raw.status,
      statusClass: statusClassOf(raw.status),
      mimeType: raw.mimeType,
      bodySize: normalizeHarBodySize(raw.contentSize, raw.bodySize),
      timeMs,
      startedDateTime: raw.startedDateTime,
      timings,
    },
    startEpochMs: Number.isFinite(parsedStart) ? parsedStart : Number.NaN,
  };
}

function nonNegFinite(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function columnarTimeMs(nums: Float64Array, base: number): number | null {
  const rawTime = nums[base + 3] as number;
  if (Number.isFinite(rawTime) && rawTime >= 0) return rawTime;
  const flags = nums[base + 12] as number;
  if ((flags & HAR_COL_FLAG_HAS_TIMINGS) === 0) return null;
  const connectTotal = Math.max(
    nonNegFinite(nums[base + 6] as number),
    nonNegFinite(nums[base + 7] as number),
  );
  const rawWait = nums[base + 9] as number;
  const rawReceive = nums[base + 10] as number;
  const summed =
    nonNegFinite(nums[base + 4] as number) +
    nonNegFinite(nums[base + 5] as number) +
    connectTotal +
    nonNegFinite(nums[base + 8] as number) +
    nonNegFinite(rawWait) +
    nonNegFinite(rawReceive);
  if (summed > 0 || Number.isFinite(rawWait) || Number.isFinite(rawReceive)) {
    return summed;
  }
  return null;
}

function columnarBodySize(nums: Float64Array, base: number): number | null {
  const rawContentSize = nums[base + 1] as number;
  if (Number.isFinite(rawContentSize) && rawContentSize >= 0) return rawContentSize;
  const rawBodySize = nums[base + 2] as number;
  return Number.isFinite(rawBodySize) && rawBodySize >= 0 ? rawBodySize : null;
}

function columnarSlotToSummary(
  entryIndex: number,
  ref: NodeRef,
  nums: Float64Array,
  base: number,
  method: string | null,
  url: string | null,
  mimeType: string | null,
  startedDateTime: string | null,
): Omit<HarRequestRowSummary, "startOffsetMs"> {
  const timings: HarTimings = {
    blocked: nonNegFinite(nums[base + 4] as number),
    dns: nonNegFinite(nums[base + 5] as number),
    connect: nonNegFinite(nums[base + 6] as number),
    ssl: nonNegFinite(nums[base + 7] as number),
    send: nonNegFinite(nums[base + 8] as number),
    wait: nonNegFinite(nums[base + 9] as number),
    receive: nonNegFinite(nums[base + 10] as number),
  };
  const rawStatus = nums[base] as number;
  const status = Number.isFinite(rawStatus) ? rawStatus : null;

  return {
    entryIndex,
    ref,
    method,
    url,
    host: hostOf(url),
    status,
    statusClass: statusClassOf(status),
    mimeType,
    bodySize: columnarBodySize(nums, base),
    timeMs: columnarTimeMs(nums, base),
    startedDateTime,
    timings,
  };
}

export function extractHarSummaryFromObject(
  entryIndex: number,
  ref: NodeRef,
  raw: Record<string, unknown>,
): {
  readonly summary: Omit<HarRequestRowSummary, "startOffsetMs">;
  readonly startEpochMs: number;
} {
  const req =
    typeof raw.request === "object" && raw.request !== null && !Array.isArray(raw.request)
      ? (raw.request as Record<string, unknown>)
      : null;
  const resp =
    typeof raw.response === "object" && raw.response !== null && !Array.isArray(raw.response)
      ? (raw.response as Record<string, unknown>)
      : null;
  const content =
    resp !== null &&
    typeof resp.content === "object" &&
    resp.content !== null &&
    !Array.isArray(resp.content)
      ? (resp.content as Record<string, unknown>)
      : null;
  const rawTimings =
    typeof raw.timings === "object" && raw.timings !== null && !Array.isArray(raw.timings)
      ? (raw.timings as Record<string, unknown>)
      : null;

  return harRawToSummary(entryIndex, ref, {
    method: req ? stringOrNull(req.method) : null,
    url: req ? stringOrNull(req.url) : null,
    pageref: stringOrNull(raw.pageref),
    status: resp ? finiteNumberOrNull(resp.status) : null,
    mimeType: content ? stringOrNull(content.mimeType) : null,
    contentSize: content ? finiteNumberOrNull(content.size) : null,
    bodySize: resp ? finiteNumberOrNull(resp.bodySize) : null,
    startedDateTime: stringOrNull(raw.startedDateTime),
    time: finiteNumberOrNull(raw.time),
    timings: rawTimings
      ? {
          blocked: finiteNumberOrNull(rawTimings.blocked),
          dns: finiteNumberOrNull(rawTimings.dns),
          connect: finiteNumberOrNull(rawTimings.connect),
          ssl: finiteNumberOrNull(rawTimings.ssl),
          send: finiteNumberOrNull(rawTimings.send),
          wait: finiteNumberOrNull(rawTimings.wait),
          receive: finiteNumberOrNull(rawTimings.receive),
        }
      : null,
  });
}

const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

const skipWsBytes = (bytes: Uint8Array, pos: number, end: number): number => {
  while (pos < end && isWs(bytes[pos] as number)) pos++;
  return pos;
};

const SKIP_INTERESTING = new Uint8Array(256);
SKIP_INTERESTING[0x22] = 1; // "
SKIP_INTERESTING[0x5b] = 1; // [
SKIP_INTERESTING[0x5d] = 1; // ]
SKIP_INTERESTING[0x7b] = 1; // {
SKIP_INTERESTING[0x7d] = 1; // }

const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];

/**
 * Returns `((endOffset) << 1) | (hasEscape ? 1 : 0)` or `-1` on EOF/error.
 * Avoids allocating `{ end, hasEscape }` objects on millions of keys and strings.
 */
const scanJsonStringEndPacked = (bytes: Uint8Array, quoteStart: number, end: number): number => {
  let p = quoteStart + 1;
  let hasEscape = 0;
  const fastLim = Math.min(end, p + 32);
  while (p < fastLim) {
    const b = bytes[p] as number;
    if (b === 0x22) return (p + 1) * 2 + hasEscape;
    if (b === 0x5c) {
      hasEscape = 1;
      p += 2;
      continue;
    }
    p++;
  }
  while (p < end) {
    const q = bytes.indexOf(0x22, p);
    if (q < 0 || q >= end) return -1;
    let bs = 0;
    for (let k = q - 1; k >= p && bytes[k] === 0x5c; k--) bs++;
    if (bs > 0) hasEscape = 1;
    if ((bs & 1) === 0) {
      if (hasEscape === 0 && bytes.subarray(quoteStart + 1, q).includes(0x5c)) {
        hasEscape = 1;
      }
      return (q + 1) * 2 + hasEscape;
    }
    hasEscape = 1;
    p = q + 1;
  }
  return -1;
};

const skipJsonStringFast = (bytes: Uint8Array, quoteStart: number, end: number): number => {
  let p = quoteStart + 1;
  const fastLim = Math.min(end, p + 12);
  while (p < fastLim) {
    const b = bytes[p] as number;
    if (b === 0x22) return p + 1;
    if (b === 0x5c) {
      p += 2;
      continue;
    }
    p++;
  }
  while (p < end) {
    const q = bytes.indexOf(0x22, p);
    if (q < 0 || q >= end) return -1;
    let bs = 0;
    for (let k = q - 1; k >= p && bytes[k] === 0x5c; k--) bs++;
    if ((bs & 1) === 0) return q + 1;
    p = q + 1;
  }
  return -1;
};

const skipJsonValueFast = (bytes: Uint8Array, pos: number, end: number): number => {
  if (pos >= end) return -1;
  const first = bytes[pos] as number;
  if (first === 0x22) return skipJsonStringFast(bytes, pos, end);
  if (first !== 0x7b && first !== 0x5b) {
    while (pos < end) {
      const b = bytes[pos] as number;
      if (b === 0x2c || b === 0x7d || b === 0x5d || isWs(b)) return pos;
      pos++;
    }
    return pos;
  }
  let depth = 1;
  pos++;
  while (pos < end && depth > 0) {
    const b = bytes[pos] as number;
    if (SKIP_INTERESTING[b] === 0) {
      pos++;
      continue;
    }
    if (b === 0x22) {
      pos = skipJsonStringFast(bytes, pos, end);
      if (pos < 0) return -1;
    } else if (b === 0x7b || b === 0x5b) {
      depth++;
      pos++;
    } else {
      depth--;
      pos++;
    }
  }
  return depth === 0 ? pos : -1;
};

const asciiKeyMatches = (
  bytes: Uint8Array,
  quoteStart: number,
  quoteEnd: number,
  hasEscape: boolean,
  target: string,
): boolean => {
  const rawStart = quoteStart + 1;
  const rawEnd = quoteEnd - 1;
  if (!hasEscape) {
    if (rawEnd - rawStart !== target.length) return false;
    for (let i = 0; i < target.length; i++) {
      if (bytes[rawStart + i] !== target.charCodeAt(i)) return false;
    }
    return true;
  }
  try {
    return parseJsonStringSlice(bytes.subarray(quoteStart, quoteEnd), 256) === target;
  } catch {
    return false;
  }
};

let parsedStrVal: string | null = null;
let parsedNumVal: number | null = null;

/**
 * Decodes unescaped ASCII strings `<= 64` bytes with `String.fromCharCode` to skip
 * `TextDecoder` FFI overhead on short HAR fields (`method`, `mimeType`, `startedDateTime`).
 */
const decodePlainStringBytes = (bytes: Uint8Array, start: number, end: number): string => {
  const len = end - start;
  if (len === 0) return "";
  if (len <= 16) {
    let allAscii = true;
    for (let i = start; i < end; i++) {
      if ((bytes[i] as number) >= 0x80) {
        allAscii = false;
        break;
      }
    }
    if (allAscii) {
      let s = "";
      for (let i = start; i < end; i++) {
        s += String.fromCharCode(bytes[i] as number);
      }
      return s;
    }
  }
  return decodeUtf8(bytes.subarray(start, end), MAX_SLICE_BYTES);
};

/** Parses string value into `parsedStrVal` and returns `nextPos` or `-1` on EOF/error. */
const decodeJsonStringInto = (bytes: Uint8Array, pos: number, end: number): number => {
  if (pos >= end) return -1;
  if (bytes[pos] !== 0x22) {
    const after = skipJsonValueFast(bytes, pos, end);
    parsedStrVal = null;
    return after;
  }
  const packed = scanJsonStringEndPacked(bytes, pos, end);
  if (packed < 0) return -1;
  const strEnd = packed >>> 1;
  const hasEscape = (packed & 1) !== 0;
  try {
    parsedStrVal = hasEscape
      ? parseJsonStringSlice(bytes.subarray(pos, strEnd), MAX_SLICE_BYTES)
      : decodePlainStringBytes(bytes, pos + 1, strEnd - 1);
    return strEnd;
  } catch {
    return -1;
  }
};

const parseAsciiNumberFast = (bytes: Uint8Array, pos: number, after: number): number | null => {
  const len = after - pos;
  if (len <= 0 || len > 128) return null;
  let i = pos;
  let neg = false;
  if (bytes[i] === 0x2d) {
    neg = true;
    i++;
    if (i >= after) return null;
  }
  const firstDigit = (bytes[i] as number) - 0x30;
  if (firstDigit < 0 || firstDigit > 9) return null;
  let intVal = firstDigit;
  i++;
  let digits = 1;
  while (i < after && digits < 15) {
    const b = bytes[i] as number;
    if (b >= 0x30 && b <= 0x39) {
      intVal = intVal * 10 + (b - 0x30);
      digits++;
      i++;
    } else {
      break;
    }
  }
  if (i === after) {
    return neg ? (intVal === 0 ? -0 : -intVal) : intVal;
  }
  if (bytes[i] === 0x2e && digits < 15) {
    i++;
    if (i < after) {
      let frac = 0;
      let fracLen = 0;
      while (i < after && fracLen < 9 && digits + fracLen < 15) {
        const b = bytes[i] as number;
        if (b < 0x30 || b > 0x39) break;
        frac = frac * 10 + (b - 0x30);
        fracLen++;
        i++;
      }
      if (i === after && fracLen > 0) {
        const scale = POW10[fracLen] as number;
        const val = (intVal * scale + frac) / scale;
        return neg ? (val === 0 ? -0 : -val) : val;
      }
    }
  }
  const n = Number(decodePlainStringBytes(bytes, pos, after));
  return Number.isFinite(n) ? n : null;
};

/** Parses numeric value into `parsedNumVal` and returns `nextPos` or `-1` on EOF/error. */
const readJsonNumberInto = (bytes: Uint8Array, pos: number, end: number): number => {
  if (pos >= end) return -1;
  const after = skipJsonValueFast(bytes, pos, end);
  if (after < 0) return -1;
  const first = bytes[pos] as number;
  if (first !== 0x2d && (first < 0x30 || first > 0x39)) {
    parsedNumVal = null;
    return after;
  }
  parsedNumVal = parseAsciiNumberFast(bytes, pos, after);
  return after;
};

const scanObjectFields = (
  bytes: Uint8Array,
  pos: number,
  end: number,
  onField: (
    quoteStart: number,
    quoteEnd: number,
    hasEscape: boolean,
    valPos: number,
  ) => number | null,
): number => {
  if (pos >= end || bytes[pos] !== 0x7b) return -1;
  pos = skipWsBytes(bytes, pos + 1, end);
  if (pos < end && bytes[pos] === 0x7d) return pos + 1;
  while (pos < end) {
    if (bytes[pos] !== 0x22) return -1;
    const keyPacked = scanJsonStringEndPacked(bytes, pos, end);
    if (keyPacked < 0) return -1;
    const keyEnd = keyPacked >>> 1;
    let cur = skipWsBytes(bytes, keyEnd, end);
    if (cur >= end || bytes[cur] !== 0x3a) return -1;
    cur = skipWsBytes(bytes, cur + 1, end);
    if (cur >= end) return -1;
    const afterVal = onField(pos, keyEnd, (keyPacked & 1) !== 0, cur);
    if (afterVal === null || afterVal < 0) return -1;
    cur = skipWsBytes(bytes, afterVal, end);
    if (cur >= end) return -1;
    const sep = bytes[cur] as number;
    if (sep === 0x7d) return cur + 1;
    if (sep !== 0x2c) return -1;
    pos = skipWsBytes(bytes, cur + 1, end);
  }
  return -1;
};

/**
 * Zero-DOM byte scanner for a single HAR entry slice (`<= MAX_SLICE_BYTES`).
 * Reads only table/waterfall metadata fields and skips huge `headers`, `cookies`,
 * `queryString`, `postData`, and `response.content.text` payloads using SIMD `indexOf`.
 * Returns `null` when malformed or non-object so callers can fall back to the index.
 */
export function extractHarTableRaw(bytes: Uint8Array): HarTableRawRow | null {
  const n = bytes.byteLength;
  const start = skipWsBytes(bytes, 0, n);
  if (start >= n || bytes[start] !== 0x7b) return null;

  let method: string | null = null;
  let url: string | null = null;
  let pageref: string | null = null;
  let status: number | null = null;
  let mimeType: string | null = null;
  let contentSize: number | null = null;
  let bodySize: number | null = null;
  let startedDateTime: string | null = null;
  let time: number | null = null;
  let timings: HarTableRawRow["timings"] = null;

  const end = scanObjectFields(bytes, start, n, (qs, qe, he, vp) => {
    const kLen = qe - qs - 2;
    if (!he) {
      if (kLen === 4 && asciiKeyMatches(bytes, qs, qe, false, "time")) {
        const nextPos = readJsonNumberInto(bytes, vp, n);
        if (nextPos < 0) return null;
        time = parsedNumVal;
        return nextPos;
      }
      if (kLen === 7 && asciiKeyMatches(bytes, qs, qe, false, "request")) {
        if (bytes[vp] === 0x7b) {
          const next = scanObjectFields(bytes, vp, n, (rqs, rqe, rhe, rvp) => {
            const rkLen = rqe - rqs - 2;
            if (!rhe && rkLen === 6 && asciiKeyMatches(bytes, rqs, rqe, false, "method")) {
              const nextPos = decodeJsonStringInto(bytes, rvp, n);
              if (nextPos < 0) return null;
              method = parsedStrVal;
              return nextPos;
            }
            if (!rhe && rkLen === 3 && asciiKeyMatches(bytes, rqs, rqe, false, "url")) {
              const nextPos = decodeJsonStringInto(bytes, rvp, n);
              if (nextPos < 0) return null;
              url = parsedStrVal;
              return nextPos;
            }
            if (rhe) {
              if (asciiKeyMatches(bytes, rqs, rqe, true, "method")) {
                const nextPos = decodeJsonStringInto(bytes, rvp, n);
                if (nextPos < 0) return null;
                method = parsedStrVal;
                return nextPos;
              }
              if (asciiKeyMatches(bytes, rqs, rqe, true, "url")) {
                const nextPos = decodeJsonStringInto(bytes, rvp, n);
                if (nextPos < 0) return null;
                url = parsedStrVal;
                return nextPos;
              }
            }
            return skipJsonValueFast(bytes, rvp, n);
          });
          return next < 0 ? null : next;
        }
        return skipJsonValueFast(bytes, vp, n);
      }
      if (kLen === 8 && asciiKeyMatches(bytes, qs, qe, false, "response")) {
        if (bytes[vp] === 0x7b) {
          const next = scanObjectFields(bytes, vp, n, (pqs, pqe, phe, pvp) => {
            const pkLen = pqe - pqs - 2;
            if (
              (!phe && pkLen === 6 && asciiKeyMatches(bytes, pqs, pqe, false, "status")) ||
              (phe && asciiKeyMatches(bytes, pqs, pqe, true, "status"))
            ) {
              const nextPos = readJsonNumberInto(bytes, pvp, n);
              if (nextPos < 0) return null;
              status = parsedNumVal;
              return nextPos;
            }
            if (
              (!phe && pkLen === 8 && asciiKeyMatches(bytes, pqs, pqe, false, "bodySize")) ||
              (phe && asciiKeyMatches(bytes, pqs, pqe, true, "bodySize"))
            ) {
              const nextPos = readJsonNumberInto(bytes, pvp, n);
              if (nextPos < 0) return null;
              bodySize = parsedNumVal;
              return nextPos;
            }
            if (
              (!phe && pkLen === 7 && asciiKeyMatches(bytes, pqs, pqe, false, "content")) ||
              (phe && asciiKeyMatches(bytes, pqs, pqe, true, "content"))
            ) {
              if (bytes[pvp] === 0x7b) {
                const cNext = scanObjectFields(bytes, pvp, n, (cqs, cqe, che, cvp) => {
                  const ckLen = cqe - cqs - 2;
                  if (
                    (!che && ckLen === 8 && asciiKeyMatches(bytes, cqs, cqe, false, "mimeType")) ||
                    (che && asciiKeyMatches(bytes, cqs, cqe, true, "mimeType"))
                  ) {
                    const nextPos = decodeJsonStringInto(bytes, cvp, n);
                    if (nextPos < 0) return null;
                    mimeType = parsedStrVal;
                    return nextPos;
                  }
                  if (
                    (!che && ckLen === 4 && asciiKeyMatches(bytes, cqs, cqe, false, "size")) ||
                    (che && asciiKeyMatches(bytes, cqs, cqe, true, "size"))
                  ) {
                    const nextPos = readJsonNumberInto(bytes, cvp, n);
                    if (nextPos < 0) return null;
                    contentSize = parsedNumVal;
                    return nextPos;
                  }
                  return skipJsonValueFast(bytes, cvp, n);
                });
                return cNext < 0 ? null : cNext;
              }
              return skipJsonValueFast(bytes, pvp, n);
            }
            return skipJsonValueFast(bytes, pvp, n);
          });
          return next < 0 ? null : next;
        }
        return skipJsonValueFast(bytes, vp, n);
      }
      if (kLen === 7 && asciiKeyMatches(bytes, qs, qe, false, "timings")) {
        if (bytes[vp] === 0x7b) {
          let blocked: number | null = null;
          let dns: number | null = null;
          let connect: number | null = null;
          let ssl: number | null = null;
          let send: number | null = null;
          let wait: number | null = null;
          let receive: number | null = null;
          const next = scanObjectFields(bytes, vp, n, (tqs, tqe, the, tvp) => {
            if (asciiKeyMatches(bytes, tqs, tqe, the, "blocked")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              blocked = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, the, "dns")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              dns = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, the, "connect")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              connect = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, the, "ssl")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              ssl = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, the, "send")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              send = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, the, "wait")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              wait = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, the, "receive")) {
              const nextPos = readJsonNumberInto(bytes, tvp, n);
              if (nextPos < 0) return null;
              receive = parsedNumVal;
              return nextPos;
            }
            return skipJsonValueFast(bytes, tvp, n);
          });
          if (next < 0) return null;
          timings = { blocked, dns, connect, ssl, send, wait, receive };
          return next;
        }
        return skipJsonValueFast(bytes, vp, n);
      }
      if (kLen === 15 && asciiKeyMatches(bytes, qs, qe, false, "startedDateTime")) {
        const nextPos = decodeJsonStringInto(bytes, vp, n);
        if (nextPos < 0) return null;
        startedDateTime = parsedStrVal;
        return nextPos;
      }
      if (kLen === 7 && asciiKeyMatches(bytes, qs, qe, false, "pageref")) {
        const nextPos = decodeJsonStringInto(bytes, vp, n);
        if (nextPos < 0) return null;
        pageref = parsedStrVal;
        return nextPos;
      }
    } else {
      if (asciiKeyMatches(bytes, qs, qe, true, "time")) {
        const nextPos = readJsonNumberInto(bytes, vp, n);
        if (nextPos < 0) return null;
        time = parsedNumVal;
        return nextPos;
      }
      if (asciiKeyMatches(bytes, qs, qe, true, "startedDateTime")) {
        const nextPos = decodeJsonStringInto(bytes, vp, n);
        if (nextPos < 0) return null;
        startedDateTime = parsedStrVal;
        return nextPos;
      }
      if (asciiKeyMatches(bytes, qs, qe, true, "pageref")) {
        const nextPos = decodeJsonStringInto(bytes, vp, n);
        if (nextPos < 0) return null;
        pageref = parsedStrVal;
        return nextPos;
      }
    }
    return skipJsonValueFast(bytes, vp, n);
  });

  if (end < 0) return null;
  if (skipWsBytes(bytes, end, n) !== n) return null;

  return {
    method,
    url,
    pageref,
    status,
    mimeType,
    contentSize,
    bodySize,
    startedDateTime,
    time,
    timings,
  };
}

/**
 * Extracts HAR row metadata inline starting at an object `{` at `start` inside `bytes[start..end)`.
 * Writes directly into columnar typed/string slots and returns the offset immediately after `}`.
 * Returns `-1` when encountering a chunk boundary straddler or syntax error.
 */
function extractHarObjectColumnarAt(
  bytes: Uint8Array,
  start: number,
  end: number,
  slot: number,
  nums: Float64Array,
  methods: Array<string | null>,
  urls: Array<string | null>,
  mimeTypes: Array<string | null>,
  startedDateTimes: Array<string | null>,
): number {
  if (start >= end || bytes[start] !== 0x7b) return -1;
  let method: string | null = null;
  let url: string | null = null;
  let status = Number.NaN;
  let mimeType: string | null = null;
  let contentSize = Number.NaN;
  let bodySize = Number.NaN;
  let startedDateTime: string | null = null;
  let time = Number.NaN;
  let hasTimings = false;
  let blocked = Number.NaN;
  let dns = Number.NaN;
  let connect = Number.NaN;
  let ssl = Number.NaN;
  let send = Number.NaN;
  let wait = Number.NaN;
  let receive = Number.NaN;

  const afterObj = scanObjectFields(bytes, start, end, (qs, qe, he, vp) => {
    const kLen = qe - qs - 2;
    if (!he) {
      if (kLen === 4 && asciiKeyMatches(bytes, qs, qe, false, "time")) {
        const nextPos = readJsonNumberInto(bytes, vp, end);
        if (nextPos < 0) return null;
        if (parsedNumVal !== null) time = parsedNumVal;
        return nextPos;
      }
      if (kLen === 7 && asciiKeyMatches(bytes, qs, qe, false, "request")) {
        if (bytes[vp] === 0x7b) {
          const next = scanObjectFields(bytes, vp, end, (rqs, rqe, rhe, rvp) => {
            const rkLen = rqe - rqs - 2;
            if (!rhe && rkLen === 6 && asciiKeyMatches(bytes, rqs, rqe, false, "method")) {
              const nextPos = decodeJsonStringInto(bytes, rvp, end);
              if (nextPos < 0) return null;
              method = parsedStrVal;
              return nextPos;
            }
            if (!rhe && rkLen === 3 && asciiKeyMatches(bytes, rqs, rqe, false, "url")) {
              const nextPos = decodeJsonStringInto(bytes, rvp, end);
              if (nextPos < 0) return null;
              url = parsedStrVal;
              return nextPos;
            }
            if (rhe) {
              if (asciiKeyMatches(bytes, rqs, rqe, true, "method")) {
                const nextPos = decodeJsonStringInto(bytes, rvp, end);
                if (nextPos < 0) return null;
                method = parsedStrVal;
                return nextPos;
              }
              if (asciiKeyMatches(bytes, rqs, rqe, true, "url")) {
                const nextPos = decodeJsonStringInto(bytes, rvp, end);
                if (nextPos < 0) return null;
                url = parsedStrVal;
                return nextPos;
              }
            }
            return skipJsonValueFast(bytes, rvp, end);
          });
          return next < 0 ? null : next;
        }
        return skipJsonValueFast(bytes, vp, end);
      }
      if (kLen === 8 && asciiKeyMatches(bytes, qs, qe, false, "response")) {
        if (bytes[vp] === 0x7b) {
          const next = scanObjectFields(bytes, vp, end, (pqs, pqe, phe, pvp) => {
            const pkLen = pqe - pqs - 2;
            if (
              (!phe && pkLen === 6 && asciiKeyMatches(bytes, pqs, pqe, false, "status")) ||
              (phe && asciiKeyMatches(bytes, pqs, pqe, true, "status"))
            ) {
              const nextPos = readJsonNumberInto(bytes, pvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) status = parsedNumVal;
              return nextPos;
            }
            if (
              (!phe && pkLen === 8 && asciiKeyMatches(bytes, pqs, pqe, false, "bodySize")) ||
              (phe && asciiKeyMatches(bytes, pqs, pqe, true, "bodySize"))
            ) {
              const nextPos = readJsonNumberInto(bytes, pvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) bodySize = parsedNumVal;
              return nextPos;
            }
            if (
              (!phe && pkLen === 7 && asciiKeyMatches(bytes, pqs, pqe, false, "content")) ||
              (phe && asciiKeyMatches(bytes, pqs, pqe, true, "content"))
            ) {
              if (bytes[pvp] === 0x7b) {
                const cNext = scanObjectFields(bytes, pvp, end, (cqs, cqe, che, cvp) => {
                  const ckLen = cqe - cqs - 2;
                  if (
                    (!che && ckLen === 8 && asciiKeyMatches(bytes, cqs, cqe, false, "mimeType")) ||
                    (che && asciiKeyMatches(bytes, cqs, cqe, true, "mimeType"))
                  ) {
                    const nextPos = decodeJsonStringInto(bytes, cvp, end);
                    if (nextPos < 0) return null;
                    mimeType = parsedStrVal;
                    return nextPos;
                  }
                  if (
                    (!che && ckLen === 4 && asciiKeyMatches(bytes, cqs, cqe, false, "size")) ||
                    (che && asciiKeyMatches(bytes, cqs, cqe, true, "size"))
                  ) {
                    const nextPos = readJsonNumberInto(bytes, cvp, end);
                    if (nextPos < 0) return null;
                    if (parsedNumVal !== null) contentSize = parsedNumVal;
                    return nextPos;
                  }
                  return skipJsonValueFast(bytes, cvp, end);
                });
                return cNext < 0 ? null : cNext;
              }
              return skipJsonValueFast(bytes, pvp, end);
            }
            return skipJsonValueFast(bytes, pvp, end);
          });
          return next < 0 ? null : next;
        }
        return skipJsonValueFast(bytes, vp, end);
      }
      if (kLen === 7 && asciiKeyMatches(bytes, qs, qe, false, "timings")) {
        if (bytes[vp] === 0x7b) {
          const next = scanObjectFields(bytes, vp, end, (tqs, tqe, the, tvp) => {
            const tkLen = tqe - tqs - 2;
            if (!the) {
              if (tkLen === 7) {
                if (asciiKeyMatches(bytes, tqs, tqe, false, "blocked")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) blocked = parsedNumVal;
                  return nextPos;
                }
                if (asciiKeyMatches(bytes, tqs, tqe, false, "connect")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) connect = parsedNumVal;
                  return nextPos;
                }
                if (asciiKeyMatches(bytes, tqs, tqe, false, "receive")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) receive = parsedNumVal;
                  return nextPos;
                }
              } else if (tkLen === 4) {
                if (asciiKeyMatches(bytes, tqs, tqe, false, "wait")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) wait = parsedNumVal;
                  return nextPos;
                }
                if (asciiKeyMatches(bytes, tqs, tqe, false, "send")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) send = parsedNumVal;
                  return nextPos;
                }
              } else if (tkLen === 3) {
                if (asciiKeyMatches(bytes, tqs, tqe, false, "dns")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) dns = parsedNumVal;
                  return nextPos;
                }
                if (asciiKeyMatches(bytes, tqs, tqe, false, "ssl")) {
                  const nextPos = readJsonNumberInto(bytes, tvp, end);
                  if (nextPos < 0) return null;
                  if (parsedNumVal !== null) ssl = parsedNumVal;
                  return nextPos;
                }
              }
              return skipJsonValueFast(bytes, tvp, end);
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "blocked")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) blocked = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "dns")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) dns = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "connect")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) connect = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "ssl")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) ssl = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "send")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) send = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "wait")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) wait = parsedNumVal;
              return nextPos;
            }
            if (asciiKeyMatches(bytes, tqs, tqe, true, "receive")) {
              const nextPos = readJsonNumberInto(bytes, tvp, end);
              if (nextPos < 0) return null;
              if (parsedNumVal !== null) receive = parsedNumVal;
              return nextPos;
            }
            return skipJsonValueFast(bytes, tvp, end);
          });
          if (next < 0) return null;
          hasTimings = true;
          return next;
        }
        return skipJsonValueFast(bytes, vp, end);
      }
      if (kLen === 15 && asciiKeyMatches(bytes, qs, qe, false, "startedDateTime")) {
        const nextPos = decodeJsonStringInto(bytes, vp, end);
        if (nextPos < 0) return null;
        startedDateTime = parsedStrVal;
        return nextPos;
      }
    } else {
      if (asciiKeyMatches(bytes, qs, qe, true, "time")) {
        const nextPos = readJsonNumberInto(bytes, vp, end);
        if (nextPos < 0) return null;
        if (parsedNumVal !== null) time = parsedNumVal;
        return nextPos;
      }
      if (asciiKeyMatches(bytes, qs, qe, true, "startedDateTime")) {
        const nextPos = decodeJsonStringInto(bytes, vp, end);
        if (nextPos < 0) return null;
        startedDateTime = parsedStrVal;
        return nextPos;
      }
    }
    return skipJsonValueFast(bytes, vp, end);
  });

  if (afterObj < 0) return -1;

  const base = slot * HAR_COL_STRIDE;
  nums[base] = status;
  nums[base + 1] = contentSize;
  nums[base + 2] = bodySize;
  nums[base + 3] = time;
  nums[base + 4] = blocked;
  nums[base + 5] = dns;
  nums[base + 6] = connect;
  nums[base + 7] = ssl;
  nums[base + 8] = send;
  nums[base + 9] = wait;
  nums[base + 10] = receive;
  nums[base + 11] = startedDateTime !== null ? parseIsoDateMsFast(startedDateTime) : Number.NaN;
  nums[base + 12] = HAR_COL_FLAG_VALID | (hasTimings ? HAR_COL_FLAG_HAS_TIMINGS : 0);
  methods[slot] = method;
  urls[slot] = url;
  mimeTypes[slot] = mimeType;
  startedDateTimes[slot] = startedDateTime;
  return afterObj;
}

function writeRawRowToColumnar(
  raw: HarTableRawRow | null,
  slot: number,
  nums: Float64Array,
  methods: Array<string | null>,
  urls: Array<string | null>,
  mimeTypes: Array<string | null>,
  startedDateTimes: Array<string | null>,
): void {
  const base = slot * HAR_COL_STRIDE;
  if (raw === null) {
    nums.fill(Number.NaN, base, base + 12);
    nums[base + 12] = 0;
    methods[slot] = null;
    urls[slot] = null;
    mimeTypes[slot] = null;
    startedDateTimes[slot] = null;
    return;
  }
  const t = raw.timings;
  nums[base] = raw.status ?? Number.NaN;
  nums[base + 1] = raw.contentSize ?? Number.NaN;
  nums[base + 2] = raw.bodySize ?? Number.NaN;
  nums[base + 3] = raw.time ?? Number.NaN;
  nums[base + 4] = t?.blocked ?? Number.NaN;
  nums[base + 5] = t?.dns ?? Number.NaN;
  nums[base + 6] = t?.connect ?? Number.NaN;
  nums[base + 7] = t?.ssl ?? Number.NaN;
  nums[base + 8] = t?.send ?? Number.NaN;
  nums[base + 9] = t?.wait ?? Number.NaN;
  nums[base + 10] = t?.receive ?? Number.NaN;
  nums[base + 11] =
    raw.startedDateTime !== null ? parseIsoDateMsFast(raw.startedDateTime) : Number.NaN;
  nums[base + 12] = HAR_COL_FLAG_VALID | (t !== null ? HAR_COL_FLAG_HAS_TIMINGS : 0);
  methods[slot] = raw.method;
  urls[slot] = raw.url;
  mimeTypes[slot] = raw.mimeType;
  startedDateTimes[slot] = raw.startedDateTime;
}

async function findJsonElementEnd(
  src: ByteSource,
  windowEnd: number,
  stepBytes: number,
  readStep: (src: ByteSource, from: number, to: number, slot: 0 | 1) => Promise<Uint8Array>,
  initialBuf: Uint8Array,
  initialBufStart: number,
  startPosInBuf: number,
  initialSlot: 0 | 1,
  initialPending: Promise<Uint8Array> | null,
  initialPendingStart: number,
): Promise<{
  readonly elemEnd: number;
  readonly curBuf: Uint8Array;
  readonly curBufStart: number;
  readonly curSlot: 0 | 1;
}> {
  let buf = initialBuf;
  let bufStart = initialBufStart;
  let slot: 0 | 1 = initialSlot;
  let pending = initialPending;
  let pendingStart = initialPendingStart;
  let i = startPosInBuf;
  let inString = false;
  let trailingBackslashOdd = false;
  let depth = 0;
  let isScalar = false;

  try {
    for (;;) {
      const len = buf.length;
      while (i < len) {
        if (inString) {
          const q = buf.indexOf(0x22, i);
          if (q < 0) {
            let bs = 0;
            let k = len - 1;
            while (k >= i && buf[k] === 0x5c) {
              bs++;
              k--;
            }
            if (k < i && i === 0) {
              trailingBackslashOdd = trailingBackslashOdd ? (bs & 1) === 0 : (bs & 1) === 1;
            } else {
              trailingBackslashOdd = (bs & 1) === 1;
            }
            i = len;
            break;
          }
          let bs = 0;
          let k = q - 1;
          while (k >= i && buf[k] === 0x5c) {
            bs++;
            k--;
          }
          const escaped =
            k < i && i === 0
              ? trailingBackslashOdd
                ? (bs & 1) === 0
                : (bs & 1) === 1
              : (bs & 1) === 1;
          trailingBackslashOdd = false;
          i = q + 1;
          if (!escaped) {
            inString = false;
            if (depth === 0) {
              if (pending !== null) {
                await pending.catch(() => {});
                pending = null;
              }
              return { elemEnd: bufStart + i, curBuf: buf, curBufStart: bufStart, curSlot: slot };
            }
          }
          continue;
        }

        const b = buf[i] as number;
        if (isScalar && depth === 0) {
          if (isWs(b) || b === 0x2c || b === 0x5d) {
            if (pending !== null) {
              await pending.catch(() => {});
              pending = null;
            }
            return { elemEnd: bufStart + i, curBuf: buf, curBufStart: bufStart, curSlot: slot };
          }
          i++;
          continue;
        }
        if (b === 0x22) {
          inString = true;
          trailingBackslashOdd = false;
          i++;
          continue;
        }
        if (b === 0x7b || b === 0x5b) {
          depth++;
          i++;
          continue;
        }
        if (b === 0x7d || b === 0x5d) {
          if (depth === 0) {
            if (pending !== null) {
              await pending.catch(() => {});
              pending = null;
            }
            return { elemEnd: bufStart + i, curBuf: buf, curBufStart: bufStart, curSlot: slot };
          }
          depth--;
          i++;
          if (depth === 0) {
            if (pending !== null) {
              await pending.catch(() => {});
              pending = null;
            }
            return { elemEnd: bufStart + i, curBuf: buf, curBufStart: bufStart, curSlot: slot };
          }
          continue;
        }
        if (depth === 0 && !isWs(b) && b !== 0x2c) {
          isScalar = true;
        }
        i++;
      }

      if (pending !== null) {
        buf = await pending;
        bufStart = pendingStart;
        slot = (slot ^ 1) as 0 | 1;
        pending = null;
        i = 0;
        if (buf.length === 0) {
          return { elemEnd: bufStart, curBuf: buf, curBufStart: bufStart, curSlot: slot };
        }
        continue;
      }

      const nextOffset = bufStart + buf.length;
      if (nextOffset >= windowEnd) {
        return { elemEnd: windowEnd, curBuf: buf, curBufStart: bufStart, curSlot: slot };
      }
      const nextEnd = Math.min(windowEnd, nextOffset + stepBytes);
      buf = await readStep(src, nextOffset, nextEnd, slot);
      bufStart = nextOffset;
      i = 0;
      if (buf.length === 0) {
        return { elemEnd: nextOffset, curBuf: buf, curBufStart: bufStart, curSlot: slot };
      }
    }
  } finally {
    if (pending !== null) {
      await pending.catch(() => {});
    }
  }
}

/**
 * Single-pass double-buffered worker scanner over `[start, end)` inside `.log.entries`.
 * Prefetches chunk `k+1` into the alternate buffer while scanning chunk `k` so Blob I/O
 * and CPU scanning overlap cleanly without unbounded memory growth.
 */
export async function scanHarTableWindowColumnar(
  src: ByteSource,
  start: number,
  end: number,
  stepBytes: number,
  readStep: (src: ByteSource, from: number, to: number, slot: 0 | 1) => Promise<Uint8Array>,
  streamBufferHolder?: { buffer: ArrayBuffer },
): Promise<HarTableColumnarData> {
  let cap = 256;
  let count = 0;
  let nums = new Float64Array(cap * HAR_COL_STRIDE);
  const methods: Array<string | null> = [];
  const urls: Array<string | null> = [];
  const mimeTypes: Array<string | null> = [];
  const startedDateTimes: Array<string | null> = [];

  if (end <= start) {
    return { count: 0, nums: new Float64Array(0), methods, urls, mimeTypes, startedDateTimes };
  }

  const clampedStep = Math.max(64 * 1024, Math.min(stepBytes, MAX_SLICE_BYTES));
  const ensureCap = (slot: number) => {
    if (slot < cap) return;
    while (cap <= slot) cap *= 2;
    const nextNums = new Float64Array(cap * HAR_COL_STRIDE);
    nextNums.set(nums);
    nums = nextNums;
  };

  if (src.openStream !== undefined) {
    const streamMinFill = Math.min(4 * 1024 * 1024, Math.max(256 * 1024, clampedStep >>> 1));
    const bufCap = clampedStep;
    let backingBuf =
      streamBufferHolder !== undefined && streamBufferHolder.buffer.byteLength >= bufCap
        ? streamBufferHolder.buffer
        : new ArrayBuffer(bufCap);
    let view = new Uint8Array(backingBuf);
    let stream = src.openStream(start, end);
    let chunkBaseOffset = start;
    let validLen = 0;
    let chunkPos = 0;
    let eof = false;

    const fillChunk = async (targetFill: number): Promise<void> => {
      if (chunkPos > 0) {
        const rem = validLen - chunkPos;
        if (rem > 0) view.copyWithin(0, chunkPos, validLen);
        chunkBaseOffset += chunkPos;
        validLen = rem;
        chunkPos = 0;
      }
      while (!eof && validLen < targetFill && validLen < bufCap) {
        const chunk = await stream.nextInto(backingBuf, validLen, bufCap - validLen);
        if (chunk.buffer !== backingBuf) {
          backingBuf = chunk.buffer;
          view = new Uint8Array(backingBuf);
        }
        if (chunk.bytesRead === 0) {
          eof = true;
          break;
        }
        validLen += chunk.bytesRead;
      }
    };

    try {
      for (;;) {
        if (chunkPos >= validLen || (!eof && validLen - chunkPos < 1024)) {
          await fillChunk(streamMinFill);
          if (chunkPos >= validLen && eof) break;
        }

        while (chunkPos < validLen) {
          const b = view[chunkPos] as number;
          if (isWs(b) || b === 0x2c) {
            chunkPos++;
            continue;
          }
          if (b === 0x5d || b === 0x7d) {
            return {
              count,
              nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
              methods,
              urls,
              mimeTypes,
              startedDateTimes,
            };
          }

          const slot = count;
          ensureCap(slot);

          if (b === 0x7b) {
            let afterPos = extractHarObjectColumnarAt(
              view,
              chunkPos,
              validLen,
              slot,
              nums,
              methods,
              urls,
              mimeTypes,
              startedDateTimes,
            );
            while (afterPos < 0 && !eof && (chunkPos > 0 || validLen < bufCap)) {
              const prevLen = validLen;
              await fillChunk(Math.min(bufCap, Math.max(streamMinFill, validLen + streamMinFill)));
              if (validLen === prevLen && chunkPos === 0) break;
              afterPos = extractHarObjectColumnarAt(
                view,
                chunkPos,
                validLen,
                slot,
                nums,
                methods,
                urls,
                mimeTypes,
                startedDateTimes,
              );
            }
            if (afterPos >= 0) {
              count++;
              chunkPos = afterPos;
              continue;
            }
          } else if (!eof && (chunkPos > 0 || validLen < bufCap)) {
            await fillChunk(Math.min(bufCap, Math.max(streamMinFill, validLen + streamMinFill)));
          }

          // Entry spans > bufCap (or EOF fallback): extract in one pass and reopen stream after it.
          const elemStart = chunkBaseOffset + chunkPos;
          stream.close();
          if (b === 0x7b) {
            const res = await extractHarTableRawWithEndFromSource(src, elemStart, end);
            if (res.endPos <= elemStart) {
              return {
                count,
                nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
                methods,
                urls,
                mimeTypes,
                startedDateTimes,
              };
            }
            writeRawRowToColumnar(res.raw, slot, nums, methods, urls, mimeTypes, startedDateTimes);
            count++;
            chunkBaseOffset = res.endPos;
            validLen = 0;
            chunkPos = 0;
            eof = res.endPos >= end;
            if (!eof) stream = src.openStream(res.endPos, end);
            break;
          }

          // Non-object fallback
          const found = await findJsonElementEnd(
            src,
            end,
            clampedStep,
            readStep,
            view,
            chunkBaseOffset,
            chunkPos,
            0,
            null,
            chunkBaseOffset + validLen,
          );
          if (found.elemEnd <= elemStart) {
            return {
              count,
              nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
              methods,
              urls,
              mimeTypes,
              startedDateTimes,
            };
          }
          const elemLen = found.elemEnd - elemStart;
          const raw =
            elemLen > MAX_SLICE_BYTES
              ? await extractHarTableRawFromSource(src, elemStart, found.elemEnd)
              : extractHarTableRaw(await src.read(elemStart, found.elemEnd));
          writeRawRowToColumnar(raw, slot, nums, methods, urls, mimeTypes, startedDateTimes);
          count++;
          chunkBaseOffset = found.elemEnd;
          validLen = 0;
          chunkPos = 0;
          eof = found.elemEnd >= end;
          if (!eof) stream = src.openStream(found.elemEnd, end);
          break;
        }
      }
    } finally {
      stream.close();
      if (streamBufferHolder !== undefined && backingBuf.byteLength > 0) {
        streamBufferHolder.buffer = backingBuf;
      }
    }

    return {
      count,
      nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
      methods,
      urls,
      mimeTypes,
      startedDateTimes,
    };
  }

  let cursor = start;
  let buf: Uint8Array = new Uint8Array(0);
  let bufStart = start;
  let chunkPos = 0;
  let activeSlot: 0 | 1 = 0;
  let pendingBuf: Promise<Uint8Array> | null = null;
  let pendingStart = start;
  let pendingEnd = start;

  const schedulePrefetch = () => {
    if (pendingBuf !== null || cursor >= end) return;
    pendingStart = cursor;
    pendingEnd = Math.min(end, cursor + clampedStep);
    pendingBuf = readStep(src, pendingStart, pendingEnd, (activeSlot ^ 1) as 0 | 1);
  };

  try {
    while (cursor < end || chunkPos < buf.length || pendingBuf !== null) {
      if (chunkPos >= buf.length) {
        if (pendingBuf !== null) {
          buf = await pendingBuf;
          bufStart = pendingStart;
          cursor = pendingEnd;
          activeSlot = (activeSlot ^ 1) as 0 | 1;
          chunkPos = 0;
          pendingBuf = null;
          if (buf.length === 0) break;
        } else {
          if (cursor >= end) break;
          const chunkEnd = Math.min(end, cursor + clampedStep);
          buf = await readStep(src, cursor, chunkEnd, activeSlot);
          bufStart = cursor;
          chunkPos = 0;
          cursor = chunkEnd;
          if (buf.length === 0) break;
        }
        schedulePrefetch();
      }

      const len = buf.length;
      while (chunkPos < len) {
        const b = buf[chunkPos] as number;
        if (isWs(b) || b === 0x2c) {
          chunkPos++;
          continue;
        }
        if (b === 0x5d || b === 0x7d) {
          return {
            count,
            nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
            methods,
            urls,
            mimeTypes,
            startedDateTimes,
          };
        }

        const slot = count;
        ensureCap(slot);

        if (b === 0x7b) {
          const afterPos = extractHarObjectColumnarAt(
            buf,
            chunkPos,
            len,
            slot,
            nums,
            methods,
            urls,
            mimeTypes,
            startedDateTimes,
          );
          if (afterPos >= 0) {
            count++;
            chunkPos = afterPos;
            continue;
          }
          // Boundary straddler or oversized (> MAX_SLICE_BYTES) object: parse and find end in one pass.
          const elemStart = bufStart + chunkPos;
          const pRef = pendingBuf as Promise<Uint8Array> | null;
          const pStart = pendingStart;
          const pEnd = pendingEnd;
          pendingBuf = null;
          const res = await extractHarTableRawWithEndFromSource(src, elemStart, end);
          if (res.endPos <= elemStart) {
            if (pRef !== null) await pRef.catch(() => {});
            return {
              count,
              nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
              methods,
              urls,
              mimeTypes,
              startedDateTimes,
            };
          }
          writeRawRowToColumnar(res.raw, slot, nums, methods, urls, mimeTypes, startedDateTimes);
          count++;

          if (res.endPos < bufStart + len) {
            pendingBuf = pRef;
            chunkPos = res.endPos - bufStart;
            continue;
          }
          if (pRef !== null && res.endPos >= pStart && res.endPos < pEnd) {
            buf = await pRef;
            bufStart = pStart;
            cursor = pEnd;
            activeSlot = (activeSlot ^ 1) as 0 | 1;
            chunkPos = res.endPos - pStart;
            if (chunkPos >= buf.length) break;
            schedulePrefetch();
            continue;
          }
          if (pRef !== null) {
            await pRef.catch(() => {});
          }
          buf = new Uint8Array(0);
          bufStart = res.endPos;
          chunkPos = 0;
          cursor = res.endPos;
          break;
        }

        const elemStart = bufStart + chunkPos;
        const pRef = pendingBuf;
        const pStartRef = pendingStart;
        pendingBuf = null;
        const found = await findJsonElementEnd(
          src,
          end,
          clampedStep,
          readStep,
          buf,
          bufStart,
          chunkPos,
          activeSlot,
          pRef,
          pStartRef,
        );
        activeSlot = found.curSlot;
        const elemEnd = found.elemEnd;
        if (elemEnd <= elemStart) {
          return {
            count,
            nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
            methods,
            urls,
            mimeTypes,
            startedDateTimes,
          };
        }

        const elemLen = elemEnd - elemStart;
        let raw: HarTableRawRow | null = null;
        if (elemLen > MAX_SLICE_BYTES) {
          raw = await extractHarTableRawFromSource(src, elemStart, elemEnd);
        } else {
          const slice = await src.read(elemStart, elemEnd);
          raw = extractHarTableRaw(slice);
        }
        writeRawRowToColumnar(raw, slot, nums, methods, urls, mimeTypes, startedDateTimes);
        count++;

        if (elemLen <= MAX_SLICE_BYTES && elemEnd < found.curBufStart + found.curBuf.length) {
          buf = found.curBuf;
          bufStart = found.curBufStart;
          chunkPos = elemEnd - found.curBufStart;
          cursor = bufStart + buf.length;
          schedulePrefetch();
        } else {
          buf = new Uint8Array(0);
          bufStart = elemEnd;
          chunkPos = 0;
          cursor = elemEnd;
          break;
        }
      }
    }
  } finally {
    const leftover = pendingBuf as Promise<Uint8Array> | null;
    if (leftover !== null) {
      await leftover.catch(() => {});
    }
  }

  return {
    count,
    nums: count === 0 ? new Float64Array(0) : nums.subarray(0, count * HAR_COL_STRIDE),
    methods,
    urls,
    mimeTypes,
    startedDateTimes,
  };
}

/** Fast single-entry columnar extraction for an oversized (`> MAX_SLICE_BYTES`) HAR bucket. */
export async function scanSingleOversizedHarRowColumnar(
  src: ByteSource,
  start: number,
  end: number,
): Promise<HarTableColumnarData> {
  const raw = await extractHarTableRawFromSource(src, start, end);
  const nums = new Float64Array(HAR_COL_STRIDE);
  const methods: Array<string | null> = [null];
  const urls: Array<string | null> = [null];
  const mimeTypes: Array<string | null> = [null];
  const startedDateTimes: Array<string | null> = [null];
  writeRawRowToColumnar(raw, 0, nums, methods, urls, mimeTypes, startedDateTimes);
  return { count: 1, nums, methods, urls, mimeTypes, startedDateTimes };
}

/** Discovers tabular arrays in a document, recommending `.log.entries` for HAR, `$`, or the largest array. */
async function discoverTableTargets(
  access: TableDocAccess,
  documentId: number,
): Promise<TableTargetsResult> {
  const format = await access.format(documentId);
  let root = await access.root(documentId);
  if (!root.settled && access.node) {
    root = await access.node(root.ref);
  }
  const targets: TableTarget[] = [];

  if (root.kind === "array") {
    targets.push({
      ref: root.ref,
      path: "$",
      label: "Root array",
      kind: "root",
      rowCount: root.childCount,
      isHarEntries: false,
    });
    return { targets, recommendedPath: "$" };
  }

  if (root.kind !== "object") {
    return { targets: [], recommendedPath: null };
  }

  const topPage = await access.rows(root.ref, 0, DISCOVER_OBJECT_MEMBERS_LIMIT, 1);
  let harEntriesPath: string | null = null;

  for (const member of topPage.rows) {
    if (targets.length >= DISCOVER_MAX_TARGETS || member.key === null) continue;
    const memberPath = pathStep("$", member.key);
    if (member.node.kind === "array") {
      targets.push({
        ref: member.node.ref,
        path: memberPath,
        label: memberPath,
        kind: "array",
        rowCount: member.node.childCount,
        isHarEntries: false,
      });
      continue;
    }
    if (member.node.kind !== "object") continue;

    const nestedPage = await access.rows(member.node.ref, 0, DISCOVER_OBJECT_MEMBERS_LIMIT, 1);
    for (const child of nestedPage.rows) {
      if (targets.length >= DISCOVER_MAX_TARGETS || child.key === null) continue;
      if (child.node.kind !== "array") continue;
      const childPath = pathStep(memberPath, child.key);
      const isHarEntries =
        member.key === "log" &&
        child.key === "entries" &&
        (format === "har" || child.node.childCount >= 0);
      if (isHarEntries) harEntriesPath = childPath;
      targets.push({
        ref: child.node.ref,
        path: childPath,
        label: isHarEntries ? `HAR entries (${childPath})` : childPath,
        kind: isHarEntries ? "harEntries" : "array",
        rowCount: child.node.childCount,
        isHarEntries,
      });
    }
  }

  if (targets.length === 0) {
    return { targets: [], recommendedPath: null };
  }

  let recommendedPath = targets[0]?.path ?? null;
  if (format === "har" && harEntriesPath !== null) {
    recommendedPath = harEntriesPath;
  } else if (harEntriesPath !== null && format === "json") {
    const harTarget = targets.find((t) => t.path === harEntriesPath);
    if (harTarget && harTarget.rowCount > 0) recommendedPath = harEntriesPath;
  } else {
    let best = targets[0] as TableTarget;
    for (const candidate of targets) {
      if (candidate.rowCount > best.rowCount) best = candidate;
    }
    recommendedPath = best.path;
  }

  return { targets, recommendedPath };
}

interface ColumnMutable {
  readonly key: string;
  readonly label: string;
  readonly index: number;
  kind: TableColumnKind;
  readonly late: boolean;
}

const jsValueKind = (value: unknown): TableColumnKind => {
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") return "container";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
};

const parseNumericString = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 64 || !NUMERIC_STRING.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

const formatScalarForCell = (
  value: unknown,
): { readonly kind: NodeKind; readonly text: string; readonly numericValue: number | null } => {
  if (value === null) return { kind: "null", text: "null", numericValue: null };
  if (value === true) return { kind: "true", text: "true", numericValue: 1 };
  if (value === false) return { kind: "false", text: "false", numericValue: 0 };
  if (typeof value === "number") {
    return {
      kind: "number",
      text: String(value),
      numericValue: Number.isFinite(value) ? value : null,
    };
  }
  if (typeof value === "string") {
    const text =
      value.length > TABLE_CELL_PREVIEW_BYTES ? value.slice(0, TABLE_CELL_PREVIEW_BYTES) : value;
    return {
      kind: "string",
      text,
      numericValue: parseNumericString(text),
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array", text: `[${value.length}]`, numericValue: null };
  }
  const count = Object.keys(value as Record<string, unknown>).length;
  return { kind: "object", text: `{${count}}`, numericValue: null };
};

export interface SortVector {
  readonly ranks: Uint8Array;
  readonly nums: Float64Array;
  readonly strs: Array<string>;
}

const RANK_MISSING = 4;
const RANK_NULL = 0;
const RANK_BOOL = 1;
const RANK_NUM = 2;
const RANK_STR = 3;

const sortVectorFromValue = (
  ranks: Uint8Array,
  nums: Float64Array,
  strs: Array<string>,
  rowIndex: number,
  value: unknown,
) => {
  if (value === undefined) {
    ranks[rowIndex] = RANK_MISSING;
    return;
  }
  if (value === null) {
    ranks[rowIndex] = RANK_NULL;
    return;
  }
  if (typeof value === "boolean") {
    ranks[rowIndex] = RANK_BOOL;
    nums[rowIndex] = value ? 1 : 0;
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      ranks[rowIndex] = RANK_NUM;
      nums[rowIndex] = value;
    } else {
      ranks[rowIndex] = RANK_STR;
      strs[rowIndex] = String(value);
    }
    return;
  }
  if (typeof value === "string") {
    const parsed = parseNumericString(value);
    if (parsed !== null) {
      ranks[rowIndex] = RANK_NUM;
      nums[rowIndex] = parsed;
      strs[rowIndex] = value;
    } else {
      ranks[rowIndex] = RANK_STR;
      strs[rowIndex] = value;
    }
    return;
  }
  ranks[rowIndex] = RANK_MISSING;
};

const sortVectorFromRowSummary = (
  ranks: Uint8Array,
  nums: Float64Array,
  strs: Array<string>,
  rowIndex: number,
  row: RowSummary | undefined,
) => {
  if (!row) {
    ranks[rowIndex] = RANK_MISSING;
    return;
  }
  switch (row.node.kind) {
    case "null":
      ranks[rowIndex] = RANK_NULL;
      return;
    case "false":
      ranks[rowIndex] = RANK_BOOL;
      nums[rowIndex] = 0;
      return;
    case "true":
      ranks[rowIndex] = RANK_BOOL;
      nums[rowIndex] = 1;
      return;
    case "number": {
      const n = row.preview ? Number(row.preview.text) : Number.NaN;
      if (Number.isFinite(n)) {
        ranks[rowIndex] = RANK_NUM;
        nums[rowIndex] = n;
      } else {
        ranks[rowIndex] = RANK_STR;
        strs[rowIndex] = row.preview?.text ?? "";
      }
      return;
    }
    case "string": {
      const text = row.preview?.text ?? "";
      const parsed = parseNumericString(text);
      if (parsed !== null) {
        ranks[rowIndex] = RANK_NUM;
        nums[rowIndex] = parsed;
      } else {
        ranks[rowIndex] = RANK_STR;
      }
      strs[rowIndex] = text;
      return;
    }
    default:
      ranks[rowIndex] = RANK_MISSING;
  }
};

/** Compares two row indices using a pre-extracted SortVector (view-only permutation). */
export function sortPermutation(
  indices: Uint32Array,
  vector: SortVector,
  direction: "asc" | "desc",
): Uint32Array {
  const { ranks, nums, strs } = vector;
  const copy = new Uint32Array(indices);
  const sign = direction === "desc" ? -1 : 1;
  copy.sort((a, b) => {
    const ra = ranks[a] as number;
    const rb = ranks[b] as number;
    // Push missing/container rows to the bottom regardless of sort direction.
    if (ra === RANK_MISSING || rb === RANK_MISSING) {
      if (ra !== rb) return ra === RANK_MISSING ? 1 : -1;
      return a - b;
    }
    if (ra !== rb) {
      return (ra - rb) * sign || a - b;
    }
    if (ra === RANK_NULL) return a - b;
    if (ra === RANK_BOOL || ra === RANK_NUM) {
      const na = nums[a] as number;
      const nb = nums[b] as number;
      if (na !== nb) return (na < nb ? -1 : 1) * sign;
      return a - b;
    }
    const sa = strs[a] ?? "";
    const sb = strs[b] ?? "";
    if (sa !== sb) return (sa < sb ? -1 : 1) * sign;
    return a - b;
  });
  return copy;
}

/** Iterates element NodeSummaries for a target array in bounded 1024-child pages. */
/**
 * Streams an oversized (`> MAX_SLICE_BYTES`) HAR entry inside a scan worker using a
 * bounded `<= 4 MiB` `SourceJsonCursor`, extracting table/waterfall metadata cleanly.
 */
export async function extractHarTableRawFromSource(
  src: ByteSource,
  elemStart: number,
  elemEnd: number,
): Promise<HarTableRawRow | null> {
  const { raw } = await extractHarTableRawWithEndFromSource(src, elemStart, elemEnd);
  return raw;
}

async function extractHarTableRawWithEndFromSource(
  src: ByteSource,
  elemStart: number,
  elemEnd: number,
): Promise<{ readonly raw: HarTableRawRow | null; readonly endPos: number }> {
  const cursor = new SourceJsonCursor(src, elemStart, elemEnd);
  const start = await cursor.skipWs(elemStart);
  if ((await cursor.byteAt(start)) !== 0x7b) return { raw: null, endPos: -1 };

  let method: string | null = null;
  let url: string | null = null;
  let pageref: string | null = null;
  let status: number | null = null;
  let mimeType: string | null = null;
  let contentSize: number | null = null;
  let bodySize: number | null = null;
  let startedDateTime: string | null = null;
  let time: number | null = null;
  let timings: HarTableRawRow["timings"] = null;

  const end = await cursor.walkObject(start, async (key, vp) => {
    if (key === "time") {
      const r = await cursor.readNumberScalar(vp);
      if (!r) return null;
      time = r.value;
      return r.nextPos;
    }
    if (key === "startedDateTime") {
      const r = await cursor.readStringScalar(vp);
      if (!r) return null;
      startedDateTime = r.value;
      return r.nextPos;
    }
    if (key === "pageref") {
      const r = await cursor.readStringScalar(vp);
      if (!r) return null;
      pageref = r.value;
      return r.nextPos;
    }
    if (key === "request" && (await cursor.byteAt(vp)) === 0x7b) {
      return cursor.walkObject(vp, async (rk, rvp) => {
        if (rk === "method") {
          const r = await cursor.readStringScalar(rvp);
          if (!r) return null;
          method = r.value;
          return r.nextPos;
        }
        if (rk === "url") {
          const r = await cursor.readStringScalar(rvp);
          if (!r) return null;
          url = r.value;
          return r.nextPos;
        }
        return cursor.skipValue(rvp);
      });
    }
    if (key === "response" && (await cursor.byteAt(vp)) === 0x7b) {
      return cursor.walkObject(vp, async (pk, pvp) => {
        if (pk === "status") {
          const r = await cursor.readNumberScalar(pvp);
          if (!r) return null;
          status = r.value;
          return r.nextPos;
        }
        if (pk === "bodySize") {
          const r = await cursor.readNumberScalar(pvp);
          if (!r) return null;
          bodySize = r.value;
          return r.nextPos;
        }
        if (pk === "content" && (await cursor.byteAt(pvp)) === 0x7b) {
          return cursor.walkObject(pvp, async (ck, cvp) => {
            if (ck === "mimeType") {
              const r = await cursor.readStringScalar(cvp);
              if (!r) return null;
              mimeType = r.value;
              return r.nextPos;
            }
            if (ck === "size") {
              const r = await cursor.readNumberScalar(cvp);
              if (!r) return null;
              contentSize = r.value;
              return r.nextPos;
            }
            return cursor.skipValue(cvp);
          });
        }
        return cursor.skipValue(pvp);
      });
    }
    if (key === "timings" && (await cursor.byteAt(vp)) === 0x7b) {
      let blocked: number | null = null;
      let dns: number | null = null;
      let connect: number | null = null;
      let ssl: number | null = null;
      let send: number | null = null;
      let wait: number | null = null;
      let receive: number | null = null;
      const next = await cursor.walkObject(vp, async (tk, tvp) => {
        if (
          tk === "blocked" ||
          tk === "dns" ||
          tk === "connect" ||
          tk === "ssl" ||
          tk === "send" ||
          tk === "wait" ||
          tk === "receive"
        ) {
          const r = await cursor.readNumberScalar(tvp);
          if (!r) return null;
          if (tk === "blocked") blocked = r.value;
          else if (tk === "dns") dns = r.value;
          else if (tk === "connect") connect = r.value;
          else if (tk === "ssl") ssl = r.value;
          else if (tk === "send") send = r.value;
          else if (tk === "wait") wait = r.value;
          else receive = r.value;
          return r.nextPos;
        }
        return cursor.skipValue(tvp);
      });
      if (next < 0) return null;
      timings = { blocked, dns, connect, ssl, send, wait, receive };
      return next;
    }
    return cursor.skipValue(vp);
  });

  if (end < 0) return { raw: null, endPos: -1 };
  return {
    raw: {
      method,
      url,
      pageref,
      status,
      mimeType,
      contentSize,
      bodySize,
      startedDateTime,
      time,
      timings,
    },
    endPos: end,
  };
}

async function readAllElements(
  access: TableDocAccess,
  targetRef: NodeRef,
  totalRows: number,
): Promise<Array<NodeSummary | undefined>> {
  let capped = Math.min(totalRows, TABLE_MAX_ROWS);
  if (capped <= 0) return [];
  const firstCount = Math.min(CHILDREN_PAGE_LIMIT, capped);
  const firstPage = await access.children(targetRef, 0, firstCount);
  capped = Math.min(firstPage.total, TABLE_MAX_ROWS);
  const elements: Array<NodeSummary | undefined> = Array.from({ length: capped });
  for (let k = 0; k < firstPage.nodes.length && k < capped; k++) {
    elements[k] = firstPage.nodes[k];
  }
  const starts: number[] = [];
  for (let from = firstPage.nodes.length; from < capped; from += CHILDREN_PAGE_LIMIT) {
    starts.push(from);
  }
  for (let at = 0; at < starts.length; at += ELEMENT_PAGE_CONCURRENCY) {
    const batch = starts.slice(at, at + ELEMENT_PAGE_CONCURRENCY);
    const pages = await Promise.all(
      batch.map((from) =>
        access.children(targetRef, from, Math.min(CHILDREN_PAGE_LIMIT, capped - from)),
      ),
    );
    for (let p = 0; p < pages.length; p++) {
      const from = batch[p] as number;
      const nodes = pages[p]?.nodes ?? [];
      for (let k = 0; k < nodes.length && from + k < capped; k++) {
        elements[from + k] = nodes[k];
      }
    }
  }
  // Trim trailing undefined holes only if truncated
  while (elements.length > 0 && elements[elements.length - 1] === undefined) {
    elements.pop();
  }
  return elements;
}

/** Reads row elements either via batched 4 MiB logical slices or bounded access.rows fallback. */
async function visitElements(
  access: TableDocAccess,
  documentId: number,
  targetRef: NodeRef,
  elements: ReadonlyArray<NodeSummary | undefined>,
  format: DocumentFormat,
  onParsedObject: (rowIndex: number, node: NodeSummary, parsed: unknown) => void,
  onFallbackNode: (rowIndex: number, node: NodeSummary) => Promise<void>,
): Promise<void> {
  const canSlice = access.logicalSlice !== undefined && format !== "jsonc";
  let i = 0;
  while (i < elements.length) {
    const first = elements[i];
    if (first === undefined) {
      i++;
      continue;
    }
    const spanLen = first.span.end - first.span.start;
    if (
      !canSlice ||
      (first.kind !== "object" && first.kind !== "array") ||
      spanLen <= 0 ||
      spanLen > SMALL_ROW_SLICE_CAP
    ) {
      const batchEnd = Math.min(elements.length, i + ROW_FETCH_CONCURRENCY);
      const tasks: Promise<void>[] = [];
      for (let j = i; j < batchEnd; j++) {
        const el = elements[j];
        if (el === undefined) continue;
        if (
          canSlice &&
          (el.kind === "object" || el.kind === "array") &&
          el.span.end - el.span.start <= SMALL_ROW_SLICE_CAP
        ) {
          break;
        }
        tasks.push(onFallbackNode(j, el));
      }
      if (tasks.length > 0) {
        await Promise.all(tasks);
        i += tasks.length;
        continue;
      }
    }

    // Batch contiguous small nodes whose combined logical byte span fits within SLICE_BATCH_BYTES.
    const batchStart = first.span.start;
    let batchEndOffset = first.span.end;
    let batchEndIndex = i + 1;
    while (batchEndIndex < elements.length) {
      const next = elements[batchEndIndex];
      if (next === undefined) break;
      const nextLen = next.span.end - next.span.start;
      if (
        (next.kind !== "object" && next.kind !== "array") ||
        nextLen <= 0 ||
        nextLen > SMALL_ROW_SLICE_CAP ||
        next.span.start < batchStart ||
        next.span.end - batchStart > SLICE_BATCH_BYTES
      ) {
        break;
      }
      batchEndOffset = Math.max(batchEndOffset, next.span.end);
      batchEndIndex++;
    }

    const slice = await (access.logicalSlice as NonNullable<TableDocAccess["logicalSlice"]>)(
      documentId,
      targetRef.tapeId,
      { start: batchStart, end: batchEndOffset },
    );

    const fallbacks: Array<{ readonly rowIndex: number; readonly node: NodeSummary }> = [];
    for (let j = i; j < batchEndIndex; j++) {
      const el = elements[j] as NodeSummary;
      const relStart = el.span.start - batchStart;
      const relEnd = el.span.end - batchStart;
      if (relStart < 0 || relEnd > slice.byteLength || relEnd <= relStart) {
        fallbacks.push({ rowIndex: j, node: el });
        continue;
      }
      try {
        const parsed: unknown = parseJsonSlice(
          slice.subarray(relStart, relEnd),
          SMALL_ROW_SLICE_CAP,
        );
        onParsedObject(j, el, parsed);
      } catch {
        fallbacks.push({ rowIndex: j, node: el });
      }
    }
    for (let k = 0; k < fallbacks.length; k += ROW_FETCH_CONCURRENCY) {
      await Promise.all(
        fallbacks
          .slice(k, k + ROW_FETCH_CONCURRENCY)
          .map((f) => onFallbackNode(f.rowIndex, f.node)),
      );
    }
    i = batchEndIndex;
  }
}

async function readHarSummaryFromAccess(
  access: TableDocAccess,
  entryIndex: number,
  node: NodeSummary,
): Promise<{
  readonly summary: Omit<HarRequestRowSummary, "startOffsetMs">;
  readonly startEpochMs: number;
}> {
  if (node.kind !== "object") {
    return extractHarSummaryFromObject(entryIndex, node.ref, {});
  }
  const fields = await access.rows(node.ref, 0, CHILDREN_PAGE_LIMIT, TABLE_CELL_PREVIEW_BYTES);
  const raw: Record<string, unknown> = {};

  const readSubObject = async (
    row: RowSummary | undefined,
  ): Promise<Record<string, unknown> | null> => {
    if (!row || row.node.kind !== "object") return null;
    const sub = await access.rows(row.node.ref, 0, CHILDREN_PAGE_LIMIT, TABLE_CELL_PREVIEW_BYTES);
    const out: Record<string, unknown> = {};
    for (const member of sub.rows) {
      if (member.key === null) continue;
      if (member.node.kind === "string" && member.preview !== null)
        out[member.key] = member.preview.text;
      else if (member.node.kind === "number" && member.preview !== null)
        out[member.key] = Number(member.preview.text);
      else if (member.node.kind === "true") out[member.key] = true;
      else if (member.node.kind === "false") out[member.key] = false;
      else if (member.node.kind === "null") out[member.key] = null;
      else if (member.key === "content" && member.node.kind === "object") {
        const contentRows = await access.rows(
          member.node.ref,
          0,
          CHILDREN_PAGE_LIMIT,
          TABLE_CELL_PREVIEW_BYTES,
        );
        const contentObj: Record<string, unknown> = {};
        for (const cr of contentRows.rows) {
          if (cr.key === null || cr.key === "text") continue;
          if (cr.node.kind === "string" && cr.preview !== null)
            contentObj[cr.key] = cr.preview.text;
          else if (cr.node.kind === "number" && cr.preview !== null)
            contentObj[cr.key] = Number(cr.preview.text);
        }
        out.content = contentObj;
      }
    }
    return out;
  };

  for (const row of fields.rows) {
    if (row.key === null) continue;
    if (row.key === "startedDateTime" && row.node.kind === "string" && row.preview !== null) {
      raw.startedDateTime = row.preview.text;
    } else if (row.key === "time" && row.node.kind === "number" && row.preview !== null) {
      raw.time = Number(row.preview.text);
    }
  }

  const [requestObj, responseObj, timingsObj] = await Promise.all([
    readSubObject(fields.rows.find((r) => r.key === "request")),
    readSubObject(fields.rows.find((r) => r.key === "response")),
    readSubObject(fields.rows.find((r) => r.key === "timings")),
  ]);
  if (requestObj) raw.request = requestObj;
  if (responseObj) raw.response = responseObj;
  if (timingsObj) raw.timings = timingsObj;

  return extractHarSummaryFromObject(entryIndex, node.ref, raw);
}

interface HarFallbackEntry {
  readonly summary: Omit<HarRequestRowSummary, "startOffsetMs">;
  readonly startEpochMs: number;
}

interface HarColumnarStore {
  readonly count: number;
  readonly data: HarTableColumnarData;
  readonly minStartMs: number;
  readonly placeholderTapeId: number;
  readonly fallbacks: ReadonlyMap<number, HarFallbackEntry>;
}

function finalizeTimelineBuckets(
  c1: Uint32Array,
  c2: Uint32Array,
  c3: Uint32Array,
  c4: Uint32Array,
  c5: Uint32Array,
  cO: Uint32Array,
  minStartMs: number,
  maxEndMs: number,
): HarTimelineSummary {
  const totalSpanMs = Math.max(0, maxEndMs - minStartMs);
  const bucketCount = TABLE_TIMELINE_BUCKETS;
  const bucketMs = totalSpanMs > 0 ? totalSpanMs / bucketCount : 1;
  const buckets: HarTimelineBucket[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const c1xx = c1[b] ?? 0;
    const c2xx = c2[b] ?? 0;
    const c3xx = c3[b] ?? 0;
    const c4xx = c4[b] ?? 0;
    const c5xx = c5[b] ?? 0;
    const cOther = cO[b] ?? 0;
    buckets.push({
      startMs: b * bucketMs,
      endMs: (b + 1) * bucketMs,
      total: c1xx + c2xx + c3xx + c4xx + c5xx + cOther,
      c1xx,
      c2xx,
      c3xx,
      c4xx,
      c5xx,
      cOther,
    });
  }
  return { minStartMs, maxEndMs, totalSpanMs, buckets };
}

function statusBucketArray(
  status: number | null,
  c1: Uint32Array,
  c2: Uint32Array,
  c3: Uint32Array,
  c4: Uint32Array,
  c5: Uint32Array,
  cO: Uint32Array,
): Uint32Array {
  if (status !== null && Number.isFinite(status)) {
    if (status >= 200 && status < 300) return c2;
    if (status >= 300 && status < 400) return c3;
    if (status >= 400 && status < 500) return c4;
    if (status >= 500 && status < 600) return c5;
    if (status >= 100 && status < 200) return c1;
  }
  return cO;
}

function addTimelineSpan(
  target: Uint32Array,
  start: number,
  timeMs: number | null,
  bucketCount: number,
  bucketMs: number,
  hasSpan: boolean,
): void {
  if (!hasSpan) {
    target[0] = (target[0] ?? 0) + 1;
    return;
  }
  const duration = timeMs !== null && timeMs > 0 ? timeMs : 1;
  const end = start + duration;
  const b0 = Math.max(0, Math.min(bucketCount - 1, Math.floor(start / bucketMs)));
  const b1 = Math.max(b0, Math.min(bucketCount - 1, Math.floor(end / bucketMs)));
  for (let b = b0; b <= b1; b++) {
    target[b] = (target[b] ?? 0) + 1;
  }
}

function buildHarTimeline(
  entries: ReadonlyArray<HarRequestRowSummary>,
  minStartMs: number,
  maxEndMs: number,
): HarTimelineSummary {
  const totalSpanMs = Math.max(0, maxEndMs - minStartMs);
  const bucketCount = TABLE_TIMELINE_BUCKETS;
  const bucketMs = totalSpanMs > 0 ? totalSpanMs / bucketCount : 1;
  const hasSpan = totalSpanMs > 0;
  const c1 = new Uint32Array(bucketCount);
  const c2 = new Uint32Array(bucketCount);
  const c3 = new Uint32Array(bucketCount);
  const c4 = new Uint32Array(bucketCount);
  const c5 = new Uint32Array(bucketCount);
  const cO = new Uint32Array(bucketCount);

  for (const entry of entries) {
    addTimelineSpan(
      statusBucketArray(entry.status, c1, c2, c3, c4, c5, cO),
      entry.startOffsetMs,
      entry.timeMs,
      bucketCount,
      bucketMs,
      hasSpan,
    );
  }
  return finalizeTimelineBuckets(c1, c2, c3, c4, c5, cO, minStartMs, maxEndMs);
}

function buildHarTimelineFromColumnar(
  data: HarTableColumnarData,
  fallbacks: ReadonlyMap<number, HarFallbackEntry>,
): { readonly minStartMs: number; readonly timeline: HarTimelineSummary } {
  const totalRows = data.count;
  const nums = data.nums;
  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < totalRows; i++) {
    const base = i * HAR_COL_STRIDE;
    let s: number;
    let dur: number | null;
    if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) !== 0) {
      s = nums[base + 11] as number;
      dur = columnarTimeMs(nums, base);
    } else {
      const fb = fallbacks.get(i);
      if (!fb) continue;
      s = fb.startEpochMs;
      dur = fb.summary.timeMs;
    }
    if (!Number.isFinite(s)) continue;
    if (s < minStartMs) minStartMs = s;
    const end = s + (dur !== null && dur > 0 ? dur : 0);
    if (end > maxEndMs) maxEndMs = end;
  }

  if (!Number.isFinite(minStartMs)) {
    minStartMs = 0;
    maxEndMs = 0;
  } else if (!Number.isFinite(maxEndMs) || maxEndMs < minStartMs) {
    maxEndMs = minStartMs;
  }

  const totalSpanMs = Math.max(0, maxEndMs - minStartMs);
  const bucketCount = TABLE_TIMELINE_BUCKETS;
  const bucketMs = totalSpanMs > 0 ? totalSpanMs / bucketCount : 1;
  const hasSpan = totalSpanMs > 0;
  const c1 = new Uint32Array(bucketCount);
  const c2 = new Uint32Array(bucketCount);
  const c3 = new Uint32Array(bucketCount);
  const c4 = new Uint32Array(bucketCount);
  const c5 = new Uint32Array(bucketCount);
  const cO = new Uint32Array(bucketCount);

  for (let i = 0; i < totalRows; i++) {
    const base = i * HAR_COL_STRIDE;
    let s: number;
    let dur: number | null;
    let status: number | null;
    if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) !== 0) {
      s = nums[base + 11] as number;
      dur = columnarTimeMs(nums, base);
      const rawStatus = nums[base] as number;
      status = Number.isFinite(rawStatus) ? rawStatus : null;
    } else {
      const fb = fallbacks.get(i);
      s = fb ? fb.startEpochMs : Number.NaN;
      dur = fb ? fb.summary.timeMs : null;
      status = fb ? fb.summary.status : null;
    }
    const startOffsetMs = Number.isFinite(s) ? Math.max(0, s - minStartMs) : 0;
    addTimelineSpan(
      statusBucketArray(status, c1, c2, c3, c4, c5, cO),
      startOffsetMs,
      dur,
      bucketCount,
      bucketMs,
      hasSpan,
    );
  }

  return {
    minStartMs,
    timeline: finalizeTimelineBuckets(c1, c2, c3, c4, c5, cO, minStartMs, maxEndMs),
  };
}

function harColumnarTimeSpan(
  store: HarColumnarStore,
  rowIndex: number,
): { readonly startOffsetMs: number; readonly timeMs: number | null } {
  const nums = store.data.nums;
  const base = rowIndex * HAR_COL_STRIDE;
  if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) !== 0) {
    const epoch = nums[base + 11] as number;
    return {
      startOffsetMs: Number.isFinite(epoch) ? Math.max(0, epoch - store.minStartMs) : 0,
      timeMs: columnarTimeMs(nums, base),
    };
  }
  const fb = store.fallbacks.get(rowIndex);
  const epoch = fb?.startEpochMs ?? Number.NaN;
  return {
    startOffsetMs: Number.isFinite(epoch) ? Math.max(0, epoch - store.minStartMs) : 0,
    timeMs: fb?.summary.timeMs ?? null,
  };
}

function harColumnarSortValue(store: HarColumnarStore, rowIndex: number, column: string): unknown {
  const data = store.data;
  const nums = data.nums;
  const base = rowIndex * HAR_COL_STRIDE;
  if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) !== 0) {
    switch (column) {
      case "#":
        return rowIndex + 1;
      case "method":
        return data.methods[rowIndex] ?? undefined;
      case "status": {
        const s = nums[base] as number;
        return Number.isFinite(s) ? s : undefined;
      }
      case "url":
        return data.urls[rowIndex] ?? undefined;
      case "mimeType":
        return data.mimeTypes[rowIndex] ?? undefined;
      case "bodySize":
        return columnarBodySize(nums, base) ?? undefined;
      case "timeMs":
        return columnarTimeMs(nums, base) ?? undefined;
      default:
        return undefined;
    }
  }
  const fb = store.fallbacks.get(rowIndex)?.summary;
  if (!fb) return column === "#" ? rowIndex + 1 : undefined;
  return harSortValue(fb, column);
}

function harColumnarFilterText(store: HarColumnarStore, rowIndex: number, column: string): string {
  const data = store.data;
  const nums = data.nums;
  const base = rowIndex * HAR_COL_STRIDE;
  if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) !== 0) {
    switch (column) {
      case "#":
        return String(rowIndex + 1);
      case "method":
        return data.methods[rowIndex] ?? "";
      case "status": {
        const s = nums[base] as number;
        return Number.isFinite(s) ? String(s) : "";
      }
      case "url":
        return data.urls[rowIndex] ?? "";
      case "mimeType":
        return data.mimeTypes[rowIndex] ?? "";
      case "bodySize": {
        const b = columnarBodySize(nums, base);
        return b !== null ? String(b) : "";
      }
      case "timeMs": {
        const t = columnarTimeMs(nums, base);
        return t !== null ? String(t) : "";
      }
      default:
        return "";
    }
  }
  const fb = store.fallbacks.get(rowIndex)?.summary;
  if (!fb) return column === "#" ? String(rowIndex + 1) : "";
  return harFilterText(fb, column);
}

function materializeHarSummary(
  store: HarColumnarStore,
  documentId: number,
  rowIndex: number,
  refOverride?: NodeRef,
): HarRequestRowSummary {
  const data = store.data;
  const nums = data.nums;
  const base = rowIndex * HAR_COL_STRIDE;
  const ref: NodeRef = refOverride ?? {
    documentId,
    tapeId: store.placeholderTapeId,
    token: 0,
  };
  if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) !== 0) {
    const summary = columnarSlotToSummary(
      rowIndex,
      ref,
      nums,
      base,
      data.methods[rowIndex] ?? null,
      data.urls[rowIndex] ?? null,
      data.mimeTypes[rowIndex] ?? null,
      data.startedDateTimes[rowIndex] ?? null,
    );
    const epoch = nums[base + 11] as number;
    return {
      ...summary,
      startOffsetMs: Number.isFinite(epoch) ? Math.max(0, epoch - store.minStartMs) : 0,
    };
  }
  const fb = store.fallbacks.get(rowIndex);
  if (fb) {
    return {
      ...fb.summary,
      ref,
      startOffsetMs: Number.isFinite(fb.startEpochMs)
        ? Math.max(0, fb.startEpochMs - store.minStartMs)
        : 0,
    };
  }
  return {
    ...harRawToSummary(rowIndex, ref, {
      method: null,
      url: null,
      pageref: null,
      status: null,
      mimeType: null,
      contentSize: null,
      bodySize: null,
      startedDateTime: null,
      time: null,
      timings: null,
    }).summary,
    startOffsetMs: 0,
  };
}

function harSortValue(entry: Omit<HarRequestRowSummary, "startOffsetMs">, column: string): unknown {
  switch (column) {
    case "#":
      return entry.entryIndex + 1;
    case "method":
      return entry.method ?? undefined;
    case "status":
      return entry.status ?? undefined;
    case "url":
      return entry.url ?? undefined;
    case "mimeType":
      return entry.mimeType ?? undefined;
    case "bodySize":
      return entry.bodySize ?? undefined;
    case "timeMs":
      return entry.timeMs ?? undefined;
    default:
      return undefined;
  }
}

function harFilterText(entry: Omit<HarRequestRowSummary, "startOffsetMs">, column: string): string {
  switch (column) {
    case "#":
      return String(entry.entryIndex + 1);
    case "method":
      return entry.method ?? "";
    case "status":
      return entry.status !== null ? String(entry.status) : "";
    case "url":
      return entry.url ?? "";
    case "mimeType":
      return entry.mimeType ?? "";
    case "bodySize":
      return entry.bodySize !== null ? String(entry.bodySize) : "";
    case "timeMs":
      return entry.timeMs !== null ? String(entry.timeMs) : "";
    default:
      return "";
  }
}

interface ActiveQueryState {
  readonly documentId: number;
  readonly target: TableTarget;
  readonly elements: Array<NodeSummary | undefined>;
  readonly columns: ColumnMutable[];
  readonly columnMap: Map<string, ColumnMutable>;
  readonly rowOrder: Uint32Array;
  readonly harEntries: ReadonlyArray<HarRequestRowSummary> | null;
  readonly harStore: HarColumnarStore | null;
}

export interface TableQueryInput {
  readonly documentId: number;
  readonly targetPath: string | null;
  readonly revision?: number;
  readonly sort: TableSortSpec | null;
  readonly filters: ReadonlyArray<TableFilterSpec>;
  readonly timeWindow: HarTimeWindow | null;
  readonly filteredRowIndices: ReadonlyArray<number> | null;
}

interface CachedTargetIndex {
  readonly documentId: number;
  readonly target: TableTarget;
  readonly revision: number;
  readonly elements: Array<NodeSummary | undefined>;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly harEntries: ReadonlyArray<HarRequestRowSummary> | null;
  readonly harStore: HarColumnarStore | null;
  readonly harTimeline: HarTimelineSummary | null;
}

/**
 * Stateful table query host for worker/coordinator use: discovers targets,
 * infers columns (with on-demand late column discovery), runs view-only
 * sorting and filtering up to 1,000,000 rows, and serves virtualized pages.
 */
export class TableIndexHost {
  private nextQueryId = 1;
  private readonly queries = new Map<number, ActiveQueryState>();
  private readonly targetCache = new Map<string, CachedTargetIndex>();
  private readonly docEpoch = new Map<number, number>();
  private readonly targetsCache = new WeakMap<
    TableDocAccess,
    Map<number, { readonly epoch: number; readonly result: TableTargetsResult }>
  >();
  private readonly inFlightTargets = new WeakMap<
    TableDocAccess,
    Map<number, { readonly epoch: number; readonly promise: Promise<TableTargetsResult> }>
  >();

  async targets(access: TableDocAccess, documentId: number): Promise<TableTargetsResult> {
    const epoch = this.docEpoch.get(documentId) ?? 0;
    const cachedMap = this.targetsCache.get(access);
    const cached = cachedMap?.get(documentId);
    if (cached && cached.epoch === epoch) return cached.result;

    let inflightMap = this.inFlightTargets.get(access);
    const inflight = inflightMap?.get(documentId);
    if (inflight && inflight.epoch === epoch) return inflight.promise;

    if (!inflightMap) {
      inflightMap = new Map();
      this.inFlightTargets.set(access, inflightMap);
    }

    let promise: Promise<TableTargetsResult> | undefined;
    promise = (async () => {
      try {
        const result = await discoverTableTargets(access, documentId);
        if ((this.docEpoch.get(documentId) ?? 0) === epoch) {
          let map = this.targetsCache.get(access);
          if (!map) {
            map = new Map();
            this.targetsCache.set(access, map);
          }
          map.set(documentId, { epoch, result });
        }
        return result;
      } finally {
        const cur = inflightMap?.get(documentId);
        if (cur && cur.promise === promise) inflightMap.delete(documentId);
      }
    })();

    inflightMap.set(documentId, { epoch, promise });
    return promise;
  }

  closeQuery(queryId: number): null {
    this.queries.delete(queryId);
    return null;
  }

  closeDocument(documentId: number): void {
    this.docEpoch.set(documentId, (this.docEpoch.get(documentId) ?? 0) + 1);
    for (const [id, state] of this.queries) {
      if (state.documentId === documentId) this.queries.delete(id);
    }
    for (const [key, cached] of this.targetCache) {
      if (cached.documentId === documentId) this.targetCache.delete(key);
    }
  }

  invalidateDocument(documentId: number): void {
    this.docEpoch.set(documentId, (this.docEpoch.get(documentId) ?? 0) + 1);
    for (const [key, cached] of this.targetCache) {
      if (cached.documentId === documentId) this.targetCache.delete(key);
    }
  }

  async query(access: TableDocAccess, input: TableQueryInput): Promise<TableQueryResult> {
    const format = await access.format(input.documentId);
    const discovered = await this.targets(access, input.documentId);
    const chosenPath = input.targetPath ?? discovered.recommendedPath;
    const target =
      discovered.targets.find((t) => t.path === chosenPath) ?? discovered.targets[0] ?? null;

    if (target === null) {
      const root = await access.root(input.documentId);
      const emptyTarget: TableTarget = {
        ref: root.ref,
        path: "$",
        label: "No array found",
        kind: "root",
        rowCount: 0,
        isHarEntries: false,
      };
      const queryId = this.nextQueryId++;
      this.queries.set(queryId, {
        documentId: input.documentId,
        target: emptyTarget,
        elements: [],
        columns: [],
        columnMap: new Map(),
        rowOrder: new Uint32Array(0),
        harEntries: null,
        harStore: null,
      });
      return {
        target: emptyTarget,
        columns: [],
        totalRows: 0,
        matchedRows: 0,
        queryId,
        harTimeline: null,
      };
    }

    const cacheKey = `${input.documentId}:${target.path}`;
    const cached = input.revision !== undefined ? this.targetCache.get(cacheKey) : undefined;
    const hitCache =
      cached !== undefined &&
      cached.revision === input.revision &&
      cached.target.rowCount === target.rowCount;

    const cappedTargetRows = Math.min(target.rowCount, TABLE_MAX_ROWS);
    let fastHarCols: HarTableColumnarData | null = null;
    if (!hitCache && target.isHarEntries && cappedTargetRows > 0 && access.readHarEntriesFast) {
      fastHarCols = await access.readHarEntriesFast(input.documentId, target.ref, cappedTargetRows);
    }

    const elements: Array<NodeSummary | undefined> = hitCache
      ? cached.elements
      : fastHarCols !== null
        ? Array.from<NodeSummary | undefined>({ length: fastHarCols.count })
        : await readAllElements(access, target.ref, target.rowCount);
    const totalRows = elements.length;
    const columnMap = new Map<string, ColumnMutable>();
    const columns: ColumnMutable[] = [];

    const registerColumn = (key: string, kind: TableColumnKind, late: boolean, label = key) => {
      const existing = columnMap.get(key);
      if (existing) {
        existing.kind = mergeColumnKind(existing.kind, kind);
        return;
      }
      const col: ColumnMutable = { key, label, index: columns.length, kind, late };
      columnMap.set(key, col);
      columns.push(col);
    };

    let harEntries: HarRequestRowSummary[] | null = null;
    let harStore: HarColumnarStore | null = null;
    let harTimeline: HarTimelineSummary | null = null;

    if (hitCache) {
      for (const col of cached.columns) {
        registerColumn(col.key, col.kind, col.late, col.label);
      }
      harEntries = cached.harEntries ? [...cached.harEntries] : null;
      harStore = cached.harStore;
      harTimeline = cached.harTimeline;
    } else if (target.isHarEntries) {
      for (const col of HAR_PRESET_COLUMNS) {
        registerColumn(col.key, col.kind, col.late, col.label);
      }

      if (fastHarCols !== null) {
        const fallbackMap = new Map<number, HarFallbackEntry>();
        const invalidRows: number[] = [];
        const nums = fastHarCols.nums;
        for (let rowIndex = 0; rowIndex < totalRows; rowIndex++) {
          const base = rowIndex * HAR_COL_STRIDE;
          if (((nums[base + 12] as number) & HAR_COL_FLAG_VALID) === 0) {
            invalidRows.push(rowIndex);
          }
        }
        if (invalidRows.length > 0) {
          const placeholderRef: NodeRef = {
            documentId: input.documentId,
            tapeId: target.ref.tapeId,
            token: 0,
          };
          for (let k = 0; k < invalidRows.length; k += ROW_FETCH_CONCURRENCY) {
            const slice = invalidRows.slice(k, k + ROW_FETCH_CONCURRENCY);
            await Promise.all(
              slice.map(async (rowIndex) => {
                const page = await access.children(target.ref, rowIndex, 1);
                const node = page.nodes[0];
                if (node === undefined) {
                  fallbackMap.set(
                    rowIndex,
                    harRawToSummary(rowIndex, placeholderRef, {
                      method: null,
                      url: null,
                      pageref: null,
                      status: null,
                      mimeType: null,
                      contentSize: null,
                      bodySize: null,
                      startedDateTime: null,
                      time: null,
                      timings: null,
                    }),
                  );
                  return;
                }
                elements[rowIndex] = node;
                fallbackMap.set(rowIndex, await readHarSummaryFromAccess(access, rowIndex, node));
              }),
            );
          }
        }
        const computed = buildHarTimelineFromColumnar(fastHarCols, fallbackMap);
        harTimeline = computed.timeline;
        harStore = {
          count: totalRows,
          data: fastHarCols,
          minStartMs: computed.minStartMs,
          placeholderTapeId: target.ref.tapeId,
          fallbacks: fallbackMap,
        };
      } else {
        const rawSummaries = Array.from<Omit<HarRequestRowSummary, "startOffsetMs">>({
          length: totalRows,
        });
        const startEpochs = new Float64Array(totalRows);
        startEpochs.fill(Number.NaN);

        await visitElements(
          access,
          input.documentId,
          target.ref,
          elements,
          format,
          (rowIndex, node, parsed) => {
            const obj =
              typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
            const extracted = extractHarSummaryFromObject(rowIndex, node.ref, obj);
            rawSummaries[rowIndex] = extracted.summary;
            startEpochs[rowIndex] = extracted.startEpochMs;
          },
          async (rowIndex, node) => {
            const extracted = await readHarSummaryFromAccess(access, rowIndex, node);
            rawSummaries[rowIndex] = extracted.summary;
            startEpochs[rowIndex] = extracted.startEpochMs;
          },
        );

        let minStartMs = Number.POSITIVE_INFINITY;
        let maxEndMs = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < totalRows; i++) {
          const s = startEpochs[i] as number;
          if (!Number.isFinite(s)) continue;
          if (s < minStartMs) minStartMs = s;
          const dur = rawSummaries[i]?.timeMs ?? 0;
          const end = s + (dur > 0 ? dur : 0);
          if (end > maxEndMs) maxEndMs = end;
        }
        if (!Number.isFinite(minStartMs)) {
          minStartMs = 0;
          maxEndMs = 0;
        } else if (!Number.isFinite(maxEndMs) || maxEndMs < minStartMs) {
          maxEndMs = minStartMs;
        }

        harEntries = Array.from<HarRequestRowSummary>({ length: totalRows });
        for (let i = 0; i < totalRows; i++) {
          const s = startEpochs[i] as number;
          const base = rawSummaries[i] as Omit<HarRequestRowSummary, "startOffsetMs">;
          harEntries[i] = {
            ...base,
            startOffsetMs: Number.isFinite(s) ? Math.max(0, s - minStartMs) : 0,
          };
        }
        harTimeline = buildHarTimeline(harEntries, minStartMs, maxEndMs);
      }
    } else {
      // Discover initial columns from the first TABLE_COLUMN_SAMPLE_ROWS (1024) rows.
      const sampleCount = Math.min(totalRows, TABLE_COLUMN_SAMPLE_ROWS);
      const sampleElements = elements.slice(0, sampleCount);
      const sampleObjects = Array.from<unknown>({ length: sampleCount });
      let sawNonObject = false;

      await visitElements(
        access,
        input.documentId,
        target.ref,
        sampleElements,
        format,
        (rowIndex, _node, parsed) => {
          sampleObjects[rowIndex] = parsed;
        },
        async (rowIndex, node) => {
          if (node.kind === "object") {
            const page = await access.rows(node.ref, 0, CHILDREN_PAGE_LIMIT, 1);
            const obj: Record<string, unknown> = {};
            for (const r of page.rows) {
              if (r.key !== null) obj[r.key] = kindPlaceholder(r.node.kind);
            }
            sampleObjects[rowIndex] = obj;
          } else if (node.kind === "array") {
            sampleObjects[rowIndex] = Array.from(
              { length: Math.min(node.childCount, CHILDREN_PAGE_LIMIT) },
              () => null,
            );
          } else {
            sawNonObject = true;
            sampleObjects[rowIndex] = kindPlaceholder(node.kind);
          }
        },
      );

      for (let i = 0; i < sampleCount; i++) {
        const item = sampleObjects[i];
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
            registerColumn(key, jsValueKind(val), false);
          }
        } else if (Array.isArray(item)) {
          for (let col = 0; col < item.length; col++) {
            registerColumn(String(col), jsValueKind(item[col]), false);
          }
        } else if (elements[i] !== undefined) {
          sawNonObject = true;
          registerColumn(
            "value",
            columnKindOfNode((elements[i] as NodeSummary).kind),
            false,
            "Value",
          );
        }
      }
      if (sawNonObject && columnMap.has("value") === false && totalRows > 0) {
        registerColumn("value", "mixed", false, "Value");
      }
    }

    let mask: Uint8Array | null = null;
    if (input.filteredRowIndices !== null) {
      mask = new Uint8Array(totalRows);
      for (const idx of input.filteredRowIndices) {
        if (idx >= 0 && idx < totalRows) mask[idx] = 1;
      }
    }

    if ((harStore !== null || harEntries !== null) && input.timeWindow !== null) {
      const { startMs, endMs } = input.timeWindow;
      const nextMask = mask ?? new Uint8Array(totalRows).fill(1);
      if (harStore !== null) {
        for (let i = 0; i < totalRows; i++) {
          if (nextMask[i] === 0) continue;
          const span = harColumnarTimeSpan(harStore, i);
          const entryEnd =
            span.startOffsetMs + (span.timeMs !== null && span.timeMs > 0 ? span.timeMs : 0);
          if (entryEnd < startMs || span.startOffsetMs > endMs) {
            nextMask[i] = 0;
          }
        }
      } else if (harEntries !== null) {
        for (let i = 0; i < totalRows; i++) {
          if (nextMask[i] === 0) continue;
          const entry = harEntries[i] as HarRequestRowSummary;
          const entryStart = entry.startOffsetMs;
          const entryEnd =
            entryStart + (entry.timeMs !== null && entry.timeMs > 0 ? entry.timeMs : 0);
          if (entryEnd < startMs || entryStart > endMs) {
            nextMask[i] = 0;
          }
        }
      }
      mask = nextMask;
    }

    const activeFilters = input.filters
      .map((f) => ({ column: f.column, needle: f.query.trim().toLowerCase() }))
      .filter((f) => f.needle.length > 0);
    const sortSpec = input.sort;

    const neededColumns = new Set<string>();
    for (const f of activeFilters) neededColumns.add(f.column);
    if (sortSpec !== null) neededColumns.add(sortSpec.column);

    let sortVector: SortVector | null = null;
    if (sortSpec !== null && totalRows > 0) {
      sortVector = {
        ranks: new Uint8Array(totalRows).fill(RANK_MISSING),
        nums: new Float64Array(totalRows),
        strs: Array.from<string>({ length: totalRows }),
      };
    }

    if (neededColumns.size > 0 && totalRows > 0) {
      if (harStore !== null) {
        const nextMask = mask ?? new Uint8Array(totalRows).fill(1);
        for (let i = 0; i < totalRows; i++) {
          if (nextMask[i] === 0) continue;
          for (const f of activeFilters) {
            if (!harColumnarFilterText(harStore, i, f.column).toLowerCase().includes(f.needle)) {
              nextMask[i] = 0;
              break;
            }
          }
          if (nextMask[i] === 1 && sortVector !== null && sortSpec !== null) {
            sortVectorFromValue(
              sortVector.ranks,
              sortVector.nums,
              sortVector.strs,
              i,
              harColumnarSortValue(harStore, i, sortSpec.column),
            );
          }
        }
        mask = nextMask;
      } else if (harEntries !== null) {
        const nextMask = mask ?? new Uint8Array(totalRows).fill(1);
        for (let i = 0; i < totalRows; i++) {
          if (nextMask[i] === 0) continue;
          const entry = harEntries[i] as HarRequestRowSummary;
          for (const f of activeFilters) {
            if (!harFilterText(entry, f.column).toLowerCase().includes(f.needle)) {
              nextMask[i] = 0;
              break;
            }
          }
          if (nextMask[i] === 1 && sortVector !== null && sortSpec !== null) {
            sortVectorFromValue(
              sortVector.ranks,
              sortVector.nums,
              sortVector.strs,
              i,
              harSortValue(entry, sortSpec.column),
            );
          }
        }
        mask = nextMask;
      } else {
        const nextMask =
          activeFilters.length > 0 ? (mask ?? new Uint8Array(totalRows).fill(1)) : mask;
        const filterCols = new Set(activeFilters.map((f) => f.column));

        const processObjectRow = (rowIndex: number, _node: NodeSummary, parsed: unknown) => {
          if (nextMask !== null && nextMask[rowIndex] === 0) return;
          const isObj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
          const isArr = Array.isArray(parsed);

          const readColVal = (col: string): unknown => {
            if (isObj) return (parsed as Record<string, unknown>)[col];
            if (isArr) {
              const idx = Number(col);
              return Number.isInteger(idx) && idx >= 0 && idx < parsed.length
                ? parsed[idx]
                : undefined;
            }
            return col === "value" ? parsed : undefined;
          };

          if (nextMask !== null && activeFilters.length > 0) {
            for (const f of activeFilters) {
              const val = readColVal(f.column);
              const text = val === undefined ? "" : formatScalarForCell(val).text.toLowerCase();
              if (!text.includes(f.needle)) {
                nextMask[rowIndex] = 0;
                return;
              }
            }
          }

          if (sortVector !== null && sortSpec !== null) {
            sortVectorFromValue(
              sortVector.ranks,
              sortVector.nums,
              sortVector.strs,
              rowIndex,
              readColVal(sortSpec.column),
            );
          }

          if (rowIndex >= TABLE_COLUMN_SAMPLE_ROWS && isObj) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (!columnMap.has(k)) registerColumn(k, jsValueKind(v), true);
            }
          }
        };

        await visitElements(
          access,
          input.documentId,
          target.ref,
          elements,
          format,
          processObjectRow,
          async (rowIndex, node) => {
            if (nextMask !== null && nextMask[rowIndex] === 0) return;
            if (node.kind === "object") {
              const page = await access.rows(
                node.ref,
                0,
                CHILDREN_PAGE_LIMIT,
                TABLE_CELL_PREVIEW_BYTES,
              );
              const byKey = new Map<string, RowSummary>();
              for (const r of page.rows) {
                if (r.key === null) continue;
                byKey.set(r.key, r);
                if (rowIndex >= TABLE_COLUMN_SAMPLE_ROWS && !columnMap.has(r.key)) {
                  registerColumn(r.key, columnKindOfNode(r.node.kind), true);
                }
              }
              if (nextMask !== null && activeFilters.length > 0) {
                for (const f of activeFilters) {
                  const r = byKey.get(f.column);
                  const text = r ? rowSummaryText(r).toLowerCase() : "";
                  if (!text.includes(f.needle)) {
                    nextMask[rowIndex] = 0;
                    return;
                  }
                }
              }
              if (sortVector !== null && sortSpec !== null) {
                sortVectorFromRowSummary(
                  sortVector.ranks,
                  sortVector.nums,
                  sortVector.strs,
                  rowIndex,
                  byKey.get(sortSpec.column),
                );
              }
            } else if (node.kind === "array") {
              const page = await access.rows(
                node.ref,
                0,
                CHILDREN_PAGE_LIMIT,
                TABLE_CELL_PREVIEW_BYTES,
              );
              if (nextMask !== null && activeFilters.length > 0) {
                for (const f of activeFilters) {
                  const idx = Number(f.column);
                  const r = Number.isInteger(idx) && idx >= 0 ? page.rows[idx] : undefined;
                  const text = r ? rowSummaryText(r).toLowerCase() : "";
                  if (!text.includes(f.needle)) {
                    nextMask[rowIndex] = 0;
                    return;
                  }
                }
              }
              if (sortVector !== null && sortSpec !== null) {
                const idx = Number(sortSpec.column);
                sortVectorFromRowSummary(
                  sortVector.ranks,
                  sortVector.nums,
                  sortVector.strs,
                  rowIndex,
                  Number.isInteger(idx) && idx >= 0 ? page.rows[idx] : undefined,
                );
              }
            } else {
              const textVal = await access.text(node.ref, TABLE_CELL_PREVIEW_BYTES);
              if (nextMask !== null && filterCols.has("value")) {
                const f = activeFilters.find((item) => item.column === "value");
                if (f && !textVal.text.toLowerCase().includes(f.needle)) {
                  nextMask[rowIndex] = 0;
                  return;
                }
              }
              if (sortVector !== null && sortSpec !== null && sortSpec.column === "value") {
                sortVectorFromValue(
                  sortVector.ranks,
                  sortVector.nums,
                  sortVector.strs,
                  rowIndex,
                  scalarTextToValue(node.kind, textVal.text),
                );
              }
            }
          },
        );
        mask = nextMask;
      }
    }

    let matchedCount = 0;
    if (mask === null) {
      matchedCount = totalRows;
    } else {
      for (let i = 0; i < totalRows; i++) {
        if (mask[i] === 1) matchedCount++;
      }
    }

    let rowOrder: Uint32Array = new Uint32Array(matchedCount);
    if (mask === null) {
      for (let i = 0; i < totalRows; i++) rowOrder[i] = i;
    } else {
      let at = 0;
      for (let i = 0; i < totalRows; i++) {
        if (mask[i] === 1) rowOrder[at++] = i;
      }
    }

    if (sortVector !== null && sortSpec !== null && matchedCount > 1) {
      rowOrder = sortPermutation(rowOrder, sortVector, sortSpec.direction);
    }

    const queryId = this.nextQueryId++;
    this.queries.set(queryId, {
      documentId: input.documentId,
      target,
      elements,
      columns,
      columnMap,
      rowOrder,
      harEntries,
      harStore,
    });

    if (!hitCache && input.revision !== undefined) {
      this.targetCache.set(cacheKey, {
        documentId: input.documentId,
        target,
        revision: input.revision,
        elements,
        columns: columns.map(snapshotColumn),
        harEntries,
        harStore,
        harTimeline,
      });
    }

    return {
      target,
      columns: columns.map(snapshotColumn),
      totalRows,
      matchedRows: matchedCount,
      queryId,
      harTimeline,
    };
  }

  async rows(
    access: TableDocAccess,
    queryId: number,
    from: number,
    count: number,
  ): Promise<TableRowsPage> {
    const state = this.queries.get(queryId);
    if (!state) {
      return { queryId, from, total: 0, columns: [], rows: [] };
    }
    const total = state.rowOrder.length;
    const boundedCount = Math.min(Math.max(1, count), CHILDREN_PAGE_LIMIT);
    const end = Math.min(total, from + boundedCount);
    const indices: number[] = [];
    for (let i = from; i < end; i++) indices.push(state.rowOrder[i] as number);

    let batchResolved: ReadonlyArray<ResolvedHarRowBatchItem | null> | null = null;
    if ((state.harStore !== null || state.harEntries !== null) && access.resolveHarRowsBatch) {
      batchResolved = await access.resolveHarRowsBatch(state.target.ref, indices);
    }

    const fallbackIndices: number[] = [];
    for (let k = 0; k < indices.length; k++) {
      const rowIndex = indices[k] as number;
      const hit = batchResolved?.[k];
      if (hit) {
        state.elements[rowIndex] = hit.node;
      } else if (state.elements[rowIndex] === undefined) {
        fallbackIndices.push(rowIndex);
      }
    }
    if (fallbackIndices.length > 0) {
      await ensureElementsLoaded(access, state.target.ref, state.elements, fallbackIndices);
    }

    const rows: TableRow[] = Array.from({ length: indices.length });
    for (let batchAt = 0; batchAt < indices.length; batchAt += ROW_FETCH_CONCURRENCY) {
      const slice = indices.slice(batchAt, batchAt + ROW_FETCH_CONCURRENCY);
      const built = await Promise.all(
        slice.map((rowIndex, offset) =>
          buildTableRow(
            access,
            state,
            rowIndex,
            from + batchAt + offset,
            batchResolved?.[batchAt + offset]?.refs,
          ),
        ),
      );
      for (let k = 0; k < built.length; k++) {
        rows[batchAt + k] = built[k] as TableRow;
      }
    }

    return {
      queryId,
      from,
      total,
      columns: state.columns.map(snapshotColumn),
      rows,
    };
  }
}

async function resolveHarEntryCellRefs(
  access: TableDocAccess,
  entryRef: NodeRef,
): Promise<{
  readonly methodRef: NodeRef | null;
  readonly urlRef: NodeRef | null;
  readonly statusRef: NodeRef | null;
  readonly mimeTypeRef: NodeRef | null;
  readonly bodySizeRef: NodeRef | null;
  readonly timeMsRef: NodeRef | null;
}> {
  const empty = {
    methodRef: null,
    urlRef: null,
    statusRef: null,
    mimeTypeRef: null,
    bodySizeRef: null,
    timeMsRef: null,
  };
  const top = await access.rows(entryRef, 0, CHILDREN_PAGE_LIMIT, 1);
  const reqRow = top.rows.find((r) => r.key === "request" && r.node.kind === "object");
  const respRow = top.rows.find((r) => r.key === "response" && r.node.kind === "object");
  const timeRow = top.rows.find((r) => r.key === "time");

  const [reqSub, respSub] = await Promise.all([
    reqRow ? access.rows(reqRow.node.ref, 0, CHILDREN_PAGE_LIMIT, 1) : Promise.resolve(null),
    respRow ? access.rows(respRow.node.ref, 0, CHILDREN_PAGE_LIMIT, 1) : Promise.resolve(null),
  ]);

  const methodRow = reqSub?.rows.find((r) => r.key === "method");
  const urlRow = reqSub?.rows.find((r) => r.key === "url");
  const statusRow = respSub?.rows.find((r) => r.key === "status");
  const contentRow = respSub?.rows.find((r) => r.key === "content" && r.node.kind === "object");
  const respBodySizeRow = respSub?.rows.find((r) => r.key === "bodySize");

  let mimeTypeRef: NodeRef | null = null;
  let contentSizeRef: NodeRef | null = null;
  if (contentRow) {
    const contentSub = await access.rows(contentRow.node.ref, 0, CHILDREN_PAGE_LIMIT, 1);
    const mimeRow = contentSub.rows.find((r) => r.key === "mimeType");
    const sizeRow = contentSub.rows.find((r) => r.key === "size");
    if (mimeRow && isScalarKind(mimeRow.node.kind)) mimeTypeRef = mimeRow.node.ref;
    if (sizeRow && isScalarKind(sizeRow.node.kind)) contentSizeRef = sizeRow.node.ref;
  }

  return {
    methodRef:
      methodRow && isScalarKind(methodRow.node.kind) ? methodRow.node.ref : empty.methodRef,
    urlRef: urlRow && isScalarKind(urlRow.node.kind) ? urlRow.node.ref : empty.urlRef,
    statusRef:
      statusRow && isScalarKind(statusRow.node.kind) ? statusRow.node.ref : empty.statusRef,
    mimeTypeRef,
    bodySizeRef:
      contentSizeRef ??
      (respBodySizeRow && isScalarKind(respBodySizeRow.node.kind)
        ? respBodySizeRow.node.ref
        : null),
    timeMsRef: timeRow && isScalarKind(timeRow.node.kind) ? timeRow.node.ref : empty.timeMsRef,
  };
}

async function ensureElementsLoaded(
  access: TableDocAccess,
  targetRef: NodeRef,
  elements: Array<NodeSummary | undefined>,
  indices: ReadonlyArray<number>,
): Promise<void> {
  const missing: number[] = [];
  for (const rowIndex of indices) {
    if (elements[rowIndex] === undefined) missing.push(rowIndex);
  }
  if (missing.length === 0) return;

  // Contiguous run on initial/unsorted view: fetch in minimal `CHILDREN_PAGE_LIMIT` calls.
  let min = missing[0] as number;
  let max = min;
  for (let i = 1; i < missing.length; i++) {
    const v = missing[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < CHILDREN_PAGE_LIMIT && max - min + 1 <= missing.length * 2) {
    const page = await access.children(targetRef, min, max - min + 1);
    for (let k = 0; k < page.nodes.length; k++) {
      elements[min + k] = page.nodes[k];
    }
    return;
  }

  for (let i = 0; i < missing.length; i += ROW_FETCH_CONCURRENCY) {
    const batch = missing.slice(i, i + ROW_FETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (rowIndex) => {
        const page = await access.children(targetRef, rowIndex, 1);
        if (page.nodes[0] !== undefined) elements[rowIndex] = page.nodes[0];
      }),
    );
  }
}

async function buildTableRow(
  access: TableDocAccess,
  state: ActiveQueryState,
  rowIndex: number,
  displayIndex: number,
  prefetchedRefs?: HarEntryCellRefs,
): Promise<TableRow> {
  const node = state.elements[rowIndex] as NodeSummary;
  const cells: Record<string, TableCellValue> = {};

  if (state.harStore !== null || state.harEntries !== null) {
    let har: HarRequestRowSummary;
    if (state.harStore !== null) {
      har = materializeHarSummary(state.harStore, state.documentId, rowIndex, node.ref);
    } else {
      const baseHar = (state.harEntries as ReadonlyArray<HarRequestRowSummary>)[
        rowIndex
      ] as HarRequestRowSummary;
      har =
        baseHar.ref.token === node.ref.token && baseHar.ref.tapeId === node.ref.tapeId
          ? baseHar
          : { ...baseHar, ref: node.ref };
    }
    const refs =
      prefetchedRefs ??
      (node.kind === "object"
        ? await resolveHarEntryCellRefs(access, node.ref)
        : {
            methodRef: null,
            urlRef: null,
            statusRef: null,
            mimeTypeRef: null,
            bodySizeRef: null,
            timeMsRef: null,
          });

    cells["#"] = {
      ref: null,
      kind: "number",
      text: String(har.entryIndex + 1),
      truncated: false,
      editable: false,
      numericValue: har.entryIndex + 1,
    };
    cells.method = {
      ref: refs.methodRef,
      kind: har.method !== null ? "string" : "null",
      text: har.method ?? "",
      truncated: false,
      editable: refs.methodRef !== null,
      numericValue: null,
    };
    cells.status = {
      ref: refs.statusRef,
      kind: har.status !== null ? "number" : "null",
      text: har.status !== null ? String(har.status) : "",
      truncated: false,
      editable: refs.statusRef !== null,
      numericValue: har.status,
    };
    cells.url = {
      ref: refs.urlRef,
      kind: har.url !== null ? "string" : "null",
      text: har.url ?? "",
      truncated: false,
      editable: refs.urlRef !== null,
      numericValue: null,
    };
    cells.mimeType = {
      ref: refs.mimeTypeRef,
      kind: har.mimeType !== null ? "string" : "null",
      text: har.mimeType ?? "",
      truncated: false,
      editable: refs.mimeTypeRef !== null,
      numericValue: null,
    };
    cells.bodySize = {
      ref: refs.bodySizeRef,
      kind: har.bodySize !== null ? "number" : "null",
      text: har.bodySize !== null ? String(har.bodySize) : "",
      truncated: false,
      editable: refs.bodySizeRef !== null,
      numericValue: har.bodySize,
    };
    cells.timeMs = {
      ref: refs.timeMsRef,
      kind: har.timeMs !== null ? "number" : "null",
      text: har.timeMs !== null ? String(har.timeMs) : "",
      truncated: false,
      editable: refs.timeMsRef !== null,
      numericValue: har.timeMs,
    };

    return {
      rowIndex,
      displayIndex,
      ref: node.ref,
      span: node.span,
      cells,
      har,
    };
  }

  if (node.kind === "object") {
    const page = await access.rows(node.ref, 0, CHILDREN_PAGE_LIMIT, TABLE_CELL_PREVIEW_BYTES);
    for (const member of page.rows) {
      if (member.key === null) continue;
      if (!state.columnMap.has(member.key)) {
        const col: ColumnMutable = {
          key: member.key,
          label: member.key,
          index: state.columns.length,
          kind: columnKindOfNode(member.node.kind),
          late: rowIndex >= TABLE_COLUMN_SAMPLE_ROWS,
        };
        state.columnMap.set(member.key, col);
        state.columns.push(col);
      } else {
        const existing = state.columnMap.get(member.key) as ColumnMutable;
        existing.kind = mergeColumnKind(existing.kind, columnKindOfNode(member.node.kind));
      }
      cells[member.key] = cellFromRowSummary(member);
    }
  } else if (node.kind === "array") {
    const page = await access.rows(node.ref, 0, CHILDREN_PAGE_LIMIT, TABLE_CELL_PREVIEW_BYTES);
    for (let i = 0; i < page.rows.length; i++) {
      const key = String(i);
      const member = page.rows[i] as RowSummary;
      if (!state.columnMap.has(key)) {
        const col: ColumnMutable = {
          key,
          label: key,
          index: state.columns.length,
          kind: columnKindOfNode(member.node.kind),
          late: rowIndex >= TABLE_COLUMN_SAMPLE_ROWS,
        };
        state.columnMap.set(key, col);
        state.columns.push(col);
      }
      cells[key] = cellFromRowSummary(member);
    }
  } else {
    const tv = await access.text(node.ref, TABLE_CELL_PREVIEW_BYTES);
    cells.value = cellFromNode(node, tv);
  }

  return {
    rowIndex,
    displayIndex,
    ref: node.ref,
    span: node.span,
    cells,
    har: null,
  };
}

function cellFromRowSummary(row: RowSummary): TableCellValue {
  if (row.node.kind === "object") {
    return {
      ref: row.node.ref,
      kind: "object",
      text: `{${row.node.childCount}}`,
      truncated: false,
      editable: false,
      numericValue: null,
    };
  }
  if (row.node.kind === "array") {
    return {
      ref: row.node.ref,
      kind: "array",
      text: `[${row.node.childCount}]`,
      truncated: false,
      editable: false,
      numericValue: null,
    };
  }
  const text = row.preview?.text ?? (row.node.kind === "null" ? "null" : row.node.kind);
  return {
    ref: row.node.ref,
    kind: row.node.kind,
    text,
    truncated: row.preview?.truncated ?? false,
    editable: isScalarKind(row.node.kind),
    numericValue:
      row.node.kind === "number"
        ? finiteNumberOrNull(Number(text))
        : row.node.kind === "string"
          ? parseNumericString(text)
          : row.node.kind === "true"
            ? 1
            : row.node.kind === "false"
              ? 0
              : null,
  };
}

function cellFromNode(node: NodeSummary, tv: TextValue): TableCellValue {
  return {
    ref: node.ref,
    kind: node.kind,
    text: tv.text,
    truncated: tv.truncated,
    editable: isScalarKind(node.kind),
    numericValue:
      node.kind === "number"
        ? finiteNumberOrNull(Number(tv.text))
        : node.kind === "string"
          ? parseNumericString(tv.text)
          : node.kind === "true"
            ? 1
            : node.kind === "false"
              ? 0
              : null,
  };
}

const rowSummaryText = (row: RowSummary): string => {
  if (row.node.kind === "object") return `{${row.node.childCount}}`;
  if (row.node.kind === "array") return `[${row.node.childCount}]`;
  return row.preview?.text ?? row.node.kind;
};

const scalarTextToValue = (kind: NodeKind, text: string): unknown => {
  switch (kind) {
    case "null":
      return null;
    case "true":
      return true;
    case "false":
      return false;
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    case "string":
      return text;
    default:
      return undefined;
  }
};

const kindPlaceholder = (kind: NodeKind): unknown => {
  switch (kind) {
    case "null":
      return null;
    case "true":
      return true;
    case "false":
      return false;
    case "number":
      return 0;
    case "string":
      return "";
    case "array":
      return [];
    case "object":
      return {};
  }
};

const snapshotColumn = (col: ColumnMutable): TableColumn => ({
  key: col.key,
  label: col.label,
  index: col.index,
  kind: col.kind,
  late: col.late,
});

/** Creates a TableDocAccess adapter around an EngineHost-like handle interface. */
export function createTableDocAccessFromHandle(
  handle: (
    request:
      | { readonly _tag: "root"; readonly documentId: number }
      | { readonly _tag: "node"; readonly ref: NodeRef }
      | {
          readonly _tag: "children";
          readonly ref: NodeRef;
          readonly from: number;
          readonly count: number;
        }
      | {
          readonly _tag: "rows";
          readonly ref: NodeRef;
          readonly from: number;
          readonly count: number;
          readonly previewBytes: number;
        }
      | { readonly _tag: "keyText"; readonly ref: NodeRef }
      | { readonly _tag: "text"; readonly ref: NodeRef; readonly limit: number }
      | {
          readonly _tag: "logicalSlice";
          readonly documentId: number;
          readonly tapeId: number;
          readonly range: ByteRange;
        },
  ) => Promise<unknown>,
  formatOf: (documentId: number) => Promise<DocumentFormat> | DocumentFormat,
): TableDocAccess {
  return {
    format: formatOf,
    root: (documentId) => handle({ _tag: "root", documentId }) as Promise<NodeSummary>,
    node: (ref) => handle({ _tag: "node", ref }) as Promise<NodeSummary>,
    children: (ref, from, count) =>
      handle({ _tag: "children", ref, from, count }) as Promise<ChildrenPage>,
    rows: (ref, from, count, previewBytes) =>
      handle({ _tag: "rows", ref, from, count, previewBytes }) as Promise<RowsPage>,
    keyText: (ref) => handle({ _tag: "keyText", ref }) as Promise<string>,
    text: (ref, limit) => handle({ _tag: "text", ref, limit }) as Promise<TextValue>,
    logicalSlice: (documentId, tapeId, range) =>
      handle({ _tag: "logicalSlice", documentId, tapeId, range }) as Promise<Uint8Array>,
  };
}
