/**
 * HAR capture diff supporting any chosen reference document and streaming batch extraction
 * for multi-GB HAR captures without whole-document materialization.
 */
import type {
  HarChangedSection,
  HarDiffClass,
  HarDiffCounts,
  HarDiffEntry,
  HarDiffSummary,
  StructuralDiffResult,
} from "@quipu/contracts/diff";
import { MAX_SLICE_BYTES, SliceTooLargeError } from "@quipu/contracts/engine";

import { Base64Decoder, base64MaxDecoded, decodeBase64Ascii } from "../base64.ts";
import { decodeUtf8, parseJsonSlice, parseJsonTextSlice } from "../boundedSlice.ts";
import { SourceJsonCursor } from "../harWindow.ts";
import { decodeKey, decodeString, isCleanIndex, looksLikeJson, stringBytes } from "../decode.ts";
import { indexBytes } from "../indexBuffer.ts";
import { FULL_DEPTH } from "../scan.ts";
import type { ByteSource } from "../source.ts";
import {
  firstChild,
  KIND_ARRAY,
  KIND_NUMBER,
  KIND_OBJECT,
  KIND_STRING,
  type Tape,
} from "../tape.ts";
import {
  add64,
  fnv1a64,
  fnv1a64Utf8String,
  hashArrayPairsMixedInto,
  hashContainerSumMixedInto,
  Hasher64,
  hashJsonNumberMixedInto,
  hashJsonStringMixedInto,
  hashObjectMemberMixedInto,
  hashToHex,
  mix64,
  toBigInt64,
  utf8ByteLength,
} from "./hash.ts";
import { computeSubtreeHashes, diffJsonBytes, previewTokenValue } from "./structural.ts";

export interface HarEntryPrint {
  readonly entryIndex: number;
  readonly matchKey: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status: number;
  readonly headersHash: bigint;
  readonly queryHash: bigint;
  readonly postDataHash: bigint;
  readonly bodyHash: bigint;
}

export interface HarClassification {
  readonly referenceIndex: number | null;
  readonly classes: ReadonlyArray<ReadonlyArray<HarDiffClass>>;
  readonly groups: ReadonlyArray<ReadonlyArray<number>>;
  readonly counts: HarDiffCounts;
}

const ENCODER = new TextEncoder();
const INDEX_CHUNK_BYTES = 8 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

export function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

function matchKeyHash(method: string, url: string, resourceType: string): bigint {
  return SHARED_KEY_HASHER.reset()
    .writeUtf8String(method)
    .writeU8(0)
    .writeUtf8String(withoutFragment(url))
    .writeU8(0)
    .writeUtf8String(resourceType)
    .finishMixed();
}

export function matchKey(method: string, url: string, resourceType: string): string {
  return hashToHex(matchKeyHash(method, url, resourceType));
}

function findObjectMember(tape: Tape, bytes: Uint8Array, objToken: number, name: string): number {
  let c = firstChild(tape, objToken);
  while (c >= 0) {
    if (decodeKey(tape, c, bytes) === name) return c;
    c = tape.next(c);
  }
  return -1;
}

function readStringToken(tape: Tape, bytes: Uint8Array, token: number): string {
  if (token < 0 || tape.kind(token) !== KIND_STRING) return "";
  return decodeString(bytes, tape.start(token), tape.end(token), MAX_SLICE_BYTES);
}

function hashHeadersSet(tape: Tape, bytes: Uint8Array, headersToken: number): bigint {
  if (headersToken < 0 || tape.kind(headersToken) !== KIND_ARRAY) return 0n;
  const pairs: Array<{ readonly name: string; readonly value: Uint8Array }> = [];
  let c = firstChild(tape, headersToken);
  while (c >= 0) {
    if (tape.kind(c) === KIND_OBJECT) {
      const nameTok = findObjectMember(tape, bytes, c, "name");
      const valTok = findObjectMember(tape, bytes, c, "value");
      const name = readStringToken(tape, bytes, nameTok).toLowerCase();
      const value =
        valTok >= 0 && tape.kind(valTok) === KIND_STRING
          ? stringBytes(bytes, tape.start(valTok), tape.end(valTok))
          : new Uint8Array(0);
      pairs.push({ name, value });
    }
    c = tape.next(c);
  }
  if (pairs.length === 0) return 0n;
  pairs.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    const min = Math.min(a.value.length, b.value.length);
    for (let i = 0; i < min; i++) {
      const da = a.value[i] as number;
      const db = b.value[i] as number;
      if (da !== db) return da - db;
    }
    return a.value.length - b.value.length;
  });
  const hasher = new Hasher64();
  for (const pair of pairs) {
    const nameBytes = ENCODER.encode(pair.name);
    hasher.writeU32(nameBytes.length);
    hasher.writeBytes(nameBytes);
    hasher.writeU32(pair.value.length);
    hasher.writeBytes(pair.value);
  }
  return hasher.finishMixed();
}

function decodeBase64Content(rawBytes: Uint8Array): Uint8Array | null {
  const decoder = new Base64Decoder();
  const out = new Uint8Array(base64MaxDecoded(rawBytes.length));
  const written = decoder.push(rawBytes, 0, rawBytes.length, out, 0);
  if (decoder.invalid > 0 || written === 0) return null;
  return out.subarray(0, written);
}

function hashPayloadText(rawBytes: Uint8Array, mimeType: string): bigint {
  if (rawBytes.length === 0) return 0n;
  if (looksLikeJson(rawBytes) || mimeType.toLowerCase().includes("json")) {
    try {
      const parsed = parseJsonSlice(rawBytes, MAX_SLICE_BYTES);
      const h = hashJsonValueCanonical(parsed);
      return h === 0n ? 1n : h;
    } catch {
      // Non-JSON payload even with json mimeType/prefix: hash raw bytes directly below.
    }
  }
  const h = mix64(fnv1a64(rawBytes));
  return h === 0n ? 1n : h;
}

