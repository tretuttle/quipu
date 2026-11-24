/**
 * The two per-chunk passes.
 *
 * Pass 1 (`summarize`) reads a chunk knowing nothing about what came before it
 * and reports scalars for both hypotheses (the chunk starts outside a string /
 * inside one) assuming its first byte is not escaped. ./resolve.ts chains those
 * summaries in file order into the true entry state of every chunk, which is a
 * cheap O(chunks) step. Pass 2 (`structure`) then emits tokens for the chunk with
 * its true entry state; chunks run in parallel because no pass needs another
 * chunk's bytes.
 *
 * Chunk boundaries inside strings and escapes: a quote is escaped iff an odd
 * run of backslashes precedes it. Each summary reports its trailing backslash
 * run (and whether the chunk is only backslashes, so runs chain), which gives
 * the next chunk its "first byte is escaped" bit. When that bit is set and the
 * first non-backslash byte is a quote, pass 1 counted a toggle that did not
 * happen, so every state after it is inverted: the resolver reads the opposite
 * hypothesis and flips the parity. That is the whole trick; no chunk is ever
 * rescanned.
 *
 * Memory rule: nothing here is sized by maxDepth. Stacks grow with the depth
 * actually reached, and report arrays are sized by the depth at entry or exit.
 * "Full depth" is just a large maxDepth with no allocation cost.
 *
 * Containers at the eager depth keep their childCount, and pass 2 records an
 * anchor (child index, byte offset) for their first child in the region and for
 * every BUCKET_SIZE-th child after it, so a bucket of children can be indexed on
 * demand from its own byte range (docs/internals/document-engine.md).
 */
import {
  ARR_CLOSE,
  ARR_OPEN,
  BACKSLASH,
  BYTE_CLASS,
  CLASS_BACKSLASH,
  CLASS_CLOSE,
  CLASS_COLON,
  CLASS_COMMA,
  CLASS_OPEN,
  CLASS_OTHER,
  CLASS_QUOTE,
  CLASS_SCALAR_START,
  CLASS_WS,
  COLON,
  COMMA,
  OBJ_CLOSE,
  OBJ_OPEN,
  QUOTE,
  SCALAR_CHAR,
} from "./bytes.ts";
import {
  INHERITED_KEY,
  KIND_ARRAY,
  KIND_FALSE,
  KIND_NULL,
  KIND_NUMBER,
  KIND_OBJECT,
  KIND_STRING,
  KIND_TRUE,
  NO_KEY,
  type TapeBuilder,
} from "./tape.ts";

/** Strings at least this long are recorded in the skip list whatever their depth. */
const BIG_STRING_BYTES = 256 * 1024;
/** Children of a container at the eager depth are indexed on demand in buckets of this many. */
const BUCKET_SIZE = 1024;
/** A maxDepth no document reaches: index everything. Never used as an allocation size. */
export const FULL_DEPTH = 1 << 20;

/** An unmatched open bracket, with its depth relative to the chunk start. */
export interface OpenRecord {
  readonly localDepth: number;
  readonly kind: number;
  readonly position: number;
}

/** Per-hypothesis half of a boundary summary (index 0: starts outside a string, 1: inside). */
export interface HypothesisSummary {
  depthDelta: number;
  minDepth: number;
  /** Last non-whitespace byte seen outside a string, or 0. Closing quotes count, opening quotes do not. */
  lastSig: number;
  /** Absolute position of the opening quote of the string open at exit, or -1. */
  openStringStart: number;
  /** `lastSig` at the moment that string opened, or 0. */
  openStringPrevSig: number;
  /** Unmatched opens with local depth below minDepth + maxDepth + 2, in order. */
  opens: OpenRecord[];
}

export interface BoundarySummary {
  readonly length: number;
  readonly allBackslashes: boolean;
  readonly leadingBackslashes: number;
  readonly trailingBackslashes: number;
  readonly firstNonBackslashIsQuote: boolean;
  readonly quoteCount: number;
  readonly lastByte: number;
  readonly hypotheses: readonly [HypothesisSummary, HypothesisSummary];
}

