/**
 * Streaming pretty-printer and minifier over JSON bytes: a chunk at a time, with
 * a small state carried between chunks, so a 2 GiB save never holds more than
 * one chunk of input and its output. Pretty output matches
 * `JSON.stringify(value, null, indent)` byte for byte up to MAX_INDENT_DEPTH
 * levels; past that the indentation stops growing, because a 100 k-deep document
 * printed with growing indentation is 10^10 bytes (docs/internals/document-engine.md,
 * "Deep documents").
 *
 * Inside a string the bytes are copied verbatim, jumping with indexOf between
 * quotes and backslashes, which keeps a HAR with bodies of hundreds of MiB fast.
 * The state at a chunk boundary is the scanner's own boundary state (depth,
 * in-string, escaped first byte, last significant byte), so a parallel save can
 * format every chunk at once from the scanner's first-pass summaries.
 */
import {
  ARR_OPEN,
  BACKSLASH,
  BYTE_CLASS,
  CLASS_CLOSE,
  CLASS_COLON,
  CLASS_COMMA,
  CLASS_OPEN,
  CLASS_QUOTE,
  CLASS_WS,
  COLON,
  COMMA,
  OBJ_OPEN,
  QUOTE,
} from "./bytes.ts";
import { scanStringEnd } from "./scan.ts";

export const MAX_INDENT_DEPTH = 256;
const NEWLINE = 0x0a;
const SPACE = 0x20;

export interface FormatState {
  readonly depth: number;
  readonly inString: boolean;
  /** The chunk's first byte is escaped (the previous chunk ended in an odd backslash run). */
  readonly escaped: boolean;
  /** Last significant byte outside strings before this chunk, or 0 at the start. */
  readonly lastSig: number;
}

export const INITIAL_FORMAT_STATE: FormatState = {
  depth: 0,
  inString: false,
  escaped: false,
  lastSig: 0,
};

export interface FormatOptions {
  /** 0 minifies; 2 is `JSON.stringify(x, null, 2)`. */
  readonly indent: number;
}

/**
 * A growable output buffer. `take()` copies the bytes out and keeps the
 * capacity; `finish()` hands the buffer itself over (a worker transfers it to
 * the coordinator, which hands it back for the next chunk, so a 2 GiB save
 * leaves no garbage behind).
 */
export class ByteWriter {
  private buffer: Uint8Array;
  length = 0;

  constructor(capacity: number | ArrayBuffer = 1 << 16) {
    this.buffer = new Uint8Array(capacity as number);
  }

