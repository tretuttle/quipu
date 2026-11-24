/**
 * How the Source view cuts a file into rows, by byte offset, without ever
 * holding the file or a line array.
 *
 * A row is a line, or a piece of a long one. Inside a line the first row holds
 * `wrapBytes` bytes and the grid points after it are `wrapBytes - hang` less an
 * eighth apart, where the hang is the line's leading whitespace plus two (see
 * `hangOf`), so a wrapped row can be drawn indented under its line's text. A
 * wrapped row starts just after the last space within that eighth before its
 * grid point, so words are not cut where it can be helped (see `breakBefore`). Rows are moved forward to a code point,
 * and a line is also cut wherever it crosses a multiple of SOURCE_LINE_BLOCK_BYTES,
 * so finding the start of the row that holds an offset reads at most one block
 * backward. A minified 2 GiB HAR is a single line; this is what makes it a
 * column of short rows you can scroll to any offset of.
 *
 * Line numbers count newlines from the start of the file and are offered only
 * within SOURCE_LINE_NUMBER_LIMIT_BYTES, in block-sized steps that are cached.
 */
import { SOURCE_LINE_BLOCK_BYTES, SOURCE_LINE_NUMBER_LIMIT_BYTES } from "@quipu/contracts/engine";

import { decodeUtf8 } from "./boundedSlice.ts";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
/** Backward line-start searches and row reads go through chunks of this size. */
const CHUNK_BYTES = 256 * 1024;
/** A row's column is decoded only this far from its line's start. */
const COLUMN_LIMIT_BYTES = SOURCE_LINE_BLOCK_BYTES;

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;
const SPACE = 0x20;
const TAB = 0x09;
/** Columns a wrapped row hangs past its line's own indent. */
const HANG_EXTRA = 2;

/**
 * How far the wrapped rows of the line that starts at `lineStart` hang: its
 * leading spaces and tabs plus {@link HANG_EXTRA}, at most half the width. A
 * piece of a line cut at a block boundary does not start a line, and hangs 0.
 */
async function hangOf(reader: ChunkReader, lineStart: number, wrap: number): Promise<number> {
  const most = Math.floor(wrap / 2);
  if (most <= HANG_EXTRA) return 0;
  if (lineStart === 0) return hangFrom(NEWLINE, await reader.readExact(0, most), wrap);
  // One small read: the byte before the line and its first bytes.
  const bytes = await reader.readExact(lineStart - 1, lineStart + most);
  return hangFrom(bytes[0] ?? NEWLINE, bytes.subarray(1), wrap);
}

/** The hang, from the byte before the line start and the line's first bytes (at least half the width of them, or to the end of the file). */
function hangFrom(before: number, head: Uint8Array, wrap: number): number {
  const most = Math.floor(wrap / 2);
  if (most <= HANG_EXTRA || before !== NEWLINE) return 0;
  let spaces = 0;
  while (
    spaces < most &&
    spaces < head.length &&
    (head[spaces] === SPACE || head[spaces] === TAB)
  ) {
    spaces++;
  }
  return Math.min(most, spaces + HANG_EXTRA);
}

/**
 * How far back from a grid point a wrapped row may start so that it starts
 * after a space, not inside a word: an eighth of the width (none for a width
 * under 16). The grid's later rows are that much narrower than the width, so a
 * row that starts early still fits.
 */
const wordWindow = (wrap: number) => {
  const window = Math.floor(wrap / 8);
  return window >= 2 ? window : 0;
};

/** The bytes between two grid points after a line's first row. */
const stride = (wrap: number, hang: number) => wrap - hang - wordWindow(wrap);

/** Where row `k` of a line falls on the grid, in bytes from the line's start (before moving to a code point). */
const rowOffset = (k: number, wrap: number, hang: number) =>
  k === 0 ? 0 : wrap + (k - 1) * stride(wrap, hang);

/** The row of a line that byte `distance` (from the line's start) falls in, on the grid. */
const rowOf = (distance: number, wrap: number, hang: number) =>
  distance < wrap ? 0 : 1 + Math.floor((distance - wrap) / stride(wrap, hang));

const SPACE_BREAK = 0x20;

/**
 * Where a wrapped row starts, given its grid point `grid`: just after the last
 * space within the word window before it, else at the grid point. `at` reads a
 * byte; every byte of the window is after the row before's start.
 */
function breakBefore(grid: number, wrap: number, at: (position: number) => number): number {
  const window = wordWindow(wrap);
  for (let start = grid; start > grid - window; start--) {
    if (at(start - 1) === SPACE_BREAK) return start;
  }
  return grid;
}

export interface SourceBytes {
  readonly size: number;
  /** Bytes `[start, end)`; the view may alias an internal buffer and is read at once. */
  read(start: number, end: number): Promise<Uint8Array>;
}

