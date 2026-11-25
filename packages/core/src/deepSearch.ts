import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";
import {
  type DecodeStepName,
  type DeepHitAnnotation,
  MAX_DECODE_CHAIN_DEPTH,
  MAX_DEEP_ANNOTATIONS,
  MAX_DEEP_SNIPPET_CHARS,
} from "@quipu/contracts/deepSearch";

import { Base64Decoder, base64MaxDecoded } from "./base64.ts";
import { decodeUtf8, parseJsonSlice } from "./boundedSlice.ts";
import { BACKSLASH, QUOTE } from "./bytes.ts";
import { unescapeBytes } from "./decode.ts";
import { parseForm } from "./form.ts";
import { inflateGzip } from "./gzip.ts";
import { scanJson } from "./jsonScan.ts";
import { decodeJwt, MAX_JWT_BYTES } from "./jwt.ts";
import { BudgetExceededError, type Pool } from "./pool.ts";
import {
  type ChunkOptions,
  type ChunkResult,
  compileRegex,
  DEFAULT_CHUNK_OPTIONS,
  type ReadBytes,
  safeBoundary,
  type SearchSpec,
  searchChunk,
} from "./search.ts";
import type { SearchOutcome, SearchRunOptions, SearchTarget, SkippedRange } from "./searchRun.ts";

const MAX_STRINGIFY_DEPTH = 8;
const MAX_CANDIDATE_BYTES = MAX_SLICE_BYTES;

const MIN_HEURISTIC_BASE64 = 24;
const MIN_PREFIXED_BASE64 = 16;
const PARITY_BLOCK_BYTES = 8 * 1024 * 1024;
const READ_AHEAD_STEP = 1024 * 1024;
const HINT_WINDOW_BYTES = 192;
const SNIPPET_RADIUS = 72;

