/**
 * JSON array of objects to CSV/TSV rows, as bytes. Columns come from a header
 * known up front (the first rows, or the whole document when asked), and a row
 * is written in column order from cells copied out of the window as they were
 * read, so a row never needs the window it began in.
 *
 * What does not fit a table is an error with the byte offset of the first
 * offending node: a root that is not an array, an element that is not an
 * object, a key twice in one row, a key that is not a column, and (when asked
 * not to stringify them) a nested value.
 */
import { BACKSLASH, COLON, COMMA } from "@quipu/core/bytes";
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { MAX_KEY_BYTES, unescapeBytes } from "@quipu/core/decode";

import { OffendingNode } from "./abort.ts";
import { ByteWriter } from "./byteWriter.ts";
import {
  type JsonHandler,
  KIND_ARRAY,
  KIND_NULL,
  KIND_OBJECT,
  type ScanState,
} from "./jsonScan.ts";
import { RegionStop } from "./regionStop.ts";

const QUOTE = 0x22;
const NEWLINE = 0x0a;
const CR = 0x0d;

export interface CsvOptions {
  readonly delimiter: number;
  /** `json`: a nested value is a cell holding its compact JSON. `error`: it is an offending node. */
  readonly nested: "json" | "error";
}

/** Column names as UTF-8 bytes, with a lookup that expects keys in the order the previous row had them. */
export class ColumnIndex {
  readonly names: ReadonlyArray<Uint8Array>;
  private readonly byHash = new Map<number, number[]>();
  private cursor = 0;

  constructor(names: ReadonlyArray<Uint8Array>) {
    this.names = names;
    names.forEach((name, index) => {
      const h = hashBytes(name, 0, name.length);
      const list = this.byHash.get(h);
      if (list) list.push(index);
      else this.byHash.set(h, [index]);
    });
  }

  get size() {
    return this.names.length;
  }

  /** Index of the column whose name is `bytes[from, to)`, or -1. */
  lookup(bytes: Uint8Array, from: number, to: number): number {
    const names = this.names;
    const guess = this.cursor < names.length ? this.cursor : 0;
    if (names.length > 0 && equalRange(names[guess] as Uint8Array, bytes, from, to)) {
      this.cursor = guess + 1;
      return guess;
    }
    const list = this.byHash.get(hashBytes(bytes, from, to));
    if (!list) return -1;
    for (const index of list) {
      if (equalRange(names[index] as Uint8Array, bytes, from, to)) {
        this.cursor = index + 1;
        return index;
      }
    }
    return -1;
  }
}

const hashBytes = (b: Uint8Array, from: number, to: number) => {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) h = Math.imul(h ^ (b[i] as number), 0x01000193);
  return h >>> 0;
};

const equalRange = (name: Uint8Array, b: Uint8Array, from: number, to: number) => {
  if (name.length !== to - from) return false;
  for (let i = 0; i < name.length; i++) if (name[i] !== b[from + i]) return false;
  return true;
};

/**
 * JSON may carry a lone surrogate escape, which has no UTF-8 form; the engine's
 * unescape writes its three-byte generalized encoding. Output is well-formed
 * UTF-8, so each one becomes U+FFFD in place (same length).
 */
export const wellFormUtf8 = (b: Uint8Array, length: number) => {
  for (let i = b.indexOf(0xed); i >= 0 && i < length; i = b.indexOf(0xed, i + 1)) {
    if (i + 2 < length && (b[i + 1] as number) >= 0xa0 && (b[i + 1] as number) <= 0xbf) {
      b[i] = 0xef;
      b[i + 1] = 0xbf;
      b[i + 2] = 0xbd;
    }
  }
};

const CELL_NONE = 0;
const CELL_TEXT = 1;
const CELL_NULL = 2;

/** Decodes a key token's content to UTF-8 bytes into `scratch` and returns the used length. */
const keyBytes = (bytes: Uint8Array, start: number, end: number, scratch: Uint8Array) => {
  const from = start + 1;
  const to = end - 1;
  if (bytes.subarray(from, to).indexOf(BACKSLASH) < 0) return -1;
  return unescapeBytes(bytes, from, to, scratch, 0);
};

export class CsvHandler implements JsonHandler {
  private readonly out: ByteWriter;
  private readonly st: ScanState;
  private readonly columns: ColumnIndex;
  private readonly options: CsvOptions;
  private readonly ownedEnd: number;
  private readonly rowBuf = new ByteWriter(1 << 12);
  private readonly cellOffset: Int32Array;
  private readonly cellLength: Int32Array;
  private readonly cellState: Uint8Array;
  private readonly seen: Uint32Array;
  private rowStamp = 0;
  private inRow = false;
  private column = -1;
  /** Open nested capture: the column it fills, or -1. */
  private capturing = -1;
  private captureStart = 0;
  private scratch = new Uint8Array(256);
  /** Rows written by this handler. */
  rows = 0;
  /** The first offset at or after `ownedEnd` where an element started, or -1. */
  stoppedAt = -1;

