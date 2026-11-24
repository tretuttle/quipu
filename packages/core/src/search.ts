/**
 * Search over the bytes of a document: literal or regular expression, in
 * chunks that workers run in parallel. The design and its traps are in
 * docs/internals/document-engine.md, "Search"; the rules in short:
 *
 * - **What is matched.** The text the user sees: raw bytes, with the escapes
 *   inside JSON strings replaced by the characters they stand for (`escapeView`).
 *   A text document is matched as it is.
 * - **Hits** are `[start, end)` byte ranges of the raw file, non-overlapping and
 *   leftmost-first, exactly what one sequential scan from byte 0 would report.
 * - **Chunk edges** are placed where escape pairing and UTF-8 are known from one
 *   byte of context (`safeBoundary`), so a chunk never starts inside an escape or
 *   a code point, and both neighbours compute the same edge from the same bytes.
 * - **Cross-chunk matches** belong to the chunk they start in and may run past
 *   its end (a lookahead of `lookView` decoded bytes). A chunk scans as if it
 *   were the first; when the merge finds that its first hit starts inside a
 *   hit of the previous chunk, that chunk is scanned again from the end of the
 *   previous hit, which is what the sequential scan would have done.
 * - **A match longer than the lookahead** may be cut at its end; the chunk counts
 *   those in `limited`.
 * - **Backtracking** cannot be interrupted inside a worker, so the budget is
 *   enforced from outside (`Pool` restarts a worker that overruns it) and a
 *   chunk that did is reported as skipped.
 */
import { decodeUtf8Mapped } from "./boundedSlice.ts";
import { BACKSLASH } from "./bytes.ts";
import { EscapeView, isSafeStart } from "./escapeView.ts";

/** A literal needle, as UTF-8; ASCII letters fold when `caseSensitive` is false. */
export interface LiteralSpec {
  readonly kind: "literal";
  readonly needle: Uint8Array;
  readonly caseSensitive: boolean;
}

export interface RegexSpec {
  readonly kind: "regex";
  readonly source: string;
  /** JS flags; the matcher adds `g` and `m` itself. */
  readonly flags: string;
}

export type SearchSpec = LiteralSpec | RegexSpec;

export interface ChunkOptions {
  /** Raw bytes decoded and matched at a time: what a window of the decoded text costs. */
  readonly blockBytes: number;
  /** Decoded bytes a match may run past the end of its block or chunk. */
  readonly lookView: number;
  /** Hits kept per chunk; `count` keeps counting. */
  readonly maxHits: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  blockBytes: 1024 * 1024,
  lookView: 32 * 1024,
  maxHits: 262_144,
};

/** Raw bytes of context before a chunk that `^`, `\b` and lookbehind may read. */
const PREFIX_BYTES = 256;
/** How far a chunk edge is searched for before the previous chunk takes the rest. */
const BOUNDARY_SCAN_LIMIT = 16 * 1024 * 1024;
const BOUNDARY_STEP = 4096;
/** An escape is at most 12 raw bytes (a surrogate pair) and yields at least 1 decoded byte. */
const RAW_PER_VIEW = 12;

export type ReadBytes = (start: number, end: number) => Promise<Uint8Array>;

export interface ChunkResult {
  /** The chunk's actual `[start, end)` after its edges were moved to safe positions. */
  readonly start: number;
  readonly end: number;
  readonly count: number;
  /** Retained hits as `start, end` pairs of raw byte offsets, in order. */
  readonly hits: Float64Array;
  /** Raw end of the last hit, or 0 with none. */
  readonly lastEnd: number;
  /** Hits whose match reached the end of the lookahead and may have been cut. */
  readonly limited: number;
}

/**
 * The first position at or after `at` that starts a code point and (for a JSON
 * document) sits right after a complete escape token; `size` when there is none
 * within the scan limit, which hands the rest of the file to the chunk before it.
 */
export const safeBoundary = async (
  read: ReadBytes,
  size: number,
  at: number,
  decode: boolean,
): Promise<number> => {
  if (at <= 0) return 0;
  if (at >= size) return size;
  const limit = Math.min(size, at + BOUNDARY_SCAN_LIMIT);
  let from = at;
  while (from < limit) {
    const to = Math.min(limit, from + BOUNDARY_STEP);
    const bytes = await read(from - 1, to);
    for (let k = 1; k < bytes.length; k++) {
      const here = bytes[k] as number;
      if (decode ? isSafeStart(bytes[k - 1] as number, here) : (here & 0xc0) !== 0x80) {
        return from - 1 + k;
      }
    }
    from = to;
  }
  return size;
};