const isValidUtf8 = (bytes: Uint8Array): boolean => {
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    const b = bytes[i] as number;
    if (b < 0x80) continue;
    let extra = 0;
    let min = 0;
    let cp = 0;
    if (b >= 0xc2 && b <= 0xdf) {
      extra = 1;
      min = 0x80;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      extra = 2;
      min = 0x800;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      extra = 3;
      min = 0x10000;
      cp = b & 0x07;
    } else {
      return false;
    }
    if (i + extra >= n) return false;
    for (let k = 1; k <= extra; k++) {
      const c = bytes[i + k] as number;
      if ((c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += extra;
  }
  return true;
};
const textEncoder = new TextEncoder();

const B64_VALID = new Uint8Array(256);
for (let b = 0x41; b <= 0x5a; b++) B64_VALID[b] = 1;
for (let b = 0x61; b <= 0x7a; b++) B64_VALID[b] = 1;
for (let b = 0x30; b <= 0x39; b++) B64_VALID[b] = 1;
B64_VALID[0x2b] = 1; // +
B64_VALID[0x2f] = 1; // /
B64_VALID[0x2d] = 1; // -
B64_VALID[0x5f] = 1; // _
B64_VALID[0x3d] = 2; // =
B64_VALID[0x20] = 3;
B64_VALID[0x09] = 3;
B64_VALID[0x0a] = 3;
B64_VALID[0x0d] = 3;

const HEX_DIGIT = new Uint8Array(256);
for (let b = 0x30; b <= 0x39; b++) HEX_DIGIT[b] = 1;
for (let b = 0x41; b <= 0x46; b++) HEX_DIGIT[b] = 1;
for (let b = 0x61; b <= 0x66; b++) HEX_DIGIT[b] = 1;

const isAsciiWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/** First-byte prefilter for unhinted base64/gzip/data/JWT/JSON-string candidates. */
const FAST_PREFIX = new Uint8Array(256);
for (const c of ["e", "W", "I", "C", "D", "H", "d", "B", "b", "{", "["]) {
  FAST_PREFIX[c.charCodeAt(0)] = 1;
}
FAST_PREFIX[BACKSLASH] = 1;
FAST_PREFIX[QUOTE] = 1;

export interface ParityResult {
  readonly start: number;
  readonly end: number;
  readonly unescapedQuotes: number;
}

export interface DeepChunkResult extends ChunkResult {
  readonly annotations: ReadonlyArray<DeepHitAnnotation>;
}

export interface DeepSearchOutcome extends SearchOutcome {
  readonly annotations: ReadonlyArray<DeepHitAnnotation>;
}

export interface DecodedLeafOccurrence {
  readonly pointer: string;
  readonly value: string;
  readonly decodeChain: ReadonlyArray<DecodeStepName>;
  readonly snippet: string;
}

const countTrailingBackslashes = (bytes: Uint8Array, beforeIndex: number): number => {
  let k = beforeIndex - 1;
  let bs = 0;
  while (k >= 0 && bytes[k] === BACKSLASH) {
    bs++;
    k--;
  }
  return bs;
};

const isUnescapedQuote = (bytes: Uint8Array, index: number, carryBs = 0): boolean => {
  if (index === 0) return (carryBs & 1) === 0;
  if (bytes[index - 1] !== BACKSLASH) return true;
  let bs = countTrailingBackslashes(bytes, index);
  if (bs === index) bs += carryBs;
  return (bs & 1) === 0;
};

/** Counts unescaped JSON quotes in `[start, end)` using SIMD `indexOf`. */
export const quoteParityChunk = async (
  read: ReadBytes,
  size: number,
  nominalStart: number,
  nominalEnd: number,
  decode: boolean,
): Promise<ParityResult> => {
  const start = await safeBoundary(read, size, nominalStart, decode);
  const end = await safeBoundary(read, size, nominalEnd, decode);
  if (!decode || start >= end) return { start, end, unescapedQuotes: 0 };
  let unescapedQuotes = 0;
  let carryBs = 0;
  let pos = start;
  while (pos < end) {
    const to = Math.min(end, pos + PARITY_BLOCK_BYTES);
    const bytes = await read(pos, to);
    let at = 0;
    while ((at = bytes.indexOf(QUOTE, at)) !== -1) {
      if (isUnescapedQuote(bytes, at, carryBs)) unescapedQuotes++;
      at++;
    }
    const tail = countTrailingBackslashes(bytes, bytes.length);
    carryBs = tail === bytes.length ? carryBs + tail : tail;
    pos = to;
  }
  return { start, end, unescapedQuotes };
};

interface TextMatcher {
  readonly matchBytes: (bytes: Uint8Array) => number;
  readonly matchString: (text: string) => number;
}

const buildTextMatcher = (spec: SearchSpec): TextMatcher => {
  if (spec.kind === "literal") {
    const needle = spec.needle;
    const nLen = needle.length;
    if (nLen === 0) return { matchBytes: () => -1, matchString: () => -1 };
    if (spec.caseSensitive) {
      const needleStr = decodeUtf8(needle);
      return {
        matchBytes: (bytes) => {
          if (bytes.length < nLen) return -1;
          const b0 = needle[0] as number;
          let at = 0;
          while ((at = bytes.indexOf(b0, at)) !== -1) {
            if (at + nLen > bytes.length) return -1;
            let ok = true;
            for (let k = 1; k < nLen; k++) {
              if (bytes[at + k] !== needle[k]) {
                ok = false;
                break;
              }
            }
            if (ok) return at;
            at++;
          }
          return -1;
        },
        matchString: (text) => text.indexOf(needleStr),
      };
    }
    const lowerNeedle = new Uint8Array(nLen);
    for (let i = 0; i < nLen; i++) {
      const b = needle[i] as number;
      lowerNeedle[i] = b >= 0x41 && b <= 0x5a ? b | 0x20 : b;
    }
    const firstLower = lowerNeedle[0] as number;
    const firstUpper = firstLower >= 0x61 && firstLower <= 0x7a ? firstLower & ~0x20 : firstLower;
    const needleLowerStr = decodeUtf8(lowerNeedle);
    return {
      matchBytes: (bytes) => {
        if (bytes.length < nLen) return -1;
        const limit = bytes.length - nLen;
        for (let i = 0; i <= limit; i++) {
          const b = bytes[i] as number;
          if (b !== firstLower && b !== firstUpper) continue;
          let ok = true;
          for (let k = 1; k < nLen; k++) {
            const c = bytes[i + k] as number;
            const lc = c >= 0x41 && c <= 0x5a ? c | 0x20 : c;
            if (lc !== lowerNeedle[k]) {
              ok = false;
              break;
            }
          }
          if (ok) return i;
        }
        return -1;
      },
      matchString: (text) => text.toLowerCase().indexOf(needleLowerStr),
    };
  }
  const re = compileRegex(spec);
  return {
    matchBytes: (bytes) => {
      if (!isValidUtf8(bytes)) return -1;
      try {
        const text = decodeUtf8(bytes, MAX_CANDIDATE_BYTES);
        re.lastIndex = 0;
        const m = re.exec(text);
        return m ? m.index : -1;
      } catch {
        return -1;
      }
    },
    matchString: (text) => {
      re.lastIndex = 0;
      const m = re.exec(text);
      return m ? m.index : -1;
    },
  };
};

const makeSnippet = (text: string, matchAt: number): string => {
  const start = Math.max(0, matchAt - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchAt + SNIPPET_RADIUS * 2);
  let slice = text.slice(start, end).replace(/[\r\n]+/g, " ");
  if (start > 0) slice = `…${slice}`;
  if (end < text.length) slice = `${slice}…`;
  return slice.slice(0, MAX_DEEP_SNIPPET_CHARS);
};

export const decodeUtf8Strict = (bytes: Uint8Array): string | null => {
  if (bytes.length > MAX_CANDIDATE_BYTES || !isValidUtf8(bytes)) return null;
  return decodeUtf8(bytes, MAX_CANDIDATE_BYTES);
};

export const unescapeJsonStringContent = (raw: Uint8Array): Uint8Array => {
  if (raw.indexOf(BACKSLASH) < 0) return raw;
  const out = new Uint8Array(raw.length);
  const len = unescapeBytes(raw, 0, raw.length, out, 0);
  return out.subarray(0, len);
};

const trimAsciiSlice = (bytes: Uint8Array): Uint8Array => {
  let start = 0;
  let end = bytes.length;
  while (start < end && isAsciiWs(bytes[start] as number)) start++;
  while (end > start && isAsciiWs(bytes[end - 1] as number)) end--;
  return start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end);
};

interface Base64Inspect {
  readonly ok: boolean;
  readonly isUrl: boolean;
  readonly chars: number;
}

export const inspectBase64Raw = (bytes: Uint8Array, hinted: boolean): Base64Inspect => {
  let end = bytes.length;
  while (end > 0 && isAsciiWs(bytes[end - 1] as number)) end--;
  let padding = 0;
  while (end > 0 && bytes[end - 1] === 0x3d && padding < 2) {
    end--;
    padding++;
  }
  let start = 0;
  while (start < end && isAsciiWs(bytes[start] as number)) start++;
  let chars = 0;
  let hex = true;
  let digits = true;
  let isUrl = false;
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    if (b === BACKSLASH) {
      const next = bytes[i + 1];
      if (next === 0x2f || next === 0x6e || next === 0x72 || next === 0x74) {
        if (next === 0x2f) chars++;
        i++;
        hex = false;
        digits = false;
        continue;
      }
      if (next === 0x75 && i + 5 < end) {
        i += 5;
        chars++;
        hex = false;
        digits = false;
        continue;
      }
      return { ok: false, isUrl: false, chars: 0 };
    }
    const cls = B64_VALID[b] as number;
    if (cls === 0 || cls === 2) return { ok: false, isUrl: false, chars: 0 };
    if (cls === 3) continue;
    chars++;
    if (b === 0x2d || b === 0x5f) isUrl = true;
    if (HEX_DIGIT[b] !== 1) hex = false;
    if (!(b >= 0x30 && b <= 0x39)) digits = false;
  }
  if (chars % 4 === 1) return { ok: false, isUrl: false, chars: 0 };
  if (!hinted && (hex || digits)) return { ok: false, isUrl: false, chars: 0 };
  return { ok: true, isUrl, chars };
};

