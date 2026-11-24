/**
 * Chains boundary summaries in file order into each region's true entry state.
 * See ./scan.ts for why reading the opposite hypothesis is correct when the
 * region's first byte is an escaped quote. Entry states are sized by the depth
 * actually open at the boundary, never by maxDepth: maxDepth can stand for
 * "unbounded", and sizing by it runs out of memory (docs/internals/document-engine.md,
 * "Memory accounting").
 */
import { QUOTE } from "./bytes.ts";
import type { BoundarySummary, EntryState, HypothesisSummary } from "./scan.ts";

export const INITIAL_ENTRY: EntryState = {
  depth: 0,
  inString: false,
  escaped: false,
  prevSig: 0,
  lastByte: 0,
  kinds: new Uint8Array(0),
  openStringStart: -1,
  openStringPrevSig: 0,
};

/** The entry state of the chunk after one with `state` at entry and `summary` as its pass-1 result. */
export const advanceEntry = (
  state: EntryState,
  summary: BoundarySummary,
  base: number,
  maxDepth: number,
): EntryState => {
  const keepLevels = maxDepth + 2;
  const h = state.inString ? 1 : 0;
  const swap = state.escaped && summary.firstNonBackslashIsQuote;
  const pick = summary.hypotheses[swap ? h ^ 1 : h] as HypothesisSummary;
  const parity = (summary.quoteCount & 1) ^ (swap ? 1 : 0);
  const exitInString = state.inString !== (parity === 1);

  // Container kinds: pop levels this chunk closed, push what it opened (bounded by keepLevels).
  // More closes than opens is not JSON (the structural pass reports it); the depth stops at the root.
  const depth = Math.max(0, state.depth + pick.depthDelta);
  const size = Math.min(depth, keepLevels);
  const popTo = Math.max(0, state.depth + pick.minDepth);
  const kinds = new Uint8Array(size);
  kinds.set(state.kinds.subarray(0, Math.min(popTo, size)));
  for (const open of pick.opens) {
    const level = state.depth + open.localDepth;
    if (level >= popTo && level < size) kinds[level] = open.kind;
  }

  // Under a swap the region opens by finishing an escape, and the quote after it closes the
  // string; pass 1 read the pair as an escaped quote and never saw that quote, so with nothing
  // significant after it the last significant byte is the quote itself.
  const prevSig = pick.lastSig !== 0 ? pick.lastSig : swap ? QUOTE : state.prevSig;
  let openStringStart = -1;
  let openStringPrevSig = 0;
  if (exitInString) {
    const bogusQuote = swap ? base + summary.leadingBackslashes : -1;
    if (pick.openStringStart >= 0 && pick.openStringStart !== bogusQuote) {
      openStringStart = pick.openStringStart;
      openStringPrevSig = pick.openStringPrevSig !== 0 ? pick.openStringPrevSig : state.prevSig;
    } else {
      openStringStart = state.openStringStart;
      openStringPrevSig = state.openStringPrevSig;
    }
  }
  const trailing = summary.allBackslashes
    ? summary.length - (state.escaped ? 1 : 0)
    : summary.trailingBackslashes;
  const escaped = exitInString && (trailing & 1) === 1;
  return {
    depth,
    inString: exitInString,
    escaped,
    prevSig,
    lastByte: summary.lastByte,
    kinds,
    openStringStart,
    openStringPrevSig,
  };
};