function hashPostData(
  tape: Tape,
  bytes: Uint8Array,
  subtreeHashes: BigUint64Array,
  postDataToken: number,
): bigint {
  if (postDataToken < 0 || tape.kind(postDataToken) !== KIND_OBJECT) return 0n;
  const mimeTok = findObjectMember(tape, bytes, postDataToken, "mimeType");
  const paramsTok = findObjectMember(tape, bytes, postDataToken, "params");
  const textTok = findObjectMember(tape, bytes, postDataToken, "text");
  const mimeType = readStringToken(tape, bytes, mimeTok);
  const hasher = new Hasher64();
  hasher.writeU32(mimeType.length);
  hasher.writeBytes(ENCODER.encode(mimeType));
  if (paramsTok >= 0 && tape.kind(paramsTok) === KIND_ARRAY && tape.childCount(paramsTok) > 0) {
    hasher.writeU8(1);
    hasher.writeU64(subtreeHashes[paramsTok] as bigint);
  }
  if (textTok >= 0 && tape.kind(textTok) === KIND_STRING) {
    const raw = stringBytes(bytes, tape.start(textTok), tape.end(textTok));
    if (raw.length > 0) {
      hasher.writeU8(2);
      hasher.writeU64(hashPayloadText(raw, mimeType));
    }
  }
  return hasher.finishMixed();
}

function decodeEntryResponseBody(entryBytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
} {
  const { tape } = indexBytes(entryBytes, 0, {
    maxDepth: FULL_DEPTH,
    chunkBytes: INDEX_CHUNK_BYTES,
  });
  if (tape.count === 0 || tape.kind(0) !== KIND_OBJECT) {
    return { bytes: new Uint8Array(0), mimeType: "" };
  }
  const respTok = findObjectMember(tape, entryBytes, 0, "response");
  if (respTok < 0 || tape.kind(respTok) !== KIND_OBJECT) {
    return { bytes: new Uint8Array(0), mimeType: "" };
  }
  const contentTok = findObjectMember(tape, entryBytes, respTok, "content");
  if (contentTok < 0 || tape.kind(contentTok) !== KIND_OBJECT) {
    return { bytes: new Uint8Array(0), mimeType: "" };
  }
  const textTok = findObjectMember(tape, entryBytes, contentTok, "text");
  if (textTok < 0 || tape.kind(textTok) !== KIND_STRING) {
    return { bytes: new Uint8Array(0), mimeType: "" };
  }
  const encTok = findObjectMember(tape, entryBytes, contentTok, "encoding");
  const mimeTok = findObjectMember(tape, entryBytes, contentTok, "mimeType");
  const encoding = readStringToken(tape, entryBytes, encTok).toLowerCase();
  const mimeType = readStringToken(tape, entryBytes, mimeTok);
  let raw = stringBytes(entryBytes, tape.start(textTok), tape.end(textTok));
  if (encoding === "base64" && raw.length > 0) {
    const decoded = decodeBase64Content(raw);
    if (decoded !== null) raw = decoded;
  }
  return { bytes: raw, mimeType };
}

const HASH_NULL = new Hasher64().writeU8(6).finishMixed();
const HASH_FALSE = new Hasher64().writeU8(5).writeU8(0).finishMixed();
const HASH_TRUE = new Hasher64().writeU8(5).writeU8(1).finishMixed();
const HASH_EMPTY_ARRAY = new Hasher64().writeU8(2).finishMixed();
const HASH_EMPTY_OBJECT = new Hasher64().writeU8(1).writeU64(0n).finishMixed();
const HASH_NULL_LO = Number(HASH_NULL & 0xffff_ffffn) >>> 0;
const HASH_NULL_HI = Number((HASH_NULL >> 32n) & 0xffff_ffffn) >>> 0;
const HASH_FALSE_LO = Number(HASH_FALSE & 0xffff_ffffn) >>> 0;
const HASH_FALSE_HI = Number((HASH_FALSE >> 32n) & 0xffff_ffffn) >>> 0;
const HASH_TRUE_LO = Number(HASH_TRUE & 0xffff_ffffn) >>> 0;
const HASH_TRUE_HI = Number((HASH_TRUE >> 32n) & 0xffff_ffffn) >>> 0;
const HASH_EMPTY_ARRAY_LO = Number(HASH_EMPTY_ARRAY & 0xffff_ffffn) >>> 0;
const HASH_EMPTY_ARRAY_HI = Number((HASH_EMPTY_ARRAY >> 32n) & 0xffff_ffffn) >>> 0;
const HASH_EMPTY_OBJECT_LO = Number(HASH_EMPTY_OBJECT & 0xffff_ffffn) >>> 0;
const HASH_EMPTY_OBJECT_HI = Number((HASH_EMPTY_OBJECT >> 32n) & 0xffff_ffffn) >>> 0;
const SHARED_SCALAR_HASHER = new Hasher64();
const SHARED_MEMBER_HASHER = new Hasher64();
const SHARED_HDR_HASHER = new Hasher64();
const SHARED_KEY_HASHER = new Hasher64();
const OUT_PAIR = new Uint32Array(2);
const TMP_MEMBER_PAIR = new Uint32Array(2);
let hashScratch = new Uint32Array(4096);
let hashScratchCursor = 0;
const MAX_HASH_RECURSION = 64;

function ensureHashScratch(neededWords: number): void {
  if (neededWords <= hashScratch.length) return;
  let nextCap = hashScratch.length * 2;
  while (nextCap < neededWords) nextCap *= 2;
  const next = new Uint32Array(nextCap);
  next.set(hashScratch);
  hashScratch = next;
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const looksLikeJsonText = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return (
      c === 0x7b || // '{'
      c === 0x5b || // '['
      c === 0x22 || // '"'
      c === 0x2d || // '-'
      (c >= 0x30 && c <= 0x39) || // '0'..'9'
      c === 0x74 || // 't'
      c === 0x66 || // 'f'
      c === 0x6e // 'n'
    );
  }
  return false;
};