const decodeBase64Full = (bytes: Uint8Array): Uint8Array | null => {
  const out = new Uint8Array(base64MaxDecoded(bytes.length));
  const decoder = new Base64Decoder();
  const n = decoder.push(bytes, 0, bytes.length, out, 0);
  return decoder.invalid === 0 ? out.subarray(0, n) : null;
};

const decodeBase64Prefix = (bytes: Uint8Array, maxChars = 32): Uint8Array | null => {
  const limit = Math.min(bytes.length, maxChars);
  const out = new Uint8Array(base64MaxDecoded(limit));
  const decoder = new Base64Decoder();
  const n = decoder.push(bytes, 0, limit, out, 0);
  return decoder.invalid === 0 ? out.subarray(0, n) : null;
};

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),/;

const hasEncodingBase64Hint = (buf: Uint8Array, relOpen: number, relClose: number): boolean => {
  const before = decodeUtf8(buf.subarray(Math.max(0, relOpen - HINT_WINDOW_BYTES), relOpen));
  if (/"encoding"\s*:\s*"base64"/i.test(before)) return true;
  const after = decodeUtf8(
    buf.subarray(relClose + 1, Math.min(buf.length, relClose + 1 + HINT_WINDOW_BYTES)),
  );
  return /"encoding"\s*:\s*"base64"/i.test(after);
};

const hasNestedCandidateHint = (raw: Uint8Array): boolean => {
  let pos = 0;
  while ((pos = raw.indexOf(BACKSLASH, pos)) !== -1) {
    const next = raw[pos + 1];
    if (next === BACKSLASH) return true;
    if (next === QUOTE && pos + 2 < raw.length) {
      const c = raw[pos + 2] as number;
      if (FAST_PREFIX[c] === 1) return true;
    }
    if (next === 0x75) return true;
    pos += 2;
  }
  return false;
};

const unwrapJsonStringLiteral = (trimmed: Uint8Array): Uint8Array | null => {
  if (trimmed.length < 2 || trimmed[0] !== QUOTE || trimmed[trimmed.length - 1] !== QUOTE) {
    return null;
  }
  if (scanJson(trimmed).status !== "complete") return null;
  const inner = trimmed.subarray(1, trimmed.length - 1);
  return unescapeJsonStringContent(inner);
};

const collectJsonStringSpans = (jsonBytes: Uint8Array): Array<readonly [number, number]> => {
  const spans: Array<readonly [number, number]> = [];
  let inString = false;
  let openContent = 0;
  let pos = 0;
  while ((pos = jsonBytes.indexOf(QUOTE, pos)) !== -1) {
    if (isUnescapedQuote(jsonBytes, pos)) {
      if (!inString) {
        inString = true;
        openContent = pos + 1;
      } else {
        spans.push([openContent, pos]);
        inString = false;
      }
    }
    pos++;
  }
  return spans;
};

interface DecodeHit {
  readonly decodeChain: ReadonlyArray<DecodeStepName>;
  readonly snippet: string;
}

interface DecodeContext {
  readonly matcher: TextMatcher;
  readonly hinted: boolean;
}

