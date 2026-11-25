// @effect-diagnostics preferSchemaOverJson:off - the one place the engine materializes an untyped JSON subtree the user asked for; the byte limit is the guard.
/**
 * The only module in the engine that turns bytes into a JS string or value
 * (enforced by the `no-whole-document-materialization` lint rule). Every function
 * takes a byte limit and refuses input above it, so nothing here can ever hold a
 * document: a 2 GiB file is 32 of these limits, and V8 would not hold the string
 * anyway. The limit is MAX_SLICE_BYTES, the largest subtree the product shows or
 * runs jq over.
 */
import { MAX_SLICE_BYTES, SliceTooLargeError } from "@quipu/contracts/engine";

const decoder = new TextDecoder("utf-8");

/**
 * A caller's byte budget, refused above MAX_SLICE_BYTES. The budget is what the
 * caller asked for; framing the engine reads around it (a string's quotes, an
 * escape tail, base64's 4:3 expansion) never counts against it.
 */
export const checkedLimit = (limit: number): number => {
  if (!(limit > 0 && limit <= MAX_SLICE_BYTES)) {
    const bytes = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
    throw new SliceTooLargeError({ bytes, limit: MAX_SLICE_BYTES });
  }
  return limit;
};

const assertWithinLimit = (bytes: number, limit: number) => {
  if (bytes > checkedLimit(limit)) throw new SliceTooLargeError({ bytes, limit });
};

/** UTF-8 text of at most `limit` bytes. */
export const decodeUtf8 = (bytes: Uint8Array, limit = MAX_SLICE_BYTES): string => {
  assertWithinLimit(bytes.byteLength, limit);
  // TextDecoder refuses a view over a SharedArrayBuffer (a child document's bytes); the copy is
  // within the limit just checked.
  const shared =
    typeof SharedArrayBuffer === "function" && bytes.buffer instanceof SharedArrayBuffer;
  return decoder.decode(shared ? bytes.slice() : bytes);
};

/** `JSON.parse` of at most `limit` bytes of UTF-8. */
export const parseJsonSlice = (bytes: Uint8Array, limit = MAX_SLICE_BYTES): unknown =>
  JSON.parse(decodeUtf8(bytes, limit));

/** `JSON.parse` of a JSON string token `[quote..quote]` of at most `limit` bytes of UTF-8. */
export const parseJsonStringSlice = (bytes: Uint8Array, limit = MAX_SLICE_BYTES): string => {
  const parsed: unknown = JSON.parse(decodeUtf8(bytes, limit));
  return typeof parsed === "string" ? parsed : String(parsed);
};

/** `JSON.parse` of an already-decoded string bounded to `limit` UTF-16 code units (`<= MAX_SLICE_BYTES`). */
export const parseJsonTextSlice = (text: string, limit = MAX_SLICE_BYTES): unknown => {
  assertWithinLimit(text.length, limit);
  return JSON.parse(text);
};

/** The bytes `[start, end)` of a Blob, at most `limit` of them. */
export const readBlobSlice = async (
  blob: Blob,
  start: number,
  end: number,
  limit = MAX_SLICE_BYTES,
): Promise<Uint8Array> => {
  const from = Math.max(0, Math.min(start, blob.size));
  const to = Math.max(from, Math.min(end, blob.size));
  assertWithinLimit(to - from, limit);
  return new Uint8Array(await blob.slice(from, to).arrayBuffer());
};

export interface MappedText {
  readonly text: string;
  /**
   * Byte offset in the input of each UTF-16 unit of `text`, with one more entry
   * for the end; null when the input is ASCII and units are bytes.
   */
  readonly offsets: Uint32Array | null;
}

const utf16 = new TextDecoder("utf-16le", { ignoreBOM: true });

const isAscii = (bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length; i++) if ((bytes[i] as number) >= 0x80) return false;
  return true;
};

/**
 * UTF-8 text of at most `limit` bytes together with where each UTF-16 unit came
 * from, so a regex match (an index in the string) maps back to bytes. Invalid
 * input becomes U+FFFD exactly as `TextDecoder` does it (the WHATWG maximal
 * subpart rule), which keeps the mapping exact where a decoder alone would hide it.
 */
export const decodeUtf8Mapped = (bytes: Uint8Array, limit = MAX_SLICE_BYTES): MappedText => {
  assertWithinLimit(bytes.byteLength, limit);
  if (isAscii(bytes)) return { text: decoder.decode(bytes), offsets: null };
  const n = bytes.length;
  const units = new Uint16Array(n + 1);
  const offsets = new Uint32Array(n + 2);
  let u = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let code = 0;
  let sequenceStart = 0;
  const emit = (value: number, at: number) => {
    if (value >= 0x10000) {
      const v = value - 0x10000;
      units[u] = 0xd800 | (v >> 10);
      offsets[u++] = at;
      units[u] = 0xdc00 | (v & 0x3ff);
      offsets[u++] = at;
    } else {
      units[u] = value;
      offsets[u++] = at;
    }
  };
  for (let i = 0; i < n; i++) {
    const b = bytes[i] as number;
    if (needed === 0) {
      sequenceStart = i;
      if (b < 0x80) emit(b, i);
      else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        code = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        code = b & 0xf;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        code = b & 0x7;
      } else emit(0xfffd, i);
      continue;
    }
    if (b < lower || b > upper) {
      needed = 0;
      seen = 0;
      code = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(0xfffd, sequenceStart);
      i--;
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    code = (code << 6) | (b & 0x3f);
    seen++;
    if (seen === needed) {
      emit(code, sequenceStart);
      needed = 0;
      seen = 0;
      code = 0;
    }
  }
  if (needed !== 0) emit(0xfffd, sequenceStart);
  offsets[u] = n;
  return { text: utf16.decode(units.subarray(0, u)), offsets: offsets.subarray(0, u + 1) };
};