/** What the layout remembers between requests: newline counts at block boundaries. */
export interface LineCounts {
  /** `cumulative[j]` is the number of newlines in `[0, j * block)`. */
  readonly cumulative: number[];
}

export const createLineCounts = (): LineCounts => ({ cumulative: [0] });

/** Reads through a cache of one aligned chunk, so a walk of many short rows reads once. */
class ChunkReader {
  private chunkStart = -1;
  private chunk: Uint8Array = new Uint8Array(0);

  private readonly source: SourceBytes;

  constructor(source: SourceBytes) {
    this.source = source;
  }

  get size() {
    return this.source.size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    const to = Math.min(end, this.source.size);
    if (start >= to) return new Uint8Array(0);
    if (to - start > CHUNK_BYTES) return this.source.read(start, to);
    if (
      this.chunkStart >= 0 &&
      start >= this.chunkStart &&
      to <= this.chunkStart + this.chunk.length
    ) {
      return this.chunk.subarray(start - this.chunkStart, to - this.chunkStart);
    }
    const chunkStart = Math.floor(start / CHUNK_BYTES) * CHUNK_BYTES;
    const chunkEnd = Math.min(this.source.size, Math.max(to, chunkStart + 2 * CHUNK_BYTES));
    this.chunk = await this.source.read(chunkStart, chunkEnd);
    this.chunkStart = chunkStart;
    return this.chunk.subarray(start - chunkStart, to - chunkStart);
  }

  /** Just `[start, end)`, past the cache: a few bytes far from where the walk reads. */
  async readExact(start: number, end: number): Promise<Uint8Array> {
    const to = Math.min(end, this.source.size);
    if (start >= to) return new Uint8Array(0);
    return (await this.source.read(start, to)).slice();
  }

  async byteAt(at: number): Promise<number> {
    const bytes = await this.read(at, at + 1);
    return bytes[0] ?? NEWLINE;
  }

  /**
   * `at`, moved forward past UTF-8 continuation bytes, so it starts a code point.
   * `far` reads just those bytes, for a place away from where the walk reads.
   */
  async alignForward(at: number, far = false): Promise<number> {
    if (at <= 0 || at >= this.source.size) return Math.min(Math.max(at, 0), this.source.size);
    const bytes = far ? await this.readExact(at, at + 4) : await this.read(at, at + 4);
    let moved = 0;
    while (moved < bytes.length && isContinuation(bytes[moved] as number)) moved++;
    return at + moved;
  }
}

interface RowPlace {
  readonly rowStart: number;
  readonly lineStart: number;
  /** The hang of the line's wrapped rows. */
  readonly hang: number;
  /** Which row of its line (or block piece of one) this is, from 0. */
  readonly index: number;
}

/**
 * Where row `index` of the line at `lineStart` starts, when the line reaches
 * it: null when the line ends (a newline at or before the row's grid point
 * after `known`, up to which the line is known to go on), or the file or the
 * block ends there first.
 */
async function rowStartOf(
  reader: ChunkReader,
  lineStart: number,
  hang: number,
  index: number,
  wrap: number,
  known: number,
  blockEnd: number,
): Promise<number | null> {
  if (index === 0) return lineStart;
  const grid = await reader.alignForward(lineStart + rowOffset(index, wrap, hang));
  if (grid >= reader.size || grid >= blockEnd) return null;
  if (grid > known) {
    const ahead = await reader.readExact(known + 1, grid + 1);
    if (ahead.includes(NEWLINE)) return null;
  }
  const from = grid - wordWindow(wrap);
  const window = await reader.readExact(from, grid);
  return breakBefore(grid, wrap, (position) => window[position - from] as number);
}

/** The start of the line block that holds `at`, moved to a code point. */
async function blockStartOf(reader: ChunkReader, at: number, blockBytes: number): Promise<number> {
  let block = Math.floor(at / blockBytes);
  for (;;) {
    const start = await reader.alignForward(block * blockBytes);
    if (start <= at || block === 0) return Math.min(start, at);
    block -= 1;
  }
}

/** The row just above `place`: in the same line when there is one, else found from the byte before. */
async function previousRow(
  reader: ChunkReader,
  place: RowPlace,
  wrap: number,
  blockBytes: number,
): Promise<RowPlace> {
  if (place.rowStart > place.lineStart) {
    // The row before is the line's previous one: the line goes on past it, so it is there.
    const { lineStart, hang } = place;
    const index = place.index - 1;
    const rowStart =
      (await rowStartOf(reader, lineStart, hang, index, wrap, place.rowStart, Infinity)) ??
      lineStart;
    return { rowStart, lineStart, hang, index };
  }
  return placeRow(reader, place.rowStart - 1, wrap, blockBytes);
}