const decodeAndMatchCandidate = async (
  rawOrUnescaped: Uint8Array,
  alreadyUnescaped: boolean,
  chain: ReadonlyArray<DecodeStepName>,
  stringifyDepth: number,
  ctx: DecodeContext,
  hits: DecodeHit[],
): Promise<void> => {
  if (chain.length >= MAX_DECODE_CHAIN_DEPTH) return;
  if (rawOrUnescaped.length === 0 || rawOrUnescaped.length > MAX_CANDIDATE_BYTES) return;

  const trimmed = trimAsciiSlice(rawOrUnescaped);
  if (trimmed.length === 0) return;
  const b0 = trimmed[0] as number;

  if (
    b0 === 0x64 &&
    trimmed.length > 16 &&
    trimmed[1] === 0x61 &&
    trimmed[2] === 0x74 &&
    trimmed[3] === 0x61 &&
    trimmed[4] === 0x3a
  ) {
    const unesc = alreadyUnescaped ? trimmed : unescapeJsonStringContent(trimmed);
    const head = decodeUtf8(unesc.subarray(0, Math.min(256, unesc.length)));
    const m = DATA_URL_RE.exec(head);
    if (m && /;base64$/i.test(m[2] ?? "")) {
      const comma = unesc.indexOf(0x2c);
      if (comma > 0 && chain.length + 2 <= MAX_DECODE_CHAIN_DEPTH) {
        const decoded = decodeBase64Full(unesc.subarray(comma + 1));
        if (decoded !== null) {
          await handleDecodedBytes(
            decoded,
            [...chain, "data-url", "base64"],
            stringifyDepth,
            ctx,
            hits,
            true,
          );
        }
      }
      return;
    }
  }

  if (
    trimmed.length <= MAX_JWT_BYTES &&
    ((b0 === 0x65 && trimmed[1] === 0x79) || b0 === 0x42 || b0 === 0x62)
  ) {
    const unesc = alreadyUnescaped ? trimmed : unescapeJsonStringContent(trimmed);
    const jwt = decodeJwt(unesc);
    if (jwt !== null && chain.length + 1 <= MAX_DECODE_CHAIN_DEPTH) {
      const jwtChain: DecodeStepName[] = [...chain, "jwt"];
      await handleDecodedBytes(jwt.header, jwtChain, stringifyDepth, ctx, hits, false);
      await handleDecodedBytes(jwt.payload, jwtChain, stringifyDepth, ctx, hits, false);
      return;
    }
  }

  const minLen = ctx.hinted
    ? 4
    : b0 === 0x65 || b0 === 0x48
      ? MIN_PREFIXED_BASE64
      : MIN_HEURISTIC_BASE64;
  if (trimmed.length >= minLen && (ctx.hinted || FAST_PREFIX[b0] === 1)) {
    const inspect = inspectBase64Raw(trimmed, ctx.hinted);
    if (inspect.ok && inspect.chars >= minLen) {
      const prefix = decodeBase64Prefix(trimmed);
      if (prefix !== null && prefix.length > 0) {
        const isGzip = prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
        const pTrim = trimAsciiSlice(prefix);
        const p0 = pTrim[0];
        const looksStructured = p0 === 0x7b || p0 === 0x5b || p0 === QUOTE;
        if (isGzip || looksStructured || ctx.hinted) {
          const decoded = decodeBase64Full(trimmed);
          if (decoded !== null && decoded.length > 0) {
            const b64Step: DecodeStepName = inspect.isUrl ? "base64url" : "base64";
            if (isGzip) {
              if (chain.length + 2 <= MAX_DECODE_CHAIN_DEPTH) {
                try {
                  const inflated = await inflateGzip(decoded, MAX_CANDIDATE_BYTES);
                  await handleDecodedBytes(
                    inflated,
                    [...chain, b64Step, "gzip"],
                    stringifyDepth,
                    ctx,
                    hits,
                    true,
                  );
                } catch {
                  // Ignore corrupt or oversized gzip payloads.
                }
              }
              return;
            }
            await handleDecodedBytes(
              decoded,
              [...chain, b64Step],
              stringifyDepth,
              ctx,
              hits,
              ctx.hinted,
            );
            return;
          }
        }
      }
    }
  }

  const unesc = alreadyUnescaped ? trimmed : unescapeJsonStringContent(trimmed);
  const uTrim = trimAsciiSlice(unesc);
  if (uTrim.length === 0) return;
  const u0 = uTrim[0] as number;

  if (u0 === QUOTE) {
    if (stringifyDepth >= MAX_STRINGIFY_DEPTH) return;
    const unwrapped = unwrapJsonStringLiteral(uTrim);
    if (unwrapped !== null) {
      const nextChain: DecodeStepName[] = [...chain, "json-string"];
      const matchPos = ctx.matcher.matchBytes(unwrapped);
      const innerTrim = trimAsciiSlice(unwrapped);
      const i0 = innerTrim[0];
      if (i0 === 0x7b || i0 === 0x5b || i0 === QUOTE) {
        await decodeAndMatchCandidate(unwrapped, true, nextChain, stringifyDepth + 1, ctx, hits);
      } else {
        const beforeCount = hits.length;
        await decodeAndMatchCandidate(unwrapped, true, nextChain, stringifyDepth + 1, ctx, hits);
        if (hits.length === beforeCount && matchPos >= 0) {
          const str = decodeUtf8Strict(unwrapped);
          if (str !== null) {
            hits.push({ decodeChain: nextChain, snippet: makeSnippet(str, matchPos) });
          }
        }
      }
    }
    return;
  }

  if (u0 === 0x7b || u0 === 0x5b) {
    await handleJsonContainer(uTrim, chain, stringifyDepth, ctx, hits);
  }
};

const handleDecodedBytes = async (
  bytes: Uint8Array,
  chain: ReadonlyArray<DecodeStepName>,
  stringifyDepth: number,
  ctx: DecodeContext,
  hits: DecodeHit[],
  allowPlainText: boolean,
): Promise<void> => {
  if (chain.length > MAX_DECODE_CHAIN_DEPTH || bytes.length > MAX_CANDIDATE_BYTES) return;
  const text = decodeUtf8Strict(bytes);
  if (text === null) return;

  const trimmed = trimAsciiSlice(bytes);
  if (trimmed.length === 0) return;
  const t0 = trimmed[0] as number;

  if (t0 === QUOTE) {
    if (stringifyDepth >= MAX_STRINGIFY_DEPTH) {
      const idx = ctx.matcher.matchString(text);
      if (idx >= 0) hits.push({ decodeChain: chain, snippet: makeSnippet(text, idx) });
      return;
    }
    const unwrapped = unwrapJsonStringLiteral(trimmed);
    if (unwrapped !== null && chain.length + 1 <= MAX_DECODE_CHAIN_DEPTH) {
      await handleDecodedBytes(
        unwrapped,
        [...chain, "json-string"],
        stringifyDepth + 1,
        ctx,
        hits,
        true,
      );
      return;
    }
  }

  if (t0 === 0x7b || t0 === 0x5b) {
    if (scanJson(trimmed).status === "complete" && chain.length + 1 <= MAX_DECODE_CHAIN_DEPTH) {
      await handleJsonContainer(trimmed, chain, stringifyDepth, ctx, hits);
      return;
    }
    if (trimmed.indexOf(0x0a) >= 0 && chain.length + 1 <= MAX_DECODE_CHAIN_DEPTH) {
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (
        lines.length >= 2 &&
        lines.every((l) => scanJson(textEncoder.encode(l)).status === "complete")
      ) {
        const ndjsonChain: DecodeStepName[] = [...chain, "ndjson"];
        const idx = ctx.matcher.matchString(text);
        if (idx >= 0) hits.push({ decodeChain: ndjsonChain, snippet: makeSnippet(text, idx) });
        return;
      }
    }
  }

  if (allowPlainText) {
    const idx = ctx.matcher.matchString(text);
    if (idx >= 0) {
      hits.push({ decodeChain: chain, snippet: makeSnippet(text, idx) });
    }
  }
};

