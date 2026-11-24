/**
 * Appends region tapes to the document tape in file order and patches what a
 * region could not know: ends of strings, numbers and containers that began
 * earlier, sibling links and child counts across the boundary, keys sitting in
 * an earlier region, and the bucket anchors of containers open at entry.
 * Per-level state grows with the depth actually open, never with maxDepth.
 */
import { inheritedLevel, type StructureReport } from "./scan.ts";
import { INHERITED_KEY, type MutableTape, type TapeBuffers } from "./tape.ts";

/** Where the children of one container at the eager depth begin: child index → byte offset, in order. */
export interface BucketAnchors {
  readonly index: number[];
  readonly offset: number[];
}

export class TapeMerger {
  readonly tape: MutableTape;
  private openAtLevel = new Int32Array(16).fill(-1);
  private lastChildAtLevel = new Int32Array(16).fill(-1);
  /** Levels currently open (entries beyond this are -1). */
  private openLevels = 0;
  private pendingKey = -1;
  /** Start of a cut-level member's key whose value has not started yet, carried across regions. */
  private pendingCutKey = -1;
  private pendingStringToken = -1;
  private pendingScalarToken = -1;
  /** Absolute [start, end) pairs of every big string seen, in file order. */
  readonly bigStrings: number[] = [];
  /** Bucket anchors per container token at the eager depth. */
  readonly anchors = new Map<number, BucketAnchors>();
  regionsMerged = 0;
  childrenBeyondTape = 0;
  private readonly onTapeLevels: number;

  constructor(tape: MutableTape, maxDepth: number) {
    this.tape = tape;
    this.onTapeLevels = maxDepth + 1;
  }

  private ensureLevels(n: number) {
    if (n <= this.openAtLevel.length) return;
    let size = this.openAtLevel.length;
    while (size < n) size *= 2;
    const open = new Int32Array(size).fill(-1);
    open.set(this.openAtLevel);
    this.openAtLevel = open;
    const last = new Int32Array(size).fill(-1);
    last.set(this.lastChildAtLevel);
    this.lastChildAtLevel = last;
  }

  private anchorsOf(container: number) {
    let anchors = this.anchors.get(container);
    if (!anchors) {
      anchors = { index: [], offset: [] };
      this.anchors.set(container, anchors);
    }
    return anchors;
  }

  /**
   * Tokens that later regions can still change: containers open at the end of
   * what has merged (their end and child count grow), and a string or number the
   * boundary cut. Every other merged token is final.
   */
  unsettledTokens(): number[] {
    const tokens: number[] = [];
    for (let level = 0; level < this.openLevels; level++) {
      const open = this.openAtLevel[level] as number;
      if (open >= 0) tokens.push(open);
    }
    if (this.pendingStringToken >= 0) tokens.push(this.pendingStringToken);
    if (this.pendingScalarToken >= 0) tokens.push(this.pendingScalarToken);
    return tokens;
  }

  append(buffers: TapeBuffers, report: StructureReport) {
    const tape = this.tape;
    const openAtLevel = this.openAtLevel;
    const base = tape.count;
    tape.appendSegment(buffers, (parent) =>
      parent >= 0
        ? parent + base
        : parent === -1
          ? -1
          : (openAtLevel[inheritedLevel(parent)] as number),
    );

    if (report.inheritedStringEnd >= 0 && this.pendingStringToken >= 0) {
      tape.setEnd(this.pendingStringToken, report.inheritedStringEnd);
      this.pendingStringToken = -1;
    }
    if (report.inheritedScalarEnd >= 0 && this.pendingScalarToken >= 0) {
      tape.setEnd(this.pendingScalarToken, report.inheritedScalarEnd);
      if (!report.inheritedScalarContinues) this.pendingScalarToken = -1;
    }
    if (report.inheritedKeyToken >= 0) {
      const token = base + report.inheritedKeyToken;
      if (tape.keyStart(token) === INHERITED_KEY && this.pendingKey >= 0) {
        tape.setKeyStart(token, this.pendingKey);
      }
    }
    // Anchors first: an inherited container's child index continues from the children
    // counted before this region, which the loop below is about to add to.
    const cutLevel = this.onTapeLevels - 1;
    for (let a = 0; a < report.cutAnchors.length; a += 3) {
      const local = report.cutAnchors[a] as number;
      const localIndex = report.cutAnchors[a + 1] as number;
      const raw = report.cutAnchors[a + 2] as number;
      // A negated offset marks a member whose key sits in an earlier region.
      const offset = raw < 0 ? (this.pendingCutKey >= 0 ? this.pendingCutKey : -raw) : raw;
      const container = local >= 0 ? base + local : (this.openAtLevel[cutLevel] as number);
      if (container < 0) continue;
      const before = local >= 0 ? 0 : tape.childCount(container);
      const anchors = this.anchorsOf(container);
      anchors.index.push(before + localIndex);
      anchors.offset.push(offset);
    }
    // Levels below levelBase are untouched by this region; the report arrays start there.
    const levelBase = report.levelBase;
    const inheritedLevels = report.inheritedLevels;
    for (let level = levelBase; level < inheritedLevels; level++) {
      const r = level - levelBase;
      const first = report.inheritedFirstChild[r] as number;
      const last = this.lastChildAtLevel[level] as number;
      if (first >= 0 && last >= 0) tape.setNext(last, base + first);
      const close = report.inheritedClose[r] as number;
      const open = this.openAtLevel[level] as number;
      if (close > 0 && open >= 0) {
        tape.setEnd(open, close);
        tape.setChildCount(open, tape.childCount(open) + (report.inheritedChildCount[r] as number));
        this.openAtLevel[level] = -1;
        this.lastChildAtLevel[level] = -1;
      }
    }
    const exitLevels = Math.min(report.exitDepth, this.onTapeLevels);
    this.ensureLevels(exitLevels);
    for (let level = levelBase; level < exitLevels; level++) {
      const r = level - levelBase;
      const localOpen = report.exitOpenLocal[r] as number;
      if (localOpen >= 0) {
        this.openAtLevel[level] = base + localOpen;
      } else if (
        (this.openAtLevel[level] as number) >= 0 &&
        level < inheritedLevels &&
        (report.inheritedClose[r] as number) === 0
      ) {
        const open = this.openAtLevel[level] as number;
        tape.setChildCount(open, tape.childCount(open) + (report.inheritedChildCount[r] as number));
      }
      const lastChild = report.exitLastChild[r] as number;
      if (lastChild >= 0) this.lastChildAtLevel[level] = base + lastChild;
      else if (localOpen >= 0) this.lastChildAtLevel[level] = -1;
    }
    for (let level = exitLevels; level < this.openLevels; level++) {
      this.openAtLevel[level] = -1;
      this.lastChildAtLevel[level] = -1;
    }
    this.openLevels = exitLevels;
    if (report.exitPendingKey >= 0) this.pendingKey = report.exitPendingKey;
    else if (report.exitPendingKey === -1) this.pendingKey = -1;
    if (report.exitCutKey >= 0) this.pendingCutKey = report.exitCutKey;
    else if (report.exitCutKey === -1) this.pendingCutKey = -1;
    if (report.exitStringToken >= 0) this.pendingStringToken = base + report.exitStringToken;
    if (report.exitScalarToken >= 0) this.pendingScalarToken = base + report.exitScalarToken;
    for (const v of report.bigStrings) this.bigStrings.push(v);
    this.childrenBeyondTape += report.childrenBeyondTape;
    this.regionsMerged++;
    return base;
  }
}
