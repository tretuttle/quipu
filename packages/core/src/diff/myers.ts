/**
 * Myers longest-common-subsequence diff over two 64-bit hash arrays,
 * producing Equal / Delete / Insert / Replace operations matching `similar`.
 */

export type MyersOp =
  | {
      readonly kind: "equal";
      readonly oldIndex: number;
      readonly newIndex: number;
      readonly len: number;
    }
  | { readonly kind: "delete"; readonly oldIndex: number; readonly oldLen: number }
  | { readonly kind: "insert"; readonly newIndex: number; readonly newLen: number }
  | {
      readonly kind: "replace";
      readonly oldIndex: number;
      readonly oldLen: number;
      readonly newIndex: number;
      readonly newLen: number;
    };

type RawEdit = "equal" | "delete" | "insert";

/**
 * Computes Myers shortest edit script between `a` and `b`.
 * Trims common prefix/suffix first and caps full trace size so degenerate huge arrays
 * degrade cleanly rather than exhausting memory.
 */
export function diffMyers64(a: BigUint64Array, b: BigUint64Array): MyersOp[] {
  const nTotal = a.length;
  const mTotal = b.length;

  let prefix = 0;
  while (prefix < nTotal && prefix < mTotal && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < nTotal - prefix &&
    suffix < mTotal - prefix &&
    a[nTotal - 1 - suffix] === b[mTotal - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: MyersOp[] = [];
  if (prefix > 0) {
    ops.push({ kind: "equal", oldIndex: 0, newIndex: 0, len: prefix });
  }

  const n = nTotal - prefix - suffix;
  const m = mTotal - prefix - suffix;

  if (n === 0 && m > 0) {
    ops.push({ kind: "insert", newIndex: prefix, newLen: m });
  } else if (m === 0 && n > 0) {
    ops.push({ kind: "delete", oldIndex: prefix, oldLen: n });
  } else if (n > 0 && m > 0) {
    const middleOps = myersCore(a, prefix, n, b, prefix, m);
    for (const op of middleOps) ops.push(op);
  }

  if (suffix > 0) {
    const last = ops[ops.length - 1];
    if (last && last.kind === "equal") {
      ops[ops.length - 1] = {
        kind: "equal",
        oldIndex: last.oldIndex,
        newIndex: last.newIndex,
        len: last.len + suffix,
      };
    } else {
      ops.push({
        kind: "equal",
        oldIndex: nTotal - suffix,
        newIndex: mTotal - suffix,
        len: suffix,
      });
    }
  }

  return ops;
}

const MAX_TRACE_CELLS = 4_000_000;

function myersCore(
  a: BigUint64Array,
  aOff: number,
  n: number,
  b: BigUint64Array,
  bOff: number,
  m: number,
): MyersOp[] {
  const maxD = n + m;
  const width = 2 * maxD + 1;
  // Fall back to greedy anchor matching if O(D^2) trace would exceed budget.
  if (maxD > 2000 && maxD * width > MAX_TRACE_CELLS) {
    return fallbackAnchorDiff(a, aOff, n, b, bOff, m);
  }

  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let foundD = maxD;

  outer: for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + maxD;
      let x: number;
      if (k === -d || (k !== d && (v[kIdx - 1] as number) < (v[kIdx + 1] as number))) {
        x = v[kIdx + 1] as number;
      } else {
        x = (v[kIdx - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[aOff + x] === b[bOff + y]) {
        x++;
        y++;
      }
      v[kIdx] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break outer;
      }
    }
  }

  // Backtrack edit steps in reverse.
  const revSteps: RawEdit[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const prevV = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (
      k === -d ||
      (k !== d && (prevV[k - 1 + maxD] as number) < (prevV[k + 1 + maxD] as number))
    ) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prevV[prevK + maxD] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      revSteps.push("equal");
      x--;
      y--;
    }
    if (x > prevX) {
      revSteps.push("delete");
      x--;
    } else if (y > prevY) {
      revSteps.push("insert");
      y--;
    }
  }
  while (x > 0 && y > 0) {
    revSteps.push("equal");
    x--;
    y--;
  }

  return coalesceSteps(revSteps, aOff, bOff);
}