const handleJsonContainer = async (
  jsonBytes: Uint8Array,
  chain: ReadonlyArray<DecodeStepName>,
  stringifyDepth: number,
  ctx: DecodeContext,
  hits: DecodeHit[],
): Promise<void> => {
  if (chain.length >= MAX_DECODE_CHAIN_DEPTH) return;
  const jsonChain: DecodeStepName[] =
    chain[chain.length - 1] === "json" ? [...chain] : [...chain, "json"];
  if (jsonChain.length > MAX_DECODE_CHAIN_DEPTH) return;

  const text = decodeUtf8Strict(jsonBytes);
  if (text === null) return;

  const beforeSubHits = hits.length;
  const spans = collectJsonStringSpans(jsonBytes);
  for (const [s, e] of spans) {
    const len = e - s;
    if (len < 12) continue;
    const sub = jsonBytes.subarray(s, e);
    const s0 = sub[0] as number;
    if (FAST_PREFIX[s0] === 1) {
      await decodeAndMatchCandidate(
        sub,
        false,
        jsonChain,
        stringifyDepth,
        { matcher: ctx.matcher, hinted: false },
        hits,
      );
    }
  }

  const directAt = ctx.matcher.matchString(text);
  if (directAt >= 0 && hits.length === beforeSubHits) {
    hits.push({ decodeChain: jsonChain, snippet: makeSnippet(text, directAt) });
  }
};

const isDeepStep = (step: DecodeStepName): boolean =>
  step === "base64" ||
  step === "base64url" ||
  step === "gzip" ||
  step === "jwt" ||
  step === "data-url";

const hasOverlappingPlainHit = (
  plainHits: Float64Array,
  rangeStart: number,
  rangeEnd: number,
): boolean => {
  let lo = 0;
  let hi = plainHits.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((plainHits[mid * 2 + 1] as number) <= rangeStart) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= plainHits.length / 2) return false;
  return (plainHits[lo * 2] as number) < rangeEnd && (plainHits[lo * 2 + 1] as number) > rangeStart;
};

/**
 * Searches one chunk `[nominalStart, nominalEnd)` for both plain hits and
 * deep-decoded hits inside candidate strings whose opening quote sits inside
 * the chunk.
 */