  constructor(
    out: ByteWriter,
    st: ScanState,
    columns: ColumnIndex,
    options: CsvOptions,
    ownedEnd: number,
  ) {
    this.out = out;
    this.st = st;
    this.columns = columns;
    this.options = options;
    this.ownedEnd = ownedEnd;
    const n = columns.size;
    this.cellOffset = new Int32Array(n);
    this.cellLength = new Int32Array(n);
    this.cellState = new Uint8Array(n);
    this.seen = new Uint32Array(n);
  }

  private startRow(pos: number) {
    if (pos >= this.ownedEnd) {
      this.stoppedAt = pos;
      throw new RegionStop(pos);
    }
    this.inRow = true;
    this.rowStamp++;
    this.cellState.fill(CELL_NONE);
    this.rowBuf.reset();
  }

  open(kind: number, pos: number) {
    const depth = this.st.depth;
    if (depth === 0) {
      if (kind !== KIND_ARRAY) {
        throw new OffendingNode(pos, "not-rows", "the document is not an array of objects");
      }
      return;
    }
    if (depth === 1) {
      if (pos >= this.ownedEnd) {
        this.stoppedAt = pos;
        throw new RegionStop(pos);
      }
      if (kind !== KIND_OBJECT) {
        throw new OffendingNode(pos, "row-not-object", "an element of the array is not an object");
      }
      this.startRow(pos);
      return;
    }
    if (!this.inRow) return;
    if (depth === 2) {
      if (this.options.nested === "error") {
        throw new OffendingNode(pos, "nested-value", "a cell holds an object or array");
      }
      this.beginCapture(pos);
    } else if (this.capturing >= 0) this.captureSeparator();
    if (this.capturing >= 0) this.rowBuf.byte(kind === KIND_OBJECT ? 0x7b : 0x5b);
  }

  close(kind: number, _pos: number) {
    const depth = this.st.depth;
    if (depth === 2 && this.inRow) {
      this.writeRow();
      this.inRow = false;
      return;
    }
    if (!this.inRow || this.capturing < 0) return;
    this.rowBuf.byte(kind === KIND_OBJECT ? 0x7d : 0x5d);
    if (depth === 3) this.endCapture();
  }

  key(bytes: Uint8Array, start: number, end: number) {
    if (!this.inRow) return;
    const depth = this.st.depth;
    if (depth === 2) {
      if (this.scratch.length < end - start) this.scratch = new Uint8Array((end - start) * 2);
      const length = keyBytes(bytes, start, end, this.scratch);
      let column: number;
      if (length < 0) column = this.columns.lookup(bytes, start + 1, end - 1);
      else column = this.columns.lookup(this.scratch, 0, length);
      if (column < 0) {
        throw new OffendingNode(
          start,
          "unknown-column",
          "a key that is not a column of the header",
        );
      }
      if (this.seen[column] === this.rowStamp) {
        throw new OffendingNode(start, "duplicate-key", "a key appears twice in one row");
      }
      this.seen[column] = this.rowStamp;
      this.column = column;
      return;
    }
    if (this.capturing >= 0) {
      this.captureSeparator();
      this.rowBuf.bytes(bytes, start, end);
      this.rowBuf.byte(COLON);
    }
  }

  string(bytes: Uint8Array, start: number, end: number) {
    const depth = this.st.depth;
    if (depth === 1) {
      if (start >= this.ownedEnd) {
        this.stoppedAt = start;
        throw new RegionStop(start);
      }
      throw new OffendingNode(start, "row-not-object", "an element of the array is not an object");
    }
    if (!this.inRow) return;
    if (depth === 2) {
      const column = this.column;
      this.cellOffset[column] = this.rowBuf.length;
      const room = end - start;
      if (this.scratch.length < room) this.scratch = new Uint8Array(room * 2);
      const length = unescapeBytes(bytes, start + 1, end - 1, this.scratch, 0);
      wellFormUtf8(this.scratch, length);
      this.rowBuf.bytes(this.scratch, 0, length);
      this.cellLength[column] = length;
      this.cellState[column] = CELL_TEXT;
      return;
    }
    if (this.capturing >= 0) {
      this.captureSeparator();
      this.rowBuf.bytes(bytes, start, end);
    }
  }

  scalar(bytes: Uint8Array, start: number, end: number, kind: number) {
    const depth = this.st.depth;
    if (depth === 1) {
      if (start >= this.ownedEnd) {
        this.stoppedAt = start;
        throw new RegionStop(start);
      }
      throw new OffendingNode(start, "row-not-object", "an element of the array is not an object");
    }
    if (!this.inRow) return;
    if (depth === 2) {
      const column = this.column;
      if (kind === KIND_NULL) {
        this.cellState[column] = CELL_NULL;
        return;
      }
      this.cellOffset[column] = this.rowBuf.length;
      this.rowBuf.bytes(bytes, start, end);
      this.cellLength[column] = end - start;
      this.cellState[column] = CELL_TEXT;
      return;
    }
    if (this.capturing >= 0) {
      this.captureSeparator();
      this.rowBuf.bytes(bytes, start, end);
    }
  }

