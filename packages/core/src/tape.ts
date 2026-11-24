/**
 * The structural tape: one token per JSON value, in document order, as seven
 * parallel typed arrays (25 bytes per token). Byte offsets are UTF-8 offsets into
 * the source; Uint32 covers 4 GiB, and a bigger file is refused rather than
 * wrapped (docs/internals/document-engine.md, "Tape layout").
 *
 * Children of a container sit right after it in document order, so the first
 * child of token i is i + 1 when parent(i + 1) === i. A container at the eager
 * depth keeps its childCount but its children are not on the tape; the engine
 * indexes them on demand from the anchors the eager pass recorded.
 */
export const KIND_OBJECT = 1;
export const KIND_ARRAY = 2;
export const KIND_STRING = 3;
export const KIND_NUMBER = 4;
export const KIND_TRUE = 5;
export const KIND_FALSE = 6;
export const KIND_NULL = 7;

/** `keyStart` for array elements and the root. */
export const NO_KEY = 0xffffffff;
/** `keyStart` for the first value of a region whose key sits in an earlier region; the merger patches it. */
export const INHERITED_KEY = 0xfffffffe;

/** The largest source a u32 tape can address. */
export const MAX_TAPE_SOURCE_BYTES = 0xffffffff;

/** Read access to a tape, whatever its storage. */
export interface Tape {
  readonly count: number;
  kind(i: number): number;
  start(i: number): number;
  end(i: number): number;
  parent(i: number): number;
  next(i: number): number;
  childCount(i: number): number;
  keyStart(i: number): number;
}

/** A region tape as it travels between threads: exact-size, transferable buffers. */
export interface TapeBuffers {
  readonly count: number;
  readonly kind: ArrayBuffer;
  readonly start: ArrayBuffer;
  readonly end: ArrayBuffer;
  readonly parent: ArrayBuffer;
  readonly next: ArrayBuffer;
  readonly childCount: ArrayBuffer;
  readonly keyStart: ArrayBuffer;
}

/** What the merger needs: appending a region's tokens and patching across boundaries. */
export interface MutableTape extends Tape {
  /**
   * Appends a region tape and returns the global index of its first token.
   * `rebaseParent` maps a region-local parent (local index, -1 for the root, or an
   * inherited-level code) to a global one; `next` is rebased by the base alone.
   */
  appendSegment(buffers: TapeBuffers, rebaseParent: (localParent: number) => number): number;
  setEnd(i: number, value: number): void;
  setNext(i: number, value: number): void;
  setChildCount(i: number, value: number): void;
  setKeyStart(i: number, value: number): void;
}

/** A contiguous tape that grows in place; workers build region tapes with it. */
export class TapeBuilder implements MutableTape {
  count = 0;
  kinds: Uint8Array;
  starts: Uint32Array;
  ends: Uint32Array;
  parents: Int32Array;
  nexts: Int32Array;
  childCounts: Uint32Array;
  keyStarts: Uint32Array;

  constructor(capacity = 1024) {
    this.kinds = new Uint8Array(capacity);
    this.starts = new Uint32Array(capacity);
    this.ends = new Uint32Array(capacity);
    this.parents = new Int32Array(capacity);
    this.nexts = new Int32Array(capacity);
    this.childCounts = new Uint32Array(capacity);
    this.keyStarts = new Uint32Array(capacity);
  }

  get capacity() {
    return this.kinds.length;
  }

  reserve(extra: number) {
    const needed = this.count + extra;
    if (needed <= this.capacity) return;
    // Grow by a quarter, not double: a 14 M-token tape must not spike to twice its size while copying.
    let capacity = this.capacity;
    while (capacity < needed) capacity = Math.ceil(capacity * 1.25);
    this.kinds = grow(this.kinds, new Uint8Array(capacity));
    this.starts = grow(this.starts, new Uint32Array(capacity));
    this.ends = grow(this.ends, new Uint32Array(capacity));
    this.parents = grow(this.parents, new Int32Array(capacity));
    this.nexts = grow(this.nexts, new Int32Array(capacity));
    this.childCounts = grow(this.childCounts, new Uint32Array(capacity));
    this.keyStarts = grow(this.keyStarts, new Uint32Array(capacity));
  }