function hashJsonValueIterative(root: unknown): bigint {
  type Frame =
    | {
        readonly kind: 1;
        readonly keys: string[];
        readonly obj: Record<string, unknown>;
        idx: number;
        sum: bigint;
      }
    | {
        readonly kind: 2;
        readonly arr: ReadonlyArray<unknown>;
        idx: number;
        readonly hasher: Hasher64;
      };

  const stack: Frame[] = [];
  let pendingValue: unknown = root;
  let pushMode = true;
  let lastHash = 0n;

  for (;;) {
    if (pushMode) {
      const v = pendingValue;
      if (Array.isArray(v)) {
        if (v.length === 0) {
          lastHash = HASH_EMPTY_ARRAY;
          pushMode = false;
        } else {
          stack.push({ kind: 2, arr: v, idx: 0, hasher: new Hasher64().writeU8(2) });
          pendingValue = v[0];
        }
        continue;
      }
      if (typeof v === "object" && v !== null) {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 0) {
          lastHash = HASH_EMPTY_OBJECT;
          pushMode = false;
        } else {
          stack.push({ kind: 1, keys, obj, idx: 0, sum: 0n });
          pendingValue = obj[keys[0] as string];
        }
        continue;
      }
      if (typeof v === "string") {
        lastHash = SHARED_SCALAR_HASHER.reset().writeU8(3).writeUtf8String(v).finishMixed();
      } else if (typeof v === "number") {
        SHARED_SCALAR_HASHER.reset().writeU8(4);
        if (Number.isFinite(v)) SHARED_SCALAR_HASHER.writeFloat64(v);
        lastHash = SHARED_SCALAR_HASHER.finishMixed();
      } else if (typeof v === "boolean") {
        lastHash = v ? HASH_TRUE : HASH_FALSE;
      } else {
        lastHash = HASH_NULL;
      }
      pushMode = false;
      continue;
    }

    const top = stack[stack.length - 1];
    if (!top) return lastHash;

    if (top.kind === 1) {
      const k = top.keys[top.idx] as string;
      const mh = SHARED_MEMBER_HASHER.reset().writeUtf8String(k).writeU64(lastHash).finishMixed();
      top.sum = add64(top.sum, mh);
      top.idx++;
      if (top.idx < top.keys.length) {
        pendingValue = top.obj[top.keys[top.idx] as string];
        pushMode = true;
      } else {
        stack.pop();
        lastHash = SHARED_SCALAR_HASHER.reset().writeU8(1).writeU64(top.sum).finishMixed();
      }
    } else {
      top.hasher.writeU64(lastHash);
      top.idx++;
      if (top.idx < top.arr.length) {
        pendingValue = top.arr[top.idx];
        pushMode = true;
      } else {
        stack.pop();
        lastHash = top.hasher.finishMixed();
      }
    }
  }
}

/**
 * Canonical 64-bit hash over any parsed JSON value matching `computeSubtreeHashes`.
 * Uses allocation-free bounded recursion for normal trees (`depth < 64`) and
 * falls back cleanly to `hashJsonValueIterative` at deep nesting.
 */
function hashJsonValueFastInto(v: unknown, depth: number, out: Uint32Array, outIdx: number): void {
  if (typeof v === "string") {
    hashJsonStringMixedInto(v, out, outIdx);
    return;
  }
  if (typeof v === "number") {
    hashJsonNumberMixedInto(v, out, outIdx);
    return;
  }
  if (typeof v === "boolean") {
    out[outIdx] = v ? HASH_TRUE_LO : HASH_FALSE_LO;
    out[outIdx + 1] = v ? HASH_TRUE_HI : HASH_FALSE_HI;
    return;
  }
  if (v === null || typeof v !== "object") {
    out[outIdx] = HASH_NULL_LO;
    out[outIdx + 1] = HASH_NULL_HI;
    return;
  }
  if (depth >= MAX_HASH_RECURSION) {
    const h = hashJsonValueIterative(v);
    out[outIdx] = Number(h & 0xffff_ffffn) >>> 0;
    out[outIdx + 1] = Number((h >> 32n) & 0xffff_ffffn) >>> 0;
    return;
  }
  if (Array.isArray(v)) {
    const n = v.length;
    if (n === 0) {
      out[outIdx] = HASH_EMPTY_ARRAY_LO;
      out[outIdx + 1] = HASH_EMPTY_ARRAY_HI;
      return;
    }
    const base = hashScratchCursor;
    const needed = base + n * 2;
    ensureHashScratch(needed);
    hashScratchCursor = needed;
    for (let i = 0; i < n; i++) {
      hashJsonValueFastInto(v[i], depth + 1, hashScratch, base + i * 2);
    }
    // Re-read module-level `hashScratch` (children may have grown it) and check if `out` aliased an earlier slice.
    hashArrayPairsMixedInto(hashScratch, base, n, OUT_PAIR, 0);
    out[outIdx] = OUT_PAIR[0] as number;
    out[outIdx + 1] = OUT_PAIR[1] as number;
    hashScratchCursor = base;
    return;
  }
  const obj = v as Record<string, unknown>;
  let sumLo = 0;
  let sumHi = 0;
  let count = 0;
  const slot = hashScratchCursor;
  ensureHashScratch(slot + 2);
  hashScratchCursor = slot + 2;
  for (const k in obj) {
    if (!Object.hasOwn(obj, k)) continue;
    count++;
    hashJsonValueFastInto(obj[k], depth + 1, hashScratch, slot);
    const childLo = hashScratch[slot] as number;
    const childHi = hashScratch[slot + 1] as number;
    hashObjectMemberMixedInto(k, childLo, childHi, TMP_MEMBER_PAIR, 0);
    const sLo = sumLo + (TMP_MEMBER_PAIR[0] as number);
    sumLo = sLo >>> 0;
    sumHi = (sumHi + (TMP_MEMBER_PAIR[1] as number) + (sLo >= 0x1_0000_0000 ? 1 : 0)) >>> 0;
  }
  hashScratchCursor = slot;
  if (count === 0) {
    out[outIdx] = HASH_EMPTY_OBJECT_LO;
    out[outIdx + 1] = HASH_EMPTY_OBJECT_HI;
    return;
  }
  hashContainerSumMixedInto(1, sumLo, sumHi, out, outIdx);
}

/**
 * Canonical 64-bit hash over any parsed JSON value matching `computeSubtreeHashes`.
 * Uses zero-allocation 32-bit pair arithmetic for normal trees (`depth < 64`) and
 * falls back cleanly to `hashJsonValueIterative` at deep nesting.
 */
export function hashJsonValueCanonical(v: unknown): bigint {
  hashScratchCursor = 0;
  try {
    hashJsonValueFastInto(v, 0, OUT_PAIR, 0);
    return toBigInt64(OUT_PAIR[0] as number, OUT_PAIR[1] as number);
  } finally {
    hashScratchCursor = 0;
  }
}

function compareStringsAsUtf8Bytes(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca >= 0x80 || cb >= 0x80) {
      const ba = ENCODER.encode(a);
      const bb = ENCODER.encode(b);
      const bm = Math.min(ba.length, bb.length);
      for (let j = 0; j < bm; j++) {
        const diff = (ba[j] as number) - (bb[j] as number);
        if (diff !== 0) return diff;
      }
      return ba.length - bb.length;
    }
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function hashHeadersFromArray(headers: unknown): bigint {
  if (!Array.isArray(headers) || headers.length === 0) return 0n;
  const pairs: Array<{ readonly name: string; readonly value: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const item = headers[i];
    if (!isPlainRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
    const value = typeof item.value === "string" ? item.value : "";
    pairs.push({ name, value });
  }
  if (pairs.length === 0) return 0n;
  pairs.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return compareStringsAsUtf8Bytes(a.value, b.value);
  });
  const hasher = SHARED_HDR_HASHER.reset();
  for (const pair of pairs) {
    hasher.writeU32(utf8ByteLength(pair.name));
    hasher.writeUtf8String(pair.name);
    hasher.writeU32(utf8ByteLength(pair.value));
    hasher.writeUtf8String(pair.value);
  }
  return hasher.finishMixed();
}

