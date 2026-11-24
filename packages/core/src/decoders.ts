/**
 * The decoders for encoded values inside strings. Detection reads the first
 * 4 KiB of a string; a decode reads what it needs and is bounded: nothing here
 * holds more than {@link MAX_SLICE_BYTES} of one value, and a base64 body of
 * hundreds of MiB is classified and shown from the head of its decoded bytes.
 * The engine host supplies a {@link StringAccess} for the string at hand;
 * this module knows the formats and nothing about tapes.
 */
import {
  type Decoded,
  type Detection,
  type ImagePreview,
  MAX_SLICE_BYTES,
  type NestedDocument,
  NotDecodableError,
  type NodeRef,
  SliceTooLargeError,
  type DecoderKind,
} from "@quipu/contracts/engine";

import { decodeUtf8 } from "./boundedSlice.ts";
import { detectString, STRING_HEAD_BYTES, type StringContext } from "./detectString.ts";
import { formToJson, MAX_FORM_BYTES, parseForm } from "./form.ts";
import { inflateGzip } from "./gzip.ts";
import { MAX_GRAPHQL_BYTES, prettyGraphql } from "./graphqlPretty.ts";
import { prettyJson } from "./jsonScan.ts";
import { asciiBytes, concatBytes, jsonStringBytes } from "./jsonText.ts";
import { decodeJwt, jwtAlgorithm, MAX_JWT_BYTES } from "./jwt.ts";
import { ndjsonToArray, splitLines } from "./ndjson.ts";
import { kindOfMime, type Sniffed, sniffBytes } from "./sniff.ts";

/** How much of a decoded value the Inspector gets as text. */
const VIEW_HEAD_BYTES = 16 * 1024;
const HEX_BYTES = 256;
const NDJSON_VIEW_LINES = 100;
const NDJSON_LINE_CHARS = 2000;
const BASE64_STEP_BYTES = 4 * 1024 * 1024;

/** What the engine host gives a decoder to work on one string. */
export interface StringAccess {
  readonly ref: NodeRef;
  /** Length in bytes of the string's escaped content (between the quotes). */
  readonly rawLength: number;
  readonly context: StringContext;
  /** The first `bytes` of the unescaped string (fewer when it is shorter). */
  head(bytes: number): Promise<Uint8Array>;
  /** The whole unescaped string, refused above `limit` bytes. */
  unescaped(limit: number): Promise<Uint8Array>;
  /** The whole unescaped string as a buffer every worker can read (parallel unescape). */
  unescapedShared(): Promise<{ readonly view: Uint8Array }>;
  /** The first `decodedBytes` bytes of the string decoded as base64. */
  base64Head(decodedBytes: number): Promise<Uint8Array>;
  /** The last bytes of the raw string, to count padding. */
  rawTail(bytes: number): Promise<Uint8Array>;
  /** The first bytes of the raw (still escaped) string. */
  rawHead(bytes: number): Promise<Uint8Array>;
  /** The same string from raw byte `rawOffset` on: what follows a `data:` URL's comma. */
  from(rawOffset: number): StringAccess;
  /** The string decoded as base64 into one buffer, `limit` bytes at most. */
  base64All(limit: number): Promise<Uint8Array>;
  /** Streams the string's base64 into a Blob of `mime`. */
  base64Blob(mime: string, stepBytes: number): Promise<Blob>;
  /** Indexes `bytes` as a child document; null when they do not index as one JSON value. */
  adopt(bytes: Uint8Array): Promise<NestedDocument | null>;
  /** The document the string's unescaped bytes already are (nested JSON), null when it is not JSON. */
  expandNested(): Promise<NestedDocument | null>;
}