/** The row that holds byte `at`, found by one bounded backward search. */
async function placeRow(
  reader: ChunkReader,
  at: number,
  wrap: number,
  blockBytes: number,
): Promise<RowPlace> {
  const size = reader.size;
  if (size === 0) return { rowStart: 0, lineStart: 0, hang: 0, index: 0 };
  const point = Math.min(Math.max(at, 0), size - 1);
  const blockStart = await blockStartOf(reader, point, blockBytes);
  let lineStart = blockStart;
  let searchEnd = point;
  let step = 4096;
  while (searchEnd > blockStart) {
    const from = Math.max(blockStart, searchEnd - step);
    const bytes = await reader.read(from, searchEnd);
    const found = bytes.lastIndexOf(NEWLINE);
    if (found >= 0) {
      lineStart = from + found + 1;
      break;
    }
    searchEnd = from;
    step = Math.min(step * 4, blockBytes);
  }
  // A newline byte belongs to the row its line ends in, not to a row of its own.
  let target = point;
  if ((await reader.byteAt(point)) === NEWLINE) {
    if (point > lineStart) target = point - 1;
    else if (
      point > 0 &&
      lineStart === blockStart &&
      (await reader.byteAt(point - 1)) !== NEWLINE
    ) {
      // A line cut at a block boundary that lands on its own newline: the newline ends the row before.
      return placeRow(reader, point - 1, wrap, blockBytes);
    }
  }
  const hang = await hangOf(reader, lineStart, wrap);
  const blockEnd = await reader.alignForward(
    (Math.floor(target / blockBytes) + 1) * blockBytes,
    true,
  );
  // The grid row of the target, or the one after it when that one starts early, at a space.
  for (let index = rowOf(target - lineStart, wrap, hang) + 1; index > 0; index--) {
    const rowStart = await rowStartOf(reader, lineStart, hang, index, wrap, target, blockEnd);
    if (rowStart !== null && rowStart <= target) return { rowStart, lineStart, hang, index };
  }
  return { rowStart: lineStart, lineStart, hang, index: 0 };
}

export interface LayoutRow {
  readonly start: number;
  readonly end: number;
  /** Where this row's line (or block piece of one) starts. */
  readonly lineStart: number;
  /** The row ends at a newline, so the next one begins a new line. */
  readonly endsLine: boolean;
  /** Columns to indent the row by: its line's hang for a wrapped row, 0 for a line's first. */
  readonly indent: number;
}

/**
 * Up to `count` rows from the row that starts at `rowStart`, in a line that
 * starts at `lineStart`. Reads one buffer for the whole walk.
 */
async function layoutForward(
  reader: ChunkReader,
  place: RowPlace,
  wrap: number,
  count: number,
  blockBytes: number,
): Promise<LayoutRow[]> {
  const size = reader.size;
  const rows: LayoutRow[] = [];
  let { rowStart: p, lineStart, hang, index } = place;
  if (size === 0) return [{ start: 0, end: 0, lineStart: 0, endsLine: true, indent: 0 }];
  const bufferStart = p;
  const bufferEnd = Math.min(size, p + count * (wrap + 8) + 16);
  // One wrap width more, so a line starting near the end has its indent in the buffer too.
  const buffer = (await reader.read(bufferStart, Math.min(size, bufferEnd + wrap))).slice();
  /** The hang of a line starting at `start` inside the buffer; `start` is after `bufferStart`. */
  const hangAt = (start: number) =>
    hangFrom(at(start - 1), buffer.subarray(start - bufferStart, start - bufferStart + wrap), wrap);
  const at = (position: number) => buffer[position - bufferStart] as number;
  const alignInBuffer = (position: number) => {
    let aligned = position;
    while (
      aligned < bufferEnd &&
      aligned - bufferStart < buffer.length &&
      isContinuation(at(aligned))
    ) {
      aligned += 1;
    }
    return aligned;
  };
  while (rows.length < count && p < size) {
    const grid = Math.max(p + 1, alignInBuffer(lineStart + rowOffset(index + 1, wrap, hang)));
    const indent = p > lineStart ? hang : 0;
    const block = alignInBuffer((Math.floor(p / blockBytes) + 1) * blockBytes);
    const limit = Math.min(grid, block, size);
    // A newline at the limit still ends this row: the byte after a full-width row is its break.
    const searchEnd = Math.min(limit + 1, bufferEnd);
    const found = buffer.subarray(p - bufferStart, searchEnd - bufferStart).indexOf(NEWLINE);
    if (found >= 0) {
      const newline = p + found;
      rows.push({ start: p, end: newline, lineStart, endsLine: true, indent });
      p = newline + 1;
      lineStart = p;
      index = 0;
      if (p < size) hang = hangAt(lineStart);
      continue;
    }
    // A row the grid ends (not the block or the file) ends after a space near its end, if any.
    const end = limit === grid && grid < block && grid < size ? breakBefore(grid, wrap, at) : limit;
    rows.push({ start: p, end, lineStart, endsLine: false, indent });
    if (limit === block && limit < size) {
      lineStart = limit;
      index = 0;
      hang = hangAt(lineStart);
    } else index += 1;
    p = end;
    if (limit >= bufferEnd && limit < size && rows.length < count) break;
  }
  return rows;
}