export const deepSearchChunk = async (
  read: ReadBytes,
  size: number,
  nominalStart: number,
  nominalEnd: number,
  decode: boolean,
  spec: SearchSpec,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  resumeAt: number | null = null,
  entryInString = false,
): Promise<DeepChunkResult> => {
  const plain = await searchChunk(
    read,
    size,
    nominalStart,
    nominalEnd,
    decode,
    spec,
    options,
    resumeAt,
  );
  if (!decode || plain.start >= plain.end) {
    return { ...plain, annotations: [] };
  }

  const start = await safeBoundary(read, size, nominalStart, decode);
  const end = plain.end;
  const matcher = buildTextMatcher(spec);

  const deepHits: Array<{
    readonly start: number;
    readonly end: number;
    readonly annotation: DeepHitAnnotation;
    readonly plainOverlap: boolean;
  }> = [];

  let pos = start;
  let inString = entryInString;
  let carryBs = 0;

  while (pos < end) {
    const sliceEnd = Math.min(end, pos + PARITY_BLOCK_BYTES);
    const rawView = await read(pos, sliceEnd);
    let buf: Uint8Array | null = null;
    const ensureOwnBuf = () => {
      if (buf === null) buf = rawView.slice();
      return buf;
    };

    let cursor = 0;
    while (cursor < rawView.length) {
      const q = rawView.indexOf(QUOTE, cursor);
      if (q === -1) break;
      const unescaped = isUnescapedQuote(rawView, q, carryBs);
      cursor = q + 1;
      if (!unescaped) continue;

      if (inString) {
        inString = false;
        continue;
      }

      const openAbs = pos + q;
      let closeInView = -1;
      let scanAt = q + 1;
      while (scanAt < rawView.length) {
        const cq = rawView.indexOf(QUOTE, scanAt);
        if (cq === -1) break;
        if (isUnescapedQuote(rawView, cq, carryBs)) {
          closeInView = cq;
          break;
        }
        scanAt = cq + 1;
      }

      let candidateRaw: Uint8Array;
      let closeAbs: number;
      let hinted = false;

      if (closeInView !== -1) {
        closeAbs = pos + closeInView;
        cursor = closeInView + 1;
        const contentLen = closeInView - (q + 1);
        if (contentLen < 4 || contentLen > MAX_CANDIDATE_BYTES) continue;
        const first = rawView[q + 1] as number;
        hinted = hasEncodingBase64Hint(rawView, q, closeInView);
        if (!hinted && (contentLen < MIN_PREFIXED_BASE64 || FAST_PREFIX[first] !== 1)) {
          continue;
        }
        if (
          !hinted &&
          (first === 0x7b || first === 0x5b) &&
          !hasNestedCandidateHint(rawView.subarray(q + 1, closeInView))
        ) {
          continue;
        }
        candidateRaw = rawView.subarray(q + 1, closeInView);
      } else {
        const own = ensureOwnBuf();
        const parts: Uint8Array[] = [own.subarray(q + 1)];
        let collected = own.length - (q + 1);
        let tailBs = countTrailingBackslashes(own, own.length);
        let ahead = sliceEnd;
        let foundClose = false;
        closeAbs = size;
        while (ahead < size && collected < MAX_CANDIDATE_BYTES) {
          const nextTo = Math.min(size, ahead + READ_AHEAD_STEP);
          const nextChunk = await read(ahead, nextTo);
          let scanPos = 0;
          while (scanPos < nextChunk.length) {
            const cq = nextChunk.indexOf(QUOTE, scanPos);
            if (cq === -1) break;
            if (isUnescapedQuote(nextChunk, cq, tailBs)) {
              parts.push(nextChunk.slice(0, cq));
              collected += cq;
              closeAbs = ahead + cq;
              foundClose = true;
              break;
            }
            scanPos = cq + 1;
          }
          if (foundClose) break;
          parts.push(nextChunk.slice());
          collected += nextChunk.length;
          const t = countTrailingBackslashes(nextChunk, nextChunk.length);
          tailBs = t === nextChunk.length ? tailBs + t : t;
          ahead = nextTo;
        }
        if (!foundClose || collected > MAX_CANDIDATE_BYTES) {
          inString = true;
          break;
        }
        if (closeAbs < sliceEnd) {
          cursor = closeAbs - pos + 1;
        } else {
          pos = closeAbs + 1;
          inString = false;
          carryBs = 0;
          cursor = rawView.length;
        }
        const joined = new Uint8Array(collected);
        let off = 0;
        for (const p of parts) {
          joined.set(p, off);
          off += p.length;
        }
        candidateRaw = joined;
        if (candidateRaw.length < 4) continue;
        const first = candidateRaw[0] as number;
        hinted = hasEncodingBase64Hint(own, q, own.length - 1);
        if (!hinted && (candidateRaw.length < MIN_PREFIXED_BASE64 || FAST_PREFIX[first] !== 1)) {
          continue;
        }
        if (
          !hinted &&
          (first === 0x7b || first === 0x5b) &&
          !hasNestedCandidateHint(candidateRaw)
        ) {
          continue;
        }
      }

      const outerStart = openAbs;
      const outerEnd = closeAbs + 1;
      if (resumeAt !== null && outerStart < resumeAt) continue;

      const foundHits: DecodeHit[] = [];
      await decodeAndMatchCandidate(candidateRaw, false, [], 0, { matcher, hinted }, foundHits);
      if (foundHits.length === 0) continue;

      const best = foundHits[0] as DecodeHit;
      const overlap = hasOverlappingPlainHit(plain.hits, outerStart, outerEnd);
      const hasDeepEncoding = best.decodeChain.some(isDeepStep);
      const hasStringify = best.decodeChain.includes("json-string");

      if (overlap && !hasDeepEncoding && !hasStringify) continue;

      deepHits.push({
        start: outerStart,
        end: outerEnd,
        plainOverlap: overlap,
        annotation: {
          range: { start: outerStart, end: outerEnd },
          decodeChain: best.decodeChain,
          snippet: best.snippet,
        },
      });
      if (pos > sliceEnd) break;
    }

    if (pos >= sliceEnd) continue;
    const tail = countTrailingBackslashes(rawView, rawView.length);
    carryBs = tail === rawView.length ? carryBs + tail : tail;
    pos = sliceEnd;
  }

  if (deepHits.length === 0) {
    return { ...plain, annotations: [] };
  }

  const annotations: DeepHitAnnotation[] = [];
  const addedRanges: Array<readonly [number, number]> = [];
  for (const hit of deepHits) {
    if (annotations.length < MAX_DEEP_ANNOTATIONS) annotations.push(hit.annotation);
    if (!hit.plainOverlap) addedRanges.push([hit.start, hit.end]);
  }

  if (addedRanges.length === 0) {
    return { ...plain, annotations };
  }

  const plainCount = plain.hits.length / 2;
  const merged = new Float64Array(Math.min(options.maxHits, plainCount + addedRanges.length) * 2);
  let pi = 0;
  let di = 0;
  let outIdx = 0;
  let lastEnd = plain.lastEnd;
  while (outIdx < options.maxHits && (pi < plainCount || di < addedRanges.length)) {
    const takePlain =
      di >= addedRanges.length ||
      (pi < plainCount && (plain.hits[pi * 2] as number) <= (addedRanges[di]![0] as number));
    if (takePlain) {
      const s = plain.hits[pi * 2] as number;
      const e = plain.hits[pi * 2 + 1] as number;
      merged[outIdx * 2] = s;
      merged[outIdx * 2 + 1] = e;
      if (e > lastEnd) lastEnd = e;
      pi++;
    } else {
      const [s, e] = addedRanges[di]!;
      merged[outIdx * 2] = s;
      merged[outIdx * 2 + 1] = e;
      if (e > lastEnd) lastEnd = e;
      di++;
    }
    outIdx++;
  }

  return {
    start: plain.start,
    end: plain.end,
    count: plain.count + addedRanges.length,
    hits: merged.subarray(0, outIdx * 2),
    lastEnd,
    limited: plain.limited,
    annotations,
  };
};