function hashPayloadTextString(text: string, mimeType: string): bigint {
  if (text.length === 0) return 0n;
  if (looksLikeJsonText(text) || mimeType.toLowerCase().includes("json")) {
    try {
      const parsed = parseJsonTextSlice(text, MAX_SLICE_BYTES);
      const h = hashJsonValueCanonical(parsed);
      return h === 0n ? 1n : h;
    } catch {
      // Non-JSON payload even with json mimeType/prefix: hash UTF-8 bytes directly below.
    }
  }
  const h = mix64(fnv1a64Utf8String(text));
  return h === 0n ? 1n : h;
}

function extractHarEntryPrintFast(
  entryBytes: Uint8Array,
  entryIndex: number,
): HarEntryPrint | null {
  let parsed: unknown;
  try {
    parsed = parseJsonSlice(entryBytes, MAX_SLICE_BYTES);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) {
    return {
      entryIndex,
      matchKey: matchKey("", "", ""),
      method: "",
      url: "",
      resourceType: "",
      status: 0,
      headersHash: 0n,
      queryHash: 0n,
      postDataHash: 0n,
      bodyHash: 0n,
    };
  }

  const resourceType = typeof parsed._resourceType === "string" ? parsed._resourceType : "";
  let method = "";
  let url = "";
  let headersHash = 0n;
  let queryHash = 0n;
  let postDataHash = 0n;

  const req = parsed.request;
  if (isPlainRecord(req)) {
    if (typeof req.method === "string") method = req.method;
    if (typeof req.url === "string") url = req.url;
    headersHash = hashHeadersFromArray(req.headers);
    if (Array.isArray(req.queryString) && req.queryString.length > 0) {
      queryHash = hashJsonValueCanonical(req.queryString);
    }
    const postData = req.postData;
    if (isPlainRecord(postData)) {
      const mimeType = typeof postData.mimeType === "string" ? postData.mimeType : "";
      const hasher = SHARED_SCALAR_HASHER.reset();
      hasher.writeU32(utf8ByteLength(mimeType));
      hasher.writeUtf8String(mimeType);
      if (Array.isArray(postData.params) && postData.params.length > 0) {
        hasher.writeU8(1);
        hasher.writeU64(hashJsonValueCanonical(postData.params));
      }
      if (typeof postData.text === "string" && postData.text.length > 0) {
        hasher.writeU8(2);
        hasher.writeU64(hashPayloadTextString(postData.text, mimeType));
      }
      postDataHash = hasher.finishMixed();
    }
  }

  let status = 0;
  let bodyHash = 0n;
  const resp = parsed.response;
  if (isPlainRecord(resp)) {
    if (typeof resp.status === "number" && Number.isFinite(resp.status) && resp.status >= 0) {
      status = Math.trunc(resp.status);
    }
    const content = resp.content;
    if (isPlainRecord(content) && typeof content.text === "string" && content.text.length > 0) {
      const encoding = typeof content.encoding === "string" ? content.encoding.toLowerCase() : "";
      const mimeType = typeof content.mimeType === "string" ? content.mimeType : "";
      if (encoding === "base64") {
        const decoded = content.text.includes("\\")
          ? decodeBase64Content(ENCODER.encode(content.text))
          : decodeBase64Ascii(content.text);
        bodyHash =
          decoded !== null
            ? hashPayloadText(decoded, mimeType)
            : hashPayloadTextString(content.text, mimeType);
      } else {
        bodyHash = hashPayloadTextString(content.text, mimeType);
      }
    }
  }

  return {
    entryIndex,
    matchKey: matchKey(method, url, resourceType),
    method,
    url,
    resourceType,
    status,
    headersHash,
    queryHash,
    postDataHash,
    bodyHash,
  };
}

async function hashSourceBytesBounded(
  cursor: SourceJsonCursor,
  start: number,
  end: number,
): Promise<bigint> {
  if (end <= start) return 0n;
  const hasher = new Hasher64();
  const step = 4 * 1024 * 1024;
  for (let at = start; at < end; at += step) {
    const chunk = await cursor.readChunk(at, Math.min(end, at + step));
    hasher.writeBytes(chunk);
  }
  const h = hasher.finishMixed();
  return h === 0n ? 1n : h;
}

/**
 * Extracts a complete `HarEntryPrint` from an oversized (`> MAX_SLICE_BYTES`) HAR entry
 * directly inside a scan worker using a bounded `<= 4 MiB` `SourceJsonCursor`, avoiding
 * any `> 64 MiB` buffer allocations, `bucketTape` calls, or `stepBuffer` clobbering.
 */
