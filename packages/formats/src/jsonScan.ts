/**
 * A push parser over JSON bytes with explicit state. It is the reader behind
 * every streamed converter: it is told which token starts it owns, reads each
 * token whole from a window of bytes, and calls a handler. It never builds a
 * value and never recurses; depth lives in a typed-array stack, so a 100 k-deep
 * document costs the same as a flat one.
 *
 * Ownership is by token start. A region of the file owns the tokens that begin
 * in `[from, ownedEnd)`; a token that straddles the end is finished from the
 * overhang the caller supplied, and the next region skips it (its entry state
 * says it begins inside a string or a scalar). That is why converted output does
 * not depend on where the regions were cut.
 */
import {
  BYTE_CLASS,
  CLASS_CLOSE,
  CLASS_COLON,
  CLASS_COMMA,
  CLASS_OPEN,
  CLASS_QUOTE,
  CLASS_SCALAR_START,
  CLASS_WS,
  COLON,
  COMMA,
  OBJ_OPEN,
  QUOTE,
  SCALAR_CHAR,
} from "@quipu/core/bytes";
import type { EntryState } from "@quipu/core/scan";
import { KIND_ARRAY, KIND_OBJECT } from "@quipu/core/tape";

import { scanStringEnd } from "./stringEnd.ts";

export { KIND_ARRAY, KIND_OBJECT };

export const KIND_TRUE = 5;
export const KIND_FALSE = 6;
export const KIND_NULL = 7;
export const KIND_NUMBER = 4;

const ARR_OPEN = 0x5b;

/** Where the scanner stands between tokens: enough to resume in the next window. */
export interface ScanState {
  depth: number;
  /** Container kind per open level, growable; only `[0, depth)` is meaningful. */
  kinds: Uint8Array;
  /** The last significant byte outside strings (a closing quote counts), 0 at the start. */
  prevSig: number;
}

export const newScanState = (): ScanState => ({ depth: 0, kinds: new Uint8Array(64), prevSig: 0 });

/** The scanner state a region starts in, from the engine's resolved entry state. */
export const scanStateFromEntry = (entry: EntryState): ScanState => {
  const kinds = new Uint8Array(Math.max(64, entry.depth + 16));
  kinds.set(entry.kinds.subarray(0, Math.min(entry.depth, entry.kinds.length)));
  return { depth: entry.depth, kinds, prevSig: entry.prevSig };
};

export interface JsonHandler {
  /** A container opens; `st.depth` is still the parent's depth and `st.kinds[st.depth - 1]` the parent's kind. */
  open(kind: number, pos: number): void;
  /** A container closes; `st.prevSig` is its open bracket when it is empty. */
  close(kind: number, pos: number): void;
  /** An object member key; `start`/`end` include the quotes. */
  key(bytes: Uint8Array, start: number, end: number): void;
  string(bytes: Uint8Array, start: number, end: number): void;
  /** A number or literal; `kind` is KIND_NUMBER, KIND_TRUE, KIND_FALSE or KIND_NULL. */
  scalar(bytes: Uint8Array, start: number, end: number, kind: number): void;
}

export interface WalkResult {
  /** Index of the first token not processed (its start), or the window length. */
  pos: number;
  /** The loop stopped because a token ran past the window and `final` was false. */
  incomplete: boolean;
}

const scalarKind = (b: number) =>
  b === 0x74 ? KIND_TRUE : b === 0x66 ? KIND_FALSE : b === 0x6e ? KIND_NULL : KIND_NUMBER;

const result: WalkResult = { pos: 0, incomplete: false };

/**
 * Walks tokens that start in `[from, ownedEnd)` of `bytes`. `bytes` must hold
 * every owned token whole unless `final` is false, in which case a token that
 * runs past the window stops the walk with `incomplete` so the caller can supply
 * more bytes. The returned object is reused: read it before the next call.
 */
