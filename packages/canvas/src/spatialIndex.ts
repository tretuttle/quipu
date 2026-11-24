/**
 * An R-tree over element bounds (rbush, MIT), updated on move, resize and
 * delete so a pointer hit test and a visible-set query stay O(log n).
 */
import RBush from "rbush";

import { type Box } from "./geometry.ts";

interface IndexItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  readonly id: string;
}

export interface SpatialIndex {
  /** Inserts or replaces the box for `id`. */
  readonly upsert: (id: string, box: Box) => void;
  /** Replaces the whole index with `boxes` in one packed load (a committed layout). */
  readonly load: (boxes: Iterable<readonly [string, Box]>) => void;
  readonly remove: (id: string) => void;
  readonly has: (id: string) => boolean;
  /** Ids whose box intersects `box`, in no particular order. */
  readonly search: (box: Box) => string[];
  readonly clear: () => void;
  readonly size: () => number;
}

export function createSpatialIndex(): SpatialIndex {
  const tree = new RBush<IndexItem>();
  const items = new Map<string, IndexItem>();
  return {
    upsert(id, box) {
      const existing = items.get(id);
      if (existing) tree.remove(existing);
      const item: IndexItem = {
        minX: box.x,
        minY: box.y,
        maxX: box.x + box.width,
        maxY: box.y + box.height,
        id,
      };
      items.set(id, item);
      tree.insert(item);
    },
    load(boxes) {
      tree.clear();
      items.clear();
      const bulk: IndexItem[] = [];
      for (const [id, box] of boxes) {
        const item: IndexItem = {
          minX: box.x,
          minY: box.y,
          maxX: box.x + box.width,
          maxY: box.y + box.height,
          id,
        };
        items.set(id, item);
        bulk.push(item);
      }
      tree.load(bulk);
    },
    remove(id) {
      const existing = items.get(id);
      if (!existing) return;
      tree.remove(existing);
      items.delete(id);
    },
    has: (id) => items.has(id),
    search(box) {
      return tree
        .search({ minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height })
        .map((item) => item.id);
    },
    clear() {
      tree.clear();
      items.clear();
    },
    size: () => items.size,
  };
}
