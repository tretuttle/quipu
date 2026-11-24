/**
 * JWT decoding for display. A JSON Web Token is three
 * base64url segments; this reads the header and payload and carries the
 * signature as bytes. It never verifies anything: a decoded token is a claim,
 * and the UI says the signature is not verified.
 */
import { base64MaxDecoded, Base64Decoder } from "./base64.ts";
import { decodeUtf8 } from "./boundedSlice.ts";
import { scanJson } from "./jsonScan.ts";

/** A token longer than this is not decoded: real tokens are a few KiB. */
export const MAX_JWT_BYTES = 64 * 1024;

const BEARER = [0x42, 0x65, 0x61, 0x72, 0x65, 0x72, 0x20] as const; // "Bearer "

const isUrlSafe = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2d ||
  byte === 0x5f;

export interface JwtSegments {
  /** Byte ranges of the three segments in the input. */
  readonly header: readonly [number, number];
  readonly payload: readonly [number, number];
  readonly signature: readonly [number, number];
}

/**
 * Splits `bytes` as `[Bearer ]<header>.<payload>.<signature>`; null when it is
 * not shaped like a compact JWS. The signature may be empty (`alg: none`).
 */
const splitJwt = (bytes: Uint8Array): JwtSegments | null => {
  let at = 0;
  if (BEARER.every((b, i) => bytes[i] === b)) at = BEARER.length;
  let end = bytes.length;
  while (
    end > at &&
    (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)
  )
    end--;
  const dots: number[] = [];
  for (let i = at; i < end; i++) {
    const byte = bytes[i] as number;
    if (byte === 0x2e) dots.push(i);
    else if (!isUrlSafe(byte)) return null;
  }
  const [first, second] = dots;
  if (dots.length !== 2 || first === undefined || second === undefined) return null;
  if (first - at < 2 || second - first < 2) return null;
  return {
    header: [at, first],
    payload: [first + 1, second],
    signature: [second + 1, end],
  };
};

const decodeSegment = (bytes: Uint8Array, [from, to]: readonly [number, number]) => {
  const out = new Uint8Array(base64MaxDecoded(to - from));
  const decoder = new Base64Decoder();
  const n = decoder.push(bytes, from, to, out, 0);
  return decoder.invalid === 0 ? out.subarray(0, n) : null;
};

const firstSignificant = (bytes: Uint8Array) => {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || (bytes[i] as number) <= 0x0d)) i++;
  return bytes[i];
};

/** A JWT part is one JSON object, whole. */
const isJsonObject = (bytes: Uint8Array) =>
  firstSignificant(bytes) === 0x7b && scanJson(bytes).status === "complete";

export interface DecodedJwt {
  /** The decoded JSON text of each part, verbatim. */
  readonly header: Uint8Array;
  readonly payload: Uint8Array;
  /** The signature segment as it appears (base64url), and its decoded length. */
  readonly signature: string;
  readonly signatureBytes: number;
  readonly segments: JwtSegments;
}

/** Decodes the two JSON parts of a token; null when either is not a JSON object. */
export const decodeJwt = (bytes: Uint8Array): DecodedJwt | null => {
  if (bytes.length > MAX_JWT_BYTES) return null;
  const segments = splitJwt(bytes);
  if (!segments) return null;
  const header = decodeSegment(bytes, segments.header);
  const payload = decodeSegment(bytes, segments.payload);
  if (!header || !payload) return null;
  if (!isJsonObject(header) || !isJsonObject(payload)) return null;
  const [sigFrom, sigTo] = segments.signature;
  let signature = "";
  for (let i = sigFrom; i < sigTo; i++) signature += String.fromCharCode(bytes[i] as number);
  const signatureBytes = decodeSegment(bytes, segments.signature)?.length ?? 0;
  return { header, payload, signature, signatureBytes, segments };
};

/** The decoded header of a token whose first segment is complete in `bytes`, for a head cut mid-token. */
export const decodeJwtHeader = (bytes: Uint8Array): Uint8Array | null => {
  let at = 0;
  if (BEARER.every((b, i) => bytes[i] === b)) at = BEARER.length;
  const dot = bytes.indexOf(0x2e, at);
  if (dot < at + 2) return null;
  for (let i = at; i < dot; i++) if (!isUrlSafe(bytes[i] as number)) return null;
  const header = decodeSegment(bytes, [at, dot]);
  return header && firstSignificant(header) === 0x7b && scanJson(header).status !== "invalid"
    ? header
    : null;
};

/** The header's `alg` when it is a short plain name, else null. */
export const jwtAlgorithm = (header: Uint8Array): string | null => {
  const text = decodeUtf8(header.subarray(0, Math.min(header.length, 1024)));
  const match = /"alg"\s*:\s*"([A-Za-z0-9_+-]{1,16})"/.exec(text);
  return match?.[1] ?? null;
};