export const summarize = (bytes: Uint8Array, base: number, maxDepth: number): BoundarySummary => {
  const n = bytes.length;
  const keepBelow = maxDepth + 2;
  const h: [HypothesisSummary, HypothesisSummary] = [
    {
      depthDelta: 0,
      minDepth: 0,
      lastSig: 0,
      openStringStart: -1,
      openStringPrevSig: 0,
      opens: [],
    },
    {
      depthDelta: 0,
      minDepth: 0,
      lastSig: 0,
      openStringStart: -1,
      openStringPrevSig: 0,
      opens: [],
    },
  ];
  let inside = 0; // scan state under "starts outside"
  let quoteCount = 0;
  let leading = 0;
  while (leading < n && bytes[leading] === BACKSLASH) leading++;
  const firstNonBackslashIsQuote = leading < n && bytes[leading] === QUOTE;
  const allBackslashes = leading === n;
  let trailing = 0;
  while (trailing < n && bytes[n - 1 - trailing] === BACKSLASH) trailing++;

  let target = h[0];
  let lastSig = 0; // target.lastSig, kept in a local on the hot path
  const next = new NextOccurrence(bytes);
  let i = 0;
  // Fast path at the chunk start: a chunk that begins inside a long string (a body
  // of hundreds of MiB) has no quote for megabytes, and needs no per-byte work until one.
  {
    const q = bytes.indexOf(QUOTE, 0);
    const segmentEnd = q < 0 ? n : q;
    if (segmentEnd >= FAST_SEGMENT && next.plain(0, segmentEnd)) {
      let k = segmentEnd - 1;
      while (k >= 0 && BYTE_CLASS[bytes[k] as number] === CLASS_WS) k--;
      if (k >= 0) lastSig = bytes[k] as number;
      i = segmentEnd;
    }
  }
  while (i < n) {
    const b = bytes[i] as number;
    const cls = BYTE_CLASS[b];
    if (cls === CLASS_OTHER || cls === CLASS_SCALAR_START) {
      lastSig = b;
      i++;
      continue;
    }
    if (cls === CLASS_WS) {
      i++;
      continue;
    }
    if (cls === CLASS_BACKSLASH) {
      i += 2;
      continue;
    }
    if (cls === CLASS_QUOTE) {
      quoteCount++;
      // Opens under the hypothesis whose real state here is "outside", closes under the other.
      target.lastSig = lastSig;
      const closer = h[inside ^ 1] as HypothesisSummary;
      target.openStringStart = base + i;
      target.openStringPrevSig = lastSig;
      closer.lastSig = QUOTE;
      inside ^= 1;
      target = h[inside] as HypothesisSummary;
      lastSig = target.lastSig;
      i++;
      // Fast path: a long run with no quote, backslash or structural byte needs no per-byte work
      // under either hypothesis; only lastSig (its last non-whitespace byte) matters.
      const q = bytes.indexOf(QUOTE, i);
      const segmentEnd = q < 0 ? n : q;
      if (segmentEnd - i >= FAST_SEGMENT) {
        if (next.plain(i, segmentEnd)) {
          let k = segmentEnd - 1;
          while (k >= i && BYTE_CLASS[bytes[k] as number] === CLASS_WS) k--;
          if (k >= i) lastSig = bytes[k] as number;
          i = segmentEnd;
        }
      }
      continue;
    }
    lastSig = b;
    if (cls === CLASS_OPEN) {
      const localDepth = target.depthDelta;
      if (localDepth < target.minDepth + keepBelow) {
        target.opens.push({
          localDepth,
          kind: b === OBJ_OPEN ? KIND_OBJECT : KIND_ARRAY,
          position: base + i,
        });
      }
      target.depthDelta = localDepth + 1;
    } else if (cls === CLASS_CLOSE) {
      target.depthDelta--;
      const opens = target.opens;
      const top = opens[opens.length - 1];
      if (top !== undefined && top.localDepth === target.depthDelta) opens.pop();
      if (target.depthDelta < target.minDepth) target.minDepth = target.depthDelta;
    }
    i++;
  }
  target.lastSig = lastSig;
  // A string still open at exit under a hypothesis: keep its record; otherwise clear it.
  for (let k = 0; k < 2; k++) {
    const exitInside = (k ^ (quoteCount & 1)) === 1;
    if (!exitInside) {
      (h[k] as HypothesisSummary).openStringStart = -1;
      (h[k] as HypothesisSummary).openStringPrevSig = 0;
    }
  }
  return {
    length: n,
    allBackslashes,
    leadingBackslashes: leading,
    trailingBackslashes: trailing,
    firstNonBackslashIsQuote,
    quoteCount,
    lastByte: n > 0 ? (bytes[n - 1] as number) : 0,
    hypotheses: h,
  };
};

/** Segments shorter than this are not worth the native scans. */
const FAST_SEGMENT = 64;
const STRUCTURAL = [BACKSLASH, OBJ_OPEN, ARR_OPEN, OBJ_CLOSE, ARR_CLOSE, COLON, COMMA];

/**
 * Next occurrence of each structural byte at or after the cursor, memoized so
 * every byte class is searched once per chunk in total (indexOf has no end
 * bound; re-searching per segment would rescan the whole chunk per segment).
 */
