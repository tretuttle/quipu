/**
 * Tape regions for the line-oriented formats: NDJSON (an array of line
 * documents) and CSV/TSV (an array of row objects keyed by the header). Both
 * produce the engine's tape shape: tokens in document order, children right
 * after their parent, `next` chaining siblings, `childCount` always set, byte
 * offsets into the original file, and a root array token that every row or line
 * hangs from. Neither format needs a summarize pass in the JSON sense: a line is
 * a document of its own, and a CSV row starts after a line break outside quotes,
 * which quote parity (a prefix sum) decides.
 *
 * Ownership is by start: a region owns the lines or rows that begin in it, and
 * reads past its end to finish the last one.
 */
import { structure, FULL_DEPTH } from "@quipu/core/scan";
import { INITIAL_ENTRY } from "@quipu/core/resolve";
import {
  KIND_ARRAY,
  KIND_OBJECT,
  KIND_STRING,
  NO_KEY,
  TapeBuilder,
  type TapeBuffers,
} from "@quipu/core/tape";

import { CR, LF, QUOTE } from "./csvField.ts";

/** Children of the root are indexed on demand in buckets of this many (the engine's page limit). */
export const LINE_BUCKET = 1024;

/** What depth of the tape a region builds. `-1` is the root only. */
export type LineDepth = number;

export interface LineRegion {
  readonly buffers: TapeBuffers;
  /** Lines or rows owned by the region (counted even when not on the tape). */
  readonly rows: number;
  /** Local index of the first and last root child on the tape, or -1. */
  readonly firstTop: number;
  readonly lastTop: number;
  /** [ordinal within region, absolute offset] pairs: every LINE_BUCKET-th row, when rows are not on the tape. */
  readonly anchors: number[];
  /** Where the last owned row or line ends, as a consistency check for the next region (merging does not use it). */
  readonly tokens: number;
  /** The region needs more bytes after its window to finish its last row. */
  readonly needMore: boolean;
}

const isBlank = (b: Uint8Array, s: number, e: number) => {
  for (let i = s; i < e; i++) {
    const c = b[i] as number;
    if (c !== 0x20 && c !== 0x09 && c !== CR) return false;
  }
  return true;
};

const link = (builder: TapeBuilder, state: { last: number; first: number }, idx: number) => {
  if (state.last >= 0) builder.setNext(state.last, idx);
  else state.first = idx;
  state.last = idx;
};

/**
 * `window` holds the file from `base` (which is `regionStart - 1` when the
 * region is not first, so the previous byte decides whether the region starts on
 * a line) through the region end plus an overhang.
 */
export const structureNdjson = (
  window: Uint8Array,
  base: number,
  regionStart: number,
  regionEnd: number,
  fileSize: number,
  depth: LineDepth,
  builder: TapeBuilder,
): LineRegion => {
  builder.reset();
  const n = window.length;
  const eof = base + n >= fileSize;
  let p = regionStart - base;
  if (regionStart > 0 && window[p - 1] !== LF) {
    // Mid-line: the line began in the previous region.
    const nl = window.indexOf(LF, p);
    p = nl < 0 ? n : nl + 1;
  }
  const limit = regionEnd - base;
  // Owned lines: [lineStart, lineEnd) with lineStart < limit.
  const lines: number[] = [];
  let rows = 0;
  while (p < limit && p < n) {
    let nl = window.indexOf(LF, p);
    if (nl < 0) {
      if (!eof) {
        return empty(true);
      }
      nl = n;
    }
    let e = nl;
    if (e > p && window[e - 1] === CR) e--;
    if (!isBlank(window, p, e)) lines.push(p, e);
    p = nl + 1;
  }
  const anchors: number[] = [];
  const state = { last: -1, first: -1 };
  rows = lines.length / 2;
  if (depth < 0) {
    for (let r = 0; r < rows; r += LINE_BUCKET) anchors.push(r, base + (lines[r * 2] as number));
    return finish(builder, state, rows, anchors);
  }
  if (rows > 0) {
    const from = lines[0] as number;
    const to = lines[lines.length - 1] as number;
    const bytes = window.subarray(from, to);
    // Fast path: every owned line balanced, so one structural pass covers the region.
    const report = structure(bytes, base + from, INITIAL_ENTRY, depth, builder);
    let ok = report.exitDepth === 0 && report.inheritedLevels === 0;
    if (ok) {
      // Blank lines and CRLFs sit between lines; a line that closed more than it opened would have gone negative.
      ok = builder.count >= rows;
    }
    if (!ok) {
      builder.reset();
      for (let k = 0; k < lines.length; k += 2) {
        const s = lines[k] as number;
        const e = lines[k + 1] as number;
        const before = builder.count;
        structure(window.subarray(s, e), base + s, INITIAL_ENTRY, depth, builder);
        // An unterminated container ends at the end of its line.
        for (let t = before; t < builder.count; t++) {
          if (builder.ends[t] === 0) builder.ends[t] = base + e;
        }
      }
    }
    for (let t = 0; t < builder.count; t++) {
      if (builder.parents[t] === -1) link(builder, state, t);
    }
  }
  return finish(builder, state, rows, anchors);

  function empty(needMore: boolean): LineRegion {
    builder.reset();
    return {
      buffers: builder.detach(),
      rows: 0,
      firstTop: -1,
      lastTop: -1,
      anchors: [],
      tokens: 0,
      needMore,
    };
  }
};