const hexDump = (bytes: Uint8Array) => {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const row = bytes.subarray(at, at + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const text = Array.from(row, (b) =>
      b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
    ).join("");
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${text}`);
  }
  return lines.join("\n");
};

const textValue = (bytes: Uint8Array, truncated: boolean, total: number) => ({
  text: decodeUtf8(bytes, Math.max(1, bytes.byteLength)),
  truncated,
  bytes: total,
});

/** The head of an unescaped string, `truncated` when the string goes on. */
const headOf = async (access: StringAccess, bytes: number) => {
  const head = await access.head(bytes + 1);
  return head.length > bytes
    ? { bytes: head.subarray(0, utf8Boundary(head, bytes)), truncated: true }
    : { bytes: head, truncated: false };
};

const utf8Boundary = (bytes: Uint8Array, limit: number) => {
  let at = Math.min(limit, bytes.byteLength);
  while (at > 0 && at < bytes.byteLength && ((bytes[at] as number) & 0xc0) === 0x80) at--;
  return at;
};

/** What a string can be decoded as, from its first 4 KiB and the enclosing object. */
export const detectAccess = async (access: StringAccess): Promise<ReadonlyArray<Detection>> => {
  if (access.rawLength < 2) return [];
  const { bytes, truncated } = await headOf(access, STRING_HEAD_BYTES);
  return detectString(bytes, truncated, access.context).map((found) => ({
    ...found,
    structured: found.kind === "svg" ? false : found.kind !== "base64" || hasRows(found.mime),
  }));
};

/** Base64 content has rows in the tree when it is text or an archive that holds text. */
const hasRows = (mime: string | null) => {
  if (mime === null) return false;
  const kind = kindOfMime(mime);
  return kind === "text" || kind === "gzip";
};

const notDecodable = (access: StringAccess, kind: DecoderKind) =>
  new NotDecodableError({ ref: access.ref, kind });

const decodeJson = async (access: StringAccess): Promise<Decoded> => {
  const document = await access.expandNested();
  if (!document) throw notDecodable(access, "json");
  const head = await headOf(access, VIEW_HEAD_BYTES);
  const pretty = prettyJson(head.bytes);
  const size = document.bytes;
  const root = document.root;
  const unit = root.kind === "object" ? "key" : "item";
  return {
    kind: "json",
    label: `JSON · ${root.childCount} ${unit}${root.childCount === 1 ? "" : "s"}`,
    layers: [],
    mime: "application/json",
    bytes: size,
    document,
    view: { _tag: "text", value: textValue(pretty, head.truncated, size) },
  };
};

const decodeJwtString = async (access: StringAccess): Promise<Decoded> => {
  if (access.rawLength > MAX_JWT_BYTES) throw notDecodable(access, "jwt");
  const token = decodeJwt(await access.unescaped(MAX_JWT_BYTES));
  if (!token) throw notDecodable(access, "jwt");
  const note = `not verified (${token.signatureBytes} bytes)`;
  const document = await access.adopt(
    concatBytes([
      asciiBytes('{"header":'),
      token.header,
      asciiBytes(',"payload":'),
      token.payload,
      asciiBytes(',"signature":'),
      jsonStringBytes(asciiBytes(note)),
      asciiBytes("}"),
    ]),
  );
  const algorithm = jwtAlgorithm(token.header);
  const part = (bytes: Uint8Array) => {
    const pretty = prettyJson(bytes);
    return textValue(pretty, false, bytes.byteLength);
  };
  return {
    kind: "jwt",
    label: algorithm ? `JWT · ${algorithm}` : "JWT",
    layers: [],
    mime: "application/jwt",
    bytes: access.rawLength,
    document,
    view: {
      _tag: "jwt",
      header: part(token.header),
      payload: part(token.payload),
      algorithm,
      signature: token.signature,
      signatureBytes: token.signatureBytes,
      verified: false,
    },
  };
};

const decodeForm = async (access: StringAccess): Promise<Decoded> => {
  if (access.rawLength > MAX_FORM_BYTES) throw notDecodable(access, "form");
  const bytes = await access.unescaped(MAX_FORM_BYTES);
  const { fields, total } = parseForm(bytes);
  if (total === 0) throw notDecodable(access, "form");
  return {
    kind: "form",
    label: `form · ${total} field${total === 1 ? "" : "s"}`,
    layers: [],
    mime: "application/x-www-form-urlencoded",
    bytes: bytes.byteLength,
    document: await access.adopt(formToJson(bytes)),
    view: { _tag: "form", fields, total },
  };
};

const decodeGraphql = async (access: StringAccess): Promise<Decoded> => {
  if (access.rawLength > MAX_GRAPHQL_BYTES) throw notDecodable(access, "graphql");
  const bytes = await access.unescaped(MAX_GRAPHQL_BYTES);
  const pretty = prettyGraphql(decodeUtf8(bytes, MAX_GRAPHQL_BYTES));
  if (!pretty) throw notDecodable(access, "graphql");
  const first = pretty.operations[0];
  const name = first ? [first.type, first.name].filter(Boolean).join(" ") : "";
  const text = new TextEncoder().encode(pretty.text);
  return {
    kind: "graphql",
    label: name ? `GraphQL · ${name}` : "GraphQL",
    layers: [],
    mime: "application/graphql",
    bytes: bytes.byteLength,
    document: null,
    view: {
      _tag: "text",
      value: textValue(
        text.subarray(0, VIEW_HEAD_BYTES),
        text.length > VIEW_HEAD_BYTES,
        text.length,
      ),
    },
  };
};

const decodeNdjson = async (access: StringAccess): Promise<Decoded> => {
  const { view } = await access.unescapedShared();
  const { bytes: asArray, lines } = ndjsonToArray(view);
  if (lines === 0) throw notDecodable(access, "ndjson");
  const { lines: shown, total } = splitLines(view, NDJSON_VIEW_LINES);
  const rows = shown.map(([from, to]) =>
    decodeUtf8(view.subarray(from, Math.min(to, from + NDJSON_LINE_CHARS))),
  );
  return {
    kind: "ndjson",
    label: `NDJSON · ${total} line${total === 1 ? "" : "s"}`,
    layers: [],
    mime: "application/x-ndjson",
    bytes: view.byteLength,
    document: await access.adopt(asArray),
    view: { _tag: "lines", lines: rows, total },
  };
};

const SVG_MIME = "image/svg+xml";

/** An SVG up to this size is unescaped to report its exact size; a bigger one reports the escaped size. */
const SVG_EXACT_SIZE_BYTES = 1024 * 1024;

const decodeSvg = async (access: StringAccess): Promise<Decoded> => {
  const bytes =
    access.rawLength <= SVG_EXACT_SIZE_BYTES
      ? (await access.unescaped(SVG_EXACT_SIZE_BYTES)).byteLength
      : access.rawLength;
  return {
    kind: "svg",
    label: "SVG image",
    layers: [],
    mime: SVG_MIME,
    bytes,
    document: null,
    view: { _tag: "image", mime: SVG_MIME, bytes },
  };
};

/** The raw characters of base64 text, less the `=` padding at its end. */
const base64Size = async (access: StringAccess) => {
  const tail = await access.rawTail(4);
  let padding = 0;
  for (let i = tail.length - 1; i >= 0 && tail[i] === 0x3d; i--) padding++;
  return Math.max(0, Math.floor(((access.rawLength - padding) * 3) / 4));
};

interface Base64Content {
  readonly layers: string[];
  readonly sniffed: Sniffed;
  readonly mime: string;
  readonly bytes: number;
  /** The whole decoded value when a layer (gzip) already produced it. */
  readonly inflated: Uint8Array | null;
  readonly head: Uint8Array;
  /** Where the base64 is: the string, or a `data:` URL's payload. */
  readonly access: StringAccess;
}

/** A `data:` URL's header is read from this many raw bytes; a longer one is not taken as one. */
const DATA_URL_HEAD_BYTES = 256;

/**
 * The base64 a string holds: the whole string, or the payload of a `data:` URL
 * marked `;base64`, which is read from the byte after its comma with the type
 * the URL names. Detection offers no other kind of `data:` URL.
 */
const base64Source = async (
  access: StringAccess,
): Promise<{ readonly access: StringAccess; readonly declared: string | null }> => {
  const raw = await access.rawHead(DATA_URL_HEAD_BYTES);
  const comma = raw.indexOf(0x2c);
  // The scheme is ASCII and the comma is never escaped; a `/` in the type may be (`image\/png`).
  const header = comma < 0 ? "" : decodeUtf8(raw.subarray(0, comma)).replaceAll("\\/", "/");
  const match = /^data:([^;,]*)((?:;[^;,]*)*)$/i.exec(header);
  if (match === null || !/;base64$/i.test(match[2] ?? "")) return { access, declared: null };
  const mime = (match[1] ?? "").trim().toLowerCase() || "text/plain";
  return { access: access.from(comma + 1), declared: mime };
};

const base64Content = async (whole: StringAccess): Promise<Base64Content> => {
  const { access, declared: named } = await base64Source(whole);
  const head = await access.base64Head(VIEW_HEAD_BYTES);
  const outer = sniffBytes(head);
  const declared = named ?? access.context.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const layers = ["base64"];
  if (outer.kind === "gzip") {
    const compressed = await access.base64All(MAX_SLICE_BYTES);
    const inflated = await inflateGzip(compressed, MAX_SLICE_BYTES);
    layers.push("gzip");
    const inner = sniffBytes(inflated.subarray(0, 1024));
    return {
      layers,
      sniffed: inner,
      mime: inner.mime,
      bytes: inflated.byteLength,
      inflated,
      head: inflated.subarray(0, VIEW_HEAD_BYTES),
      access,
    };
  }
  const bytes = await base64Size(access);
  // Bytes that name no type take the declared one; an undeclared body is octet-stream.
  const known = outer.mime !== "application/octet-stream";
  const mime = known ? outer.mime : declared || outer.mime;
  const sniffed: Sniffed = known ? outer : { kind: kindOfMime(mime), mime };
  return { layers, sniffed, mime, bytes, inflated: null, head, access };
};

const decodeBase64Value = async (access: StringAccess): Promise<Decoded> => {
  const content = await base64Content(access);
  const { sniffed, head } = content;
  const label = `base64${content.layers.includes("gzip") ? " · gzip" : ""} · ${content.mime}`;
  const base = {
    kind: "base64",
    label,
    layers: content.layers,
    mime: content.mime,
    bytes: content.bytes,
  } as const;
  if (sniffed.kind === "image") {
    return {
      ...base,
      document: null,
      view: { _tag: "image", mime: content.mime, bytes: content.bytes },
    };
  }
  if (sniffed.kind === "text" && looksTextual(head)) {
    const json = content.mime === "application/json" || sniffed.mime === "application/json";
    let document: NestedDocument | null = null;
    if (json && content.bytes <= MAX_SLICE_BYTES) {
      const whole = content.inflated ?? (await content.access.base64All(MAX_SLICE_BYTES));
      document = await access.adopt(whole);
    }
    const shown = json ? prettyJson(head) : head;
    return {
      ...base,
      document,
      view: {
        _tag: "text",
        value: textValue(shown, content.bytes > head.byteLength, content.bytes),
      },
    };
  }
  return {
    ...base,
    document: null,
    view: {
      _tag: "binary",
      mime: content.mime,
      bytes: content.bytes,
      hex: hexDump(head.subarray(0, HEX_BYTES)),
    },
  };
};

const looksTextual = (head: Uint8Array) => sniffBytes(head).kind === "text";

/** Runs one decoder on a string, when detection says the string is that kind of value. */
export const decodeAccess = async (access: StringAccess, kind: DecoderKind): Promise<Decoded> => {
  const detected = await detectAccess(access);
  if (!detected.some((d) => d.kind === kind)) throw notDecodable(access, kind);
  return decodeKind(access, kind);
};

const decodeKind = (access: StringAccess, kind: DecoderKind): Promise<Decoded> => {
  switch (kind) {
    case "json":
      return decodeJson(access);
    case "jwt":
      return decodeJwtString(access);
    case "form":
      return decodeForm(access);
    case "graphql":
      return decodeGraphql(access);
    case "ndjson":
      return decodeNdjson(access);
    case "base64":
      return decodeBase64Value(access);
    case "svg":
      return decodeSvg(access);
  }
};

/** The image behind a base64 string, as a Blob the page can show through an object URL. */
export const previewAccess = async (access: StringAccess): Promise<ImagePreview> => {
  const detected = await detectAccess(access);
  if (detected.some((d) => d.kind === "svg")) {
    if (access.rawLength > MAX_SLICE_BYTES) {
      throw new SliceTooLargeError({ bytes: access.rawLength, limit: MAX_SLICE_BYTES });
    }
    const bytes = await access.unescaped(MAX_SLICE_BYTES);
    return {
      blob: new Blob([bytes as BlobPart], { type: SVG_MIME }),
      mime: SVG_MIME,
      bytes: bytes.byteLength,
    };
  }
  const content = await base64Content(access);
  if (content.sniffed.kind !== "image") {
    throw new NotDecodableError({ ref: access.ref, kind: "base64" });
  }
  if (content.bytes > MAX_SLICE_BYTES) {
    throw new SliceTooLargeError({ bytes: content.bytes, limit: MAX_SLICE_BYTES });
  }
  const blob = content.inflated
    ? new Blob([content.inflated as BlobPart], { type: content.mime })
    : await content.access.base64Blob(content.mime, BASE64_STEP_BYTES);
  return { blob, mime: content.mime, bytes: blob.size };
};

/** Decoded size and head of a base64 string without any view: how a WebSocket frame is summarized. */
export const base64Summary = async (access: StringAccess, headBytes: number) => {
  const head = await access.base64Head(headBytes);
  return { head, bytes: await base64Size(access), sniffed: sniffBytes(head) };
};
