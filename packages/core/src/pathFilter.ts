import { CHILDREN_PAGE_LIMIT, type NodeKind, type NodeRef } from "@quipu/contracts/engine";

import type {
  FilterCmpOp,
  FilterExpr,
  FilterLiteral,
  FilterOperand,
  FilterPath,
  PathExpression,
  Selector,
} from "./pathParse.ts";

const PATH_FILTER_DEFAULT_MAX_SET = 1_000_000;
const FILTER_CANDIDATE_BATCH = 16;

export interface PathNodeInfo {
  readonly ref: NodeRef;
  readonly kind: NodeKind;
  readonly childCount: number;
  readonly key: string | null;
}

export interface PathFilterHost {
  readonly rootRef: NodeRef;
  nodeInfo(ref: NodeRef): Promise<PathNodeInfo>;
  listChildren(
    ref: NodeRef,
    from: number,
    count: number,
    includeKeys: boolean,
  ): Promise<ReadonlyArray<PathNodeInfo>>;
  member(ref: NodeRef, name: string): Promise<PathNodeInfo | null>;
  readScalar(ref: NodeRef): Promise<FilterLiteral | null>;
}

type EvalVal =
  | { readonly kind: "literal"; readonly literal: FilterLiteral }
  | { readonly kind: "node"; readonly ref: NodeRef }
  | { readonly kind: "nothing" };

type AbsoluteCache = Map<FilterPath, Promise<ReadonlyArray<NodeRef>>>;

function isContainerKind(kind: NodeKind): boolean {
  return kind === "object" || kind === "array";
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len;) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

function compareLiterals(a: FilterLiteral, b: FilterLiteral): number | null {
  if (a.kind !== b.kind) return null;
  switch (a.kind) {
    case "null":
      return 0;
    case "boolean":
      return a.value === (b as Extract<FilterLiteral, { kind: "boolean" }>).value ? 0 : null;
    case "number": {
      const nb = (b as Extract<FilterLiteral, { kind: "number" }>).value;
      if (Number.isNaN(a.value) || Number.isNaN(nb)) return null;
      return a.value < nb ? -1 : a.value > nb ? 1 : 0;
    }
    case "string":
      return compareStrings(a.value, (b as Extract<FilterLiteral, { kind: "string" }>).value);
  }
}

async function equalNodes(
  host: PathFilterHost,
  aRef: NodeRef,
  aInfo: PathNodeInfo,
  bRef: NodeRef,
  bInfo: PathNodeInfo,
): Promise<boolean> {
  if (aInfo.kind !== bInfo.kind) return false;
  if (aInfo.kind === "object") {
    if (aInfo.childCount !== bInfo.childCount) return false;
    for (let from = 0; from < aInfo.childCount; from += CHILDREN_PAGE_LIMIT) {
      const page = await host.listChildren(
        aRef,
        from,
        Math.min(CHILDREN_PAGE_LIMIT, aInfo.childCount - from),
        true,
      );
      for (const child of page) {
        if (child.key === null) return false;
        const other = await host.member(bRef, child.key);
        if (other === null) return false;
        if (!(await equalNodes(host, child.ref, child, other.ref, other))) return false;
      }
    }
    return true;
  }
  if (aInfo.kind === "array") {
    if (aInfo.childCount !== bInfo.childCount) return false;
    for (let from = 0; from < aInfo.childCount; from += CHILDREN_PAGE_LIMIT) {
      const count = Math.min(CHILDREN_PAGE_LIMIT, aInfo.childCount - from);
      const [pageA, pageB] = await Promise.all([
        host.listChildren(aRef, from, count, false),
        host.listChildren(bRef, from, count, false),
      ]);
      if (pageA.length !== pageB.length) return false;
      for (let i = 0; i < pageA.length; i++) {
        const ca = pageA[i] as PathNodeInfo;
        const cb = pageB[i] as PathNodeInfo;
        if (!(await equalNodes(host, ca.ref, ca, cb.ref, cb))) return false;
      }
    }
    return true;
  }
  const [litA, litB] = await Promise.all([host.readScalar(aRef), host.readScalar(bRef)]);
  if (litA === null || litB === null) return false;
  return compareLiterals(litA, litB) === 0;
}

function isOrderedKind(val: EvalVal, info: PathNodeInfo | null): boolean {
  if (val.kind === "literal") {
    return val.literal.kind === "number" || val.literal.kind === "string";
  }
  if (val.kind === "node" && info !== null) {
    return info.kind === "number" || info.kind === "string";
  }
  return false;
}

