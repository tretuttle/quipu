/**
 * A tape made of the region tapes themselves. Each segment is adopted as it
 * arrives (its `parent` and `next` rebased to global ids once, in place), so the
 * 2 GiB HAR's 345 MB tape is never copied and leaves no garbage behind. Merging
 * into one contiguous tape instead pushes about one run in five over the memory
 * limit on that copy alone (docs/internals/document-engine.md, "Segmented, not merged").
 *
 * Token id = segment base + local index. Segments are looked up by a binary
 * search over the bases, with the last hit cached because walks are monotone.
 */
import type { MutableTape, TapeBuffers } from "./tape.ts";

interface Segment {
  readonly base: number;
  readonly count: number;
  readonly kind: Uint8Array;
  readonly start: Uint32Array;
  readonly end: Uint32Array;
  readonly parent: Int32Array;
  readonly next: Int32Array;
  readonly childCount: Uint32Array;
  readonly keyStart: Uint32Array;
}

export class SegmentedTape implements MutableTape {
  count = 0;
  private readonly segments: Segment[] = [];
  private readonly bases: number[] = [];
  private last = 0;

  get segmentCount() {
    return this.segments.length;
  }

  appendSegment(buffers: TapeBuffers, rebaseParent: (localParent: number) => number): number {
    const base = this.count;
    const parent = new Int32Array(buffers.parent);
    const next = new Int32Array(buffers.next);
    const n = buffers.count;
    for (let i = 0; i < n; i++) {
      parent[i] = rebaseParent(parent[i] as number);
      const sibling = next[i] as number;
      next[i] = sibling >= 0 ? sibling + base : -1;
    }
    this.segments.push({
      base,
      count: n,
      kind: new Uint8Array(buffers.kind),
      start: new Uint32Array(buffers.start),
      end: new Uint32Array(buffers.end),
      parent,
      next,
      childCount: new Uint32Array(buffers.childCount),
      keyStart: new Uint32Array(buffers.keyStart),
    });
    this.bases.push(base);
    this.count = base + n;
    return base;
  }

  private segment(i: number): Segment {
    const segments = this.segments;
    let s = segments[this.last] as Segment;
    if (i >= s.base && i < s.base + s.count) return s;
    // Monotone walks step to a neighbour; anything else is a binary search.
    const after = segments[this.last + 1];
    if (after && i >= after.base && i < after.base + after.count) {
      this.last++;
      return after;
    }
    let lo = 0;
    let hi = segments.length - 1;
    const bases = this.bases;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((bases[mid] as number) <= i) lo = mid;
      else hi = mid - 1;
    }
    this.last = lo;
    s = segments[lo] as Segment;
    if (i < s.base || i >= s.base + s.count) throw new RangeError(`token ${i} is not on the tape`);
    return s;
  }

  kind(i: number) {
    const s = this.segment(i);
    return s.kind[i - s.base] as number;
  }
  start(i: number) {
    const s = this.segment(i);
    return s.start[i - s.base] as number;
  }
  end(i: number) {
    const s = this.segment(i);
    return s.end[i - s.base] as number;
  }
  parent(i: number) {
    const s = this.segment(i);
    return s.parent[i - s.base] as number;
  }
  next(i: number) {
    const s = this.segment(i);
    return s.next[i - s.base] as number;
  }
  childCount(i: number) {
    const s = this.segment(i);
    return s.childCount[i - s.base] as number;
  }
  keyStart(i: number) {
    const s = this.segment(i);
    return s.keyStart[i - s.base] as number;
  }
  setEnd(i: number, value: number) {
    const s = this.segment(i);
    s.end[i - s.base] = value;
  }
  setNext(i: number, value: number) {
    const s = this.segment(i);
    s.next[i - s.base] = value;
  }
  setChildCount(i: number, value: number) {
    const s = this.segment(i);
    s.childCount[i - s.base] = value;
  }
  setKeyStart(i: number, value: number) {
    const s = this.segment(i);
    s.keyStart[i - s.base] = value;
  }
}