const utf16Length = (bytes: Uint8Array) => {
  let ascii = true;
  for (const byte of bytes) {
    if (byte >= 0x80) {
      ascii = false;
      break;
    }
  }
  return ascii ? bytes.length : decodeUtf8(bytes).length;
};

/** Newlines in `[0, at)`, counted in cached block steps; null beyond the limit. */
async function newlinesBefore(
  reader: ChunkReader,
  counts: LineCounts,
  at: number,
): Promise<number | null> {
  if (at > SOURCE_LINE_NUMBER_LIMIT_BYTES) return null;
  const block = Math.floor(at / SOURCE_LINE_BLOCK_BYTES);
  while (counts.cumulative.length <= block) {
    const index = counts.cumulative.length - 1;
    const from = index * SOURCE_LINE_BLOCK_BYTES;
    const bytes = await reader.read(from, from + SOURCE_LINE_BLOCK_BYTES);
    counts.cumulative.push((counts.cumulative[index] as number) + countNewlines(bytes));
  }
  const from = block * SOURCE_LINE_BLOCK_BYTES;
  const tail = at > from ? countNewlines(await reader.read(from, at)) : 0;
  return (counts.cumulative[block] as number) + tail;
}

const countNewlines = (bytes: Uint8Array) => {
  let count = 0;
  let at = bytes.indexOf(NEWLINE);
  while (at >= 0) {
    count += 1;
    at = bytes.indexOf(NEWLINE, at + 1);
  }
  return count;
};

export interface RowLayout {
  readonly rows: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    /** Where the row's text ends: `end`, less the carriage return of a CRLF break. */
    readonly textEnd: number;
    readonly line: number | null;
    readonly column: number | null;
    /** Columns a wrapped row is drawn indented by, under its line's text. */
    readonly indent: number;
  }>;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/**
 * The rows around `offset`: `before` rows above the row that holds it, then that
 * row and `rows - 1` below. Everything it reads is bounded by the row count, the
 * wrap width and one line block.
 */
export async function layoutRows(
  source: SourceBytes,
  counts: LineCounts,
  options: {
    readonly offset: number;
    readonly before: number;
    readonly rows: number;
    readonly wrapBytes: number;
    /** Where long lines are cut so a row's line start is found within one block; tests shrink it. */
    readonly blockBytes?: number;
  },
): Promise<RowLayout> {
  const reader = new ChunkReader(source);
  const { wrapBytes: wrap } = options;
  const blockBytes = options.blockBytes ?? SOURCE_LINE_BLOCK_BYTES;
  const anchor = await placeRow(reader, options.offset, wrap, blockBytes);
  // Walk back one row at a time, each found from the byte just before the last.
  let first = anchor;
  let back = 0;
  while (back < options.before && first.rowStart > 0) {
    first = await previousRow(reader, first, wrap, blockBytes);
    back += 1;
  }
  const laid = await layoutForward(reader, first, wrap, back + options.rows, blockBytes);
  const rows: Array<RowLayout["rows"][number]> = [];
  const firstNewlines = await newlinesBefore(reader, counts, first.lineStart);
  let line = firstNewlines === null ? null : firstNewlines + 1;
  let column: number | null = null;
  const firstRow = laid[0];
  if (line !== null && firstRow) {
    const gap = firstRow.start - firstRow.lineStart;
    column =
      gap === 0
        ? 0
        : gap <= COLUMN_LIMIT_BYTES
          ? utf16Length(await reader.read(firstRow.lineStart, firstRow.start))
          : null;
  }
  for (const row of laid) {
    const bytes = await reader.read(row.start, row.end);
    const hasReturn =
      row.endsLine && bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN;
    const textEnd = hasReturn ? row.end - 1 : row.end;
    rows.push({
      start: row.start,
      end: row.end,
      textEnd,
      line,
      column: line === null ? null : column,
      indent: row.indent,
    });
    if (row.endsLine) {
      line = line === null ? null : line + 1;
      column = line === null ? null : 0;
    } else if (column !== null) {
      column += utf16Length(bytes);
    }
  }
  // A line number is only known when every newline before it was counted.
  const last = laid[laid.length - 1];
  return {
    rows,
    atStart: first.rowStart === 0,
    atEnd: last === undefined || last.end + (last.endsLine ? 1 : 0) >= source.size,
  };
}