async function compareValues(
  host: PathFilterHost,
  a: EvalVal,
  op: FilterCmpOp,
  b: EvalVal,
): Promise<boolean> {
  if (a.kind === "nothing" && b.kind === "nothing") {
    return op === "==";
  }
  if (a.kind === "nothing" || b.kind === "nothing") {
    return op === "!=";
  }

  let infoA: PathNodeInfo | null = null;
  let infoB: PathNodeInfo | null = null;
  if (a.kind === "node") infoA = await host.nodeInfo(a.ref);
  if (b.kind === "node") infoB = await host.nodeInfo(b.ref);

  let ord: number | null = null;
  if (
    a.kind === "node" &&
    b.kind === "node" &&
    infoA !== null &&
    infoB !== null &&
    (isContainerKind(infoA.kind) || isContainerKind(infoB.kind))
  ) {
    if (infoA.kind === infoB.kind && (await equalNodes(host, a.ref, infoA, b.ref, infoB))) {
      ord = 0;
    }
  } else {
    const litA = a.kind === "literal" ? a.literal : await host.readScalar(a.ref);
    const litB = b.kind === "literal" ? b.literal : await host.readScalar(b.ref);
    if (litA !== null && litB !== null) ord = compareLiterals(litA, litB);
  }

  if (op === "==") return ord === 0;
  if (op === "!=") return ord !== 0;

  if (!isOrderedKind(a, infoA) || !isOrderedKind(b, infoB) || ord === null) {
    return false;
  }
  switch (op) {
    case "<":
      return ord < 0;
    case "<=":
      return ord <= 0;
    case ">":
      return ord > 0;
    case ">=":
      return ord >= 0;
  }
}

function resolveFilterPath(
  host: PathFilterHost,
  path: FilterPath,
  currentRef: NodeRef,
  absCache: AbsoluteCache,
): Promise<ReadonlyArray<NodeRef>> {
  if (!path.absolute) {
    return evalPathExpression(host, currentRef, path.segments, { complete: true });
  }
  let cached = absCache.get(path);
  if (cached === undefined) {
    cached = evalPathExpression(host, host.rootRef, path.segments, { complete: true });
    absCache.set(path, cached);
  }
  return cached;
}

async function resolveOperand(
  host: PathFilterHost,
  operand: FilterOperand,
  currentRef: NodeRef,
  absCache: AbsoluteCache,
): Promise<EvalVal> {
  if (operand.kind === "literal") {
    return { kind: "literal", literal: operand.literal };
  }
  const nodes = await resolveFilterPath(host, operand.path, currentRef, absCache);
  if (nodes.length === 1) return { kind: "node", ref: nodes[0] as NodeRef };
  return { kind: "nothing" };
}

async function evalFilterExpr(
  host: PathFilterHost,
  expr: FilterExpr,
  currentRef: NodeRef,
  absCache: AbsoluteCache,
): Promise<boolean> {
  switch (expr.kind) {
    case "or":
      return (
        (await evalFilterExpr(host, expr.left, currentRef, absCache)) ||
        (await evalFilterExpr(host, expr.right, currentRef, absCache))
      );
    case "and":
      return (
        (await evalFilterExpr(host, expr.left, currentRef, absCache)) &&
        (await evalFilterExpr(host, expr.right, currentRef, absCache))
      );
    case "not":
      return !(await evalFilterExpr(host, expr.expr, currentRef, absCache));
    case "exists":
      return (await resolveFilterPath(host, expr.path, currentRef, absCache)).length > 0;
    case "compare": {
      const [a, b] = await Promise.all([
        resolveOperand(host, expr.left, currentRef, absCache),
        resolveOperand(host, expr.right, currentRef, absCache),
      ]);
      return compareValues(host, a, expr.op, b);
    }
  }
}

function sliceIndices(
  startOpt: number | null,
  endOpt: number | null,
  stepOpt: number | null,
  count: number,
): number[] {
  const step = stepOpt ?? 1;
  if (step === 0) return [];
  const norm = (value: number) => (value >= 0 ? value : count + value);
  const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
  const out: number[] = [];
  if (step > 0) {
    const lo = clamp(startOpt === null ? 0 : norm(startOpt), 0, count);
    const hi = clamp(endOpt === null ? count : norm(endOpt), 0, count);
    for (let i = lo; i < hi; i += step) out.push(i);
    return out;
  }
  const hi = clamp(startOpt === null ? count - 1 : norm(startOpt), -1, count - 1);
  const lo = clamp(endOpt === null ? -count - 1 : norm(endOpt), -1, count - 1);
  for (let i = hi; i > lo; i += step) out.push(i);
  return out;
}

async function listRange(
  host: PathFilterHost,
  ref: NodeRef,
  from: number,
  to: number,
  out: NodeRef[],
  state: { complete: boolean },
  maxSet: number,
): Promise<void> {
  for (let at = from; at < to;) {
    if (out.length >= maxSet) {
      state.complete = false;
      return;
    }
    const page = await host.listChildren(
      ref,
      at,
      Math.min(CHILDREN_PAGE_LIMIT, to - at, maxSet - out.length),
      false,
    );
    if (page.length === 0) return;
    for (const item of page) out.push(item.ref);
    at += page.length;
  }
}

