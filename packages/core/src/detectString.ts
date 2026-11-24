/**
 * Detection of encoded values inside strings. Each rule reads the head of the
 * string's unescaped bytes (at most {@link STRING_HEAD_BYTES}) plus the little
 * the enclosing object says about it (a HAR body's `mimeType` and `encoding`),
 * never the whole value: a body of hundreds of MiB is classified by its first
 * 4 KiB. Rules are ordered cheapest and most specific first, and a string can
 * match more than one (base64 of JSON is `base64` first, and its decode says
 * what is inside).
 */
import { type DecoderKind } from "@quipu/contracts/engine";

import { decodeUtf8 } from "./boundedSlice.ts";
import { Base64Decoder, base64MaxDecoded } from "./base64.ts";
import { decodeJwt, decodeJwtHeader, jwtAlgorithm, MAX_JWT_BYTES } from "./jwt.ts";
import { MAX_GRAPHQL_BYTES, prettyGraphql } from "./graphqlPretty.ts";
import { scanJson } from "./jsonScan.ts";
import { type Sniffed, sniffBytes } from "./sniff.ts";

/** How much of a string's unescaped start detection reads. */
export const STRING_HEAD_BYTES = 4096;

/** What the enclosing object says about a string, when it says anything. */
export interface StringContext {
  readonly key: string | null;
  readonly mimeType: string | null;
  readonly encoding: string | null;
}

export const NO_CONTEXT: StringContext = { key: null, mimeType: null, encoding: null };

export interface StringDetection {
  readonly kind: DecoderKind;
  readonly label: string;
  /** For base64: the type of the decoded content when it is known. */
  readonly mime: string | null;
}

const isSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

const leadingSpace = (bytes: Uint8Array) => {
  let i = 0;
  while (i < bytes.length && isSpace(bytes[i] as number)) i++;
  return i;
};

const trimmedEnd = (bytes: Uint8Array) => {
  let end = bytes.length;
  while (end > 0 && isSpace(bytes[end - 1] as number)) end--;
  return end;
};

const mimeBase = (mime: string | null) => mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const NDJSON_MIMES = new Set([
  "application/x-ndjson",
  "application/ndjson",
  "application/jsonl",
  "application/x-jsonlines",
  "application/jsonlines",
  "application/json-seq",
]);

const detectJwt = (head: Uint8Array, truncated: boolean): StringDetection | null => {
  const start = leadingSpace(head);
  const bytes = start === 0 ? head : head.subarray(start);
  // Header segments of real tokens are `{"…` in base64url, which is `eyJ`.
  const bearer = bytes[0] === 0x42 ? 7 : 0;
  if (bytes[bearer] !== 0x65 || bytes[bearer + 1] !== 0x79) return null;
  if (!truncated) {
    const decoded = bytes.length <= MAX_JWT_BYTES ? decodeJwt(bytes) : null;
    return decoded ? { kind: "jwt", label: jwtLabel(decoded.header), mime: null } : null;
  }
  // The token is longer than the head: the header and the shape are all there is to go on.
  for (let i = bearer; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte !== 0x2e && !isUrlSafe(byte)) return null;
  }
  const header = decodeJwtHeader(bytes);
  return header ? { kind: "jwt", label: jwtLabel(header), mime: null } : null;
};

const isUrlSafe = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2d ||
  byte === 0x5f;

const jwtLabel = (header: Uint8Array) => {
  const algorithm = jwtAlgorithm(header);
  return algorithm ? `JWT · ${algorithm}` : "JWT";
};