  /** A comma before the next entry of a captured container, when the source had one. */
  private captureSeparator() {
    if (this.st.prevSig === COMMA) this.rowBuf.byte(COMMA);
  }

  private beginCapture(_pos: number) {
    this.capturing = this.column;
    this.captureStart = this.rowBuf.length;
  }

  private endCapture() {
    const column = this.capturing;
    this.cellOffset[column] = this.captureStart;
    this.cellLength[column] = this.rowBuf.length - this.captureStart;
    this.cellState[column] = CELL_TEXT;
    this.capturing = -1;
  }

  private writeRow() {
    const out = this.out;
    const cells = this.cellState.length;
    const delimiter = this.options.delimiter;
    const buf = this.rowBuf.view();
    for (let c = 0; c < cells; c++) {
      if (c > 0) out.byte(delimiter);
      if (this.cellState[c] !== CELL_TEXT) {
        if (cells === 1) {
          out.byte(QUOTE);
          out.byte(QUOTE);
        }
        continue;
      }
      const from = this.cellOffset[c] as number;
      const to = from + (this.cellLength[c] as number);
      if (to === from) {
        if (cells === 1) {
          out.byte(QUOTE);
          out.byte(QUOTE);
        }
        continue;
      }
      let special = false;
      for (let i = from; i < to; i++) {
        const b = buf[i] as number;
        if (b === delimiter || b === QUOTE || b === NEWLINE || b === CR) {
          special = true;
          break;
        }
      }
      if (!special) out.bytes(buf, from, to);
      else {
        out.byte(QUOTE);
        let run = from;
        for (let i = from; i < to; i++) {
          if (buf[i] === QUOTE) {
            out.bytes(buf, run, i + 1);
            out.byte(QUOTE);
            run = i + 1;
          }
        }
        out.bytes(buf, run, to);
        out.byte(QUOTE);
      }
    }
    out.byte(NEWLINE);
    this.rows++;
  }
}

/** Appends one CSV field to `out`, quoting it when it holds the delimiter, a quote or a line break. */
export const writeCsvField = (
  out: ByteWriter,
  bytes: Uint8Array,
  delimiter: number,
  single: boolean,
) => {
  if (bytes.length === 0) {
    if (single) {
      out.byte(QUOTE);
      out.byte(QUOTE);
    }
    return;
  }
  let special = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === delimiter || b === QUOTE || b === NEWLINE || b === CR) {
      special = true;
      break;
    }
  }
  if (!special) {
    out.bytes(bytes, 0, bytes.length);
    return;
  }
  out.byte(QUOTE);
  let run = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === QUOTE) {
      out.bytes(bytes, run, i + 1);
      out.byte(QUOTE);
      run = i + 1;
    }
  }
  out.bytes(bytes, run, bytes.length);
  out.byte(QUOTE);
};

/**
 * Collects column names in first-seen order from the rows of an array of
 * objects; it writes nothing. Stops after `maxRows` rows (Infinity reads all).
 */
export class ColumnCollector implements JsonHandler {
  readonly names: Uint8Array[] = [];
  private readonly seen = new Set<string>();
  private readonly st: ScanState;
  private readonly maxRows: number;
  rows = 0;

  constructor(st: ScanState, maxRows: number) {
    this.st = st;
    this.maxRows = maxRows;
  }

  open(kind: number, pos: number) {
    const depth = this.st.depth;
    if (depth === 0 && kind !== KIND_ARRAY) {
      throw new OffendingNode(pos, "not-rows", "the document is not an array of objects");
    }
    if (depth === 1) {
      if (kind !== KIND_OBJECT) {
        throw new OffendingNode(pos, "row-not-object", "an element of the array is not an object");
      }
      if (this.rows >= this.maxRows) throw new RegionStop(pos);
      this.rows++;
    }
  }

  close() {}

  key(bytes: Uint8Array, start: number, end: number) {
    if (this.st.depth !== 2) return;
    const raw = bytes.subarray(start + 1, end - 1);
    const text = raw.indexOf(BACKSLASH) < 0 ? raw : this.unescaped(bytes, start, end);
    const key = decodeUtf8(text, MAX_KEY_BYTES);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.names.push(text.slice());
  }

  private unescaped(bytes: Uint8Array, start: number, end: number) {
    const out = new Uint8Array(end - start);
    const n = unescapeBytes(bytes, start + 1, end - 1, out, 0);
    return out.subarray(0, n);
  }

  string(_bytes: Uint8Array, start: number) {
    if (this.st.depth === 1) {
      throw new OffendingNode(start, "row-not-object", "an element of the array is not an object");
    }
  }

  scalar(_bytes: Uint8Array, start: number) {
    if (this.st.depth === 1) {
      throw new OffendingNode(start, "row-not-object", "an element of the array is not an object");
    }
  }
}