export async function extractHarPrintFromOversizedSource(
  src: ByteSource,
  elemStart: number,
  elemEnd: number,
  entryIndex: number,
): Promise<HarEntryPrint | null> {
  const cursor = new SourceJsonCursor(src, elemStart, elemEnd);
  const start = await cursor.skipWs(elemStart);
  if ((await cursor.byteAt(start)) !== 0x7b) return null;

  let resourceType = "";
  let method = "";
  let url = "";
  let headersHash = 0n;
  let queryHash = 0n;
  let postDataHash = 0n;
  let status = 0;
  let bodyHash = 0n;

  const end = await cursor.walkObject(start, async (key, vp) => {
    if (key === "_resourceType") {
      const r = await cursor.readStringScalar(vp);
      if (!r) return null;
      if (r.value !== null) resourceType = r.value;
      return r.nextPos;
    }
    if (key === "request" && (await cursor.byteAt(vp)) === 0x7b) {
      return cursor.walkObject(vp, async (rk, rvp) => {
        if (rk === "method") {
          const r = await cursor.readStringScalar(rvp);
          if (!r) return null;
          if (r.value !== null) method = r.value;
          return r.nextPos;
        }
        if (rk === "url") {
          const r = await cursor.readStringScalar(rvp);
          if (!r) return null;
          if (r.value !== null) url = r.value;
          return r.nextPos;
        }
        if (rk === "headers" || rk === "queryString" || rk === "postData") {
          const valEnd = await cursor.skipValue(rvp);
          if (valEnd < 0) return null;
          const len = valEnd - rvp;
          if (len > 0 && len <= MAX_SLICE_BYTES) {
            const slice = await cursor.readBounded(rvp, valEnd, MAX_SLICE_BYTES);
            if (slice !== null) {
              if (rk === "headers") {
                try {
                  headersHash = hashHeadersFromArray(parseJsonSlice(slice, MAX_SLICE_BYTES));
                } catch {
                  headersHash = mix64(fnv1a64(slice));
                }
              } else if (rk === "queryString") {
                try {
                  const parsed = parseJsonSlice(slice, MAX_SLICE_BYTES);
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    queryHash = hashJsonValueCanonical(parsed);
                  }
                } catch {
                  queryHash = mix64(fnv1a64(slice));
                }
              } else {
                try {
                  const pd = parseJsonSlice(slice, MAX_SLICE_BYTES);
                  if (isPlainRecord(pd)) {
                    const mimeType = typeof pd.mimeType === "string" ? pd.mimeType : "";
                    const h = new Hasher64();
                    const mb = ENCODER.encode(mimeType);
                    h.writeU32(mb.length).writeBytes(mb);
                    if (Array.isArray(pd.params) && pd.params.length > 0) {
                      h.writeU8(1).writeU64(hashJsonValueCanonical(pd.params));
                    }
                    if (typeof pd.text === "string" && pd.text.length > 0) {
                      h.writeU8(2).writeU64(hashPayloadTextString(pd.text, mimeType));
                    }
                    postDataHash = h.finishMixed();
                  }
                } catch {
                  postDataHash = mix64(fnv1a64(slice));
                }
              }
            }
          } else if (len > MAX_SLICE_BYTES && rk === "postData") {
            postDataHash = await hashSourceBytesBounded(cursor, rvp, valEnd);
          }
          return valEnd;
        }
        return cursor.skipValue(rvp);
      });
    }
    if (key === "response" && (await cursor.byteAt(vp)) === 0x7b) {
      return cursor.walkObject(vp, async (pk, pvp) => {
        if (pk === "status") {
          const r = await cursor.readNumberScalar(pvp);
          if (!r) return null;
          if (r.value !== null && r.value >= 0) status = Math.trunc(r.value);
          return r.nextPos;
        }
        if (pk === "content" && (await cursor.byteAt(pvp)) === 0x7b) {
          let encoding = "";
          let mimeType = "";
          let textStart = -1;
          let textEnd = -1;
          const next = await cursor.walkObject(pvp, async (ck, cvp) => {
            if (ck === "encoding") {
              const r = await cursor.readStringScalar(cvp);
              if (!r) return null;
              if (r.value !== null) encoding = r.value.toLowerCase();
              return r.nextPos;
            }
            if (ck === "mimeType") {
              const r = await cursor.readStringScalar(cvp);
              if (!r) return null;
              if (r.value !== null) mimeType = r.value;
              return r.nextPos;
            }
            if (ck === "text" && (await cursor.byteAt(cvp)) === 0x22) {
              const s = await cursor.skipString(cvp);
              if (s === null) return null;
              textStart = cvp;
              textEnd = s.end;
              return s.end;
            }
            return cursor.skipValue(cvp);
          });
          if (next < 0) return null;
          if (textStart >= 0 && textEnd > textStart + 2) {
            const rawLen = textEnd - textStart;
            if (rawLen <= MAX_SLICE_BYTES) {
              const slice = await cursor.readBounded(textStart, textEnd, MAX_SLICE_BYTES);
              if (slice !== null) {
                try {
                  const decodedStr = parseJsonSlice(slice, MAX_SLICE_BYTES);
                  if (typeof decodedStr === "string" && decodedStr.length > 0) {
                    if (encoding === "base64") {
                      const d = decodedStr.includes("\\")
                        ? decodeBase64Content(ENCODER.encode(decodedStr))
                        : decodeBase64Ascii(decodedStr);
                      bodyHash =
                        d !== null
                          ? hashPayloadText(d, mimeType)
                          : hashPayloadTextString(decodedStr, mimeType);
                    } else {
                      bodyHash = hashPayloadTextString(decodedStr, mimeType);
                    }
                  }
                } catch {
                  bodyHash = mix64(fnv1a64(slice));
                }
              }
            } else {
              bodyHash = await hashSourceBytesBounded(cursor, textStart + 1, textEnd - 1);
            }
          }
          return next;
        }
        return cursor.skipValue(pvp);
      });
    }
    return cursor.skipValue(vp);
  });

  if (end < 0) return null;
  return {
    entryIndex,
    matchKey: matchKey(method, url, resourceType),
    method,
    url,
    resourceType,
    status,
    headersHash,
    queryHash,
    postDataHash,
    bodyHash,
  };
}

/**
 * Extracts a single HAR entry's comparison print from a bounded slice (`<= MAX_SLICE_BYTES`).
 * Uses native `JSON.parse` (`parseJsonSlice`) + iterative canonical hashing on valid entries,
 * falling back to `indexBytes` + `computeSubtreeHashes` if the slice contains invalid JSON.
 */