const detectNdjson = (head: Uint8Array, truncated: boolean, context: StringContext) => {
  const start = leadingSpace(head);
  const first = head[start];
  if (first !== 0x7b && first !== 0x5b) return null;
  const hinted = NDJSON_MIMES.has(mimeBase(context.mimeType));
  let lines = 0;
  let at = start;
  while (at < head.length) {
    let nl = head.indexOf(0x0a, at);
    const terminated = nl >= 0;
    if (!terminated) nl = head.length;
    let end = nl;
    while (end > at && isSpace(head[end - 1] as number)) end--;
    let from = at;
    while (from < end && isSpace(head[from] as number)) from++;
    if (end > from) {
      const lead = head[from];
      if (lead !== 0x7b && lead !== 0x5b) return null;
      const scan = scanJson(head, from, end);
      if (scan.status === "invalid") return null;
      // A line that ends before the head does must be a whole value.
      if (scan.status === "prefix" && (terminated || !truncated)) return null;
      lines++;
    }
    at = nl + 1;
  }
  if (lines >= 2 || (lines === 1 && hinted)) {
    return { kind: "ndjson", label: "NDJSON", mime: null } satisfies StringDetection;
  }
  return null;
};

const detectJson = (head: Uint8Array, truncated: boolean): StringDetection | null => {
  const start = leadingSpace(head);
  const first = head[start];
  if (first !== 0x7b && first !== 0x5b) return null;
  const scan = scanJson(head, start);
  if (scan.status === "invalid") return null;
  if (scan.status === "complete") return { kind: "json", label: "JSON", mime: null };
  // A prefix: valid so far, so a string that goes on is JSON only when the head says something.
  return truncated && scan.end - start >= 2 ? { kind: "json", label: "JSON", mime: null } : null;
};

const KEYWORDS = ["query", "mutation", "subscription", "fragment"] as const;
const isNameStart = (byte: number) =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;
const isNameByte = (byte: number) => isNameStart(byte) || (byte >= 0x30 && byte <= 0x39);

/**
 * A document starts with a keyword, or with an anonymous `{ selection }`. The
 * second needs more than a name between the braces: URL templates such as
 * `{CACHEBUSTER}` and `{uid}` are valid one-field queries and common in HAR
 * strings, so a bare braced word counts only with a sub-selection, arguments
 * or a spread after it.
 */
const startsGraphql = (head: Uint8Array, hinted: boolean) => {
  let i = leadingSpace(head);
  // Comments before the first definition.
  while (head[i] === 0x23) {
    const nl = head.indexOf(0x0a, i);
    if (nl < 0) return false;
    i += leadingSpace(head.subarray(nl + 1)) + (nl + 1 - i);
  }
  const rest = head.subarray(i);
  if (rest[0] === 0x7b) {
    const next = leadingSpace(rest.subarray(1)) + 1;
    if (!(isNameStart(rest[next] as number) || rest[next] === 0x2e)) return false;
    if (hinted) return true;
    for (let k = next; k < rest.length; k++) {
      const byte = rest[k] as number;
      if (byte === 0x7b || byte === 0x28 || byte === 0x2e) return true;
      if (byte === 0x7d) return false;
    }
    return false;
  }
  for (const word of KEYWORDS) {
    let hit = rest.length > word.length;
    for (let k = 0; hit && k < word.length; k++) hit = rest[k] === word.charCodeAt(k);
    if (hit && !isNameByte(rest[word.length] as number)) return true;
  }
  return false;
};

const detectGraphql = (
  head: Uint8Array,
  truncated: boolean,
  context: StringContext,
): StringDetection | null => {
  const hinted = context.key === "query" || mimeBase(context.mimeType) === "application/graphql";
  if (!startsGraphql(head, hinted)) return null;
  if (truncated) {
    // Too long to parse from the head; the keyword and an opening brace are the evidence.
    const braces = head.indexOf(0x7b) >= 0;
    return braces && (hinted || head.length >= 64)
      ? { kind: "graphql", label: "GraphQL", mime: null }
      : null;
  }
  if (head.length > MAX_GRAPHQL_BYTES) return null;
  const pretty = prettyGraphql(decodeUtf8(head));
  if (!pretty) return null;
  const first = pretty.operations[0];
  const name = first ? [first.type, first.name].filter(Boolean).join(" ") : "";
  return { kind: "graphql", label: name ? `GraphQL · ${name}` : "GraphQL", mime: null };
};