/** Runs deep-decode search in parallel across `pool` workers. */
export const runDeepSearch = async (
  pool: Pool,
  target: SearchTarget,
  spec: SearchSpec,
  options: SearchRunOptions,
): Promise<DeepSearchOutcome> => {
  const { size } = target;
  const from = target.start ?? 0;
  const to = target.end ?? size;
  const chunkCount = Math.max(0, Math.ceil((to - from) / options.chunkBytes));
  const workerCount = options.workers ?? pool.size;
  const nominal = (index: number) => ({
    a: from + index * options.chunkBytes,
    b: Math.min(to, from + (index + 1) * options.chunkBytes),
  });

  const entryInString = new Uint8Array(chunkCount);
  if (chunkCount > 1 && target.decode) {
    const parities: Array<ParityResult | undefined> = Array.from({ length: chunkCount });
    let nextP = 0;
    await Promise.all(
      pool.workers.slice(0, workerCount).map(async (_, worker) => {
        while (!options.isCancelled()) {
          const index = nextP++;
          if (index >= chunkCount) return;
          const { a, b } = nominal(index);
          parities[index] = await pool.call<ParityResult>(worker, {
            type: "quoteParity",
            sourceId: target.sourceId,
            start: a,
            end: b,
            size,
            decode: target.decode,
          });
        }
      }),
    );
    if (options.isCancelled()) {
      return {
        count: 0,
        hits: new Float64Array(0),
        retainedUntil: size,
        skipped: [],
        limited: 0,
        status: "cancelled",
        annotations: [],
      };
    }
    let inside = false;
    for (let i = 0; i < chunkCount; i++) {
      entryInString[i] = inside ? 1 : 0;
      const p = parities[i];
      if (p && (p.unescapedQuotes & 1) === 1) inside = !inside;
    }
  }

  const results: Array<DeepChunkResult | null | undefined> = Array.from({ length: chunkCount });
  const skipped: SkippedRange[] = [];
  let next = 0;
  const abort = { stopped: false };

  const run = async (worker: number, index: number, resumeAt: number | null) => {
    const { a, b } = nominal(index);
    try {
      return await pool.call<DeepChunkResult>(
        worker,
        {
          type: "deepSearch",
          sourceId: target.sourceId,
          start: a,
          end: b,
          size,
          decode: target.decode,
          spec,
          options: options.chunk,
          resumeAt,
          entryInString: entryInString[index] === 1,
        },
        [],
        options.budgetMs,
      );
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      skipped.push({ start: resumeAt ?? a, end: b });
      if (skipped.length >= options.maxSkipped) abort.stopped = true;
      return null;
    }
  };

  await Promise.all(
    pool.workers.slice(0, workerCount).map(async (_, worker) => {
      while (!abort.stopped && !options.isCancelled()) {
        const index = next++;
        if (index >= chunkCount) return;
        results[index] = await run(worker, index, null);
      }
    }),
  );

  let carry = 0;
  let count = 0;
  let limited = 0;
  let retained = 0;
  let retainedUntil = size;
  let holes = false;
  const kept: Float64Array[] = [];
  const annotations: DeepHitAnnotation[] = [];

  for (let index = 0; index < chunkCount; index++) {
    let result = results[index];
    if (result === undefined || result === null) continue;
    if (result.count > 0 && (result.hits[0] as number) < carry) {
      if (carry >= result.end) {
        result = { ...result, count: 0, hits: new Float64Array(0), limited: 0, annotations: [] };
      } else {
        const again = await run(index % workerCount, index, carry);
        if (again === null) continue;
        result = again;
      }
    }
    count += result.count;
    limited += result.limited;
    if (result.count > 0) carry = Math.max(carry, result.lastEnd);
    for (const ann of result.annotations) {
      if (annotations.length < MAX_DEEP_ANNOTATIONS) annotations.push(ann);
    }
    if (holes) continue;
    const room = Math.max(0, options.maxRetained - retained);
    const stored = result.hits.length / 2;
    if (stored <= room && result.count === stored) {
      kept.push(result.hits);
      retained += stored;
      continue;
    }
    const take = Math.min(stored, room);
    kept.push(result.hits.subarray(0, take * 2));
    retained += take;
    retainedUntil = take > 0 ? (result.hits[take * 2 - 1] as number) : result.start;
    holes = true;
  }

  const hits = new Float64Array(retained * 2);
  let at = 0;
  for (const part of kept) {
    hits.set(part, at);
    at += part.length;
  }
  const status = options.isCancelled() ? "cancelled" : abort.stopped ? "partial" : "complete";
  return { count, hits, retainedUntil, skipped, limited, status, annotations };
};

export const formatJsonPointerSegment = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

const walkJsonValueOccurrences = async (
  value: unknown,
  target: string,
  pointerPrefix: string,
  chain: ReadonlyArray<DecodeStepName>,
  stringifyDepth: number,
  out: DecodedLeafOccurrence[],
): Promise<void> => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    const str = String(value);
    if (str === target) {
      out.push({
        pointer: pointerPrefix,
        value: str,
        decodeChain: chain,
        snippet: str.slice(0, MAX_DEEP_SNIPPET_CHARS),
      });
    }
    return;
  }
  if (typeof value === "string") {
    if (value === target) {
      out.push({
        pointer: pointerPrefix,
        value,
        decodeChain: chain,
        snippet: value.slice(0, MAX_DEEP_SNIPPET_CHARS),
      });
      return;
    }
    if (chain.length < MAX_DECODE_CHAIN_DEPTH) {
      await extractDecodedValueOccurrences(
        textEncoder.encode(value),
        true,
        target,
        pointerPrefix,
        chain,
        stringifyDepth,
        out,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      await walkJsonValueOccurrences(
        value[i],
        target,
        `${pointerPrefix}/${i}`,
        chain,
        stringifyDepth,
        out,
      );
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      await walkJsonValueOccurrences(
        v,
        target,
        `${pointerPrefix}/${formatJsonPointerSegment(k)}`,
        chain,
        stringifyDepth,
        out,
      );
    }
  }
};

