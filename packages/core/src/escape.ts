/**
 * JSON string escaping over bytes, for re-escaping an edited nested document
 * into its parent on save. The escaper is the inverse of decode.ts's unescaper
 * and matches `JSON.stringify` byte for byte: `"` and `\` get a backslash, the
 * C0 controls become `\n`, `\r`, `\t`, `\b`, `\f` or `\u00XX`, everything else
 * (including every non-ASCII byte) is copied. A run without escapes is copied
 * with one `set`.
 */
import { BACKSLASH, QUOTE } from "./bytes.ts";

const HEX = "0123456789abcdef";
const SHORT: Record<number, number> = {
  0x08: 0x62,
  0x09: 0x74,
  0x0a: 0x6e,
  0x0c: 0x66,
  0x0d: 0x72,
};

/** Escaped length of one byte: 1, 2 or 6. */
const escapedByteLength = (b: number) =>
  b === QUOTE || b === BACKSLASH ? 2 : b >= 0x20 ? 1 : SHORT[b] ? 2 : 6;

const needsEscape = (b: number) => b === QUOTE || b === BACKSLASH || b < 0x20;

/** The escaped length of raw bytes [from, to). */
export const escapedLength = (bytes: Uint8Array, from = 0, to = bytes.byteLength) => {
  let n = to - from;
  for (let i = from; i < to; i++) {
    const b = bytes[i] as number;
    if (needsEscape(b)) n += escapedByteLength(b) - 1;
  }
  return n;
};

/** Writes the escaped form of raw bytes [from, to) into `out` at `at`; returns the new offset. `out` must have room (escapedLength). */
export const escapeInto = (
  bytes: Uint8Array,
  from: number,
  to: number,
  out: Uint8Array,
  at: number,
) => {
  let o = at;
  let i = from;
  while (i < to) {
    let j = i;
    while (j < to && !needsEscape(bytes[j] as number)) j++;
    if (j > i) {
      out.set(bytes.subarray(i, j), o);
      o += j - i;
      i = j;
      if (i >= to) break;
    }
    const b = bytes[i] as number;
    out[o++] = BACKSLASH;
    if (b === QUOTE || b === BACKSLASH) out[o++] = b;
    else if (SHORT[b]) out[o++] = SHORT[b] as number;
    else {
      out[o++] = 0x75;
      out[o++] = 0x30;
      out[o++] = 0x30;
      out[o++] = HEX.charCodeAt(b >> 4);
      out[o++] = HEX.charCodeAt(b & 0xf);
    }
    i++;
  }
  return o;
};

/** The escaped form of raw bytes [from, to) as a fresh array. */
export const escapeBytes = (bytes: Uint8Array, from = 0, to = bytes.byteLength) => {
  const out = new Uint8Array(escapedLength(bytes, from, to));
  escapeInto(bytes, from, to, out, 0);
  return out;
};

/**
 * The largest count of raw bytes from `from` whose escaped form fits in `budget`
 * escaped bytes, and that escaped size; a streamed re-escape uses it to cut raw
 * input at an escaped-byte boundary without producing a partial escape.
 */
export const rawBytesFitting = (bytes: Uint8Array, from: number, to: number, budget: number) => {
  let raw = 0;
  let escaped = 0;
  for (let i = from; i < to; i++) {
    const n = escapedByteLength(bytes[i] as number);
    if (escaped + n > budget) break;
    escaped += n;
    raw++;
  }
  return { raw, escaped };
};