  reserve(extra: number) {
    const needed = this.length + extra;
    if (needed <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength;
    while (capacity < needed) capacity = Math.ceil(capacity * 1.5);
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  byte(b: number) {
    if (this.length === this.buffer.byteLength) this.reserve(1);
    this.buffer[this.length++] = b;
  }

  bytes(src: Uint8Array, from: number, to: number) {
    this.reserve(to - from);
    this.buffer.set(src.subarray(from, to), this.length);
    this.length += to - from;
  }

  fill(b: number, count: number) {
    this.reserve(count);
    this.buffer.fill(b, this.length, this.length + count);
    this.length += count;
  }

  /** The bytes written so far, as an exact copy; the writer is empty afterwards. */
  take(): Uint8Array {
    const out = this.buffer.slice(0, this.length);
    this.length = 0;
    return out;
  }

  /** The bytes written so far as a view on the writer's own buffer, which the writer gives up. */
  finish(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.buffer.buffer as ArrayBuffer, 0, this.length);
    this.buffer = new Uint8Array(0);
    this.length = 0;
    return out;
  }
}

const isOpen = (b: number) => b === OBJ_OPEN || b === ARR_OPEN;

/**
 * Formats one chunk given the state at its first byte and returns the state at
 * its end. Whitespace outside strings is dropped and re-emitted per `indent`.
 */
export const formatChunk = (
  bytes: Uint8Array,
  state: FormatState,
  options: FormatOptions,
  out: ByteWriter,
): FormatState => {
  const n = bytes.byteLength;
  const indent = options.indent;
  let depth = state.depth;
  let lastSig = state.lastSig;
  let i = 0;

  const newline = (level: number) => {
    if (indent <= 0) return;
    out.byte(NEWLINE);
    out.fill(SPACE, Math.min(level, MAX_INDENT_DEPTH) * indent);
  };
  /** Before a significant byte: the break an open bracket or a comma deferred. */
  const breakBefore = (b: number) => {
    if (isOpen(lastSig)) {
      // An empty container stays `{}`; anything else starts a new line.
      if (BYTE_CLASS[b] !== CLASS_CLOSE) newline(depth);
    } else if (lastSig === COMMA) newline(depth);
  };
  /** Copies string content from `from` (after the opening quote) through the closing quote; returns the index after it, or -1 when the string runs past the chunk. */
  const copyString = (from: number, firstEscaped: boolean): number => {
    const end = scanStringEnd(bytes, firstEscaped ? Math.min(n, from + 1) : from);
    out.bytes(bytes, from, end < 0 ? n : end);
    return end;
  };

  if (state.inString) {
    i = copyString(0, state.escaped);
    if (i < 0) return { depth, inString: true, escaped: openEscape(bytes, state.escaped), lastSig };
    lastSig = QUOTE;
  }
  while (i < n) {
    const b = bytes[i] as number;
    const cls = BYTE_CLASS[b];
    if (cls === CLASS_WS) {
      i++;
      continue;
    }
    if (cls === CLASS_QUOTE) {
      breakBefore(b);
      out.byte(QUOTE);
      const after = copyString(i + 1, false);
      if (after < 0) return { depth, inString: true, escaped: openEscape(bytes, false), lastSig };
      i = after;
      lastSig = QUOTE;
      continue;
    }
    if (cls === CLASS_OPEN) {
      breakBefore(b);
      out.byte(b);
      depth++;
      lastSig = b;
      i++;
      continue;
    }
    if (cls === CLASS_CLOSE) {
      if (isOpen(lastSig)) out.byte(b);
      else {
        depth--;
        newline(depth);
        out.byte(b);
        depth++;
      }
      depth--;
      lastSig = b;
      i++;
      continue;
    }
    if (cls === CLASS_COMMA) {
      out.byte(COMMA);
      lastSig = COMMA;
      i++;
      continue;
    }
    if (cls === CLASS_COLON) {
      out.byte(COLON);
      if (indent > 0) out.byte(SPACE);
      lastSig = COLON;
      i++;
      continue;
    }
    // A number or literal: copy its run of scalar bytes.
    breakBefore(b);
    let j = i + 1;
    while (j < n) {
      const c = BYTE_CLASS[bytes[j] as number];
      if (
        c === CLASS_WS ||
        c === CLASS_COMMA ||
        c === CLASS_CLOSE ||
        c === CLASS_COLON ||
        c === CLASS_QUOTE ||
        c === CLASS_OPEN
      )
        break;
      j++;
    }
    out.bytes(bytes, i, j);
    lastSig = bytes[j - 1] as number;
    i = j;
  }
  return { depth, inString: false, escaped: false, lastSig };
};

/**
 * Whether a string still open at the chunk end leaves its next byte escaped: the
 * trailing backslash run is odd, with the first byte's own escape accounted for
 * when the whole chunk is backslashes.
 */
const openEscape = (bytes: Uint8Array, firstEscaped: boolean) => {
  let k = 0;
  const n = bytes.byteLength;
  while (k < n && bytes[n - 1 - k] === BACKSLASH) k++;
  if (k === n && firstEscaped) k--;
  return k % 2 === 1;
};

/** Convenience for tests and small values: the whole input, formatted. */
export const formatBytes = (bytes: Uint8Array, options: FormatOptions) => {
  const out = new ByteWriter(Math.max(64, bytes.byteLength));
  formatChunk(bytes, INITIAL_FORMAT_STATE, options, out);
  return out.take();
};