export function extractHarEntryPrintFromSlice(
  entryBytes: Uint8Array,
  entryIndex: number,
): HarEntryPrint {
  if (entryBytes.byteLength > MAX_SLICE_BYTES) {
    throw new SliceTooLargeError({ bytes: entryBytes.byteLength, limit: MAX_SLICE_BYTES });
  }
  const fast = extractHarEntryPrintFast(entryBytes, entryIndex);
  if (fast !== null) return fast;
  const { tape } = indexBytes(entryBytes, 0, {
    maxDepth: FULL_DEPTH,
    chunkBytes: INDEX_CHUNK_BYTES,
  });
  if (tape.count === 0 || tape.kind(0) !== KIND_OBJECT) {
    return {
      entryIndex,
      matchKey: matchKey("", "", ""),
      method: "",
      url: "",
      resourceType: "",
      status: 0,
      headersHash: 0n,
      queryHash: 0n,
      postDataHash: 0n,
      bodyHash: 0n,
    };
  }
  const subtreeHashes = computeSubtreeHashes({ tape, bytes: entryBytes });
  const rtypeTok = findObjectMember(tape, entryBytes, 0, "_resourceType");
  const resourceType = readStringToken(tape, entryBytes, rtypeTok);

  let method = "";
  let url = "";
  let headersHash = 0n;
  let queryHash = 0n;
  let postDataHash = 0n;

  const reqTok = findObjectMember(tape, entryBytes, 0, "request");
  if (reqTok >= 0 && tape.kind(reqTok) === KIND_OBJECT) {
    method = readStringToken(
      tape,
      entryBytes,
      findObjectMember(tape, entryBytes, reqTok, "method"),
    );
    url = readStringToken(tape, entryBytes, findObjectMember(tape, entryBytes, reqTok, "url"));
    headersHash = hashHeadersSet(
      tape,
      entryBytes,
      findObjectMember(tape, entryBytes, reqTok, "headers"),
    );
    const queryTok = findObjectMember(tape, entryBytes, reqTok, "queryString");
    if (queryTok >= 0 && tape.kind(queryTok) === KIND_ARRAY && tape.childCount(queryTok) > 0) {
      queryHash = subtreeHashes[queryTok] as bigint;
    }
    postDataHash = hashPostData(
      tape,
      entryBytes,
      subtreeHashes,
      findObjectMember(tape, entryBytes, reqTok, "postData"),
    );
  }

  let status = 0;
  let bodyHash = 0n;
  const respTok = findObjectMember(tape, entryBytes, 0, "response");
  if (respTok >= 0 && tape.kind(respTok) === KIND_OBJECT) {
    const statusTok = findObjectMember(tape, entryBytes, respTok, "status");
    if (statusTok >= 0 && tape.kind(statusTok) === KIND_NUMBER) {
      const parsed = Number(
        decodeUtf8(entryBytes.subarray(tape.start(statusTok), tape.end(statusTok)), 64),
      );
      if (Number.isFinite(parsed) && parsed >= 0) status = Math.trunc(parsed);
    }
    const contentTok = findObjectMember(tape, entryBytes, respTok, "content");
    if (contentTok >= 0 && tape.kind(contentTok) === KIND_OBJECT) {
      const textTok = findObjectMember(tape, entryBytes, contentTok, "text");
      if (textTok >= 0 && tape.kind(textTok) === KIND_STRING) {
        const encTok = findObjectMember(tape, entryBytes, contentTok, "encoding");
        const mimeTok = findObjectMember(tape, entryBytes, contentTok, "mimeType");
        const encoding = readStringToken(tape, entryBytes, encTok).toLowerCase();
        const mimeType = readStringToken(tape, entryBytes, mimeTok);
        let raw = stringBytes(entryBytes, tape.start(textTok), tape.end(textTok));
        if (encoding === "base64" && raw.length > 0) {
          const decoded = decodeBase64Content(raw);
          if (decoded !== null) raw = decoded;
        }
        bodyHash = hashPayloadText(raw, mimeType);
      }
    }
  }

  return {
    entryIndex,
    matchKey: matchKey(method, url, resourceType),
    method,
    url,
    resourceType,
    status,
    headersHash,
    queryHash,
    postDataHash,
    bodyHash,
  };
}

function printsEqual(a: HarEntryPrint, b: HarEntryPrint): boolean {
  return (
    a.headersHash === b.headersHash &&
    a.queryHash === b.queryHash &&
    a.postDataHash === b.postDataHash &&
    a.status === b.status &&
    a.bodyHash === b.bodyHash
  );
}

function diffSectionsOfPrints(a: HarEntryPrint, b: HarEntryPrint): HarChangedSection[] {
  const sections: HarChangedSection[] = [];
  if (a.headersHash !== b.headersHash) sections.push("headers");
  if (a.queryHash !== b.queryHash) sections.push("query");
  if (a.postDataHash !== b.postDataHash) sections.push("postData");
  if (a.status !== b.status) sections.push("status");
  if (a.bodyHash !== b.bodyHash) sections.push("body");
  return sections;
}

/**
 * Classifies requests across N captures against a chosen `referenceIndex` (default 0).
 * Matches nth occurrence of `(method, url_without_fragment, _resourceType)`.
 */
export function classifyHarCaptures(
  captures: ReadonlyArray<ReadonlyArray<HarEntryPrint> | null>,
  referenceIndex = 0,
): HarClassification {
  const n = captures.length;
  const resolvedRef =
    captures[referenceIndex] !== null && captures[referenceIndex] !== undefined
      ? referenceIndex
      : (() => {
          const first = captures.findIndex((c) => c !== null && c !== undefined);
          return first >= 0 ? first : null;
        })();
  const openCount = captures.filter((c) => c !== null && c !== undefined).length;

  const sets = new Map<string, number>();
  const members: Array<Array<number | null>> = [];
  const groups: number[][] = Array.from({ length: n }, () => []);

  for (let slot = 0; slot < n; slot++) {
    const prints = captures[slot];
    if (!prints) continue;
    const nth = new Map<string, number>();
    const slotGroups = groups[slot] as number[];
    for (let i = 0; i < prints.length; i++) {
      const p = prints[i] as HarEntryPrint;
      const k = nth.get(p.matchKey) ?? 0;
      nth.set(p.matchKey, k + 1);
      const setIdKey = `${p.matchKey}#${k}`;
      let g = sets.get(setIdKey);
      if (g === undefined) {
        g = members.length;
        sets.set(setIdKey, g);
        members.push(Array.from({ length: n }, () => null));
      }
      (members[g] as Array<number | null>)[slot] = i;
      slotGroups.push(g);
    }
  }

  let same = 0;
  let added = 0;
  let removed = 0;
  let changed = 0;
  const setClass: HarDiffClass[] = [];

  for (const m of members) {
    let cls: HarDiffClass;
    if (openCount < 2 || resolvedRef === null) {
      cls = "same";
    } else {
      const ri = m[resolvedRef];
      if (ri === null || ri === undefined) {
        cls = "added";
      } else {
        const present = m.filter((x) => x !== null && x !== undefined).length;
        if (present < openCount) {
          cls = "removed";
        } else {
          const base = (captures[resolvedRef] as ReadonlyArray<HarEntryPrint>)[ri] as HarEntryPrint;
          let differs = false;
          for (let slot = 0; slot < n; slot++) {
            const idx = m[slot];
            if (idx === null || idx === undefined) continue;
            const candidate = (captures[slot] as ReadonlyArray<HarEntryPrint>)[
              idx
            ] as HarEntryPrint;
            if (!printsEqual(candidate, base)) {
              differs = true;
              break;
            }
          }
          cls = differs ? "changed" : "same";
        }
      }
    }
    setClass.push(cls);
    switch (cls) {
      case "same":
        same++;
        break;
      case "added":
        added++;
        break;
      case "removed":
        removed++;
        break;
      case "changed":
        changed++;
        break;
    }
  }

  const classes: HarDiffClass[][] = groups.map((slotGroups, slot) =>
    slotGroups.map((setId, i) => {
      const cls = setClass[setId] as HarDiffClass;
      if (resolvedRef !== null && cls === "changed" && slot !== resolvedRef) {
        const ri = members[setId]?.[resolvedRef];
        if (ri !== null && ri !== undefined) {
          const refPrint = (captures[resolvedRef] as ReadonlyArray<HarEntryPrint>)[
            ri
          ] as HarEntryPrint;
          const slotPrint = (captures[slot] as ReadonlyArray<HarEntryPrint>)[i] as HarEntryPrint;
          return printsEqual(refPrint, slotPrint) ? "same" : "changed";
        }
      }
      return cls;
    }),
  );

  return {
    referenceIndex: resolvedRef,
    classes,
    groups,
    counts: { same, added, removed, changed },
  };
}

