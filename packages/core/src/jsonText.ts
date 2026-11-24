/**
 * Builds JSON text from decoded pieces: the documents the tree shows as the
 * children of a JWT, a form body or an NDJSON body are generated here as bytes,
 * then indexed like any child document. Every function works on bytes and is
 * bounded by its input; nothing parses.
 */

const HEX = "0123456789abcdef";

/** The JSON string literal (quotes included) for UTF-8 `content`. */
export const jsonStringBytes = (content: Uint8Array): Uint8Array => {
  let extra = 2;
  for (const byte of content) {
    if (byte === 0x22 || byte === 0x5c) extra += 1;
    else if (byte < 0x20) extra += 5;
  }
  const out = new Uint8Array(content.length + extra);
  let o = 0;
  out[o++] = 0x22;
  for (const byte of content) {
    if (byte === 0x22 || byte === 0x5c) {
      out[o++] = 0x5c;
      out[o++] = byte;
    } else if (byte === 0x0a) {
      out[o++] = 0x5c;
      out[o++] = 0x6e;
    } else if (byte === 0x0d) {
      out[o++] = 0x5c;
      out[o++] = 0x72;
    } else if (byte === 0x09) {
      out[o++] = 0x5c;
      out[o++] = 0x74;
    } else if (byte < 0x20) {
      out[o++] = 0x5c;
      out[o++] = 0x75;
      out[o++] = 0x30;
      out[o++] = 0x30;
      out[o++] = HEX.charCodeAt(byte >> 4);
      out[o++] = HEX.charCodeAt(byte & 15);
    } else out[o++] = byte;
  }
  out[o++] = 0x22;
  return out.subarray(0, o);
};

/** Concatenates byte pieces. */
export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
};

const ASCII = new TextEncoder();
/** ASCII text as bytes; for punctuation and fixed keys only. */
export const asciiBytes = (text: string) => ASCII.encode(text);
