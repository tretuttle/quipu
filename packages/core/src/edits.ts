/**
 * How an edited document keeps its structural index without rewriting it. The
 * main tape keeps the offsets the scanner wrote, in original-file coordinates.
 * An edit re-scans the smallest enclosing value (with its key) into a side tape
 * and records that value as a *region*: a disjoint span of the main tape whose
 * bytes are now described by the side tape, in coordinates relative to the
 * region's start.
 *
 * The logical position of an unedited token is its file offset plus the summed
 * length change of every region that ends before it, an O(log R) binary search
 * over R regions, where R is bounded by the number of distinct values edited.
 * Nothing on the main tape is rewritten: `parent`, `next` and the offsets of
 * every untouched token stay bitwise what the index produced.
 *
 * Regions nest: a region's side tape is a level of its own with its own
 * `Regions` (document.ts `Level`), so an edit inside a region re-scans the
 * smallest enclosing value on the side tape, not the region. At one level a
 * region absorbs the regions it contains. Tokens of a level's tape under one of
 * its regions are dead; a query for one fails and the view re-asks from the
 * region's node.
 */
import { NO_KEY, type Tape } from "./tape.ts";

export interface Region {
  /**
   * The main-tape token this region stands for. A value inside a container the
   * eager index cut has no main-tape token (it sits on a bucket tape): its region
   * is keyed by `-(fileStart + 1)` and carries what the tape would have told.
   */
  readonly token: number;
  /** For a bucket region: its place among its parent's children. */
  readonly ordinal?: number;
  /** For a bucket region: the kind of the container it sits in. */
  readonly parentKind?: number;
  /** For a bucket region: how many containers enclose it. */
  readonly depth?: number;
  /** For a bucket region: the container it sits in (on the bucket tape, or the one the bucket was cut from). */
  readonly parent?: { readonly tapeId: number; readonly token: number };
  /** File offset of the key's opening quote, or of the value when it has none. */
  readonly fileStart: number;
  /** File offset just past the value. */
  readonly fileEnd: number;
  /** Current logical length of the region's bytes. */
  length: number;
}

const hasKey = (keyStart: number) => keyStart !== NO_KEY && keyStart < 0xfffffffe;

/** Where a token's region would start: its key's quote when it has one. */
export const regionStart = (tape: Tape, token: number) => {
  const key = tape.keyStart(token);
  return hasKey(key) ? key : tape.start(token);
};

export class Regions {
  private readonly list: Region[] = [];
  /** `deltaBefore[i]` is the summed length change of regions 0..i-1. */
  private deltaBefore: number[] = [0];
  private readonly byToken = new Map<number, Region>();

  get count() {
    return this.list.length;
  }

  all(): ReadonlyArray<Region> {
    return this.list;
  }

  regionOf(token: number) {
    return this.byToken.get(token);
  }

  private rebuild() {
    const prefix = [0];
    let sum = 0;
    for (const region of this.list) {
      sum += region.length - (region.fileEnd - region.fileStart);
      prefix.push(sum);
    }
    this.deltaBefore = prefix;
  }

  /** Number of regions that end at or before `fileOffset`. */
  private regionsEndingBy(fileOffset: number) {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.list[mid] as Region).fileEnd <= fileOffset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Summed length change of the regions that end at or before `fileOffset`. */
  delta(fileOffset: number) {
    return this.deltaBefore[this.regionsEndingBy(fileOffset)] as number;
  }

  /** Logical offset of a file offset that is not inside a region (a region's own start maps to its logical start). */
  logical(fileOffset: number) {
    return fileOffset + this.delta(fileOffset);
  }

  logicalStart(region: Region) {
    return this.logical(region.fileStart);
  }

  /** The region whose file span contains `fileOffset`, if any. */
  containing(fileOffset: number): Region | undefined {
    const i = this.regionsEndingBy(fileOffset);
    const region = this.list[i];
    return region && region.fileStart <= fileOffset ? region : undefined;
  }