export function diffHarCaptures(
  aPrints: ReadonlyArray<HarEntryPrint>,
  bPrints: ReadonlyArray<HarEntryPrint>,
  options: { readonly reference?: "a" | "b" } = {},
): HarDiffSummary {
  const refSide = options.reference ?? "a";
  const refIdx = refSide === "b" ? 1 : 0;
  const classification = classifyHarCaptures([aPrints, bPrints], refIdx);

  const refPrints = refSide === "a" ? aPrints : bPrints;
  const targetPrints = refSide === "a" ? bPrints : aPrints;
  const refGroups = classification.groups[refIdx] as ReadonlyArray<number>;
  const targetIdx = refSide === "a" ? 1 : 0;
  const targetGroups = classification.groups[targetIdx] as ReadonlyArray<number>;
  const targetClasses = classification.classes[targetIdx] as ReadonlyArray<HarDiffClass>;

  const refByGroup = new Map<number, HarEntryPrint>();
  for (let i = 0; i < refPrints.length; i++) {
    refByGroup.set(refGroups[i] as number, refPrints[i] as HarEntryPrint);
  }
  const targetGroupSeen = new Set<number>();
  const occByKey = new Map<string, number>();

  const nextOccurrence = (key: string) => {
    const occ = occByKey.get(key) ?? 0;
    occByKey.set(key, occ + 1);
    return occ;
  };

  const entries: HarDiffEntry[] = [];
  for (let i = 0; i < targetPrints.length; i++) {
    const tp = targetPrints[i] as HarEntryPrint;
    const gid = targetGroups[i] as number;
    targetGroupSeen.add(gid);
    const rp = refByGroup.get(gid);
    const cls = targetClasses[i] as HarDiffClass;

    if (!rp) {
      entries.push({
        matchKey: tp.matchKey,
        groupId: gid,
        occurrence: nextOccurrence(tp.matchKey),
        classification: "added",
        method: tp.method,
        url: tp.url,
        resourceType: tp.resourceType,
        statusBefore: null,
        statusAfter: tp.status,
        entryIndexBefore: null,
        entryIndexAfter: tp.entryIndex,
        changedSections: [],
      });
    } else {
      entries.push({
        matchKey: tp.matchKey,
        groupId: gid,
        occurrence: nextOccurrence(tp.matchKey),
        classification: cls,
        method: tp.method,
        url: tp.url,
        resourceType: tp.resourceType,
        statusBefore: rp.status,
        statusAfter: tp.status,
        entryIndexBefore: rp.entryIndex,
        entryIndexAfter: tp.entryIndex,
        changedSections: cls === "changed" ? diffSectionsOfPrints(rp, tp) : [],
      });
    }
  }

  for (let i = 0; i < refPrints.length; i++) {
    const gid = refGroups[i] as number;
    if (targetGroupSeen.has(gid)) continue;
    const rp = refPrints[i] as HarEntryPrint;
    entries.push({
      matchKey: rp.matchKey,
      groupId: gid,
      occurrence: nextOccurrence(rp.matchKey),
      classification: "removed",
      method: rp.method,
      url: rp.url,
      resourceType: rp.resourceType,
      statusBefore: rp.status,
      statusAfter: null,
      entryIndexBefore: rp.entryIndex,
      entryIndexAfter: null,
      changedSections: [],
    });
  }

  return {
    referenceIndex: refIdx,
    counts: classification.counts,
    entries,
  };
}

export interface HarStreamRange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Scans a HAR `ByteSource` in bounded 8 MiB chunks to locate the `[start, end)` byte
 * ranges of every object element inside `.log.entries`, without materializing the file.
 */
export async function scanHarEntryRanges(source: ByteSource): Promise<HarStreamRange[]> {
  const ranges: HarStreamRange[] = [];
  const size = source.size;
  if (size === 0) return ranges;

  let inString = false;
  let escaped = false;
  let depth = 0;
  let stringStart = -1;
  let pendingKey: string | null = null;
  let expectingValueForKey = false;
  let logDepth = -1;
  let inEntriesArray = false;
  let entriesArrayDepth = -1;
  let entryStart = -1;
  let entryIdx = 0;

  let curKeyBytes: number[] = [];
  const captureKeyLimit = 64;

  const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

  for (let offset = 0; offset < size; offset += SCAN_CHUNK_BYTES) {
    const end = Math.min(size, offset + SCAN_CHUNK_BYTES);
    const chunk = await source.read(offset, end);

    for (let i = 0; i < chunk.length; i++) {
      const abs = offset + i;
      const b = chunk[i] as number;

      if (inString) {
        if (escaped) {
          escaped = false;
          if (stringStart >= 0 && curKeyBytes.length < captureKeyLimit) curKeyBytes.push(b);
          continue;
        }
        if (b === 0x5c) {
          escaped = true;
          continue;
        }
        if (b === 0x22) {
          inString = false;
          if (stringStart >= 0 && curKeyBytes.length <= captureKeyLimit) {
            const key = decodeUtf8(new Uint8Array(curKeyBytes), captureKeyLimit);
            pendingKey = key;
          }
          stringStart = -1;
          curKeyBytes = [];
          continue;
        }
        if (stringStart >= 0 && curKeyBytes.length < captureKeyLimit) {
          curKeyBytes.push(b);
        }
        continue;
      }

      if (isWs(b)) continue;

      if (b === 0x22) {
        inString = true;
        escaped = false;
        const capture =
          !expectingValueForKey &&
          ((depth === 1 && logDepth < 0) || (logDepth === 1 && depth === 2 && !inEntriesArray));
        if (expectingValueForKey) {
          expectingValueForKey = false;
          pendingKey = null;
        }
        stringStart = capture ? abs : -1;
        curKeyBytes = [];
        continue;
      }

      if (b === 0x3a) {
        if (pendingKey !== null) expectingValueForKey = true;
        continue;
      }

      if (b === 0x7b) {
        if (expectingValueForKey && pendingKey === "log" && depth === 1 && logDepth < 0) {
          logDepth = 1;
        }
        expectingValueForKey = false;
        pendingKey = null;
        if (inEntriesArray && depth === entriesArrayDepth) {
          entryStart = abs;
        }
        depth++;
        continue;
      }

      if (b === 0x7d) {
        depth--;
        if (inEntriesArray && depth === entriesArrayDepth && entryStart >= 0) {
          ranges.push({ index: entryIdx++, start: entryStart, end: abs + 1 });
          entryStart = -1;
        }
        if (logDepth >= 0 && depth < logDepth + 1) {
          logDepth = -1;
        }
        expectingValueForKey = false;
        pendingKey = null;
        continue;
      }

      if (b === 0x5b) {
        if (expectingValueForKey && pendingKey === "entries" && logDepth === 1 && depth === 2) {
          inEntriesArray = true;
          entriesArrayDepth = depth + 1;
        }
        expectingValueForKey = false;
        pendingKey = null;
        depth++;
        continue;
      }

      if (b === 0x5d) {
        depth--;
        if (inEntriesArray && depth < entriesArrayDepth) {
          inEntriesArray = false;
          entriesArrayDepth = -1;
          return ranges;
        }
        expectingValueForKey = false;
        pendingKey = null;
        continue;
      }

      expectingValueForKey = false;
      pendingKey = null;
    }
  }

  return ranges;
}

