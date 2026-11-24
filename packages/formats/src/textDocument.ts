/**
 * Whole-text formats (YAML, TOML) are parsed by libraries that need the entire
 * text, so they open up to TEXT_FORMAT_LIMIT bytes and no further:
 * above it the file opens as text. The bytes are read in bounded slices
 * and decoded through `boundedSlice` in pieces cut at character boundaries, so
 * the rule that no module but boundedSlice turns bytes into a string holds here
 * too.
 */
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";

export const TEXT_FORMAT_LIMIT = 256 * 1024 * 1024;

/** Cuts at a UTF-8 character boundary at or before `at` (never inside a multi-byte sequence). */
const boundaryAtOrBefore = (bytes: Uint8Array, at: number) => {
  let i = Math.min(at, bytes.length);
  while (i > 0 && i < bytes.length && ((bytes[i] as number) & 0xc0) === 0x80) i--;
  return i;
};

/** The text of `bytes`, decoded in slices of at most MAX_SLICE_BYTES. Invalid UTF-8 becomes U+FFFD. */
export const decodeLargeText = (bytes: Uint8Array): string => {
  if (bytes.length <= MAX_SLICE_BYTES) return decodeUtf8(bytes);
  const parts: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const end =
      at + MAX_SLICE_BYTES >= bytes.length
        ? bytes.length
        : boundaryAtOrBefore(bytes, at + MAX_SLICE_BYTES);
    parts.push(decodeUtf8(bytes.subarray(at, end)));
    at = end;
  }
  return parts.join("");
};

/**
 * Maps UTF-16 offsets in a decoded text to UTF-8 byte offsets in the bytes it
 * came from. Requests are almost always in increasing order (a walk of the
 * document), which a single forward cursor serves; a request behind the cursor
 * restarts from a checkpoint.
 */
export class ByteOffsets {
  private readonly text: string;
  private readonly ascii: boolean;
  private readonly checkpoints: Uint32Array;
  private cursorChar = 0;
  private cursorByte = 0;
  private static readonly STEP = 4096;

  constructor(text: string, byteLength: number) {
    this.text = text;
    this.ascii = text.length === byteLength;
    const count = Math.ceil(text.length / ByteOffsets.STEP) + 1;
    this.checkpoints = new Uint32Array(this.ascii ? 0 : count);
    if (!this.ascii) {
      let bytes = 0;
      for (let i = 0; i < text.length; i++) {
        if (i % ByteOffsets.STEP === 0) this.checkpoints[i / ByteOffsets.STEP] = bytes;
        bytes += utf8Units(text, i);
        if (isHighSurrogate(text.charCodeAt(i)) && i + 1 < text.length) i++;
      }
    }
  }

  at(char: number): number {
    if (this.ascii) return char;
    if (char < this.cursorChar) {
      const k = Math.floor(char / ByteOffsets.STEP);
      this.cursorChar = k * ByteOffsets.STEP;
      this.cursorByte = this.checkpoints[k] as number;
    }
    let c = this.cursorChar;
    let b = this.cursorByte;
    const text = this.text;
    while (c < char) {
      const code = text.charCodeAt(c);
      if (code < 0x80) b += 1;
      else if (code < 0x800) b += 2;
      else if (isHighSurrogate(code) && c + 1 < text.length) {
        b += 4;
        c++;
      } else b += 3;
      c++;
    }
    this.cursorChar = c;
    this.cursorByte = b;
    return b;
  }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

const utf8Units = (text: string, i: number) => {
  const code = text.charCodeAt(i);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (isHighSurrogate(code) && i + 1 < text.length) return 4;
  return 3;
};

/**
 * The UTF-8 byte offset of a 1-based line and 1-based UTF-16 column, the form
 * parsers report errors in. Lines end at LF. A position past the end of its
 * line or of the text stops at the end of the line or text.
 */
export const byteOffsetOfLineColumn = (bytes: Uint8Array, line: number, column: number): number => {
  let at = 0;
  for (let seen = 1; seen < line; seen++) {
    const next = bytes.indexOf(0x0a, at);
    if (next < 0) return bytes.length;
    at = next + 1;
  }
  let units = column - 1;
  while (units > 0 && at < bytes.length && bytes[at] !== 0x0a) {
    const lead = bytes[at] as number;
    if (lead >= 0xf0) {
      at += 4;
      units -= 2;
    } else {
      at += lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      units -= 1;
    }
  }
  return Math.min(at, bytes.length);
};
