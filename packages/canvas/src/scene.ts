/**
 * The scene: every element by id, in z-order, with its spatial index and the
 * reverse map of bindings. Elements are immutable records; a change replaces
 * the record and bumps `version`. Deleting tombstones (`isDeleted`), it never
 * splices, so history entries and bindings keep resolving.
 */
import { compareIndexKeys, keyBetween } from "./fractionalIndex.ts";
import { unionBoxes, type Box } from "./geometry.ts";
import { elementBounds } from "./hitTest.ts";
import { refreshBoundPoints } from "./bindings.ts";
import { createSpatialIndex, type SpatialIndex } from "./spatialIndex.ts";
import { isLinearElement, type Element, type ElementId } from "./elements.ts";

export interface SceneSnapshot {
  /** Live elements in z-order, bottom first. */
  readonly elements: ReadonlyArray<Element>;
  /** Every record, tombstones included, for persistence. */
  readonly allElements: ReadonlyArray<Element>;
}

export interface Scene {
  readonly get: (id: ElementId) => Element | null;
  /** Live (non-deleted) elements in z-order. Cached until the next change. */
  readonly live: () => ReadonlyArray<Element>;
  /** Every record including tombstones, in z-order. */
  readonly all: () => ReadonlyArray<Element>;
  /** Inserts or replaces a record. Returns the previous record, or null. */
  readonly put: (element: Element) => Element | null;
  /** Forgets a record entirely (undoing a creation); deletion otherwise tombstones. */
  readonly remove: (id: ElementId) => void;
  /** The ids whose bounds intersect `box`, live only. */
  readonly search: (box: Box) => ElementId[];
  /** Live arrows and lines bound to `targetId`. */
  readonly boundTo: (targetId: ElementId) => ElementId[];
  /** The next z-order key above every element. */
  readonly topIndex: () => string;
  /** Bounds of every live element, or null when the scene is empty. */
  readonly bounds: () => Box | null;
  readonly index: SpatialIndex;
}

export function createScene(initial: ReadonlyArray<Element> = []): Scene {
  const byId = new Map<ElementId, Element>();
  const index = createSpatialIndex();
  const bindingsByTarget = new Map<ElementId, Set<ElementId>>();
  let sorted: Element[] | null = null;
  let liveCache: Element[] | null = null;

  const unlinkBindings = (element: Element) => {
    if (!isLinearElement(element)) return;
    for (const binding of [element.startBinding, element.endBinding]) {
      if (!binding) continue;
      const set = bindingsByTarget.get(binding.targetId);
      set?.delete(element.id);
      if (set && set.size === 0) bindingsByTarget.delete(binding.targetId);
    }
  };
  const linkBindings = (element: Element) => {
    if (!isLinearElement(element) || element.isDeleted) return;
    for (const binding of [element.startBinding, element.endBinding]) {
      if (!binding) continue;
      let set = bindingsByTarget.get(binding.targetId);
      if (!set) {
        set = new Set();
        bindingsByTarget.set(binding.targetId, set);
      }
      set.add(element.id);
    }
  };

  const put = (element: Element): Element | null => {
    const previous = byId.get(element.id) ?? null;
    if (previous) unlinkBindings(previous);
    byId.set(element.id, element);
    linkBindings(element);
    if (element.isDeleted) index.remove(element.id);
    else index.upsert(element.id, elementBounds(element));
    sorted = null;
    liveCache = null;
    return previous;
  };

  const remove = (id: ElementId) => {
    const existing = byId.get(id);
    if (!existing) return;
    unlinkBindings(existing);
    byId.delete(id);
    index.remove(id);
    sorted = null;
    liveCache = null;
  };

  for (const element of initial) put(element);

  const all = (): ReadonlyArray<Element> => {
    if (sorted === null) {
      sorted = [...byId.values()].sort((a, b) => compareIndexKeys(a.index, b.index));
    }
    return sorted;
  };

  return {
    index,
    get: (id) => byId.get(id) ?? null,
    all,
    live: () => {
      if (liveCache === null) liveCache = all().filter((element) => !element.isDeleted);
      return liveCache;
    },
    put,
    remove,
    search: (box) => index.search(box),
    boundTo: (targetId) => [...(bindingsByTarget.get(targetId) ?? [])],
    topIndex: () => {
      const elements = all();
      const last = elements[elements.length - 1];
      return keyBetween(last ? last.index : null, null);
    },
    bounds: () => {
      const live = all().filter((element) => !element.isDeleted);
      return unionBoxes(live.map(elementBounds));
    },
  };
}

/**
 * Recomputes every arrow bound to any of `targetIds` and returns the changed
 * records (not yet put). Also refreshes `targetIds` themselves when they are
 * arrows, so a moved arrow with bound ends snaps back onto its targets.
 */
export function refreshBindingsFor(
  scene: Scene,
  targetIds: Iterable<ElementId>,
  /** Resolves a binding target that is not a scene element (a map node). */
  external: (id: ElementId) => Element | null = () => null,
): Element[] {
  const toRefresh = new Set<ElementId>();
  for (const id of targetIds) {
    const element = scene.get(id);
    if (element && isLinearElement(element)) toRefresh.add(id);
    for (const arrowId of scene.boundTo(id)) toRefresh.add(arrowId);
  }
  const changed: Element[] = [];
  for (const id of toRefresh) {
    const arrow = scene.get(id);
    if (!arrow || arrow.isDeleted || !isLinearElement(arrow)) continue;
    const refreshed = refreshBoundPoints(arrow, (targetId) => {
      const target = scene.get(targetId);
      if (target) return target.isDeleted ? null : target;
      return external(targetId);
    });
    if (refreshed !== arrow) changed.push({ ...refreshed, version: arrow.version + 1 });
  }
  return changed;
}
