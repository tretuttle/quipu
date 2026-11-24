/**
 * Single-threaded index over an in-memory byte range, chunked at `chunkBytes`.
 * It runs the exact pipeline the worker pool runs (summarize → resolve →
 * structure → merge), which lets the differential tests stress region boundaries
 * with tiny chunks. Workers use it for on-demand buckets too.
 */
import { type BucketAnchors, TapeMerger } from "./merge.ts";
import { advanceEntry, INITIAL_ENTRY } from "./resolve.ts";
import { type EntryState, structure, summarize } from "./scan.ts";
import { SegmentedTape } from "./segmentedTape.ts";
import { type MutableTape, TapeBuilder } from "./tape.ts";

export interface IndexResult<T extends MutableTape = MutableTape> {
  readonly tape: T;
  /** Absolute [start, end) pairs of strings ≥ BIG_STRING_BYTES, in file order. */
  readonly bigStrings: ReadonlyArray<number>;
  readonly anchors: ReadonlyMap<number, BucketAnchors>;
  readonly childrenBeyondTape: number;
}

export interface IndexBytesOptions {
  readonly maxDepth: number;
  readonly chunkBytes: number;
  readonly entry?: EntryState;
}

/**
 * Indexes `bytes` (whose first byte sits at absolute offset `base`) into `target`.
 * Only one entry state is alive at a time: keeping every entry, as the pool must
 * briefly, is O(chunks × depth), which at 1-byte chunks on a 100 k-deep document
 * runs out of memory.
 */
const indexInto = <T extends MutableTape>(
  target: T,
  bytes: Uint8Array,
  base: number,
  options: IndexBytesOptions,
): IndexResult<T> => {
  const { maxDepth, chunkBytes } = options;
  const merger = new TapeMerger(target, maxDepth);
  let state = options.entry ?? INITIAL_ENTRY;
  const chunkCount = Math.max(1, Math.ceil(bytes.length / chunkBytes));
  const builder = new TapeBuilder(256);
  for (let k = 0; k < chunkCount; k++) {
    const start = k * chunkBytes;
    const end = Math.min(bytes.length, start + chunkBytes);
    const chunk = bytes.subarray(start, end);
    builder.reset();
    const report = structure(chunk, base + start, state, maxDepth, builder);
    merger.append(builder.detach(), report);
    state = advanceEntry(state, summarize(chunk, base + start, maxDepth), base + start, maxDepth);
  }
  return {
    tape: target,
    bigStrings: merger.bigStrings,
    anchors: merger.anchors,
    childrenBeyondTape: merger.childrenBeyondTape,
  };
};

/** A contiguous tape; the right shape for a sub-document or a bucket. */
export const indexBytes = (bytes: Uint8Array, base: number, options: IndexBytesOptions) =>
  indexInto(
    new TapeBuilder(Math.min(1 << 16, Math.max(256, bytes.length >> 4))),
    bytes,
    base,
    options,
  );

/** The same pipeline into a segmented tape, one segment per chunk (tests compare the two). */
export const indexBytesSegmented = (bytes: Uint8Array, base: number, options: IndexBytesOptions) =>
  indexInto(new SegmentedTape(), bytes, base, options);