const isLetter = (b: number) => (b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a;

/** Finds matches in `view`'s `[from, to)` starts; calls `emit` with view offsets. */
type Matcher = (
  view: Uint8Array,
  available: number,
  ownedTo: number,
  carry: number,
  prefix: Uint8Array,
  emit: (start: number, end: number) => void,
) => void;

const literalMatcher = (spec: LiteralSpec): Matcher => {
  const needle = spec.needle;
  const m = needle.length;
  const first = needle[0] as number;
  const fold = !spec.caseSensitive && isLetter(first);
  const lower = fold ? first | 0x20 : first;
  const upper = fold ? first & ~0x20 : first;
  const folded = spec.caseSensitive ? needle : needle.map((b) => (isLetter(b) ? b | 0x20 : b));
  const matches = (view: Uint8Array, at: number) => {
    if (spec.caseSensitive) {
      for (let k = 1; k < m; k++) if (view[at + k] !== needle[k]) return false;
      return true;
    }
    for (let k = 1; k < m; k++) {
      const b = view[at + k] as number;
      if ((isLetter(b) ? b | 0x20 : b) !== folded[k]) return false;
    }
    return true;
  };
  return (view, available, ownedTo, carry, _prefix, emit) => {
    const limit = Math.min(ownedTo, available - m + 1);
    let i = carry;
    // Next occurrence of each case of the first byte, searched again only once passed:
    // `indexOf` has no end bound, so a rare byte would otherwise rescan the block per call.
    let nextLower = -2;
    let nextUpper = lower === upper ? -1 : -2;
    while (i < limit) {
      if (nextLower !== -1 && nextLower < i) nextLower = view.indexOf(lower, i);
      if (nextUpper !== -1 && nextUpper < i) nextUpper = view.indexOf(upper, i);
      let at = -1;
      if (nextLower >= 0) at = nextLower;
      if (nextUpper >= 0 && (at < 0 || nextUpper < at)) at = nextUpper;
      if (at < 0 || at >= limit) break;
      if (matches(view, at)) {
        emit(at, at + m);
        i = at + m;
      } else i = at + 1;
    }
  };
};

/** Compiles a regex spec; `u` is dropped when the pattern is not valid in unicode mode. */
export const compileRegex = (spec: RegexSpec): RegExp => {
  const flags = [...new Set(`${spec.flags}gm`)].join("");
  try {
    return new RegExp(spec.source, flags);
  } catch (error) {
    if (!flags.includes("u") && !flags.includes("v")) throw error;
    return new RegExp(spec.source, flags.replace(/[uv]/g, ""));
  }
};

const concat = (a: Uint8Array, b: Uint8Array, bLength: number) => {
  const out = new Uint8Array(a.length + bLength);
  out.set(a, 0);
  out.set(b.subarray(0, bLength), a.length);
  return out;
};

const regexMatcher = (spec: RegexSpec): Matcher => {
  const regex = compileRegex(spec);
  return (view, available, ownedTo, carry, prefix, emit) => {
    const window = concat(prefix, view, available);
    const { text, offsets } = decodeUtf8Mapped(window);
    const byteOf = (unit: number) => (offsets === null ? unit : (offsets[unit] as number));
    const unitOf = (byte: number) => {
      if (offsets === null) return byte;
      let lo = 0;
      let hi = offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((offsets[mid] as number) < byte) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const base = prefix.length;
    regex.lastIndex = unitOf(base + carry);
    for (;;) {
      const found = regex.exec(text);
      if (found === null) break;
      const at = found.index;
      const length = found[0].length;
      const startByte = byteOf(at) - base;
      if (startByte >= ownedTo) break;
      if (length === 0) {
        const code = text.codePointAt(at);
        regex.lastIndex = at + (code !== undefined && code > 0xffff ? 2 : 1);
        continue;
      }
      emit(startByte, byteOf(at + length) - base);
    }
  };
};

const createMatcher = (spec: SearchSpec): Matcher =>
  spec.kind === "literal" ? literalMatcher(spec) : regexMatcher(spec);

class HitBuffer {
  count = 0;
  limited = 0;
  lastEnd = 0;
  private stored = 0;
  private pairs: Float64Array;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
    this.pairs = new Float64Array(Math.min(max, 256) * 2);
  }
  push(start: number, end: number) {
    this.count++;
    this.lastEnd = end;
    if (this.stored >= this.max) return;
    if (this.stored * 2 >= this.pairs.length) {
      const next = new Float64Array(Math.min(this.max, Math.max(256, this.stored * 2)) * 2);
      next.set(this.pairs);
      this.pairs = next;
    }
    this.pairs[this.stored * 2] = start;
    this.pairs[this.stored * 2 + 1] = end;
    this.stored++;
  }
  hits() {
    return this.pairs.slice(0, this.stored * 2);
  }
}

/**
 * Searches the chunk whose nominal edges are `[nominalStart, nominalEnd)`. With
 * `resumeAt` (a token boundary a previous scan ended on) the chunk is scanned
 * from there instead, which is how the merge repairs a chunk after a match that
 * ran into it.
 */
export const searchChunk = async (
  read: ReadBytes,
  size: number,
  nominalStart: number,
  nominalEnd: number,
  decode: boolean,
  spec: SearchSpec,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  resumeAt: number | null = null,
): Promise<ChunkResult> => {
  const start = resumeAt ?? (await safeBoundary(read, size, nominalStart, decode));
  const end = await safeBoundary(read, size, nominalEnd, decode);
  const out = new HitBuffer(options.maxHits);
  if (start >= end) {
    return { start, end, count: 0, hits: new Float64Array(0), lastEnd: 0, limited: 0 };
  }
  const matcher = createMatcher(spec);
  const needsPrefix = spec.kind === "regex";
  const lookView = spec.kind === "literal" ? Math.max(0, spec.needle.length - 1) : options.lookView;
  // Escapes shrink when decoded, so the raw lookahead grows until the decoded one is long enough.
  const maxLookRaw = decode ? lookView * RAW_PER_VIEW + RAW_PER_VIEW : lookView + 4;
  const firstLookRaw = decode ? Math.min(maxLookRaw, lookView * 2 + 64) : maxLookRaw;
  const view = new EscapeView();
  const prefixView = new EscapeView();

  let prefix: Uint8Array = new Uint8Array(0);
  if (needsPrefix && start > 0) {
    const from = Math.max(0, start - PREFIX_BYTES);
    const before = await read(from, start);
    if (decode && before.indexOf(BACKSLASH) >= 0) {
      prefixView.decode(before, 0, before.length);
      prefix = prefixView.bytes.slice(0, prefixView.length);
    } else prefix = before.slice();
  }

  let pos = start;
  let carry = 0;
  while (pos < end) {
    const blockEnd = Math.min(end, pos + options.blockBytes);
    const ownedRaw = blockEnd - pos;
    let bytes: Uint8Array;
    let available: number;
    let ownedView: number;
    let ownedRawEnd: number;
    let escaped = false;
    let readEnd: number;
    let raw: Uint8Array;
    for (let lookRaw = firstLookRaw; ; lookRaw = Math.min(maxLookRaw, lookRaw * 4)) {
      readEnd = Math.min(size, blockEnd + lookRaw);
      raw = await read(pos, readEnd);
      escaped = decode && raw.indexOf(BACKSLASH) >= 0;
      if (!escaped) {
        ownedRawEnd = ownedRaw;
        // A chunk edge is a code point start, but a block edge inside it may not be.
        while (ownedRawEnd < raw.length && ((raw[ownedRawEnd] as number) & 0xc0) === 0x80) {
          ownedRawEnd++;
        }
        bytes = raw;
        available = raw.length;
        ownedView = ownedRawEnd;
        break;
      }
      view.decode(raw, 0, raw.length);
      const boundary = view.boundaryAtOrAfter(ownedRaw);
      ownedRawEnd = boundary.raw;
      ownedView = boundary.view;
      // A block edge inside a code point moves on past its continuation bytes, which are plain.
      while (ownedRawEnd < raw.length && ((raw[ownedRawEnd] as number) & 0xc0) === 0x80) {
        ownedRawEnd++;
        ownedView++;
      }
      bytes = view.bytes;
      available = view.length;
      if (available - ownedView >= lookView || readEnd >= size || lookRaw >= maxLookRaw) break;
    }
    ownedRawEnd = Math.min(ownedRawEnd, raw.length);
    const limitedAt = Math.min(available, ownedView + lookView);
    const toRawStart = (v: number) => (escaped ? pos + view.rawStart(v) : pos + v);
    const toRawEnd = (v: number) => (escaped ? pos + view.rawEnd(v - 1) : pos + v);
    const moreBeyond = limitedAt < available || readEnd < size;
    let lastViewEnd = 0;
    matcher(bytes, limitedAt, ownedView, carry, prefix, (s, e) => {
      out.push(toRawStart(s), toRawEnd(e));
      lastViewEnd = e;
      if (needsPrefix && e >= limitedAt && moreBeyond) out.limited++;
    });
    carry = Math.max(0, Math.max(carry, lastViewEnd) - ownedView);
    if (needsPrefix) {
      const tail = Math.min(ownedView, PREFIX_BYTES);
      prefix = bytes.slice(ownedView - tail, ownedView);
    }
    if (ownedRawEnd <= 0) break;
    pos += ownedRawEnd;
  }
  return {
    start,
    end,
    count: out.count,
    hits: out.hits(),
    lastEnd: out.lastEnd,
    limited: out.limited,
  };
};
