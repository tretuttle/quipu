/**
 * Structural JSON comparison:
 * - Bottom-up 64-bit subtree hashing (order-free for objects, canonical f64 for numbers).
 * - Object matching by decoded member key.
 * - Array matching by identity key (`id`, `uuid`, `_id`, `key`, `name`) with Myers LCS fallback.
 * - Iterative traversal so deep documents (100k+ levels) never overflow the call stack.
 * - Bounded to fully-indexed documents <= 256 MiB; multi-GB HARs use `har.ts`.
 */
import {
  DiffCancelledError,
  type DiffChange,
  type DiffMark,
  type DiffMergedRow,
  DiffTooLargeError,
  MAX_DIFF_PREVIEW_BYTES,
  MAX_STRUCTURAL_DIFF_BYTES,
  type StructuralDiffCounts,
  type StructuralDiffResult,
} from "@quipu/contracts/diff";
import type { NodeKind } from "@quipu/contracts/engine";

import { decodeUtf8 } from "../boundedSlice.ts";
import { decodeKey, isCleanIndex, stringBytes, stringEnd } from "../decode.ts";
import { indexBytes } from "../indexBuffer.ts";
import { FULL_DEPTH } from "../scan.ts";
import {
  firstChild,
  isContainer,
  KIND_ARRAY,
  KIND_FALSE,
  KIND_NUMBER,
  KIND_OBJECT,
  KIND_STRING,
  KIND_TRUE,
  NO_KEY,
  needsExpand,
  type Tape,
} from "../tape.ts";
import { add64, float64Bits, Hasher64 } from "./hash.ts";
import { diffMyers64 } from "./myers.ts";

export interface StructuralInput {
  readonly tape: Tape;
  readonly bytes: Uint8Array;
}

export interface StructuralDiffOptions {
  /** Return `false` to cancel the diff job. */
  readonly onProgress?: (fraction: number) => boolean;
}

const IDENTITY_KEYS = ["id", "uuid", "_id", "key", "name"] as const;
const EMPTY_BYTES = new Uint8Array(0);
const ENCODER = new TextEncoder();
const IDENTITY_KEY_BYTES = IDENTITY_KEYS.map((k) => ENCODER.encode(k));
const PROGRESS_STRIDE = 1 << 16;
const MAX_SLICE_NUMBER_BYTES = 1024;
const DEFAULT_INDEX_CHUNK_BYTES = 8 * 1024 * 1024;

type NormalizedKind = "object" | "array" | "string" | "number" | "bool" | "null";

function normalizeKind(kind: number): NormalizedKind {
  switch (kind) {
    case KIND_OBJECT:
      return "object";
    case KIND_ARRAY:
      return "array";
    case KIND_STRING:
      return "string";
    case KIND_NUMBER:
      return "number";
    case KIND_TRUE:
    case KIND_FALSE:
      return "bool";
    default:
      return "null";
  }
}