export interface HarStreamingOptions {
  readonly batchSize?: number;
  readonly onBatch?: (batch: ReadonlyArray<HarEntryPrint>) => void | Promise<void>;
}

/**
 * Extracts `HarEntryPrint` summaries from a HAR `ByteSource` in bounded streaming batches.
 * Never reads more than `MAX_SLICE_BYTES` at a time, supporting multi-GB HAR captures.
 */
export async function extractHarPrintsStreaming(
  source: ByteSource,
  options: HarStreamingOptions = {},
): Promise<HarEntryPrint[]> {
  const batchSize = Math.max(1, options.batchSize ?? 128);
  const ranges = await scanHarEntryRanges(source);
  const all: HarEntryPrint[] = [];
  let batch: HarEntryPrint[] = [];

  for (const range of ranges) {
    const len = range.end - range.start;
    if (len > MAX_SLICE_BYTES) {
      throw new SliceTooLargeError({ bytes: len, limit: MAX_SLICE_BYTES });
    }
    const entryBytes = await source.read(range.start, range.end);
    const print = extractHarEntryPrintFromSlice(entryBytes, range.index);
    all.push(print);
    batch.push(print);
    if (batch.length >= batchSize) {
      await options.onBatch?.(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await options.onBatch?.(batch);
  }
  return all;
}

/**
 * On-demand node-level structural diff of the decoded response bodies of two matched HAR entries.
 * Each entry slice must be `<= MAX_SLICE_BYTES`.
 */
export function diffHarEntryBodies(
  aEntryBytes: Uint8Array | null,
  bEntryBytes: Uint8Array | null,
): StructuralDiffResult {
  const aDecoded = aEntryBytes ? decodeEntryResponseBody(aEntryBytes) : null;
  const bDecoded = bEntryBytes ? decodeEntryResponseBody(bEntryBytes) : null;

  const aBytes = aDecoded?.bytes ?? new Uint8Array(0);
  const bBytes = bDecoded?.bytes ?? new Uint8Array(0);

  if (
    aDecoded &&
    bDecoded &&
    aBytes.length > 0 &&
    bBytes.length > 0 &&
    (looksLikeJson(aBytes) || aDecoded.mimeType.toLowerCase().includes("json")) &&
    (looksLikeJson(bBytes) || bDecoded.mimeType.toLowerCase().includes("json"))
  ) {
    try {
      return diffJsonBytes(aBytes, bBytes);
    } catch {
      // Fall through to plain text comparison when body is invalid JSON.
    }
  }

  const aText =
    aBytes.length > 0
      ? decodeUtf8(aBytes.subarray(0, Math.min(aBytes.length, MAX_SLICE_BYTES)), MAX_SLICE_BYTES)
      : "";
  const bText =
    bBytes.length > 0
      ? decodeUtf8(bBytes.subarray(0, Math.min(bBytes.length, MAX_SLICE_BYTES)), MAX_SLICE_BYTES)
      : "";

  if (aText === bText) {
    return {
      changes: [],
      counts: { same: 1, added: 0, removed: 0, changed: 0, moved: 0 },
      rows: [
        {
          id: "b:0",
          aToken: 0,
          bToken: 0,
          depth: 0,
          mark: "same",
          kind: "string",
          key: null,
          index: null,
          value: JSON.stringify(bText.slice(0, 256)),
          wasValue: null,
          pointer: "",
          expandable: false,
          childCount: 0,
        },
      ],
    };
  }

  if (aEntryBytes === null) {
    return {
      changes: [{ kind: "added", aToken: null, bToken: 0, pathA: null, pathB: "" }],
      counts: { same: 0, added: 1, removed: 0, changed: 0, moved: 0 },
      rows: [
        {
          id: "b:0",
          aToken: null,
          bToken: 0,
          depth: 0,
          mark: "added",
          kind: "string",
          key: null,
          index: null,
          value: JSON.stringify(bText.slice(0, 256)),
          wasValue: null,
          pointer: "",
          expandable: false,
          childCount: 0,
        },
      ],
    };
  }

  if (bEntryBytes === null) {
    return {
      changes: [{ kind: "removed", aToken: 0, bToken: null, pathA: "", pathB: null }],
      counts: { same: 0, added: 0, removed: 1, changed: 0, moved: 0 },
      rows: [
        {
          id: "a:0",
          aToken: 0,
          bToken: null,
          depth: 0,
          mark: "removed",
          kind: "string",
          key: null,
          index: null,
          value: JSON.stringify(aText.slice(0, 256)),
          wasValue: null,
          pointer: "",
          expandable: false,
          childCount: 0,
        },
      ],
    };
  }

  return {
    changes: [{ kind: "changed", aToken: 0, bToken: 0, pathA: "", pathB: "" }],
    counts: { same: 0, added: 0, removed: 0, changed: 1, moved: 0 },
    rows: [
      {
        id: "b:0",
        aToken: 0,
        bToken: 0,
        depth: 0,
        mark: "changed",
        kind: "string",
        key: null,
        index: null,
        value: JSON.stringify(bText.slice(0, 256)),
        wasValue: JSON.stringify(aText.slice(0, 256)),
        pointer: "",
        expandable: false,
        childCount: 0,
      },
    ],
  };
}