class NextOccurrence {
  private readonly at = new Int32Array(STRUCTURAL.length).fill(-1);
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  /** True when [from, to) holds none of the bytes pass 1 acts on. */
  plain(from: number, to: number) {
    const at = this.at;
    const bytes = this.bytes;
    for (let k = 0; k < STRUCTURAL.length; k++) {
      let p = at[k] as number;
      if (p < from) {
        p = bytes.indexOf(STRUCTURAL[k] as number, from);
        if (p < 0) p = bytes.length;
        at[k] = p;
      }
      if (p < to) return false;
    }
    return true;
  }
}

/** Resolved state at the first byte of a chunk. */
export interface EntryState {
  readonly depth: number;
  readonly inString: boolean;
  /** The first byte is escaped (the previous chunk ended in an odd backslash run). */
  readonly escaped: boolean;
  /** Last significant byte before this chunk, outside strings; 0 at file start. */
  readonly prevSig: number;
  /** Raw last byte of the previous chunk; 0 at file start. */
  readonly lastByte: number;
  /** Container kinds for levels 0..min(depth, maxDepth + 1) - 1. */
  readonly kinds: Uint8Array;
  /** When inString: where that string opened and the significant byte before it. */
  readonly openStringStart: number;
  readonly openStringPrevSig: number;
}

/**
 * Why a document is not JSON, at the first byte that shows it. `end` and
 * `unterminated` are found when the last region is merged; the rest by the
 * structural pass, which checks the grammar at every byte it already visits
 * outside strings, scalars against `true`, `false`, `null` and the number
 * grammar, and escapes where it meets a backslash.
 */
export type SyntaxCode =
  | "unexpected"
  | "trailing-comma"
  | "close-mismatch"
  | "trailing-data"
  | "literal"
  | "number"
  | "escape"
  | "end"
  | "unterminated";

export interface SyntaxProblem {
  readonly offset: number;
  readonly code: SyntaxCode;
}

/** The earlier of two problems; null when neither exists. */
export const firstProblem = (a: SyntaxProblem | null, b: SyntaxProblem | null) =>
  a === null ? b : b === null ? a : b.offset < a.offset ? b : a;

/** What a chunk's structural pass tells the merger about tokens it could not finish. */
export interface StructureReport {
  /** The first byte in the chunk that breaks the JSON grammar, or null. */
  problem: SyntaxProblem | null;
  /** Absolute end (exclusive) of a string that began in an earlier chunk, or -1. */
  inheritedStringEnd: number;
  /** Absolute end (exclusive) of a number/literal that began in an earlier chunk, or -1. */
  inheritedScalarEnd: number;
  /** That inherited number/literal reaches the chunk end, so the next chunk continues it too. */
  inheritedScalarContinues: boolean;
  /** Local index of the first emitted token with an INHERITED_KEY keyStart, or -1. */
  inheritedKeyToken: number;
  /**
   * Lowest level this chunk could have touched. Levels below it are exactly as the
   * merger left them, so every per-level array below covers [levelBase, …) only and
   * a chunk's report costs O(levels touched), never O(depth).
   */
  levelBase: number;
  /** Per inherited level in [levelBase, inheritedLevels): local index of the first emitted child of that inherited container, or -1. */
  inheritedFirstChild: Int32Array;
  /** Per inherited level in [levelBase, inheritedLevels): children counted for the inherited container at that level (closed or not). */
  inheritedChildCount: Uint32Array;
  /** Per inherited level in [levelBase, inheritedLevels): absolute end of an inherited container closed here, or 0. */
  inheritedClose: Uint32Array;
  /** Number of inherited levels on the tape: min(entry.depth, maxDepth + 1). */
  inheritedLevels: number;
  /** Depth at exit (containers still open). */
  exitDepth: number;
  /** Per level in [levelBase, min(exitDepth, maxDepth + 1)): local index of the container opened here and still open, or -1 if inherited. */
  exitOpenLocal: Int32Array;
  /** Per level in [levelBase, min(exitDepth, maxDepth + 1)): local index of the last emitted child of the open container at that level, or -1. */
  exitLastChild: Int32Array;
  /** Local index of an emitted string token still open at exit, or -1. */
  exitStringToken: number;
  /** Local index of an emitted number/literal reaching the chunk end, or -1. */
  exitScalarToken: number;
  /** Absolute start of a key whose value has not started at exit, -1 if none, -2 if inherited from before this chunk. */
  exitPendingKey: number;
  /**
   * Same for a key at depth maxDepth + 1 (a cut container's member): its value is not
   * on the tape, but its bucket anchor must start at the key, so the merger carries it.
   */
  exitCutKey: number;
  /** Absolute [start, end) pairs of strings ≥ BIG_STRING_BYTES that close in this chunk, any depth. */
  bigStrings: number[];
  /** Number of children counted at depth maxDepth + 1 for the deepest on-tape containers (statistics). */
  childrenBeyondTape: number;
  /**
   * Triples (container, localChildIndex, byteOffset) for children at depth maxDepth + 1
   * whose index within this region is a multiple of BUCKET_SIZE: `container` is the
   * local token index of the parent, or -1 when the parent was open at entry (the
   * merger resolves it and adds the children it counted before this region). The
   * offset is the member's key when the key was seen here, the value otherwise; a
   * negative offset is the value's start, negated, of a member whose key sits in an
   * earlier chunk (the merger substitutes the key it carried).
   */
  cutAnchors: number[];
}

