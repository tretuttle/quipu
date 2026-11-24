/**
 * Content sniffing for decoded bytes: a short list of magic numbers for the
 * file types HAR bodies and API payloads carry, and a UTF-8 text test. It reads
 * at most the head it is given (a few hundred bytes decide every case).
 */

export type SniffKind = "image" | "text" | "gzip" | "binary";

export interface Sniffed {
  readonly kind: SniffKind;
  readonly mime: string;
}

const startsWith = (bytes: Uint8Array, magic: ReadonlyArray<number>, at = 0) => {
  if (bytes.length < at + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[at + i] !== magic[i]) return false;
  return true;
};

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const WEBP = ascii("WEBP");
const RIFF = ascii("RIFF");
const FTYP = ascii("ftyp");

interface Magic {
  readonly magic: ReadonlyArray<number>;
  readonly at?: number;
  readonly mime: string;
  readonly kind: SniffKind;
}

const MAGICS: ReadonlyArray<Magic> = [
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png", kind: "image" },
  { magic: [0xff, 0xd8, 0xff], mime: "image/jpeg", kind: "image" },
  { magic: ascii("GIF87a"), mime: "image/gif", kind: "image" },
  { magic: ascii("GIF89a"), mime: "image/gif", kind: "image" },
  { magic: [0x00, 0x00, 0x01, 0x00], mime: "image/x-icon", kind: "image" },
  { magic: ascii("BM"), mime: "image/bmp", kind: "image" },
  { magic: [0x1f, 0x8b, 0x08], mime: "application/gzip", kind: "gzip" },
  { magic: ascii("%PDF-"), mime: "application/pdf", kind: "binary" },
  { magic: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip", kind: "binary" },
  { magic: ascii("wOF2"), mime: "font/woff2", kind: "binary" },
  { magic: ascii("wOFF"), mime: "font/woff", kind: "binary" },
  { magic: [0x00, 0x61, 0x73, 0x6d], mime: "application/wasm", kind: "binary" },
  { magic: ascii("OggS"), mime: "audio/ogg", kind: "binary" },
  { magic: ascii("ID3"), mime: "audio/mpeg", kind: "binary" },
];

const TEXT_SNIFF_BYTES = 1024;
const SVG_SEARCH_BYTES = 512;

/** True when `bytes` is UTF-8 (a sequence cut at the end is allowed) with almost no control bytes. */
export const looksLikeText = (bytes: Uint8Array): boolean => {
  const n = Math.min(bytes.length, TEXT_SNIFF_BYTES);
  if (n === 0) return false;
  let control = 0;
  let i = 0;
  while (i < n) {
    const byte = bytes[i] as number;
    let extra = 0;
    if (byte < 0x80) {
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c)
        control++;
      else if (byte === 0x7f) control++;
    } else if (byte >= 0xc2 && byte <= 0xdf) extra = 1;
    else if (byte >= 0xe0 && byte <= 0xef) extra = 2;
    else if (byte >= 0xf0 && byte <= 0xf4) extra = 3;
    else return false;
    for (let k = 1; k <= extra; k++) {
      // A sequence cut by the end of the head is fine; one cut by a bad byte is not.
      if (i + k >= n) break;
      if (((bytes[i + k] as number) & 0xc0) !== 0x80) return false;
    }
    i += 1 + extra;
  }
  return control / n < 0.01;
};

const firstNonSpace = (bytes: Uint8Array) => {
  let i = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || (bytes[i] as number) <= 0x0d)) i++;
  return i;
};

const indexOfAscii = (bytes: Uint8Array, needle: string, limit: number) => {
  const n = ascii(needle);
  const end = Math.min(bytes.length, limit) - n.length;
  for (let i = 0; i <= end; i++) {
    let hit = true;
    for (let k = 0; k < n.length; k++) {
      if (((bytes[i + k] as number) | 0x20) !== n[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
};

/** Names what `head` (the first bytes of decoded content) is. */
export const sniffBytes = (head: Uint8Array): Sniffed => {
  for (const m of MAGICS) {
    if (startsWith(head, m.magic, m.at ?? 0)) return { kind: m.kind, mime: m.mime };
  }
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) {
    return { kind: "image", mime: "image/webp" };
  }
  if (startsWith(head, FTYP, 4)) {
    let brand = "";
    for (let i = 8; i < Math.min(12, head.length); i++)
      brand += String.fromCharCode(head[i] as number);
    if (brand === "avif" || brand === "avis") return { kind: "image", mime: "image/avif" };
    if (brand === "heic" || brand === "heix") return { kind: "image", mime: "image/heic" };
    return { kind: "binary", mime: "video/mp4" };
  }
  if (!looksLikeText(head)) return { kind: "binary", mime: "application/octet-stream" };
  const at = firstNonSpace(head);
  const first = head[at];
  if (indexOfAscii(head.subarray(at), "<svg", SVG_SEARCH_BYTES) >= 0 && first === 0x3c) {
    return { kind: "image", mime: "image/svg+xml" };
  }
  if (first === 0x7b || first === 0x5b) return { kind: "text", mime: "application/json" };
  if (first === 0x3c) {
    const rest = head.subarray(at);
    if (indexOfAscii(rest, "<!doctype html", 20) === 0 || indexOfAscii(rest, "<html", 8) === 0) {
      return { kind: "text", mime: "text/html" };
    }
    if (startsWith(rest, ascii("<?xml"))) return { kind: "text", mime: "application/xml" };
  }
  return { kind: "text", mime: "text/plain" };
};

/** The kind a declared MIME type implies, for bodies whose bytes do not say. */
export const kindOfMime = (mime: string): SniffKind => {
  const type = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded" ||
    type === "application/graphql"
  ) {
    return "text";
  }
  if (type === "application/gzip" || type === "application/x-gzip") return "gzip";
  return "binary";
};
