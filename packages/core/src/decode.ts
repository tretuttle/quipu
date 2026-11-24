/**
 * Lazy value decoding from byte slices. Nothing here touches more than one
 * value's bytes, strings pass through boundedSlice's limit, and the piece-wise
 * unescape (`unescapePiece`) gives the same bytes however a string is split.
 */
import { decodeUtf8 } from "./boundedSlice.ts";
import { BACKSLASH, QUOTE } from "./bytes.ts";
import { KIND_FALSE, KIND_NULL, KIND_NUMBER, KIND_STRING, KIND_TRUE, type Tape } from "./tape.ts";

/** Keys are decoded whole; a key longer than this is refused. */
export const MAX_KEY_BYTES = 1 << 20;

const decodeEscape = (
  bytes: Uint8Array,
  i: number,
  out: Uint8Array,
  o: number,
): [number, number] => {
  const e = bytes[i + 1] as number;
  i += 2;
  switch (e) {
    case 0x22:
      out[o++] = 0x22;
      break;
    case 0x5c:
      out[o++] = 0x5c;
      break;
    case 0x2f:
      out[o++] = 0x2f;
      break;
    case 0x62:
      out[o++] = 0x08;
      break;
    case 0x66:
      out[o++] = 0x0c;
      break;
    case 0x6e:
      out[o++] = 0x0a;
      break;
    case 0x72:
      out[o++] = 0x0d;
      break;
    case 0x74:
      out[o++] = 0x09;
      break;
    case 0x75: {
      let code = hex4(bytes, i);
      i += 4;
      if (code >= 0xd800 && code <= 0xdbff && bytes[i] === BACKSLASH && bytes[i + 1] === 0x75) {
        const low = hex4(bytes, i + 2);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i += 6;
        }
      }
      o = writeUtf8(out, o, code);
      break;
    }
    default:
      out[o++] = e;
  }
  return [i, o];
};

/** Unescapes the bytes between the quotes of a JSON string into raw UTF-8 bytes; returns the length written. */
export const unescapeBytes = (
  bytes: Uint8Array,
  from: number,
  to: number,
  out: Uint8Array,
  outOffset = 0,
): number => {
  let o = outOffset;
  let i = from;
  while (i < to) {
    if (bytes[i] !== BACKSLASH) {
      let j = i + 1;
      while (j < to && bytes[j] !== BACKSLASH) j++;
      out.set(bytes.subarray(i, j), o);
      o += j - i;
      i = j;
      continue;
    }
    [i, o] = decodeEscape(bytes, i, out, o);
  }
  return o;
};

/**
 * Like unescapeBytes over [from, to), except an escape that starts before `to`
 * is completed from the bytes after `to` (which must be present). The parallel
 * unescape uses it so pieces never cut an escape in half.
 */
const unescapeBytesBounded = (
  bytes: Uint8Array,
  from: number,
  to: number,
  out: Uint8Array,
  outOffset = 0,
): number => {
  let o = outOffset;
  let i = from;
  while (i < to) {
    if (bytes[i] !== BACKSLASH) {
      let j = bytes.indexOf(BACKSLASH, i);
      if (j < 0 || j > to) j = to;
      out.set(bytes.subarray(i, j), o);
      o += j - i;
      i = j;
      continue;
    }
    [i, o] = decodeEscape(bytes, i, out, o);
  }
  return o - outOffset;
};

export const hex4 = (bytes: Uint8Array, at: number) => {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const c = bytes[at + k] as number;
    v = (v << 4) | (c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x61 + 10);
  }
  return v;
};

export const writeUtf8 = (out: Uint8Array, o: number, code: number) => {
  if (code < 0x80) out[o++] = code;
  else if (code < 0x800) {
    out[o++] = 0xc0 | (code >> 6);
    out[o++] = 0x80 | (code & 0x3f);
  } else if (code < 0x10000) {
    out[o++] = 0xe0 | (code >> 12);
    out[o++] = 0x80 | ((code >> 6) & 0x3f);
    out[o++] = 0x80 | (code & 0x3f);
  } else {
    out[o++] = 0xf0 | (code >> 18);
    out[o++] = 0x80 | ((code >> 12) & 0x3f);
    out[o++] = 0x80 | ((code >> 6) & 0x3f);
    out[o++] = 0x80 | (code & 0x3f);
  }
  return o;
};

/** Raw UTF-8 bytes of a string token's content (quotes excluded, escapes resolved); `bytes` holds the token. */
export const stringBytes = (bytes: Uint8Array, start: number, end: number): Uint8Array => {
  const length = end - start - 2;
  if (length < 0) throw new RangeError("malformed string token");
  const out = new Uint8Array(length);
  const n = unescapeBytes(bytes, start + 1, end - 1, out, 0);
  return out.subarray(0, n);
};

/** Decodes a string token to a JS string, within boundedSlice's limit. */
export const decodeString = (bytes: Uint8Array, start: number, end: number, limit?: number) =>
  decodeUtf8(stringBytes(bytes, start, end), limit);

/** Finds the end (exclusive, past the closing quote) of the string that opens at `start`, or -1. */
export const stringEnd = (bytes: Uint8Array, start: number) => {
  let escaped = false;
  for (let i = start + 1; i < bytes.length; i++) {
    const b = bytes[i];
    if (escaped) escaped = false;
    else if (b === BACKSLASH) escaped = true;
    else if (b === QUOTE) return i + 1;
  }
  return -1;
};

/** The source text of a scalar token (strings unescaped), as the user sees it. */
const scalarText = (tape: Tape, i: number, bytes: Uint8Array, limit?: number): string => {
  const start = tape.start(i);
  const end = tape.end(i);
  switch (tape.kind(i)) {
    case KIND_STRING:
      return decodeString(bytes, start, end, limit);
    case KIND_NUMBER:
    case KIND_TRUE:
    case KIND_FALSE:
    case KIND_NULL:
      return decodeUtf8(bytes.subarray(start, end), limit);
    default:
      throw new RangeError(`token ${i} is a container`);
  }
};