function toNodeKind(kind: number): NodeKind {
  switch (kind) {
    case KIND_OBJECT:
      return "object";
    case KIND_ARRAY:
      return "array";
    case KIND_STRING:
      return "string";
    case KIND_NUMBER:
      return "number";
    case KIND_TRUE:
      return "true";
    case KIND_FALSE:
      return "false";
    default:
      return "null";
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function keyBytesOf(tape: Tape, bytes: Uint8Array, token: number): Uint8Array {
  const ks = tape.keyStart(token);
  if (ks === NO_KEY) return EMPTY_BYTES;
  const end = stringEnd(bytes, ks);
  if (end < 0) return EMPTY_BYTES;
  return stringBytes(bytes, ks, end);
}

function escapePointerSegment(segment: string): string {
  if (!segment.includes("~") && !segment.includes("/")) return segment;
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function childrenOf(tape: Tape, token: number): number[] {
  const out: number[] = [];
  let c = firstChild(tape, token);
  while (c >= 0) {
    out.push(c);
    c = tape.next(c);
  }
  return out;
}

interface TreeMeta {
  readonly subtreeEnd: Uint32Array;
  readonly depth: Uint32Array;
}

function buildTreeMeta(tape: Tape, sizeBytes: number): TreeMeta {
  const n = tape.count;
  const subtreeEnd = new Uint32Array(n);
  const depth = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    if (needsExpand(tape, i)) {
      throw new DiffTooLargeError({
        bytes: sizeBytes,
        limit: MAX_STRUCTURAL_DIFF_BYTES,
        detail:
          "Structural diff requires a fully indexed document up to 256 MiB. Use HAR entry diff for multi-GB HAR captures.",
      });
    }
    const p = tape.parent(i);
    depth[i] = p < 0 ? 0 : (depth[p] as number) + 1;
    const nx = tape.next(i);
    subtreeEnd[i] = nx >= 0 ? nx : p >= 0 ? (subtreeEnd[p] as number) : n;
  }
  return { subtreeEnd, depth };
}

function assertBoundedInput(input: StructuralInput): void {
  if (input.bytes.byteLength > MAX_STRUCTURAL_DIFF_BYTES) {
    throw new DiffTooLargeError({
      bytes: input.bytes.byteLength,
      limit: MAX_STRUCTURAL_DIFF_BYTES,
      detail: `Document size (${input.bytes.byteLength} bytes) exceeds the 256 MiB structural diff limit. Use HAR entry diff for multi-GB HAR captures.`,
    });
  }
  if (input.tape.count === 0) {
    throw new DiffTooLargeError({
      bytes: input.bytes.byteLength,
      limit: MAX_STRUCTURAL_DIFF_BYTES,
      detail: "Cannot structurally diff an empty or unindexed document.",
    });
  }
}

function kindTag(kind: number): number {
  switch (kind) {
    case KIND_OBJECT:
      return 1;
    case KIND_ARRAY:
      return 2;
    case KIND_STRING:
      return 3;
    case KIND_NUMBER:
      return 4;
    case KIND_TRUE:
    case KIND_FALSE:
      return 5;
    default:
      return 6;
  }
}

export function computeSubtreeHashes(
  input: StructuralInput,
  onProgress?: (fraction: number) => boolean,
): BigUint64Array {
  const { tape, bytes } = input;
  const n = tape.count;
  const hashes = new BigUint64Array(n);

  for (let i = n - 1; i >= 0; i--) {
    if (onProgress && i % PROGRESS_STRIDE === 0 && !onProgress((n - i) / n)) {
      throw new DiffCancelledError({ detail: "Structural diff cancelled." });
    }
    const kind = tape.kind(i);
    const hasher = new Hasher64();
    hasher.writeU8(kindTag(kind));

    switch (kind) {
      case KIND_OBJECT: {
        // Order-free: commutative 64-bit sum of mixed (key, childHash) hashes.
        let sum = 0n;
        let c = firstChild(tape, i);
        while (c >= 0) {
          const member = new Hasher64();
          member.writeBytes(keyBytesOf(tape, bytes, c));
          member.writeU64(hashes[c] as bigint);
          sum = add64(sum, member.finishMixed());
          c = tape.next(c);
        }
        hasher.writeU64(sum);
        break;
      }
      case KIND_ARRAY: {
        let c = firstChild(tape, i);
        while (c >= 0) {
          hasher.writeU64(hashes[c] as bigint);
          c = tape.next(c);
        }
        break;
      }
      case KIND_STRING: {
        hasher.writeBytes(stringBytes(bytes, tape.start(i), tape.end(i)));
        break;
      }
      case KIND_NUMBER: {
        const start = tape.start(i);
        const end = tape.end(i);
        const raw = bytes.subarray(start, end);
        const num = Number(decodeUtf8(raw, MAX_SLICE_NUMBER_BYTES));
        if (Number.isFinite(num)) {
          hasher.writeU64(float64Bits(num));
        } else {
          hasher.writeBytes(raw);
        }
        break;
      }
      case KIND_TRUE:
        hasher.writeU8(1);
        break;
      case KIND_FALSE:
        hasher.writeU8(0);
        break;
      default:
        break;
    }

    hashes[i] = hasher.finishMixed();
  }

  return hashes;
}

function pointerOf(tape: Tape, bytes: Uint8Array, token: number): string {
  const parts: string[] = [];
  let cur = token;
  while (cur >= 0) {
    const parent = tape.parent(cur);
    if (parent < 0) break;
    if (tape.kind(parent) === KIND_OBJECT) {
      const k = decodeKey(tape, cur, bytes) ?? "";
      parts.push(escapePointerSegment(k));
    } else {
      let idx = 0;
      let sib = firstChild(tape, parent);
      while (sib >= 0 && sib !== cur) {
        idx++;
        sib = tape.next(sib);
      }
      parts.push(String(idx));
    }
    cur = parent;
  }
  if (parts.length === 0) return "";
  parts.reverse();
  return `/${parts.join("/")}`;
}

export function previewTokenValue(tape: Tape, bytes: Uint8Array, token: number): string {
  const kind = tape.kind(token);
  if (kind === KIND_OBJECT) {
    const count = tape.childCount(token);
    return count === 1 ? "{ 1 key }" : `{ ${count} keys }`;
  }
  if (kind === KIND_ARRAY) {
    const count = tape.childCount(token);
    return count === 1 ? "[ 1 item ]" : `[ ${count} items ]`;
  }
  if (kind === KIND_STRING) {
    const unescaped = stringBytes(bytes, tape.start(token), tape.end(token));
    const truncated = unescaped.length > MAX_DIFF_PREVIEW_BYTES;
    const text = decodeUtf8(
      truncated ? unescaped.subarray(0, MAX_DIFF_PREVIEW_BYTES) : unescaped,
      MAX_DIFF_PREVIEW_BYTES,
    );
    return truncated ? `${JSON.stringify(text)}…` : JSON.stringify(text);
  }
  const raw = bytes.subarray(tape.start(token), tape.end(token));
  const truncated = raw.length > MAX_DIFF_PREVIEW_BYTES;
  const text = decodeUtf8(
    truncated ? raw.subarray(0, MAX_DIFF_PREVIEW_BYTES) : raw,
    MAX_DIFF_PREVIEW_BYTES,
  );
  return truncated ? `${text}…` : text;
}

/** Longest increasing subsequence of matched positions in `a`, O(n log n). */
function stayedPositions(inA: ReadonlyArray<number | null>): boolean[] {
  const tails: number[] = [];
  const prev = new Int32Array(inA.length).fill(-1);
  for (let j = 0; j < inA.length; j++) {
    const v = inA[j];
    if (v === null || v === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const tailVal = inA[tails[mid] as number] as number;
      if (tailVal < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[j] = tails[lo - 1] as number;
    if (lo === tails.length) tails.push(j);
    else tails[lo] = j;
  }
  const out = Array.from({ length: inA.length }, () => false);
  let at = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (at >= 0) {
    out[at] = true;
    at = prev[at] as number;
  }
  return out;
}

function findMemberByKeyBytes(
  tape: Tape,
  bytes: Uint8Array,
  objToken: number,
  targetKeyBytes: Uint8Array,
): number | null {
  let c = firstChild(tape, objToken);
  while (c >= 0) {
    if (bytesEqual(keyBytesOf(tape, bytes, c), targetKeyBytes)) return c;
    c = tape.next(c);
  }
  return null;
}

function findIdentityKey(
  a: StructuralInput,
  ia: ReadonlyArray<number>,
  b: StructuralInput,
  ib: ReadonlyArray<number>,
  ha: BigUint64Array,
  hb: BigUint64Array,
): Uint8Array | null {
  if (ia.length === 0 || ib.length === 0) return null;
  for (const c of ia) if (a.tape.kind(c) !== KIND_OBJECT) return null;
  for (const c of ib) if (b.tape.kind(c) !== KIND_OBJECT) return null;

  const isUniqueFor = (
    input: StructuralInput,
    items: ReadonlyArray<number>,
    hashes: BigUint64Array,
    keyBytes: Uint8Array,
  ) => {
    const seen = new Set<string>();
    for (const item of items) {
      const member = findMemberByKeyBytes(input.tape, input.bytes, item, keyBytes);
      if (member === null) return false;
      const k = input.tape.kind(member);
      if (isContainer(k)) return false;
      const sig = `${normalizeKind(k)}:${(hashes[member] as bigint).toString(16)}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
    }
    return true;
  };

  for (const keyBytes of IDENTITY_KEY_BYTES) {
    if (isUniqueFor(a, ia, ha, keyBytes) && isUniqueFor(b, ib, hb, keyBytes)) {
      return keyBytes;
    }
  }
  return null;
}

function membersMap(input: StructuralInput, objToken: number): Map<string, number> {
  const map = new Map<string, number>();
  let c = firstChild(input.tape, objToken);
  while (c >= 0) {
    const key = decodeKey(input.tape, c, input.bytes) ?? "";
    map.set(key, c);
    c = input.tape.next(c);
  }
  return map;
}

function sameKeyOrder(
  a: StructuralInput,
  an: number,
  endA: number,
  b: StructuralInput,
  bn: number,
  endB: number,
): boolean {
  const len = endA - an;
  if (len !== endB - bn) return false;
  for (let offset = 0; offset < len; offset++) {
    const ta = an + offset;
    const tb = bn + offset;
    if (a.tape.kind(ta) !== b.tape.kind(tb)) return false;
    const ka = a.tape.keyStart(ta);
    const kb = b.tape.keyStart(tb);
    if ((ka === NO_KEY) !== (kb === NO_KEY)) return false;
    if (
      ka !== NO_KEY &&
      !bytesEqual(keyBytesOf(a.tape, a.bytes, ta), keyBytesOf(b.tape, b.bytes, tb))
    ) {
      return false;
    }
  }
  return true;
}

function propagateInside(tape: Tape, marks: DiffMark[]): void {
  for (let i = tape.count - 1; i >= 1; i--) {
    if (marks[i] !== "same") {
      const p = tape.parent(i);
      if (p >= 0 && marks[p] === "same") {
        marks[p] = "inside";
      }
    }
  }
}

export class StructuralDiff {
  readonly changes: ReadonlyArray<DiffChange>;
  readonly marksA: ReadonlyArray<DiffMark>;
  readonly marksB: ReadonlyArray<DiffMark>;
  private readonly aToB: Int32Array;
  private readonly bToA: Int32Array;
  private readonly metaA: TreeMeta;
  private readonly metaB: TreeMeta;

  constructor(
    changes: ReadonlyArray<DiffChange>,
    marksA: ReadonlyArray<DiffMark>,
    marksB: ReadonlyArray<DiffMark>,
    aToB: Int32Array,
    bToA: Int32Array,
    metaA: TreeMeta,
    metaB: TreeMeta,
  ) {
    this.changes = changes;
    this.marksA = marksA;
    this.marksB = marksB;
    this.aToB = aToB;
    this.bToA = bToA;
    this.metaA = metaA;
    this.metaB = metaB;
  }

  isEmpty(): boolean {
    return this.changes.length === 0;
  }

  markA(token: number): DiffMark {
    return this.marksA[token] ?? "same";
  }

  markB(token: number): DiffMark {
    return this.marksB[token] ?? "same";
  }

  inB(aToken: number): number | null {
    const v = this.aToB[aToken];
    return v !== undefined && v >= 0 ? v : null;
  }

  inA(bToken: number): number | null {
    const v = this.bToA[bToken];
    return v !== undefined && v >= 0 ? v : null;
  }

  counts(): StructuralDiffCounts {
    let added = 0;
    let removed = 0;
    let changed = 0;
    let moved = 0;
    for (const c of this.changes) {
      switch (c.kind) {
        case "added":
          added++;
          break;
        case "removed":
          removed++;
          break;
        case "changed":
          changed++;
          break;
        case "moved":
          moved++;
          break;
      }
    }
    let same = 0;
    for (const m of this.marksB) {
      if (m === "same") same++;
    }
    return { same, added, removed, changed, moved };
  }

  private anchor(a: Tape, change: DiffChange): number {
    if (change.bToken !== null) return change.bToken;
    let at = change.aToken;
    while (at !== null && at >= 0) {
      const mapped = this.inB(at);
      if (mapped !== null) return mapped;
      const p = a.parent(at);
      at = p >= 0 ? p : null;
    }
    return 0;
  }

  nextChange(a: Tape, fromBToken: number): DiffChange | null {
    if (this.changes.length === 0) return null;
    for (const c of this.changes) {
      if (this.anchor(a, c) > fromBToken) return c;
    }
    return this.changes[0] ?? null;
  }

  previousChange(a: Tape, fromBToken: number): DiffChange | null {
    if (this.changes.length === 0) return null;
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i] as DiffChange;
      if (this.anchor(a, c) < fromBToken) return c;
    }
    return this.changes[this.changes.length - 1] ?? null;
  }

  merged(a: StructuralInput, b: StructuralInput): DiffMergedRow[] {
    const rows: DiffMergedRow[] = [];

    type MergeFrame =
      | {
          readonly kind: "b";
          readonly bn: number;
          readonly depth: number;
          readonly index: number | null;
          readonly key: string | null;
          readonly pointer: string;
        }
      | {
          readonly kind: "removed";
          readonly an: number;
          readonly depth: number;
          readonly index: number | null;
          readonly key: string | null;
          readonly parentPointer: string;
        };

    const stack: MergeFrame[] = [
      { kind: "b", bn: 0, depth: 0, index: null, key: null, pointer: "" },
    ];

    while (stack.length > 0) {
      const frame = stack.pop() as MergeFrame;
      if (frame.kind === "removed") {
        const baseDepth = this.metaA.depth[frame.an] as number;
        const end = this.metaA.subtreeEnd[frame.an] as number;
        const idxByToken = new Map<number, number | null>();
        const ptrByToken = new Map<number, string>();
        const keyByToken = new Map<number, string | null>();
        idxByToken.set(frame.an, frame.index);
        keyByToken.set(frame.an, frame.key);
        const rootSeg =
          frame.key !== null ? escapePointerSegment(frame.key) : String(frame.index ?? 0);
        ptrByToken.set(
          frame.an,
          frame.parentPointer === "" ? `/${rootSeg}` : `${frame.parentPointer}/${rootSeg}`,
        );

        for (let t = frame.an; t < end; t++) {
          const tDepth = frame.depth + ((this.metaA.depth[t] as number) - baseDepth);
          let tKey = keyByToken.get(t) ?? null;
          let tIdx = idxByToken.get(t) ?? null;
          let tPtr = ptrByToken.get(t);
          if (tPtr === undefined) {
            const p = a.tape.parent(t);
            const pPtr = ptrByToken.get(p) ?? "";
            if (a.tape.kind(p) === KIND_OBJECT) {
              tKey = decodeKey(a.tape, t, a.bytes) ?? "";
              tIdx = null;
              tPtr = `${pPtr}/${escapePointerSegment(tKey)}`;
            } else {
              let idx = 0;
              let sib = firstChild(a.tape, p);
              while (sib >= 0 && sib !== t) {
                idx++;
                sib = a.tape.next(sib);
              }
              tKey = null;
              tIdx = idx;
              tPtr = `${pPtr}/${idx}`;
            }
            keyByToken.set(t, tKey);
            idxByToken.set(t, tIdx);
            ptrByToken.set(t, tPtr);
          }

          const tKind = a.tape.kind(t);
          rows.push({
            id: `a:${t}`,
            aToken: t,
            bToken: null,
            depth: tDepth,
            mark: this.markA(t),
            kind: toNodeKind(tKind),
            key: tKey,
            index: tIdx,
            value: previewTokenValue(a.tape, a.bytes, t),
            wasValue: null,
            pointer: tPtr,
            expandable: isContainer(tKind) && a.tape.childCount(t) > 0,
            childCount: a.tape.childCount(t),
          });
        }
        continue;
      }

      const { bn, depth, index, key, pointer } = frame;
      const an = this.inA(bn);
      const bKind = b.tape.kind(bn);
      const mark = this.markB(bn);
      let wasValue: string | null = null;
      if (mark === "changed" && an !== null && !isContainer(a.tape.kind(an))) {
        wasValue = previewTokenValue(a.tape, a.bytes, an);
      }

      rows.push({
        id: `b:${bn}`,
        aToken: an,
        bToken: bn,
        depth,
        mark,
        kind: toNodeKind(bKind),
        key,
        index,
        value: previewTokenValue(b.tape, b.bytes, bn),
        wasValue,
        pointer,
        expandable: isContainer(bKind) && b.tape.childCount(bn) > 0,
        childCount: b.tape.childCount(bn),
      });

      const leading: Array<{ an: number; index: number | null; key: string | null }> = [];
      const after = new Map<
        number,
        Array<{ an: number; index: number | null; key: string | null }>
      >();
      if (
        an !== null &&
        isContainer(a.tape.kind(an)) &&
        normalizeKind(a.tape.kind(an)) === normalizeKind(bKind)
      ) {
        let prevB: number | null = null;
        let ac = firstChild(a.tape, an);
        let aIdx = 0;
        const aIsObject = a.tape.kind(an) === KIND_OBJECT;
        while (ac >= 0) {
          const cb = this.inB(ac);
          if (cb !== null && b.tape.parent(cb) === bn) {
            prevB = cb;
          } else if (cb === null) {
            const entry = {
              an: ac,
              index: aIsObject ? null : aIdx,
              key: aIsObject ? (decodeKey(a.tape, ac, a.bytes) ?? "") : null,
            };
            if (prevB === null) {
              leading.push(entry);
            } else {
              let list = after.get(prevB);
              if (!list) {
                list = [];
                after.set(prevB, list);
              }
              list.push(entry);
            }
          }
          aIdx++;
          ac = a.tape.next(ac);
        }
      }

      const bChildren = childrenOf(b.tape, bn);
      const bIsObject = bKind === KIND_OBJECT;

      // Push children and trailing removals in reverse so stack pops in forward document order.
      for (let idx = bChildren.length - 1; idx >= 0; idx--) {
        const c = bChildren[idx] as number;
        const trailing = after.get(c);
        if (trailing) {
          for (let r = trailing.length - 1; r >= 0; r--) {
            const rem = trailing[r]!;
            stack.push({
              kind: "removed",
              an: rem.an,
              depth: depth + 1,
              index: rem.index,
              key: rem.key,
              parentPointer: pointer,
            });
          }
        }
        const cKey = bIsObject ? (decodeKey(b.tape, c, b.bytes) ?? "") : null;
        const seg = cKey !== null ? escapePointerSegment(cKey) : String(idx);
        stack.push({
          kind: "b",
          bn: c,
          depth: depth + 1,
          index: bIsObject ? null : idx,
          key: cKey,
          pointer: pointer === "" ? `/${seg}` : `${pointer}/${seg}`,
        });
      }

      for (let r = leading.length - 1; r >= 0; r--) {
        const rem = leading[r]!;
        stack.push({
          kind: "removed",
          an: rem.an,
          depth: depth + 1,
          index: rem.index,
          key: rem.key,
          parentPointer: pointer,
        });
      }
    }

    return rows;
  }

  toResult(a: StructuralInput, b: StructuralInput): StructuralDiffResult {
    return {
      changes: this.changes,
      counts: this.counts(),
      rows: this.merged(a, b),
    };
  }
}

export function diffTapes(
  a: StructuralInput,
  b: StructuralInput,
  options: StructuralDiffOptions = {},
): StructuralDiff {
  assertBoundedInput(a);
  assertBoundedInput(b);
  const metaA = buildTreeMeta(a.tape, a.bytes.byteLength);
  const metaB = buildTreeMeta(b.tape, b.bytes.byteLength);

  const onProgress = options.onProgress;
  const totalWork = (a.tape.count + b.tape.count) * 2;
  const ha = computeSubtreeHashes(
    a,
    onProgress ? (f) => onProgress((f * a.tape.count) / totalWork) : undefined,
  );
  const baseB = a.tape.count / totalWork;
  const hb = computeSubtreeHashes(
    b,
    onProgress ? (f) => onProgress(baseB + (f * b.tape.count) / totalWork) : undefined,
  );

  const marksA = Array.from({ length: a.tape.count }, (): DiffMark => "same");
  const marksB = Array.from({ length: b.tape.count }, (): DiffMark => "same");
  const aToB = new Int32Array(a.tape.count).fill(-1);
  const bToA = new Int32Array(b.tape.count).fill(-1);
  const changes: DiffChange[] = [];

  let visited = 0;
  const baseCompare = (a.tape.count + b.tape.count) / totalWork;
  const tick = (nodes: number) => {
    if (!onProgress) return;
    const prevBucket = visited >> 16;
    visited += nodes;
    if (visited >> 16 !== prevBucket) {
      if (!onProgress(baseCompare + visited / totalWork)) {
        throw new DiffCancelledError({ detail: "Structural diff cancelled." });
      }
    }
  };

  const pair = (an: number, bn: number) => {
    aToB[an] = bn;
    bToA[bn] = an;
  };

  const pushChange = (kind: DiffChange["kind"], an: number | null, bn: number | null) => {
    changes.push({
      kind,
      aToken: an,
      bToken: bn,
      pathA: an !== null ? pointerOf(a.tape, a.bytes, an) : null,
      pathB: bn !== null ? pointerOf(b.tape, b.bytes, bn) : null,
    });
  };

  const pairSameSubtree = (anRoot: number, bnRoot: number) => {
    const queue: Array<[number, number]> = [[anRoot, bnRoot]];
    while (queue.length > 0) {
      const [an, bn] = queue.pop() as [number, number];
      pair(an, bn);
      const endA = metaA.subtreeEnd[an] as number;
      const endB = metaB.subtreeEnd[bn] as number;
      const lenA = endA - an;
      tick(lenA);

      if (sameKeyOrder(a, an, endA, b, bn, endB)) {
        for (let off = 0; off < lenA; off++) {
          const ta = an + off;
          const tb = bn + off;
          aToB[ta] = tb;
          bToA[tb] = ta;
        }
        continue;
      }

      if (a.tape.kind(an) === KIND_OBJECT) {
        const bMembers = membersMap(b, bn);
        let c = firstChild(a.tape, an);
        while (c >= 0) {
          const k = decodeKey(a.tape, c, a.bytes) ?? "";
          const d = bMembers.get(k);
          if (d !== undefined) queue.push([c, d]);
          c = a.tape.next(c);
        }
      } else if (a.tape.kind(an) === KIND_ARRAY) {
        let ca = firstChild(a.tape, an);
        let cb = firstChild(b.tape, bn);
        while (ca >= 0 && cb >= 0) {
          queue.push([ca, cb]);
          ca = a.tape.next(ca);
          cb = b.tape.next(cb);
        }
      }
    }
  };

  type WorkTask =
    | { readonly kind: "compare"; readonly an: number; readonly bn: number }
    | { readonly kind: "added"; readonly bn: number }
    | { readonly kind: "removed"; readonly an: number }
    | { readonly kind: "moved"; readonly an: number; readonly bn: number };

  const stack: WorkTask[] = [{ kind: "compare", an: 0, bn: 0 }];

  while (stack.length > 0) {
    const task = stack.pop() as WorkTask;

    if (task.kind === "added") {
      const endB = metaB.subtreeEnd[task.bn] as number;
      for (let t = task.bn; t < endB; t++) marksB[t] = "added";
      tick(endB - task.bn);
      pushChange("added", null, task.bn);
      continue;
    }

    if (task.kind === "removed") {
      const endA = metaA.subtreeEnd[task.an] as number;
      for (let t = task.an; t < endA; t++) marksA[t] = "removed";
      tick(endA - task.an);
      pushChange("removed", task.an, null);
      continue;
    }

    if (task.kind === "moved") {
      marksA[task.an] = "moved";
      marksB[task.bn] = "moved";
      pushChange("moved", task.an, task.bn);
      continue;
    }

    const { an, bn } = task;
    pair(an, bn);
    if (ha[an] === hb[bn]) {
      pairSameSubtree(an, bn);
      continue;
    }

    tick(1);
    const ka = a.tape.kind(an);
    const kb = b.tape.kind(bn);
    if (normalizeKind(ka) !== normalizeKind(kb) || !isContainer(ka)) {
      const endA = metaA.subtreeEnd[an] as number;
      const endB = metaB.subtreeEnd[bn] as number;
      for (let t = an; t < endA; t++) marksA[t] = "changed";
      for (let t = bn; t < endB; t++) marksB[t] = "changed";
      pushChange("changed", an, bn);
      continue;
    }

    if (ka === KIND_OBJECT) {
      const bMembers = membersMap(b, bn);
      const bChildren = childrenOf(b.tape, bn);
      const bIndex = new Map<number, number>();
      for (let i = 0; i < bChildren.length; i++) bIndex.set(bChildren[i] as number, i);
      const matched = Array.from({ length: bChildren.length }, () => false);
      const pairs: Array<{ an: number; bn: number }> = [];
      const removed: number[] = [];

      let c = firstChild(a.tape, an);
      while (c >= 0) {
        const k = decodeKey(a.tape, c, a.bytes) ?? "";
        const d = bMembers.get(k);
        if (d !== undefined) {
          matched[bIndex.get(d) as number] = true;
          pairs.push({ an: c, bn: d });
        } else {
          removed.push(c);
        }
        c = a.tape.next(c);
      }

      pairs.sort((x, y) => x.bn - y.bn);

      // Push in reverse order: removed -> added -> pairs.
      for (let i = removed.length - 1; i >= 0; i--) {
        stack.push({ kind: "removed", an: removed[i] as number });
      }
      for (let i = bChildren.length - 1; i >= 0; i--) {
        if (!matched[i]) {
          stack.push({ kind: "added", bn: bChildren[i] as number });
        }
      }
      for (let i = pairs.length - 1; i >= 0; i--) {
        const p = pairs[i]!;
        stack.push({ kind: "compare", an: p.an, bn: p.bn });
      }
      continue;
    }

    // Array comparison: identity key if present and unique on both sides, else Myers LCS.
    const ia = childrenOf(a.tape, an);
    const ib = childrenOf(b.tape, bn);
    const idKey = findIdentityKey(a, ia, b, ib, ha, hb);

    if (idKey !== null) {
      const ids = new Map<string, number>();
      for (let i = 0; i < ia.length; i++) {
        const v = findMemberByKeyBytes(a.tape, a.bytes, ia[i] as number, idKey) as number;
        const sig = `${normalizeKind(a.tape.kind(v))}:${(ha[v] as bigint).toString(16)}`;
        ids.set(sig, i);
      }
      const inA = Array.from<number | null>({ length: ib.length }).fill(null);
      const taken = Array.from({ length: ia.length }, () => false);
      for (let j = 0; j < ib.length; j++) {
        const v = findMemberByKeyBytes(b.tape, b.bytes, ib[j] as number, idKey) as number;
        const sig = `${normalizeKind(b.tape.kind(v))}:${(hb[v] as bigint).toString(16)}`;
        const i = ids.get(sig);
        if (i !== undefined) {
          inA[j] = i;
          taken[i] = true;
        }
      }
      const stayed = stayedPositions(inA);
      for (let i = ia.length - 1; i >= 0; i--) {
        if (!taken[i]) stack.push({ kind: "removed", an: ia[i] as number });
      }
      for (let j = ib.length - 1; j >= 0; j--) {
        const i = inA[j];
        const d = ib[j] as number;
        if (i !== null && i !== undefined) {
          const ca = ia[i] as number;
          stack.push({ kind: "compare", an: ca, bn: d });
          if (!stayed[j]) stack.push({ kind: "moved", an: ca, bn: d });
        } else {
          stack.push({ kind: "added", bn: d });
        }
      }
      continue;
    }

    const arrayHa = new BigUint64Array(ia.length);
    for (let i = 0; i < ia.length; i++) arrayHa[i] = ha[ia[i] as number] as bigint;
    const arrayHb = new BigUint64Array(ib.length);
    for (let j = 0; j < ib.length; j++) arrayHb[j] = hb[ib[j] as number] as bigint;

    const ops = diffMyers64(arrayHa, arrayHb);
    const inA = Array.from<number | null>({ length: ib.length }).fill(null);
    const taken = Array.from({ length: ia.length }, () => false);
    const moved = Array.from({ length: ib.length }, () => false);
    const runs: Array<{
      oldStart: number;
      oldEnd: number;
      newStart: number;
      newEnd: number;
    }> = [];

    for (const op of ops) {
      switch (op.kind) {
        case "equal":
          for (let k = 0; k < op.len; k++) {
            inA[op.newIndex + k] = op.oldIndex + k;
            taken[op.oldIndex + k] = true;
          }
          break;
        case "delete":
          runs.push({
            oldStart: op.oldIndex,
            oldEnd: op.oldIndex + op.oldLen,
            newStart: 0,
            newEnd: 0,
          });
          break;
        case "insert":
          runs.push({
            oldStart: 0,
            oldEnd: 0,
            newStart: op.newIndex,
            newEnd: op.newIndex + op.newLen,
          });
          break;
        case "replace":
          runs.push({
            oldStart: op.oldIndex,
            oldEnd: op.oldIndex + op.oldLen,
            newStart: op.newIndex,
            newEnd: op.newIndex + op.newLen,
          });
          break;
      }
    }

    // Moves: removed items that match added items by hash.
    const loose = new Map<bigint, number[]>();
    for (const run of runs) {
      for (let i = run.oldEnd - 1; i >= run.oldStart; i--) {
        const h = arrayHa[i] as bigint;
        let list = loose.get(h);
        if (!list) {
          list = [];
          loose.set(h, list);
        }
        list.push(i);
      }
    }
    for (const run of runs) {
      for (let j = run.newStart; j < run.newEnd; j++) {
        const h = arrayHb[j] as bigint;
        const list = loose.get(h);
        const i = list?.pop();
        if (i !== undefined) {
          inA[j] = i;
          taken[i] = true;
          moved[j] = true;
        }
      }
    }

    // Remaining items in replaced runs pair in order within the same normalized kind.
    for (const run of runs) {
      const olds: number[] = [];
      for (let i = run.oldStart; i < run.oldEnd; i++) {
        if (!taken[i]) olds.push(i);
      }
      let at = 0;
      for (let j = run.newStart; j < run.newEnd; j++) {
        if (inA[j] !== null) continue;
        const kind = normalizeKind(b.tape.kind(ib[j] as number));
        for (let k = at; k < olds.length; k++) {
          const i = olds[k] as number;
          if (normalizeKind(a.tape.kind(ia[i] as number)) === kind) {
            inA[j] = i;
            taken[i] = true;
            at = k + 1;
            break;
          }
        }
      }
    }

    for (let i = ia.length - 1; i >= 0; i--) {
      if (!taken[i]) stack.push({ kind: "removed", an: ia[i] as number });
    }
    for (let j = ib.length - 1; j >= 0; j--) {
      const i = inA[j];
      const d = ib[j] as number;
      if (i !== null && i !== undefined) {
        const ca = ia[i] as number;
        stack.push({ kind: "compare", an: ca, bn: d });
        if (moved[j]) stack.push({ kind: "moved", an: ca, bn: d });
      } else {
        stack.push({ kind: "added", bn: d });
      }
    }
  }

  propagateInside(a.tape, marksA);
  propagateInside(b.tape, marksB);
  onProgress?.(1);

  return new StructuralDiff(changes, marksA, marksB, aToB, bToA, metaA, metaB);
}

export function indexJsonForDiff(bytes: Uint8Array): StructuralInput {
  if (bytes.byteLength > MAX_STRUCTURAL_DIFF_BYTES) {
    throw new DiffTooLargeError({
      bytes: bytes.byteLength,
      limit: MAX_STRUCTURAL_DIFF_BYTES,
      detail: `Document size (${bytes.byteLength} bytes) exceeds the 256 MiB structural diff limit. Use HAR entry diff for multi-GB HAR captures.`,
    });
  }
  const { tape } = indexBytes(bytes, 0, {
    maxDepth: FULL_DEPTH,
    chunkBytes: DEFAULT_INDEX_CHUNK_BYTES,
  });
  if (!isCleanIndex(tape, bytes)) {
    throw new Error("Input is not a single valid JSON value.");
  }
  return { tape, bytes };
}

export function diffJsonBytes(
  aBytes: Uint8Array,
  bBytes: Uint8Array,
  options: StructuralDiffOptions = {},
): StructuralDiffResult {
  const a = indexJsonForDiff(aBytes);
  const b = indexJsonForDiff(bBytes);
  return diffTapes(a, b, options).toResult(a, b);
}

export function formatChangeSummary(change: DiffChange): string {
  const fmt = (p: string | null) => (p === "" ? "/" : (p ?? ""));
  switch (change.kind) {
    case "added":
      return `added ${fmt(change.pathB)}`;
    case "removed":
      return `removed ${fmt(change.pathA)}`;
    case "changed":
      return change.pathA !== change.pathB
        ? `changed ${fmt(change.pathB)} (was ${fmt(change.pathA)})`
        : `changed ${fmt(change.pathB)}`;
    case "moved":
      return `moved ${fmt(change.pathA)} to ${fmt(change.pathB)}`;
  }
}