const finish = (
  builder: TapeBuilder,
  state: { last: number; first: number },
  rows: number,
  anchors: number[],
): LineRegion => ({
  buffers: builder.detach(),
  rows,
  firstTop: state.first,
  lastTop: state.last,
  anchors,
  tokens: builder.count,
  needMore: false,
});

export interface CsvHeader {
  readonly delimiter: number;
  /** Absolute offset where the first data row starts (after the BOM and the header row). */
  readonly dataStart: number;
  /** Absolute offset of each header field's first byte. */
  readonly fieldStarts: ReadonlyArray<number>;
}

export interface CsvEntry {
  /** The region starts inside a quoted field. */
  readonly inQuote: boolean;
  /** The byte before the region is a line break outside quotes (or the region is first). */
  readonly atRowStart: boolean;
}

export const CSV_INITIAL_ENTRY: CsvEntry = { inQuote: false, atRowStart: true };

/** Pass 1 for CSV: the parity of quotes in a region and its last byte. */
export const summarizeCsv = (bytes: Uint8Array) => {
  let quotes = 0;
  let at = bytes.indexOf(QUOTE);
  while (at >= 0) {
    quotes++;
    at = bytes.indexOf(QUOTE, at + 1);
  }
  return {
    quoteParity: quotes & 1,
    lastByte: bytes.length > 0 ? (bytes[bytes.length - 1] as number) : 0,
  };
};

export const advanceCsvEntry = (
  entry: CsvEntry,
  summary: { quoteParity: number; lastByte: number },
): CsvEntry => {
  const inQuote = entry.inQuote !== (summary.quoteParity === 1);
  return { inQuote, atRowStart: summary.lastByte === LF && !inQuote };
};

/** Reads the header row from the start of a file: its field starts and where data begins. */
export const readCsvHeader = (
  bytes: Uint8Array,
  bom: number,
  delimiter: number,
): { header: CsvHeader; complete: boolean } => {
  const starts: number[] = [];
  let inQuote = false;
  let fieldStart = bom;
  starts.push(bom);
  for (let i = bom; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === QUOTE) inQuote = !inQuote;
    else if (!inQuote) {
      if (b === delimiter) {
        starts.push(i + 1);
        fieldStart = i + 1;
      } else if (b === LF) {
        void fieldStart;
        return { header: { delimiter, dataStart: i + 1, fieldStarts: starts }, complete: true };
      }
    }
  }
  return { header: { delimiter, dataStart: bytes.length, fieldStarts: starts }, complete: false };
};

/**
 * Structures the rows that start in `[regionStart, regionEnd)`. `window` begins
 * at `base` ≤ regionStart and holds at least up to the end of the last owned
 * row. `depth`: ≥ 1 puts rows and fields on the tape, 0 rows only, -1 neither.
 */
