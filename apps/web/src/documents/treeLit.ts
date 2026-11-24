import type { ByteRange } from "@quipu/contracts/engine";
import { useEffect, useSyncExternalStore } from "react";

import type { HitSet } from "./searchStore.ts";
import { nodeBytes } from "./selectionStore.ts";
import type { ViewRow } from "./treeModel.ts";

/**
 * The bytes a tree row shows: a scalar's member (key and value), or just the key
 * of a container, which is the part of it on the row. Chunk and pending rows
 * show nothing of the file.
 */
function rowRange(row: ViewRow): ByteRange | null {
  const node = row.node;
  if (row.kind !== "node" || node === null) return null;
  const bytes = nodeBytes(node);
  const container = node.kind === "object" || node.kind === "array";
  // A container's row shows its key: the bytes up to where its value starts.
  const end = container ? node.span.start : bytes.end;
  const start = bytes.start;
  return end > start ? { start, end } : null;
}

/**
 * The part of a container's value the engine can answer about without a scan:
 * the bytes up to where its kept hits end. A hit there means the row is on the
 * way to one, so it stays readable while unrelated rows dim.
 */
function insideRange(row: ViewRow, retainedUntil: number): ByteRange | null {
  const node = row.node;
  if (row.kind !== "node" || node === null) return null;
  if (node.kind !== "object" && node.kind !== "array") return null;
  const start = node.span.start;
  const end = Math.min(node.span.end, retainedUntil);
  return end > start ? { start, end } : null;
}

interface LitSnapshot {
  readonly searchId: number;
  readonly lit: ReadonlySet<string>;
  readonly asked: ReadonlySet<string>;
}

const EMPTY: LitSnapshot = { searchId: -1, lit: new Set(), asked: new Set() };

/**
 * Which rows hold a hit, asked of the engine in batches: each row on screen
 * registers its range, and one request per tick answers them all. Readers get
 * immutable snapshots, so a component reading one re-renders when it changes.
 */
class LitCache {
  private snapshot: LitSnapshot = EMPTY;
  private readonly queued = new Map<string, ByteRange>();
  private readonly listeners = new Set<() => void>();
  private scheduled = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private publish(next: LitSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  request(hitSet: HitSet, rowId: string, range: ByteRange) {
    if (this.snapshot.searchId !== hitSet.searchId) {
      this.queued.clear();
      this.snapshot = { searchId: hitSet.searchId, lit: new Set(), asked: new Set() };
    }
    if (this.snapshot.asked.has(rowId) || this.queued.has(rowId)) return;
    this.queued.set(rowId, range);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const batch = [...this.queued];
      this.queued.clear();
      const searchId = hitSet.searchId;
      if (batch.length === 0 || this.snapshot.searchId !== searchId) return;
      void hitSet
        .isLit(batch.map(([, rowRange]) => rowRange))
        .then((answers) => {
          const current = this.snapshot;
          if (current.searchId !== searchId) return;
          const lit = new Set(current.lit);
          const asked = new Set(current.asked);
          batch.forEach(([id], index) => {
            asked.add(id);
            if (answers[index] === true) lit.add(id);
          });
          this.publish({ searchId, lit, asked });
        })
        .catch(() => {
          // The rows stay dimmed; the next search asks again.
        });
    });
  }
}

const cache = new LitCache();

export interface RowLit {
  /** The row's own text holds a hit. */
  readonly lit: boolean;
  /** A hit sits inside the container the row opens: the row is on the way to it. */
  readonly inside: boolean;
}

const insideId = (rowId: string) => `${rowId}\u0000inside`;

/** Whether `row` holds a hit of `hitSet`, or leads to one; false while the engine has not answered. */
export function useRowLit(hitSet: HitSet | null, row: ViewRow): RowLit {
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const range = rowRange(row);
  const start = range?.start;
  const end = range?.end;
  const inside = hitSet === null ? null : insideRange(row, hitSet.retainedUntil);
  const insideStart = inside?.start;
  const insideEnd = inside?.end;
  useEffect(() => {
    if (hitSet === null) return;
    if (start !== undefined && end !== undefined) cache.request(hitSet, row.id, { start, end });
    if (insideStart !== undefined && insideEnd !== undefined) {
      cache.request(hitSet, insideId(row.id), { start: insideStart, end: insideEnd });
    }
  }, [hitSet, row.id, start, end, insideStart, insideEnd]);
  if (hitSet === null || snapshot.searchId !== hitSet.searchId) {
    return { lit: false, inside: false };
  }
  return {
    lit: range !== null && snapshot.lit.has(row.id),
    inside: inside !== null && snapshot.lit.has(insideId(row.id)),
  };
}
