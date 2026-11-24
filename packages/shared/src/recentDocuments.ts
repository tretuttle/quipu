import { MAX_RECENT_DOCUMENTS } from "@quipu/contracts";

/**
 * The recent list after `entry` was opened: it moves to
 * the front, one row per file by id, and only the newest
 * {@link MAX_RECENT_DOCUMENTS} stay. `evicted` are the rows that fell off, so the
 * web store can drop the handles that only they held.
 */
export function pushRecentDocument<
  T extends { readonly id: string; readonly lastOpenedAt: number },
>(
  list: ReadonlyArray<T>,
  entry: T,
): { readonly list: ReadonlyArray<T>; readonly evicted: ReadonlyArray<T> } {
  const sorted = [entry, ...list.filter((existing) => existing.id !== entry.id)].toSorted(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt,
  );
  return {
    list: sorted.slice(0, MAX_RECENT_DOCUMENTS),
    evicted: sorted.slice(MAX_RECENT_DOCUMENTS),
  };
}
