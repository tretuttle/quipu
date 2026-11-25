/**
 * Base64 decoding of text that sits inside a JSON string, so it may carry the
 * JSON escapes serializers add: `\/` (PHP's json_encode writes every slash that
 * way), `\u002f`, and `\n`/`\r` line breaks from MIME-wrapped bodies. Both
 * alphabets (`+/` and `-_`) are accepted, whitespace and padding are skipped.
 *
 * The decoder is a state machine so a body streams through it in bounded steps:
 * a body of hundreds of MiB is decoded 4 MiB at a time and never exists as one string.
 */
const TABLE = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  TABLE["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;
}
TABLE[0x2d] = 62; // -
TABLE[0x5f] = 63; // _

const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const PAD = 0x3d;

const hexValue = (byte: number) => (byte <= 0x39 ? byte - 0x30 : (byte | 0x20) - 0x61 + 10);
const isHex = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x66);

/** Upper bound on the bytes decoding `chars` base64 characters can write. */
export const base64MaxDecoded = (chars: number) => Math.ceil(chars / 4) * 3 + 3;

/**
 * Decodes an ASCII base64 string (standard `+/` or URL `-_`, optional whitespace/`=`)
 * directly into a `Uint8Array` without UTF-8 encoding via `TextEncoder`.
 * Returns `null` if empty, non-ASCII, contains JSON backslash escapes, or contains invalid chars.
 */
export function decodeBase64Ascii(text: string): Uint8Array | null {
  const n = text.length;
  if (n === 0) return null;
  const out = new Uint8Array(base64MaxDecoded(n));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80) return null;
    const v = TABLE[code] as number;
    if (v < 0) {
      if (code === 0x0a || code === 0x0d || code === 0x20 || code === 0x09 || code === PAD) {
        continue;
      }
      return null;
    }
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === 0 ? null : out.subarray(0, o);
}

export class Base64Decoder {
  private acc = 0;
  private bits = 0;
  private pending: "none" | "escape" | "unicode" = "none";
  private unicode = 0;
  private unicodeDigits = 0;
  /** Bytes that are neither alphabet, padding, whitespace nor a recognized escape. */
  invalid = 0;
  /** Alphabet characters consumed. */
  chars = 0;
  /**
   * Escapes and whitespace seen: each one makes raw positions stop being
   * 4-character aligned, so a decode split into pieces is only valid at 0.
   */
  shifted = 0;

  /**
   * Decodes `text[from, to)` into `out` from `outOffset`, which must have room
   * for {@link base64MaxDecoded}(to - from) bytes. Returns the bytes written.
   */
  push(text: Uint8Array, from: number, to: number, out: Uint8Array, outOffset = 0): number {
    let o = outOffset;
    for (let i = from; i < to; i++) {
      let byte = text[i] as number;
      if (this.pending === "escape") {
        this.pending = "none";
        this.shifted++;
        if (byte === SLASH) {
          // `\/`
        } else if (byte === 0x75) {
          this.pending = "unicode";
          this.unicode = 0;
          this.unicodeDigits = 0;
          continue;
        } else {
          // `\n`, `\r`, `\t` and any other escape carry no data.
          if (!(byte === 0x6e || byte === 0x72 || byte === 0x74)) this.invalid++;
          continue;
        }
      } else if (this.pending === "unicode") {
        if (!isHex(byte)) {
          this.pending = "none";
          this.invalid++;
          continue;
        }
        this.unicode = (this.unicode << 4) | hexValue(byte);
        if (++this.unicodeDigits < 4) continue;
        this.pending = "none";
        if (this.unicode >= 0x80) {
          this.invalid++;
          continue;
        }
        byte = this.unicode;
      } else if (byte === BACKSLASH) {
        this.pending = "escape";
        continue;
      }
      const v = TABLE[byte] as number;
      if (v < 0) {
        if (byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09) this.shifted++;
        else if (byte !== PAD) this.invalid++;
        continue;
      }
      this.chars++;
      this.acc = ((this.acc << 6) | v) & 0xffffff;
      this.bits += 6;
      if (this.bits >= 8) {
        this.bits -= 8;
        out[o++] = (this.acc >> this.bits) & 0xff;
      }
    }
    return o - outOffset;
  }
}
