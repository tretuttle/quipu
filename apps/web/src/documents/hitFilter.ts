import type { DeepHitAnnotation } from "@quipu/contracts/deepSearch";
import type { ByteRange } from "@quipu/contracts/engine";
import { create } from "zustand";

/**
 * Computes the ancestor closure of `matchedIds` by walking `parentOf(id)` up
 * to the root. Every matched node and every ancestor leading to one is kept.
 */
export const computeAncestorClosure = (
  matchedIds: Iterable<string>,
  parentOf: (id: string) => string | null | undefined,
): Set<string> => {
  const kept = new Set<string>();
  for (const rawId of matchedIds) {
    let current: string | null | undefined = rawId;
    while (current !== null && current !== undefined && !kept.has(current)) {
      kept.add(current);
      current = parentOf(current);
    }
  }
  return kept;
};

/**
 * Reusable hit-filter helper for TableView (Lane E) and other flat-row views:
 * given per-row byte ranges and sorted non-overlapping `hitRanges`, returns the
 * 0-based indices of rows whose range overlaps at least one hit.
 */
export const filterRowIndicesByHits = (
  rowRanges: ReadonlyArray<ByteRange | null>,
  hitRanges: ReadonlyArray<ByteRange>,
): number[] => {
  if (hitRanges.length === 0 || rowRanges.length === 0) return [];
  const indices: number[] = [];
  for (let i = 0; i < rowRanges.length; i++) {
    const row = rowRanges[i];
    if (row === null || row === undefined || row.end <= row.start) continue;
    let lo = 0;
    let hi = hitRanges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((hitRanges[mid]!.end as number) <= row.start) lo = mid + 1;
      else hi = mid;
    }
    const hit = hitRanges[lo];
    if (hit !== undefined && hit.start < row.end && hit.end > row.start) {
      indices.push(i);
    }
  }
  return indices;
};

/** Filters an arbitrary list of items to those whose identifier sits in `keptIds`. */
export const filterIdsByHits = <T>(
  items: ReadonlyArray<T>,
  idOf: (item: T) => string,
  keptIds: ReadonlySet<string>,
): T[] => items.filter((item) => keptIds.has(idOf(item)));

interface MatchFilterState {
  readonly enabled: boolean;
  readonly matchedIds: ReadonlySet<string>;
  readonly hitRanges: ReadonlyArray<ByteRange>;
  readonly setEnabled: (enabled: boolean) => void;
  readonly toggle: () => void;
  readonly setMatchedIds: (matchedIds: ReadonlySet<string>) => void;
  readonly setHitRanges: (hitRanges: ReadonlyArray<ByteRange>) => void;
  readonly clear: () => void;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_RANGES: ReadonlyArray<ByteRange> = [];

export const useMatchFilterStore = create<MatchFilterState>((set) => ({
  enabled: false,
  matchedIds: EMPTY_IDS,
  hitRanges: EMPTY_RANGES,
  setEnabled: (enabled) => set({ enabled }),
  toggle: () => set((state) => ({ enabled: !state.enabled })),
  setMatchedIds: (matchedIds) => set({ matchedIds }),
  setHitRanges: (hitRanges) => set({ hitRanges }),
  clear: () => set({ enabled: false, matchedIds: EMPTY_IDS, hitRanges: EMPTY_RANGES }),
}));

interface DeepHitState {
  readonly searchId: number | null;
  readonly annotations: ReadonlyArray<DeepHitAnnotation>;
  readonly setAnnotations: (
    searchId: number | null,
    annotations: ReadonlyArray<DeepHitAnnotation>,
  ) => void;
  readonly annotationForRange: (range: ByteRange) => DeepHitAnnotation | null;
  readonly clear: () => void;
}

export const useDeepHitStore = create<DeepHitState>((set, get) => ({
  searchId: null,
  annotations: [],
  setAnnotations: (searchId, annotations) => set({ searchId, annotations }),
  annotationForRange: (range) => {
    const list = get().annotations;
    for (const ann of list) {
      if (ann.range.start === range.start && ann.range.end === range.end) return ann;
      if (ann.range.start <= range.start && ann.range.end >= range.end) return ann;
    }
    return null;
  },
  clear: () => set({ searchId: null, annotations: [] }),
}));
