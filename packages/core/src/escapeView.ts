/**
 * The text a search matches. In a JSON document every backslash sits inside a
 * string and starts an escape, so the text the user sees is the bytes with each
 * escape replaced by the character it stands for (`\u00e9` is `é`, `\"` is `"`).
 * `EscapeView` decodes one window of raw bytes into that text and keeps a sparse
 * table of the escapes, one entry per escape token, so a match found in the
 * decoded bytes maps back to the raw bytes it covers without a per-byte table:
 * a window costs 10 bytes per escape, not 4 bytes per byte.
 *
 * One level only: a stringified JSON document inside a string is matched as the
 * string that holds it, which is the text the string shows before it is expanded
 * (docs/internals/document-engine.md, "Search").
 *
 * Escape pairing is only right from a position that follows a complete token,
 * which `isSafeStart` recognizes from the byte before it alone.
 */
import { BACKSLASH } from "./bytes.ts";
import { hex4, writeUtf8 } from "./decode.ts";

const HEX = new Uint8Array(256);
for (let b = 0x30; b <= 0x39; b++) HEX[b] = 1;
for (let b = 0x41; b <= 0x46; b++) HEX[b] = 1;
for (let b = 0x61; b <= 0x66; b++) HEX[b] = 1;

/**
 * A position whose escape state is known from the byte before it: that byte is
 * not a backslash (it would escape the next byte), not a hex digit and not `u`
 * (it could be inside `\uXXXX`), and the byte itself does not continue a UTF-8
 * sequence. Conservative: `\b` ends in a hex digit, so a position after it is
 * skipped even though it is safe.
 */
export const isSafeStart = (before: number, at: number): boolean =>
  before !== BACKSLASH && before !== 0x75 && HEX[before] === 0 && (at & 0xc0) !== 0x80;

const grow = (array: Uint32Array<ArrayBuffer>, need: number): Uint32Array<ArrayBuffer> => {
  if (array.length >= need) return array;
  const next = new Uint32Array(Math.max(need, array.length * 2));
  next.set(array);
  return next;
};

export class EscapeView {
  /** Decoded bytes of the last `decode`; only `[0, length)` is meaningful. */
  bytes = new Uint8Array(0);
  length = 0;
  /** Raw bytes consumed by the last `decode` (it finishes the escape it was in). */
  consumed = 0;
  private viewAt = new Uint32Array(64);
  private rawAt = new Uint32Array(64);
  private rawLen = new Uint8Array(64);
  private outLen = new Uint8Array(64);
  private tokens = 0;
  private base = 0;

  /**
   * Decodes `raw[from, to)`, finishing an escape that starts before `to` from the
   * bytes after it. Output lands at `bytes[0..length)`.
   */
  decode(raw: Uint8Array, from: number, to: number): void {
    const capacity = Math.max(0, raw.length - from) + 8;
    if (this.bytes.length < capacity)
      this.bytes = new Uint8Array(Math.max(capacity, this.bytes.length * 2));
    const out = this.bytes;
    let tokens = 0;
    let o = 0;
    let i = from;
    while (i < to) {
      let j = raw.indexOf(BACKSLASH, i);
      if (j < 0 || j > to) j = to;
      if (j > i) {
        out.set(raw.subarray(i, j), o);
        o += j - i;
        i = j;
        if (i >= to) break;
      }
      // An escape: one token, also for a surrogate pair written as `\ud83d\ude00`.
      const e = raw[i + 1];
      const start = i;
      const viewStart = o;
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
          let code = hex4(raw, i);
          i += 4;
          if (code >= 0xd800 && code <= 0xdbff && raw[i] === BACKSLASH && raw[i + 1] === 0x75) {
            const low = hex4(raw, i + 2);
            if (low >= 0xdc00 && low <= 0xdfff) {
              code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
              i += 6;
            }
          }
          o = writeUtf8(out, o, code);
          break;
        }
        case undefined:
          // A backslash at the very end of the bytes: nothing follows to escape.
          out[o++] = BACKSLASH;
          i = start + 1;
          break;
        default:
          out[o++] = e;
      }
      if (tokens >= this.viewAt.length) {
        this.viewAt = grow(this.viewAt, tokens + 1);
        this.rawAt = grow(this.rawAt, tokens + 1);
        const rawLen = new Uint8Array(this.viewAt.length);
        rawLen.set(this.rawLen);
        this.rawLen = rawLen;
        const outLen = new Uint8Array(this.viewAt.length);
        outLen.set(this.outLen);
        this.outLen = outLen;
      }
      this.viewAt[tokens] = viewStart;
      this.rawAt[tokens] = start;
      this.rawLen[tokens] = i - start;
      this.outLen[tokens] = o - viewStart;
      tokens++;
    }
    this.tokens = tokens;
    this.length = o;
    this.consumed = i - from;
    this.base = from;
  }

  /** Index of the last escape token that begins at or before view offset `v`, or -1. */
  private tokenAt(v: number): number {
    let lo = 0;
    let hi = this.tokens - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.viewAt[mid] as number) <= v) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /**
   * The first token boundary at or after raw offset `r` (an index into the `raw`
   * given to `decode`) and the view offset that boundary corresponds to.
   */
  boundaryAtOrAfter(r: number): { readonly raw: number; readonly view: number } {
    let lo = 0;
    let hi = this.tokens - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.rawAt[mid] as number) < r) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return { raw: r, view: r - this.base };
    const rawAt = this.rawAt[found] as number;
    const rawLen = this.rawLen[found] as number;
    const viewAt = this.viewAt[found] as number;
    const out = this.outLen[found] as number;
    if (r < rawAt + rawLen) return { raw: rawAt + rawLen, view: viewAt + out };
    return { raw: r, view: viewAt + out + (r - rawAt - rawLen) };
  }

  /** Raw offset (an index into the `raw` given to `decode`) of the byte view offset `v` came from. */
  rawStart(v: number): number {
    const k = this.tokenAt(v);
    if (k < 0) return this.base + v;
    const viewAt = this.viewAt[k] as number;
    const out = this.outLen[k] as number;
    const rawAt = this.rawAt[k] as number;
    if (v < viewAt + out) return rawAt;
    return rawAt + (this.rawLen[k] as number) + (v - viewAt - out);
  }

  /** Raw offset just past the byte at view offset `v`. */
  rawEnd(v: number): number {
    const k = this.tokenAt(v);
    if (k < 0) return this.base + v + 1;
    const viewAt = this.viewAt[k] as number;
    const out = this.outLen[k] as number;
    const rawAt = this.rawAt[k] as number;
    if (v < viewAt + out) return rawAt + (this.rawLen[k] as number);
    return rawAt + (this.rawLen[k] as number) + (v - viewAt - out) + 1;
  }
}