/**
 * Fallback for massive arrays with huge edit distances: index `a` hashes and pair
 * greedy strictly-increasing matches, preserving bounded memory.
 */
function fallbackAnchorDiff(
  a: BigUint64Array,
  aOff: number,
  n: number,
  b: BigUint64Array,
  bOff: number,
  m: number,
): MyersOp[] {
  const pos = new Map<bigint, number[]>();
  for (let i = n - 1; i >= 0; i--) {
    const h = a[aOff + i] as bigint;
    let list = pos.get(h);
    if (!list) {
      list = [];
      pos.set(h, list);
    }
    list.push(i);
  }
  const ops: MyersOp[] = [];
  let ai = 0;
  let bi = 0;
  while (bi < m) {
    const list = pos.get(b[bOff + bi] as bigint);
    let matchI = -1;
    if (list) {
      while (list.length > 0 && (list[list.length - 1] as number) < ai) list.pop();
      if (list.length > 0) matchI = list.pop() as number;
    }
    if (matchI >= 0) {
      if (matchI > ai) {
        ops.push({ kind: "delete", oldIndex: aOff + ai, oldLen: matchI - ai });
        ai = matchI;
      }
      let len = 1;
      while (ai + len < n && bi + len < m && a[aOff + ai + len] === b[bOff + bi + len]) len++;
      ops.push({ kind: "equal", oldIndex: aOff + ai, newIndex: bOff + bi, len });
      ai += len;
      bi += len;
    } else {
      const startB = bi;
      while (bi < m) {
        const cand = pos.get(b[bOff + bi] as bigint);
        if (cand && cand.length > 0 && (cand[cand.length - 1] as number) >= ai) break;
        bi++;
      }
      ops.push({ kind: "insert", newIndex: bOff + startB, newLen: bi - startB });
    }
  }
  if (ai < n) {
    ops.push({ kind: "delete", oldIndex: aOff + ai, oldLen: n - ai });
  }
  return mergeAdjacentDeleteInsert(ops);
}

function coalesceSteps(revSteps: RawEdit[], aOff: number, bOff: number): MyersOp[] {
  const ops: MyersOp[] = [];
  let ai = aOff;
  let bi = bOff;
  let idx = revSteps.length - 1;
  while (idx >= 0) {
    const step = revSteps[idx] as RawEdit;
    if (step === "equal") {
      let len = 0;
      while (idx >= 0 && revSteps[idx] === "equal") {
        len++;
        idx--;
      }
      ops.push({ kind: "equal", oldIndex: ai, newIndex: bi, len });
      ai += len;
      bi += len;
      continue;
    }
    let delLen = 0;
    let insLen = 0;
    while (idx >= 0 && revSteps[idx] !== "equal") {
      if (revSteps[idx] === "delete") delLen++;
      else insLen++;
      idx--;
    }
    if (delLen > 0 && insLen > 0) {
      ops.push({ kind: "replace", oldIndex: ai, oldLen: delLen, newIndex: bi, newLen: insLen });
    } else if (delLen > 0) {
      ops.push({ kind: "delete", oldIndex: ai, oldLen: delLen });
    } else if (insLen > 0) {
      ops.push({ kind: "insert", newIndex: bi, newLen: insLen });
    }
    ai += delLen;
    bi += insLen;
  }
  return ops;
}

function mergeAdjacentDeleteInsert(raw: MyersOp[]): MyersOp[] {
  const out: MyersOp[] = [];
  for (const op of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "delete" && op.kind === "insert") {
      out[out.length - 1] = {
        kind: "replace",
        oldIndex: prev.oldIndex,
        oldLen: prev.oldLen,
        newIndex: op.newIndex,
        newLen: op.newLen,
      };
    } else if (prev && prev.kind === "insert" && op.kind === "delete") {
      out[out.length - 1] = {
        kind: "replace",
        oldIndex: op.oldIndex,
        oldLen: op.oldLen,
        newIndex: prev.newIndex,
        newLen: prev.newLen,
      };
    } else {
      out.push(op);
    }
  }
  return out;
}