const scalarKind = (b: number) =>
  b === 0x74 ? KIND_TRUE : b === 0x66 ? KIND_FALSE : b === 0x6e ? KIND_NULL : KIND_NUMBER;

/**
 * Finds the end (exclusive) of a string whose opening quote sits before `from`,
 * jumping with native indexOf between quotes and backslashes. Returns -1 when the
 * string runs past the end of `bytes`. Escapes are resolved by pair skipping: at a
 * backslash the next byte is consumed whatever it is.
 *
 * indexOf has no end bound, so the next-backslash position is memoized per byte
 * array: without that, a document with few escapes rescans the rest of the chunk
 * for every string, which is quadratic and stalls on a wide 50 MiB document.
 */
let memoBytes: Uint8Array | null = null;
let memoFrom = 0;
let memoBackslash = 0;
const nextBackslash = (bytes: Uint8Array, from: number) => {
  if (bytes !== memoBytes || from < memoFrom || from > memoBackslash) {
    memoBytes = bytes;
    memoFrom = from;
    const at = bytes.indexOf(BACKSLASH, from);
    memoBackslash = at < 0 ? bytes.length : at;
  }
  return memoBackslash;
};

/**
 * While the structural pass runs, the first escape that JSON does not allow
 * (`\q`, or `\u` without four hex digits) is noted here; escapes are the one
 * place inside a string that the scan visits byte by byte anyway.
 */
let watchEscapes = false;
let badEscape = -1;
const ESCAPE_OK = new Uint8Array(256);
for (const c of '"\\/bfnrtu') ESCAPE_OK[c.charCodeAt(0)] = 1;
const isHex = (b: number) =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
const noteEscape = (bytes: Uint8Array, k: number) => {
  const n = bytes.length;
  const c = bytes[k + 1];
  // An escape cut by the chunk end is checked by nobody; the next chunk starts past it.
  if (c === undefined) return;
  if (ESCAPE_OK[c] === 0) {
    badEscape = k;
    return;
  }
  if (c !== 0x75) return;
  for (let h = k + 2; h < Math.min(n, k + 6); h++) {
    if (!isHex(bytes[h] as number)) {
      badEscape = k;
      return;
    }
  }
};

export const scanStringEnd = (bytes: Uint8Array, from: number): number => {
  const n = bytes.length;
  let j = from;
  while (j < n) {
    const q = bytes.indexOf(QUOTE, j);
    if (q < 0) return -1;
    let k = nextBackslash(bytes, j);
    if (k > q) return q + 1;
    while (k < q) {
      if (bytes[k] === BACKSLASH) {
        if (watchEscapes && badEscape < 0) noteEscape(bytes, k);
        k += 2;
      } else {
        const next = nextBackslash(bytes, k);
        if (next > q) {
          k = q;
          break;
        }
        k = next;
      }
    }
    if (k === q) return q + 1;
    j = k; // the quote at q was escaped; continue after the escape
  }
  return -1;
};

const LITERALS: Record<number, ReadonlyArray<number>> = {
  0x74: [0x74, 0x72, 0x75, 0x65],
  0x66: [0x66, 0x61, 0x6c, 0x73, 0x65],
  0x6e: [0x6e, 0x75, 0x6c, 0x6c],
};
const isDigit = (b: number | undefined) => b !== undefined && b >= 0x30 && b <= 0x39;

/** Null when [start, end) is `true`, `false`, `null` or a JSON number; else what it fails as. */
const scalarProblem = (bytes: Uint8Array, start: number, end: number): SyntaxCode | null => {
  const literal = LITERALS[bytes[start] as number];
  if (literal !== undefined) {
    if (end - start !== literal.length) return "literal";
    for (let k = 1; k < literal.length; k++) if (bytes[start + k] !== literal[k]) return "literal";
    return null;
  }
  let k = start;
  if (bytes[k] === 0x2d) k++;
  if (bytes[k] === 0x30) k++;
  else if (isDigit(bytes[k])) while (k < end && isDigit(bytes[k])) k++;
  else return "number";
  if (k < end && bytes[k] === 0x2e) {
    k++;
    if (!isDigit(bytes[k]) || k >= end) return "number";
    while (k < end && isDigit(bytes[k])) k++;
  }
  if (k < end && (bytes[k] === 0x65 || bytes[k] === 0x45)) {
    k++;
    if (k < end && (bytes[k] === 0x2b || bytes[k] === 0x2d)) k++;
    if (!isDigit(bytes[k]) || k >= end) return "number";
    while (k < end && isDigit(bytes[k])) k++;
  }
  return k === end ? null : "number";
};