export const structureCsv = (
  window: Uint8Array,
  base: number,
  regionStart: number,
  regionEnd: number,
  fileSize: number,
  entry: CsvEntry,
  header: CsvHeader,
  depth: LineDepth,
  builder: TapeBuilder,
): LineRegion => {
  builder.reset();
  const n = window.length;
  const eof = base + n >= fileSize;
  const delimiter = header.delimiter;
  const fields = header.fieldStarts;
  const fieldCount = fields.length;
  const state = { last: -1, first: -1 };
  const anchors: number[] = [];
  let rows = 0;
  let p = regionStart - base;
  let inQuote = entry.inQuote;
  const limit = regionEnd - base;
  // Skip the header row and anything before the data in the first region.
  if (regionStart < header.dataStart) {
    p = header.dataStart - base;
    inQuote = false;
  } else if (!entry.atRowStart) {
    // Finish the row that began in an earlier region.
    for (; p < n; p++) {
      const b = window[p] as number;
      if (b === QUOTE) inQuote = !inQuote;
      else if (b === LF && !inQuote) {
        p++;
        break;
      }
    }
    if (p >= n && !eof) return needMoreRegion(builder);
  }
  const rowTokens = depth >= 0;
  while (p < limit && p < n) {
    // One row: fields until a line break outside quotes.
    const rowStart = p;
    let rowEnd = -1;
    let q = p;
    let fieldStart = p;
    let index = 0;
    let rowToken = -1;
    let inside = false;
    const mark = builder.count;
    // Collect fields; emit tokens only when the row is non-blank (decided at its end).
    const fieldRanges: number[] = [];
    inside = false;
    for (; q < n; q++) {
      const b = window[q] as number;
      if (b === QUOTE) inside = !inside;
      else if (!inside) {
        if (b === delimiter) {
          fieldRanges.push(fieldStart, q);
          fieldStart = q + 1;
          index++;
        } else if (b === LF) {
          rowEnd = q;
          break;
        }
      }
    }
    if (rowEnd < 0) {
      if (!eof) return needMoreRegion(builder);
      rowEnd = n;
    }
    let contentEnd = rowEnd;
    if (contentEnd > rowStart && window[contentEnd - 1] === CR) contentEnd--;
    const next = rowEnd + 1;
    if (isBlank(window, rowStart, contentEnd) && fieldRanges.length === 0) {
      p = next;
      continue;
    }
    let lastFieldEnd = contentEnd;
    if (fieldRanges.length > 0 || contentEnd >= fieldStart) {
      fieldRanges.push(fieldStart, lastFieldEnd);
    }
    const count = fieldRanges.length / 2;
    if (rows % LINE_BUCKET === 0 && depth < 0) anchors.push(rows, base + rowStart);
    rows++;
    if (rowTokens) {
      rowToken = builder.push(KIND_OBJECT, base + rowStart, -1, NO_KEY);
      builder.setEnd(rowToken, base + contentEnd);
      builder.setChildCount(rowToken, count);
      link(builder, state, rowToken);
      if (depth >= 1) {
        let prev = -1;
        for (let k = 0; k < count; k++) {
          const t = builder.push(
            KIND_STRING,
            base + (fieldRanges[k * 2] as number),
            rowToken,
            k < fieldCount ? (fields[k] as number) : NO_KEY,
          );
          builder.setEnd(t, base + (fieldRanges[k * 2 + 1] as number));
          if (prev >= 0) builder.setNext(prev, t);
          prev = t;
        }
      }
    }
    void mark;
    void index;
    p = next;
  }
  return finish(builder, state, rows, anchors);
};

const needMoreRegion = (builder: TapeBuilder): LineRegion => {
  builder.reset();
  return {
    buffers: builder.detach(),
    rows: 0,
    firstTop: -1,
    lastTop: -1,
    anchors: [],
    tokens: 0,
    needMore: true,
  };
};

export { FULL_DEPTH, KIND_ARRAY };