const FORM_NAME = new Uint8Array(256);
for (let b = 0; b < 256; b++) {
  const c = String.fromCharCode(b);
  if (/[A-Za-z0-9_.\-[\]%+~!*'():,]/.test(c)) FORM_NAME[b] = 1;
}

const detectForm = (
  head: Uint8Array,
  truncated: boolean,
  context: StringContext,
): StringDetection | null => {
  let from = 0;
  if (head[0] === 0x3f) from = 1;
  let end = head.length;
  while (end > from && isSpace(head[end - 1] as number)) end--;
  if (end - from < 3) return null;
  const hinted = mimeBase(context.mimeType) === "application/x-www-form-urlencoded";
  let pairs = 0;
  let start = from;
  for (let i = from; i <= end; i++) {
    if (i < end) {
      const byte = head[i] as number;
      if (byte <= 0x20 || byte >= 0x7f) return null;
      if (byte !== 0x26) continue;
    }
    // A segment [start, i). The last one of a cut head may be partial.
    const lastPartial = truncated && i === end;
    if (i > start) {
      let eq = start;
      while (eq < i && head[eq] !== 0x3d) eq++;
      if (eq === start) return null;
      for (let k = start; k < eq; k++) if (FORM_NAME[head[k] as number] !== 1) return null;
      if (eq === i && !lastPartial) return null;
      if (eq < i || lastPartial) pairs++;
    }
    start = i + 1;
  }
  // One pair alone is a cookie, a header parameter or a query string as often as a form:
  // it is a form only when the enclosing object says so.
  if (pairs >= 2 || (pairs === 1 && hinted)) return { kind: "form", label: "form", mime: null };
  return null;
};

/**
 * An SVG document held as text (a HAR body whose `mimeType` is `image/svg+xml`
 * and that carries no `encoding`). It is previewed as an image, never inline.
 */
const detectSvg = (head: Uint8Array, context: StringContext): StringDetection | null => {
  const window = head.subarray(0, 2048);
  const text = decodeUtf8(window.subarray(0, utf8Cut(window)));
  // The root element is <svg>: only a prolog (XML declaration, comments, doctype) may come first.
  const match =
    /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg(?=[\s>/])/i.exec(
      text,
    );
  if (!match) return null;
  const declared = mimeBase(context.mimeType) === "image/svg+xml";
  return declared || text.includes("http://www.w3.org/2000/svg")
    ? { kind: "svg", label: "SVG image", mime: "image/svg+xml" }
    : null;
};

/** The longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
const utf8Cut = (bytes: Uint8Array) => {
  let end = bytes.length;
  let back = 0;
  while (end > 0 && back < 3 && ((bytes[end - 1] as number) & 0xc0) === 0x80) {
    end--;
    back++;
  }
  if (end > 0 && (bytes[end - 1] as number) >= 0xc0) end--;
  return end;
};

const B64_CHAR = new Uint8Array(256);
for (const range of [
  [0x41, 0x5a],
  [0x61, 0x7a],
  [0x30, 0x39],
]) {
  for (let b = range[0] as number; b <= (range[1] as number); b++) B64_CHAR[b] = 1;
}
for (const b of [0x2b, 0x2f, 0x2d, 0x5f]) B64_CHAR[b] = 1;

/**
 * The shortest base64 (without padding) taken on its own, with no key or
 * encoding saying so: `eyJwYWdlIjoyfQ==` (`{"page":2}`, a paging cursor) is 14.
 * Below {@link SHORT_UNHINTED_BASE64} such a string counts only when it decodes
 * to a JSON object or array: short runs of letters and digits are too often
 * names and ids that happen to decode.
 */
const MIN_UNHINTED_BASE64 = 12;
const SHORT_UNHINTED_BASE64 = 24;
const DATA_URL = /^data:([^;,]*)((?:;[^;,]*)*),/;
const DATA_URL_PREFIX_BYTES = 256;

/**
 * The object names this string as base64: a HAR body (`text` beside
 * `encoding: "base64"`; its siblings `mimeType` and `encoding` are not the
 * body), or a key that says so.
 */
const b64Hint = (context: StringContext) =>
  (context.encoding?.toLowerCase() === "base64" && context.key === "text") ||
  (context.key !== null && /(^|[_-])(b64|base64)$/i.test(context.key));

/** The decoded head of base64 text (up to `decoded` bytes), and whether every byte was base64. */
const decodePrefix = (bytes: Uint8Array, from: number, to: number, decoded: number) => {
  const chars = Math.min(to - from, Math.ceil(decoded / 3) * 4);
  const out = new Uint8Array(base64MaxDecoded(chars));
  const decoder = new Base64Decoder();
  const n = decoder.push(bytes, from, from + chars, out, 0);
  return { bytes: out.subarray(0, n), clean: decoder.invalid === 0 };
};

const detectBase64 = (
  head: Uint8Array,
  truncated: boolean,
  context: StringContext,
): StringDetection | null => {
  const hinted = b64Hint(context);
  // data: URLs name the type themselves.
  if (head[0] === 0x64 && head[1] === 0x61 && head[2] === 0x74 && head[3] === 0x61) {
    const prefix = decodeUtf8(head.subarray(0, Math.min(head.length, DATA_URL_PREFIX_BYTES)));
    const match = DATA_URL.exec(prefix);
    if (match && /;base64$/i.test(match[2] ?? "")) {
      const mime = match[1] || "text/plain";
      return { kind: "base64", label: `base64 · ${mime}`, mime };
    }
    return null;
  }
  const from = leadingSpace(head);
  let end = trimmedEnd(head);
  // Padding is at most two `=` and only at the very end of the whole string.
  let padding = 0;
  while (end > from && head[end - 1] === 0x3d && padding < 2) {
    end--;
    padding++;
  }
  if (padding > 0 && truncated) return null;
  const length = end - from;
  if (length < (truncated ? 128 : hinted ? 4 : MIN_UNHINTED_BASE64)) return null;
  let hex = true;
  let digits = true;
  let newlines = 0;
  let chars = 0;
  for (let i = from; i < end; i++) {
    const byte = head[i] as number;
    if (byte === 0x0a || byte === 0x0d) {
      if (byte === 0x0a) newlines++;
      continue;
    }
    if (B64_CHAR[byte] !== 1) return null;
    chars++;
    if (!((byte >= 0x30 && byte <= 0x39) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x66)))
      hex = false;
    if (!(byte >= 0x30 && byte <= 0x39)) digits = false;
  }
  if (!truncated && chars % 4 === 1) return null;
  if (!hinted && (hex || digits)) return null;
  // Wrapped lines are base64 only when they are regular (MIME wraps at 64 or 76).
  if (newlines > 0 && !hinted) {
    const first = head.indexOf(0x0a, from);
    if (first < 32 || first > 200) return null;
  }
  const decoded = decodePrefix(head, from, end, 512);
  if (!decoded.clean) return null;
  const first = decoded.bytes[0];
  if (!hinted && length < SHORT_UNHINTED_BASE64 && first !== 0x7b && first !== 0x5b) return null;
  const sniffed: Sniffed = sniffBytes(decoded.bytes);
  const declared = mimeBase(context.mimeType);
  const known = sniffed.mime !== "application/octet-stream";
  if (!known && !hinted) return null;
  if (sniffed.kind === "text" && !hinted && decoded.bytes.length < 8) return null;
  const mime = known ? sniffed.mime : declared || null;
  return { kind: "base64", label: mime ? `base64 · ${mime}` : "base64", mime };
};

/**
 * What `head` (the unescaped start of a string) can be decoded as, in the order
 * the tree should offer. `truncated` says the string goes on past the head.
 */
export const detectString = (
  head: Uint8Array,
  truncated: boolean,
  context: StringContext = NO_CONTEXT,
): ReadonlyArray<StringDetection> => {
  if (head.length < 2) return [];
  const found: StringDetection[] = [];
  const add = (detection: StringDetection | null) => {
    if (detection) found.push(detection);
  };
  add(detectJwt(head, truncated));
  const ndjson = detectNdjson(head, truncated, context);
  if (ndjson) found.push(ndjson);
  else add(detectJson(head, truncated));
  add(detectSvg(head, context));
  add(detectGraphql(head, truncated, context));
  add(detectForm(head, truncated, context));
  add(detectBase64(head, truncated, context));
  return found;
};