/** What may come next, as a set of these. */
const M_KEY = 1;
const M_VALUE = 2;
const M_CLOSE_OBJECT = 4;
const M_CLOSE_ARRAY = 8;
const M_COLON = 16;
const M_COMMA = 32;
/** What may follow a finished value, by the kind of the container it is in (index: kind + 1, 0 for the top level). */
const AFTER_VALUE = Uint8Array.of(
  0,
  M_COMMA | M_CLOSE_OBJECT | M_CLOSE_ARRAY,
  M_COMMA | M_CLOSE_OBJECT,
  M_COMMA | M_CLOSE_ARRAY,
);
/** What may follow a comma, the same way. */
const AFTER_COMMA = Uint8Array.of(M_KEY | M_VALUE, M_KEY | M_VALUE, M_KEY, M_VALUE);

/**
 * Pass 2. Emits tokens at absolute depth ≤ maxDepth into `tape` (local indices),
 * counting children at depth maxDepth + 1 for their parents.
 */
export const structure = (
  bytes: Uint8Array,
  base: number,
  entry: EntryState,
  maxDepth: number,
  tape: TapeBuilder,
): StructureReport => {
  const n = bytes.length;
  const onTapeLevels = maxDepth + 1; // levels whose containers are tokens
  const inheritedLevels = Math.min(entry.depth, onTapeLevels);
  // A chunk of n bytes can close at most n levels, so levels below entry.depth - n - 1 are
  // untouchable: stacks are indexed relative to `stackBase` and cost O(min(depth, n)).
  const stackBase = Math.max(0, entry.depth - n - 1);
  let cap = Math.max(16, entry.depth - stackBase + 2);
  let stackKind = new Uint8Array(cap + 1);
  let stackLocal = new Int32Array(cap).fill(-1);
  let stackLast = new Int32Array(cap).fill(-1);
  let stackCount = new Uint32Array(cap);
  const grow = (need: number) => {
    while (cap <= need) cap *= 2;
    const k = new Uint8Array(cap + 1);
    k.set(stackKind);
    stackKind = k;
    const l = new Int32Array(cap).fill(-1);
    l.set(stackLocal);
    stackLocal = l;
    const la = new Int32Array(cap).fill(-1);
    la.set(stackLast);
    stackLast = la;
    const c = new Uint32Array(cap);
    c.set(stackCount);
    stackCount = c;
  };
  // Levels open at entry are inherited: kinds known (up to maxDepth + 1), tokens elsewhere.
  const knownKinds = Math.min(entry.depth, onTapeLevels + 1, entry.kinds.length);
  for (let level = stackBase; level < knownKinds; level++)
    stackKind[level - stackBase] = entry.kinds[level] as number;

  let depth = entry.depth;
  let minDepth = depth; // lowest depth reached; levels ≥ minDepth - 1 may have been touched
  let prevSig = entry.prevSig;
  // After a colon or a closing quote the pending key (if any) lives in an earlier
  // chunk: -2 asks the merger to use its own, and survives whitespace-only chunks.
  let pendingKey = prevSig === COLON || prevSig === QUOTE ? -2 : -1;
  let i = 0;
  // Grammar check. Whether the last string was a key: unknown when it closed before this chunk.
  let lastStringKey: boolean | null = null;
  watchEscapes = true;
  badEscape = -1;
  const fail = (offset: number, code: SyntaxCode) => {
    if (report.problem === null || offset < report.problem.offset)
      report.problem = { offset, code };
  };
  /** The container kind at a level: object, array, or 0 when it opened before this chunk past the known kinds. */
  const kindAt = (level: number) => (stackKind[level - stackBase] as number) || 0;
  const after = () => {
    if (depth === 0) return 0;
    const top = kindAt(depth - 1);
    return top === KIND_OBJECT
      ? M_COMMA | M_CLOSE_OBJECT
      : top === KIND_ARRAY
        ? M_COMMA | M_CLOSE_ARRAY
        : M_COMMA | M_CLOSE_OBJECT | M_CLOSE_ARRAY;
  };
  const expected = () => {
    switch (prevSig) {
      case 0:
        return depth === 0 ? M_VALUE : M_KEY | M_VALUE | M_CLOSE_OBJECT | M_CLOSE_ARRAY;
      case OBJ_OPEN:
        return M_KEY | M_CLOSE_OBJECT;
      case ARR_OPEN:
        return M_VALUE | M_CLOSE_ARRAY;
      case COLON:
        return M_VALUE;
      case COMMA: {
        const top = depth === 0 ? -1 : kindAt(depth - 1);
        return top === KIND_OBJECT ? M_KEY : top === KIND_ARRAY ? M_VALUE : M_KEY | M_VALUE;
      }
      case QUOTE:
        return lastStringKey === true
          ? M_COLON
          : lastStringKey === false
            ? after()
            : M_COLON | after();
      default:
        return after();
    }
  };
  /** `allow` (what may come next, kept up to date token by token) said no to the byte at `at`. */
  let allow = 0;
  const reject = (at: number, b: number) => {
    if (allow === 0 && depth === 0) fail(base + at, "trailing-data");
    else if (prevSig === COMMA && (b === OBJ_CLOSE || b === ARR_CLOSE))
      fail(base + at, "trailing-comma");
    else if (
      (b === OBJ_CLOSE || b === ARR_CLOSE) &&
      (allow & (M_CLOSE_OBJECT | M_CLOSE_ARRAY)) !== 0
    )
      fail(base + at, "close-mismatch");
    else fail(base + at, "unexpected");
  };
  /** The container kind of the innermost open level plus one; 0 at the top level. */
  const topSlot = () => (depth === 0 ? 0 : (stackKind[depth - 1 - stackBase] as number) + 1);
  const report: StructureReport = {
    problem: null,
    inheritedStringEnd: -1,
    inheritedScalarEnd: -1,
    inheritedScalarContinues: false,
    inheritedKeyToken: -1,
    levelBase: 0,
    inheritedFirstChild: new Int32Array(0),
    inheritedChildCount: new Uint32Array(0),
    inheritedClose: new Uint32Array(0),
    inheritedLevels,
    exitDepth: 0,
    exitOpenLocal: new Int32Array(0),
    exitLastChild: new Int32Array(0),
    exitStringToken: -1,
    exitScalarToken: -1,
    exitPendingKey: -1,
    exitCutKey: -1,
    bigStrings: [],
    childrenBeyondTape: 0,
    cutAnchors: [],
  };
  // Inherited-level bookkeeping, indexed by (level - stackBase); sliced to [levelBase, …) at the end.
  const inhCap = Math.max(0, inheritedLevels - stackBase);
  const inhFirstChild = new Int32Array(inhCap).fill(-1);
  const inhChildCount = new Uint32Array(inhCap);
  const inhClose = new Uint32Array(inhCap);

  // Children at depth onTapeLevels are counted, not emitted; every BUCKET_SIZE-th one
  // (per region) is an anchor the host indexes a bucket from. Object members anchor
  // at their key so the bucket index sees the key too. -2 means the key sits in an
  // earlier chunk, like `pendingKey`; the merger carries its offset.
  let cutKeyStart = depth === onTapeLevels && (prevSig === COLON || prevSig === QUOTE) ? -2 : -1;

  const finish = (pending: number) => {
    watchEscapes = false;
    if (badEscape >= 0) fail(base + badEscape, "escape");
    report.exitDepth = depth;
    const levelBase = Math.max(0, minDepth - 1, stackBase);
    report.levelBase = levelBase;
    const exitLevels = Math.min(depth, onTapeLevels);
    const rel = levelBase - stackBase;
    report.exitOpenLocal =
      exitLevels > levelBase ? stackLocal.slice(rel, exitLevels - stackBase) : new Int32Array(0);
    report.exitLastChild =
      exitLevels > levelBase ? stackLast.slice(rel, exitLevels - stackBase) : new Int32Array(0);
    for (let level = levelBase; level < exitLevels; level++) {
      const local = stackLocal[level - stackBase] as number;
      // Children seen so far: on the token when it opened here, else reported for the merger to add.
      if (local >= 0) tape.childCounts[local] = stackCount[level - stackBase] as number;
      else if (level < inheritedLevels)
        inhChildCount[level - stackBase] = stackCount[level - stackBase] as number;
    }
    if (inheritedLevels > levelBase) {
      report.inheritedFirstChild = inhFirstChild.slice(rel, inheritedLevels - stackBase);
      report.inheritedChildCount = inhChildCount.slice(rel, inheritedLevels - stackBase);
      report.inheritedClose = inhClose.slice(rel, inheritedLevels - stackBase);
    }
    report.exitPendingKey = pending;
    report.exitCutKey = cutKeyStart;
    return report;
  };

  // Finish a string that started in an earlier chunk.
  if (entry.inString) {
    const d = depth;
    const inheritedStringIsKey =
      d >= 1 &&
      d <= onTapeLevels &&
      stackKind[d - 1 - stackBase] === KIND_OBJECT &&
      (entry.openStringPrevSig === OBJ_OPEN || entry.openStringPrevSig === COMMA);
    let end: number;
    if (entry.escaped) {
      // The first byte completes an escape begun in the previous chunk.
      end = n >= 1 ? scanStringEnd(bytes, 1) : -1;
    } else end = scanStringEnd(bytes, 0);
    if (end < 0) return finish(pendingKey); // the whole chunk is inside the string
    i = end;
    report.inheritedStringEnd = base + end;
    if (entry.openStringStart >= 0 && base + end - entry.openStringStart >= BIG_STRING_BYTES)
      report.bigStrings.push(entry.openStringStart, base + end);
    prevSig = QUOTE;
    const top = d === 0 ? -1 : kindAt(d - 1);
    lastStringKey =
      top === KIND_OBJECT
        ? entry.openStringPrevSig === OBJ_OPEN || entry.openStringPrevSig === COMMA
        : top === KIND_ARRAY
          ? false
          : null;
    if (inheritedStringIsKey) {
      pendingKey = entry.openStringStart;
      if (d === onTapeLevels) cutKeyStart = entry.openStringStart;
    }
  } else if (SCALAR_CHAR[entry.lastByte] === 1 && entry.lastByte !== 0) {
    // Finish a number/literal that started in an earlier chunk.
    while (i < n && SCALAR_CHAR[bytes[i] as number] === 1) i++;
    report.inheritedScalarEnd = base + i;
    report.inheritedScalarContinues = i === n;
    prevSig = bytes[i - 1] ?? entry.lastByte;
  }

  const countCutChild = (position: number) => {
    const r = onTapeLevels - 1 - stackBase;
    const seen = stackCount[r] as number;
    if (seen % BUCKET_SIZE === 0) {
      const at =
        stackKind[r] !== KIND_OBJECT
          ? position
          : cutKeyStart >= 0
            ? cutKeyStart
            : cutKeyStart === -2
              ? -position
              : position;
      report.cutAnchors.push(stackLocal[r] as number, seen, at);
    }
    cutKeyStart = -1;
    report.childrenBeyondTape++;
  };

  const emit = (kind: number, start: number) => {
    const d = depth;
    const p = d - 1 - stackBase;
    // Root: -1. Inherited container at level d - 1: -(d + 1), decoded by `inheritedLevel`.
    const parent =
      d === 0 ? -1 : (stackLocal[p] as number) >= 0 ? (stackLocal[p] as number) : -(d + 1);
    let key = NO_KEY;
    if (d >= 1 && stackKind[p] === KIND_OBJECT) {
      if (pendingKey === -2) key = INHERITED_KEY;
      else if (pendingKey >= 0) key = pendingKey;
      pendingKey = -1;
    }
    const idx = tape.push(kind, start, parent, key);
    if (key === INHERITED_KEY && report.inheritedKeyToken < 0) report.inheritedKeyToken = idx;
    if (d >= 1) {
      const last = stackLast[p] as number;
      if (last >= 0) tape.nexts[last] = idx;
      else if ((stackLocal[p] as number) < 0 && d - 1 < inheritedLevels) inhFirstChild[p] = idx;
      stackLast[p] = idx;
    }
    return idx;
  };

  allow = expected();
  for (; i < n; i++) {
    const b = bytes[i] as number;
    const cls = BYTE_CLASS[b];
    if (cls === CLASS_WS) continue;
    if (cls === CLASS_QUOTE) {
      if ((allow & (M_KEY | M_VALUE)) === 0) reject(i, b);
      const keyHere = (allow & M_KEY) !== 0 ? ((allow & M_VALUE) !== 0 ? null : true) : false;
      const d = depth;
      const isKey =
        d >= 1 &&
        d <= onTapeLevels &&
        stackKind[d - 1 - stackBase] === KIND_OBJECT &&
        (prevSig === OBJ_OPEN || prevSig === COMMA);
      const start = i;
      let token = -1;
      if (!isKey) {
        if (d <= maxDepth) token = emit(KIND_STRING, base + start);
        else pendingKey = -1;
        if (d === onTapeLevels) countCutChild(base + start);
        if (d >= 1 && d <= onTapeLevels)
          stackCount[d - 1 - stackBase] = (stackCount[d - 1 - stackBase] as number) + 1;
      } else if (d === onTapeLevels) cutKeyStart = base + start;
      const end = scanStringEnd(bytes, i + 1);
      if (end < 0) {
        // String runs past the chunk end.
        if (token >= 0) {
          tape.ends[token] = base + n;
          report.exitStringToken = token;
        }
        return finish(isKey ? -1 : pendingKey);
      }
      if (token >= 0) tape.ends[token] = base + end;
      if (end - start >= BIG_STRING_BYTES) report.bigStrings.push(base + start, base + end);
      if (isKey && d <= maxDepth) pendingKey = base + start;
      i = end - 1;
      prevSig = QUOTE;
      lastStringKey = keyHere;
      allow =
        keyHere === true
          ? M_COLON
          : keyHere === false
            ? (AFTER_VALUE[topSlot()] as number)
            : M_COLON | (AFTER_VALUE[topSlot()] as number);
      continue;
    }
    if (cls === CLASS_OPEN) {
      if ((allow & M_VALUE) === 0) reject(i, b);
      const d = depth;
      if (d + 1 - stackBase >= cap) grow(d + 1 - stackBase);
      const kind = b === OBJ_OPEN ? KIND_OBJECT : KIND_ARRAY;
      if (d <= maxDepth) {
        const idx = emit(kind, base + i);
        stackLocal[d - stackBase] = idx;
        stackLast[d - stackBase] = -1;
        stackCount[d - stackBase] = 0;
      } else {
        pendingKey = -1;
      }
      if (d === onTapeLevels) countCutChild(base + i);
      if (d >= 1 && d <= onTapeLevels)
        stackCount[d - 1 - stackBase] = (stackCount[d - 1 - stackBase] as number) + 1;
      // Every level's kind is kept, past the tape too: the grammar check reads it.
      stackKind[d - stackBase] = kind;
      depth = d + 1;
      prevSig = b;
      allow = kind === KIND_OBJECT ? M_KEY | M_CLOSE_OBJECT : M_VALUE | M_CLOSE_ARRAY;
      continue;
    }
    if (cls === CLASS_CLOSE) {
      if ((allow & (b === OBJ_CLOSE ? M_CLOSE_OBJECT : M_CLOSE_ARRAY)) === 0) reject(i, b);
      // A close with nothing open is reported above; the depth cannot go below the root.
      if (depth === 0) {
        allow = 0;
        continue;
      }
      depth--;
      const d = depth;
      if (d < minDepth) minDepth = d;
      if (d <= maxDepth) {
        const r = d - stackBase;
        const local = stackLocal[r] as number;
        if (local >= 0) {
          tape.ends[local] = base + i + 1;
          tape.childCounts[local] = stackCount[r] as number;
        } else if (d < inheritedLevels) {
          inhClose[r] = base + i + 1;
          inhChildCount[r] = stackCount[r] as number;
        }
        stackLocal[r] = -1;
        stackLast[r] = -1;
        stackCount[r] = 0;
      }
      pendingKey = -1;
      cutKeyStart = -1;
      prevSig = b;
      allow = AFTER_VALUE[topSlot()] as number;
      continue;
    }
    if (cls === CLASS_SCALAR_START) {
      if ((allow & M_VALUE) === 0) reject(i, b);
      const d = depth;
      let token = -1;
      if (d <= maxDepth) token = emit(scalarKind(b), base + i);
      else pendingKey = -1;
      if (d === onTapeLevels) countCutChild(base + i);
      if (d >= 1 && d <= onTapeLevels)
        stackCount[d - 1 - stackBase] = (stackCount[d - 1 - stackBase] as number) + 1;
      let j = i + 1;
      while (j < n && SCALAR_CHAR[bytes[j] as number] === 1) j++;
      // A scalar cut by the chunk end is checked by nobody: the next chunk sees only its tail.
      if (j < n) {
        const bad = scalarProblem(bytes, i, j);
        if (bad !== null) fail(base + i, bad);
      }
      if (token >= 0) tape.ends[token] = base + j;
      prevSig = bytes[j - 1] as number;
      allow = AFTER_VALUE[topSlot()] as number;
      if (j === n && token >= 0) report.exitScalarToken = token;
      i = j - 1;
      continue;
    }
    if (cls === CLASS_COLON) {
      if ((allow & M_COLON) === 0) reject(i, b);
      allow = M_VALUE;
      // A colon with no key seen in this chunk: the key sits in an earlier chunk.
      if (pendingKey < 0) pendingKey = -2;
      prevSig = b;
      continue;
    }
    if (cls === CLASS_COMMA) {
      if ((allow & M_COMMA) === 0) reject(i, b);
      allow = AFTER_COMMA[topSlot()] as number;
      pendingKey = -1;
      cutKeyStart = -1;
      prevSig = b;
      continue;
    }
    // CLASS_BACKSLASH or other bytes outside strings: not JSON; noted, then skipped. A UTF-8
    // byte order mark at the start of the file is allowed.
    if (base + i > 2 || !(b === 0xef || b === 0xbb || b === 0xbf)) reject(i, b);
  }
  return finish(pendingKey);
};

/** Decodes the inherited-parent encoding used by `structure` (parent = -(level + 2)). */
export const inheritedLevel = (parent: number) => -parent - 2;