  push(kind: number, start: number, parent: number, keyStart: number) {
    if (this.count === this.capacity) this.reserve(1);
    const i = this.count++;
    this.kinds[i] = kind;
    this.starts[i] = start;
    this.ends[i] = 0;
    this.parents[i] = parent;
    this.nexts[i] = -1;
    this.childCounts[i] = 0;
    this.keyStarts[i] = keyStart;
    return i;
  }

  /** Starts a new tape in the same arrays (a worker reuses one builder for every region). */
  reset() {
    this.count = 0;
  }

  /** Exact-size copies of the live prefix for transfer; the builder keeps its arrays. */
  detach(): TapeBuffers {
    const n = this.count;
    return {
      count: n,
      kind: this.kinds.slice(0, n).buffer,
      start: this.starts.slice(0, n).buffer,
      end: this.ends.slice(0, n).buffer,
      parent: this.parents.slice(0, n).buffer,
      next: this.nexts.slice(0, n).buffer,
      childCount: this.childCounts.slice(0, n).buffer,
      keyStart: this.keyStarts.slice(0, n).buffer,
    };
  }

  appendSegment(buffers: TapeBuffers, rebaseParent: (localParent: number) => number): number {
    const base = this.count;
    const n = buffers.count;
    this.reserve(n);
    this.kinds.set(new Uint8Array(buffers.kind), base);
    this.starts.set(new Uint32Array(buffers.start), base);
    this.ends.set(new Uint32Array(buffers.end), base);
    this.childCounts.set(new Uint32Array(buffers.childCount), base);
    this.keyStarts.set(new Uint32Array(buffers.keyStart), base);
    const parents = new Int32Array(buffers.parent);
    const nexts = new Int32Array(buffers.next);
    for (let i = 0; i < n; i++) {
      this.parents[base + i] = rebaseParent(parents[i] as number);
      const next = nexts[i] as number;
      this.nexts[base + i] = next >= 0 ? next + base : -1;
    }
    this.count = base + n;
    return base;
  }

  kind(i: number) {
    return this.kinds[i] as number;
  }
  start(i: number) {
    return this.starts[i] as number;
  }
  end(i: number) {
    return this.ends[i] as number;
  }
  parent(i: number) {
    return this.parents[i] as number;
  }
  next(i: number) {
    return this.nexts[i] as number;
  }
  childCount(i: number) {
    return this.childCounts[i] as number;
  }
  keyStart(i: number) {
    return this.keyStarts[i] as number;
  }
  setEnd(i: number, value: number) {
    this.ends[i] = value;
  }
  setNext(i: number, value: number) {
    this.nexts[i] = value;
  }
  setChildCount(i: number, value: number) {
    this.childCounts[i] = value;
  }
  setKeyStart(i: number, value: number) {
    this.keyStarts[i] = value;
  }
}

const grow = <T extends Uint8Array | Uint32Array | Int32Array>(from: T, to: T): T => {
  to.set(from as never);
  return to;
};

/** Wraps transferred buffers as a read-only tape without copying. */
export const tapeFromBuffers = (b: TapeBuffers): Tape => {
  const kinds = new Uint8Array(b.kind);
  const starts = new Uint32Array(b.start);
  const ends = new Uint32Array(b.end);
  const parents = new Int32Array(b.parent);
  const nexts = new Int32Array(b.next);
  const childCounts = new Uint32Array(b.childCount);
  const keyStarts = new Uint32Array(b.keyStart);
  return {
    count: b.count,
    kind: (i) => kinds[i] as number,
    start: (i) => starts[i] as number,
    end: (i) => ends[i] as number,
    parent: (i) => parents[i] as number,
    next: (i) => nexts[i] as number,
    childCount: (i) => childCounts[i] as number,
    keyStart: (i) => keyStarts[i] as number,
  };
};

export const transferList = (b: TapeBuffers) => [
  b.kind,
  b.start,
  b.end,
  b.parent,
  b.next,
  b.childCount,
  b.keyStart,
];

export const isContainer = (kind: number) => kind === KIND_OBJECT || kind === KIND_ARRAY;

export const firstChild = (tape: Tape, i: number) =>
  i + 1 < tape.count && tape.parent(i + 1) === i ? i + 1 : -1;

/** True when a container's children are not on this tape (it sits at the eager depth). */
export const needsExpand = (tape: Tape, i: number) =>
  isContainer(tape.kind(i)) && tape.childCount(i) > 0 && firstChild(tape, i) < 0;