export const walkJson = (
  bytes: Uint8Array,
  from: number,
  ownedEnd: number,
  st: ScanState,
  h: JsonHandler,
  final: boolean,
): WalkResult => {
  const n = bytes.length;
  let i = from;
  let prevSig = st.prevSig;
  let depth = st.depth;
  let kinds = st.kinds;
  const limit = Math.min(ownedEnd, n);
  result.incomplete = false;
  while (i < limit) {
    const b = bytes[i] as number;
    const cls = BYTE_CLASS[b];
    if (cls === CLASS_WS) {
      i++;
      continue;
    }
    if (cls === CLASS_QUOTE) {
      const end = scanStringEnd(bytes, i + 1);
      if (end < 0) {
        if (final) {
          // An unterminated string at the end of the file: treat what is there as the token.
          st.prevSig = prevSig;
          st.depth = depth;
          dispatchString(h, bytes, i, n, st, kinds, depth, prevSig);
          result.pos = n;
          return result;
        }
        result.pos = i;
        result.incomplete = true;
        st.prevSig = prevSig;
        st.depth = depth;
        return result;
      }
      st.prevSig = prevSig;
      st.depth = depth;
      dispatchString(h, bytes, i, end, st, kinds, depth, prevSig);
      prevSig = QUOTE;
      i = end;
      continue;
    }
    if (cls === CLASS_OPEN) {
      st.prevSig = prevSig;
      st.depth = depth;
      const kind = b === OBJ_OPEN ? KIND_OBJECT : KIND_ARRAY;
      h.open(kind, i);
      if (depth >= kinds.length) {
        const next = new Uint8Array(kinds.length * 2);
        next.set(kinds);
        kinds = next;
        st.kinds = next;
      }
      kinds[depth] = kind;
      depth++;
      prevSig = b;
      i++;
      continue;
    }
    if (cls === CLASS_CLOSE) {
      if (depth > 0) {
        st.prevSig = prevSig;
        st.depth = depth;
        h.close(kinds[depth - 1] as number, i);
        depth--;
      }
      prevSig = b;
      i++;
      continue;
    }
    if (cls === CLASS_SCALAR_START) {
      let j = i + 1;
      while (j < n && SCALAR_CHAR[bytes[j] as number] === 1) j++;
      if (j === n && !final) {
        result.pos = i;
        result.incomplete = true;
        st.prevSig = prevSig;
        st.depth = depth;
        return result;
      }
      st.prevSig = prevSig;
      st.depth = depth;
      h.scalar(bytes, i, j, scalarKind(b));
      prevSig = bytes[j - 1] as number;
      i = j;
      continue;
    }
    if (cls === CLASS_COLON || cls === CLASS_COMMA) {
      prevSig = b;
      i++;
      continue;
    }
    // Any other byte outside a string is not JSON; skip it.
    i++;
  }
  st.prevSig = prevSig;
  st.depth = depth;
  st.kinds = kinds;
  result.pos = i;
  return result;
};

const dispatchString = (
  h: JsonHandler,
  bytes: Uint8Array,
  start: number,
  end: number,
  st: ScanState,
  kinds: Uint8Array,
  depth: number,
  prevSig: number,
) => {
  const isKey =
    depth > 0 && kinds[depth - 1] === KIND_OBJECT && (prevSig === OBJ_OPEN || prevSig === COMMA);
  if (isKey) h.key(bytes, start, end);
  else h.string(bytes, start, end);
  void st;
};

/**
 * Where the first token owned by a region that starts mid-document begins: skips
 * the string or scalar that began before the region (`entry` says which), so
 * the region does not process it twice.
 */
export const skipInherited = (bytes: Uint8Array, entry: EntryState): number => {
  if (entry.inString) {
    const from = entry.escaped ? 1 : 0;
    const end = scanStringEnd(bytes, from);
    return end < 0 ? bytes.length : end;
  }
  if (entry.lastByte !== 0 && SCALAR_CHAR[entry.lastByte] === 1) {
    let i = 0;
    while (i < bytes.length && SCALAR_CHAR[bytes[i] as number] === 1) i++;
    return i;
  }
  return 0;
};

export { ARR_OPEN, COLON };