  /** The region whose logical span contains logical offset `at`, if any. */
  containingLogical(at: number): Region | undefined {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const region = this.list[mid] as Region;
      if (this.logicalStart(region) + region.length <= at) lo = mid + 1;
      else hi = mid;
    }
    const region = this.list[lo];
    return region && this.logicalStart(region) <= at ? region : undefined;
  }

  /**
   * Maps a logical offset to a file offset. Inside a region the result is the
   * region's own start (for the end of a span, pass `forEnd` so a position inside
   * a region maps to the region's end): the span then covers the whole region,
   * which is the unit the main tape knows.
   */
  fileOf(at: number, forEnd = false) {
    const inside = this.containingLogical(at - (forEnd ? 1 : 0));
    if (inside) return forEnd ? inside.fileEnd : inside.fileStart;
    // Regions whose logical end is at or before `at` have all shifted it.
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const region = this.list[mid] as Region;
      if (this.logicalStart(region) + region.length <= at) lo = mid + 1;
      else hi = mid;
    }
    return at - (this.deltaBefore[lo] as number);
  }

  /** Adds a region, removing every region it contains; returns the regions it absorbed. */
  add(region: Region): Region[] {
    const absorbed: Region[] = [];
    let i = 0;
    while (i < this.list.length && (this.list[i] as Region).fileEnd <= region.fileStart) i++;
    let j = i;
    while (j < this.list.length && (this.list[j] as Region).fileStart < region.fileEnd) {
      const other = this.list[j] as Region;
      if (other.fileStart < region.fileStart || other.fileEnd > region.fileEnd) {
        throw new RangeError("regions overlap without nesting");
      }
      absorbed.push(other);
      this.byToken.delete(other.token);
      j++;
    }
    this.list.splice(i, j - i, region);
    this.byToken.set(region.token, region);
    this.rebuild();
    return absorbed;
  }

  remove(region: Region) {
    const i = this.list.indexOf(region);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.byToken.delete(region.token);
    this.rebuild();
  }

  /** A region's length changed. */
  resized(region: Region, length: number) {
    region.length = length;
    this.rebuild();
  }

  /** Total logical length change over the whole document. */
  get totalDelta() {
    return this.deltaBefore[this.list.length] as number;
  }
}

/**
 * The smallest value of a level's tape whose region covers tape span
 * [fileStart, fileEnd], climbing from the deepest token that starts at or before
 * `fileStart`. A span that sits in a member's key picks that member. A result
 * inside an existing region is widened to that region's token; the caller
 * descends into a region before asking, so that only happens for a span that
 * straddles one. Returns -1 only for an empty tape.
 */
export const enclosingToken = (
  tape: Tape,
  regions: Regions,
  fileStart: number,
  fileEnd: number,
) => {
  if (tape.count === 0) return -1;
  // Last token whose start is at or before fileStart; starts are non-decreasing in document order.
  let lo = 0;
  let hi = tape.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tape.start(mid) <= fileStart) lo = mid + 1;
    else hi = mid;
  }
  let token = Math.max(0, lo - 1);
  // The span may sit in the key of the next member (its key precedes its value).
  if (
    lo < tape.count &&
    hasKey(tape.keyStart(lo)) &&
    tape.keyStart(lo) <= fileStart &&
    fileEnd <= tape.end(lo)
  ) {
    token = lo;
  }
  const covers = (t: number) => regionStart(tape, t) <= fileStart && fileEnd <= tape.end(t);
  while (token >= 0 && !covers(token)) token = tape.parent(token);
  if (token < 0) token = 0;
  const inside = regions.containing(regionStart(tape, token));
  if (inside && inside.fileEnd >= tape.end(token)) return inside.token;
  return token;
};

/** The parent to retry with when a region's re-scan did not come out clean, or -1 at the root. */
export const widerToken = (tape: Tape, regions: Regions, token: number) => {
  const parent = tape.parent(token);
  if (parent < 0) return -1;
  const inside = regions.containing(regionStart(tape, parent));
  return inside && inside.fileEnd >= tape.end(parent) ? inside.token : parent;
};