/** The JS value of a scalar token, as `JSON.parse` would produce it. */
export const scalarValue = (tape: Tape, i: number, bytes: Uint8Array, limit?: number): unknown => {
  switch (tape.kind(i)) {
    case KIND_STRING:
      return scalarText(tape, i, bytes, limit);
    case KIND_NUMBER:
      return Number(scalarText(tape, i, bytes, limit));
    case KIND_TRUE:
      return true;
    case KIND_FALSE:
      return false;
    case KIND_NULL:
      return null;
    default:
      throw new RangeError(`token ${i} is a container`);
  }
};

/** The member key of token `i`, or undefined for roots and array elements; `bytes` holds the key. */
export const decodeKey = (tape: Tape, i: number, bytes: Uint8Array): string | undefined => {
  const keyStart = tape.keyStart(i);
  if (keyStart === 0xffffffff) return undefined;
  const end = stringEnd(bytes, keyStart);
  if (end < 0) throw new RangeError(`key at ${keyStart} has no closing quote`);
  return decodeString(bytes, keyStart, end, MAX_KEY_BYTES);
};

/**
 * Unescapes the piece [start, end) of a JSON string's content, given `bytes`
 * holding [from, tailEnd) with from ≤ start - lookbehind (or the content start)
 * and tailEnd ≥ min(contentEnd, end + 16). Pieces compose: byte-for-byte, the
 * concatenation over consecutive pieces equals the unescape of the whole content.
 *
 * Boundary rules at `start`: an odd backslash run ending at start - 1 means the
 * byte at start is escaped and belongs to the previous piece's escape (plus four
 * hex digits when it is `u`); a start inside the digits of a live \uXXXX skips
 * to its end; a low surrogate escape right after a high one is the previous
 * piece's too. At `end`, an escape that began before `end` is finished from the
 * tail. Those two rules are mirror images, which is what makes pieces compose.
 */
const pieceStart = (bytes: Uint8Array, from: number, start: number): number => {
  let at = start - from;
  let run = 0;
  while (at - 1 - run >= 0 && bytes[at - 1 - run] === BACKSLASH) run++;
  if ((run & 1) === 1) {
    at += bytes[at] === 0x75 ? 5 : 1;
  } else {
    for (let d = 1; d <= 4; d++) {
      const u = at - d;
      if (
        u >= 1 &&
        bytes[u] === 0x75 &&
        bytes[u - 1] === BACKSLASH &&
        activeBackslash(bytes, u - 1)
      ) {
        at = u + 5;
        break;
      }
    }
  }
  // A low surrogate escape at `at` whose high surrogate escape ends at `at` was consumed
  // with it, whether `at` was the start or landed here by skipping the high escape.
  if (
    at >= 6 &&
    bytes[at] === BACKSLASH &&
    bytes[at + 1] === 0x75 &&
    bytes[at - 6] === BACKSLASH &&
    bytes[at - 5] === 0x75 &&
    activeBackslash(bytes, at - 6)
  ) {
    const high = hex4(bytes, at - 4);
    const low = hex4(bytes, at + 2);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) at += 6;
  }
  return at;
};

export const unescapePiece = (
  bytes: Uint8Array,
  from: number,
  start: number,
  end: number,
): Uint8Array => {
  const at = pieceStart(bytes, from, start);
  const to = end - from;
  if (at >= to) return new Uint8Array(0);
  const out = new Uint8Array(to - at + 8);
  const n = unescapeBytesBounded(bytes, at, to, out);
  return out.slice(0, n);
};

/**
 * {@link unescapePiece} written straight into `out` at `outOffset`, which needs
 * `end - start + 8` bytes of room. Returns the bytes written. Parallel workers
 * use it to fill one shared buffer without a copy per piece.
 */
export const unescapePieceInto = (
  bytes: Uint8Array,
  from: number,
  start: number,
  end: number,
  out: Uint8Array,
  outOffset: number,
): number => {
  const at = pieceStart(bytes, from, start);
  const to = end - from;
  return at >= to ? 0 : unescapeBytesBounded(bytes, at, to, out, outOffset);
};

/** True when the backslash at `i` is not itself escaped (the run ending at i has odd length). */
const activeBackslash = (bytes: Uint8Array, i: number) => {
  let run = 0;
  while (i - run >= 0 && bytes[i - run] === BACKSLASH) run++;
  return (run & 1) === 1;
};

/** Lookbehind and tail a piece needs around [start, end) so no escape is cut. */
export const PIECE_LOOKBEHIND = 256;
export const PIECE_TAIL = 16;

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** A string holds embedded JSON when its unescaped content starts with `{` or `[` after whitespace. */
export const looksLikeJson = (raw: Uint8Array) => {
  let i = 0;
  while (i < raw.length && WS.has(raw[i] as number)) i++;
  return i < raw.length && (raw[i] === 0x7b || raw[i] === 0x5b);
};

/** A clean index has exactly one root token whose bytes span the trimmed input. */
export const isCleanIndex = (tape: Tape, bytes: Uint8Array) => {
  if (tape.count === 0) return false;
  let roots = 0;
  for (let i = 0; i < tape.count; i++) if (tape.parent(i) === -1) roots++;
  if (roots !== 1) return false;
  let end = bytes.length;
  while (end > 0 && WS.has(bytes[end - 1] as number)) end--;
  let start = 0;
  while (start < end && WS.has(bytes[start] as number)) start++;
  return tape.start(0) === start && tape.end(0) === end && tape.kind(0) !== 0;
};