async function descendantsOrSelf(
  host: PathFilterHost,
  nodes: ReadonlyArray<NodeRef>,
  state: { complete: boolean },
  maxSet: number,
): Promise<NodeRef[]> {
  const out: NodeRef[] = [];
  const stack = nodes.toReversed();
  while (stack.length > 0) {
    if (out.length >= maxSet) {
      state.complete = false;
      break;
    }
    const ref = stack.pop() as NodeRef;
    out.push(ref);
    const info = await host.nodeInfo(ref);
    if (!isContainerKind(info.kind) || info.childCount === 0) continue;
    const kids: NodeRef[] = [];
    await listRange(host, ref, 0, info.childCount, kids, state, maxSet);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as NodeRef);
  }
  return out;
}

async function applySelector(
  host: PathFilterHost,
  ref: NodeRef,
  selector: Selector,
  out: NodeRef[],
  state: { complete: boolean },
  maxSet: number,
): Promise<void> {
  if (selector.kind === "filter") {
    await evalFilterSelector(host, ref, selector.expr, out, state, maxSet);
    return;
  }
  const info = await host.nodeInfo(ref);
  if (!isContainerKind(info.kind)) return;
  switch (selector.kind) {
    case "name": {
      if (info.kind !== "object") return;
      const found = await host.member(ref, selector.name);
      if (found !== null) {
        if (out.length >= maxSet) state.complete = false;
        else out.push(found.ref);
      }
      return;
    }
    case "wildcard":
      await listRange(host, ref, 0, info.childCount, out, state, maxSet);
      return;
    case "index": {
      if (info.kind !== "array") return;
      const idx = selector.index < 0 ? info.childCount + selector.index : selector.index;
      if (idx >= 0 && idx < info.childCount) {
        await listRange(host, ref, idx, idx + 1, out, state, maxSet);
      }
      return;
    }
    case "slice": {
      if (info.kind !== "array") return;
      const indices = sliceIndices(selector.start, selector.end, selector.step, info.childCount);
      if (indices.length === 0) return;
      if ((selector.step ?? 1) === 1) {
        const lo = indices[0] as number;
        const hi = (indices[indices.length - 1] as number) + 1;
        await listRange(host, ref, lo, hi, out, state, maxSet);
        return;
      }
      for (const idx of indices) {
        if (out.length >= maxSet) {
          state.complete = false;
          return;
        }
        await listRange(host, ref, idx, idx + 1, out, state, maxSet);
      }
    }
  }
}

/**
 * Evaluates a `[?(expr)]` filter selector against the direct children of `containerRef`
 * using bounded reads and logical-read paths (zero full-doc parse, respects edits).
 */
export async function evalFilterSelector(
  host: PathFilterHost,
  containerRef: NodeRef,
  expr: FilterExpr,
  out: NodeRef[],
  state: { complete: boolean },
  maxSet = PATH_FILTER_DEFAULT_MAX_SET,
): Promise<void> {
  const info = await host.nodeInfo(containerRef);
  if (!isContainerKind(info.kind) || info.childCount === 0) return;

  const absCache: AbsoluteCache = new Map();
  for (let from = 0; from < info.childCount; from += CHILDREN_PAGE_LIMIT) {
    if (out.length >= maxSet) {
      state.complete = false;
      return;
    }
    const page = await host.listChildren(
      containerRef,
      from,
      Math.min(CHILDREN_PAGE_LIMIT, info.childCount - from),
      false,
    );
    if (page.length === 0) break;
    for (let i = 0; i < page.length; i += FILTER_CANDIDATE_BATCH) {
      if (out.length >= maxSet) {
        state.complete = false;
        return;
      }
      const batch = page.slice(i, i + FILTER_CANDIDATE_BATCH);
      const matches = await Promise.all(
        batch.map((child) => evalFilterExpr(host, expr, child.ref, absCache)),
      );
      for (let k = 0; k < batch.length; k++) {
        if (!matches[k]) continue;
        if (out.length >= maxSet) {
          state.complete = false;
          return;
        }
        out.push((batch[k] as PathNodeInfo).ref);
      }
    }
  }
}

/** Evaluates a parsed JSONPath expression starting at `startRef` via `PathFilterHost`. */
export async function evalPathExpression(
  host: PathFilterHost,
  startRef: NodeRef,
  segments: PathExpression,
  state: { complete: boolean },
  maxSet = PATH_FILTER_DEFAULT_MAX_SET,
): Promise<NodeRef[]> {
  let current: NodeRef[] = [startRef];
  for (const segment of segments) {
    const inputs = segment.descendant
      ? await descendantsOrSelf(host, current, state, maxSet)
      : current;
    const next: NodeRef[] = [];
    for (const ref of inputs) {
      for (const selector of segment.selectors) {
        if (next.length >= maxSet) {
          state.complete = false;
          return next;
        }
        await applySelector(host, ref, selector, next, state, maxSet);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}