/** Extracts every exact leaf occurrence of `target` inside a raw or decoded string value. */
export const extractDecodedValueOccurrences = async (
  rawOrUnescaped: Uint8Array,
  alreadyUnescaped: boolean,
  target: string,
  pointerPrefix: string,
  chain: ReadonlyArray<DecodeStepName>,
  stringifyDepth: number,
  out: DecodedLeafOccurrence[],
  hinted = false,
): Promise<void> => {
  if (chain.length >= MAX_DECODE_CHAIN_DEPTH || rawOrUnescaped.length > MAX_CANDIDATE_BYTES) return;
  const trimmed = trimAsciiSlice(rawOrUnescaped);
  if (trimmed.length === 0) return;
  const b0 = trimmed[0] as number;

  if (
    b0 === 0x64 &&
    trimmed.length > 16 &&
    trimmed[1] === 0x61 &&
    trimmed[2] === 0x74 &&
    trimmed[3] === 0x61 &&
    trimmed[4] === 0x3a
  ) {
    const unesc = alreadyUnescaped ? trimmed : unescapeJsonStringContent(trimmed);
    const head = decodeUtf8(unesc.subarray(0, Math.min(256, unesc.length)));
    const m = DATA_URL_RE.exec(head);
    if (m && /;base64$/i.test(m[2] ?? "")) {
      const comma = unesc.indexOf(0x2c);
      if (comma > 0 && chain.length + 2 <= MAX_DECODE_CHAIN_DEPTH) {
        const decoded = decodeBase64Full(unesc.subarray(comma + 1));
        if (decoded !== null) {
          await extractDecodedValueOccurrences(
            decoded,
            true,
            target,
            pointerPrefix,
            [...chain, "data-url", "base64"],
            stringifyDepth,
            out,
            true,
          );
        }
      }
      return;
    }
  }

  if (
    trimmed.length <= MAX_JWT_BYTES &&
    ((b0 === 0x65 && trimmed[1] === 0x79) || b0 === 0x42 || b0 === 0x62)
  ) {
    const unesc = alreadyUnescaped ? trimmed : unescapeJsonStringContent(trimmed);
    const jwt = decodeJwt(unesc);
    if (jwt !== null && chain.length + 1 <= MAX_DECODE_CHAIN_DEPTH) {
      const nextChain: DecodeStepName[] = [...chain, "jwt"];
      await extractDecodedValueOccurrences(
        jwt.header,
        true,
        target,
        `${pointerPrefix}/header`,
        nextChain,
        stringifyDepth,
        out,
      );
      await extractDecodedValueOccurrences(
        jwt.payload,
        true,
        target,
        `${pointerPrefix}/payload`,
        nextChain,
        stringifyDepth,
        out,
      );
      return;
    }
  }

  const minLen = hinted
    ? 4
    : b0 === 0x65 || b0 === 0x48
      ? MIN_PREFIXED_BASE64
      : MIN_HEURISTIC_BASE64;
  if (trimmed.length >= minLen && (hinted || FAST_PREFIX[b0] === 1)) {
    const inspect = inspectBase64Raw(trimmed, hinted);
    if (inspect.ok && inspect.chars >= minLen) {
      const prefix = decodeBase64Prefix(trimmed);
      if (prefix !== null && prefix.length > 0) {
        const isGzip = prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
        const p0 = trimAsciiSlice(prefix)[0];
        if (isGzip || p0 === 0x7b || p0 === 0x5b || p0 === QUOTE || hinted) {
          const decoded = decodeBase64Full(trimmed);
          if (decoded !== null) {
            const b64Step: DecodeStepName = inspect.isUrl ? "base64url" : "base64";
            if (isGzip) {
              try {
                const inflated = await inflateGzip(decoded, MAX_CANDIDATE_BYTES);
                await extractDecodedValueOccurrences(
                  inflated,
                  true,
                  target,
                  pointerPrefix,
                  [...chain, b64Step, "gzip"],
                  stringifyDepth,
                  out,
                  true,
                );
              } catch {
                // Ignore corrupt gzip.
              }
              return;
            }
            await extractDecodedValueOccurrences(
              decoded,
              true,
              target,
              pointerPrefix,
              [...chain, b64Step],
              stringifyDepth,
              out,
              hinted,
            );
            return;
          }
        }
      }
    }
  }

  const unesc = alreadyUnescaped ? trimmed : unescapeJsonStringContent(trimmed);
  const text = decodeUtf8Strict(unesc);
  if (text === null) return;
  if (text === target && chain.length > 0) {
    out.push({
      pointer: pointerPrefix,
      value: text,
      decodeChain: chain,
      snippet: text.slice(0, MAX_DEEP_SNIPPET_CHARS),
    });
    return;
  }
  const uTrim = trimAsciiSlice(unesc);
  const u0 = uTrim[0];
  if (u0 === QUOTE && stringifyDepth < MAX_STRINGIFY_DEPTH) {
    const unwrapped = unwrapJsonStringLiteral(uTrim);
    if (unwrapped !== null) {
      await extractDecodedValueOccurrences(
        unwrapped,
        true,
        target,
        pointerPrefix,
        [...chain, "json-string"],
        stringifyDepth + 1,
        out,
      );
      return;
    }
  }
  if (u0 === 0x7b || u0 === 0x5b) {
    try {
      const parsed = parseJsonSlice(unesc, MAX_CANDIDATE_BYTES);
      const jsonChain: DecodeStepName[] = [...chain, "json"];
      if (jsonChain.length <= MAX_DECODE_CHAIN_DEPTH) {
        await walkJsonValueOccurrences(
          parsed,
          target,
          pointerPrefix,
          jsonChain,
          stringifyDepth,
          out,
        );
      }
      return;
    } catch {
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length >= 2) {
        try {
          const parsedLines = lines.map((l) =>
            parseJsonSlice(textEncoder.encode(l), MAX_CANDIDATE_BYTES),
          );
          await walkJsonValueOccurrences(
            parsedLines,
            target,
            pointerPrefix,
            [...chain, "ndjson"],
            stringifyDepth,
            out,
          );
          return;
        } catch {
          // Not NDJSON.
        }
      }
    }
  }
  if (unesc.indexOf(0x3d) >= 0 && unesc.indexOf(0x20) < 0 && unesc.indexOf(0x0a) < 0) {
    const form = parseForm(unesc);
    if (form.fields.length > 0 && form.fields.some((f) => f.value === target)) {
      const formChain: DecodeStepName[] = [...chain, "form"];
      for (const field of form.fields) {
        if (field.value === target) {
          out.push({
            pointer: `${pointerPrefix}/${formatJsonPointerSegment(field.name)}`,
            value: field.value,
            decodeChain: formChain,
            snippet: `${field.name}=${field.value}`.slice(0, MAX_DEEP_SNIPPET_CHARS),
          });
        }
      }
    }
  }
};
