/**
 * Pure arrangement over element records: align, distribute, group and
 * ungroup, duplicate. Each returns the records to put; the editor commits
 * them as one history entry and refreshes bindings afterwards.
 */
import { keysBetween } from "./fractionalIndex.ts";
import { unionBoxes, type Box } from "./geometry.ts";
import { elementBounds } from "./hitTest.ts";
import { isLinearElement, type Element, type ElementId } from "./elements.ts";
import type { Rng } from "./random.ts";

export type AlignEdge = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

/**
 * Splits elements into the maximal groups they belong to: every element of a
 * group moves together, ungrouped elements stand alone. Returns the clusters.
 */
export function maximumGroups(elements: ReadonlyArray<Element>): Element[][] {
  const byGroup = new Map<string, Element[]>();
  const singles: Element[][] = [];
  for (const element of elements) {
    const outermost = element.groupIds[element.groupIds.length - 1];
    if (outermost === undefined) {
      singles.push([element]);
      continue;
    }
    const bucket = byGroup.get(outermost);
    if (bucket) bucket.push(element);
    else byGroup.set(outermost, [element]);
  }
  return [...byGroup.values(), ...singles];
}

function clusterBounds(cluster: ReadonlyArray<Element>): Box {
  return unionBoxes(cluster.map(elementBounds)) ?? { x: 0, y: 0, width: 0, height: 0 };
}

function moved(element: Element, dx: number, dy: number): Element {
  if (dx === 0 && dy === 0) return element;
  return { ...element, x: element.x + dx, y: element.y + dy, version: element.version + 1 };
}

export function alignElements(elements: ReadonlyArray<Element>, edge: AlignEdge): Element[] {
  const clusters = maximumGroups(elements);
  if (clusters.length < 2) return [];
  const bounds = clusterBounds(elements);
  const changed: Element[] = [];
  for (const cluster of clusters) {
    const box = clusterBounds(cluster);
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = bounds.x - box.x;
        break;
      case "centerX":
        dx = bounds.x + bounds.width / 2 - (box.x + box.width / 2);
        break;
      case "right":
        dx = bounds.x + bounds.width - (box.x + box.width);
        break;
      case "top":
        dy = bounds.y - box.y;
        break;
      case "centerY":
        dy = bounds.y + bounds.height / 2 - (box.y + box.height / 2);
        break;
      case "bottom":
        dy = bounds.y + bounds.height - (box.y + box.height);
        break;
    }
    if (dx === 0 && dy === 0) continue;
    for (const element of cluster) changed.push(moved(element, dx, dy));
  }
  return changed;
}

/**
 * Spreads clusters evenly: equal gaps between them when they fit, otherwise
 * equal spacing of their centers with the two outer clusters left in place.
 */
export function distributeElements(
  elements: ReadonlyArray<Element>,
  axis: DistributeAxis,
): Element[] {
  const clusters = maximumGroups(elements);
  if (clusters.length < 3) return [];
  const start = (b: Box) => (axis === "horizontal" ? b.x : b.y);
  const size = (b: Box) => (axis === "horizontal" ? b.width : b.height);
  const items = clusters
    .map((cluster) => ({ cluster, box: clusterBounds(cluster) }))
    .sort((a, b) => start(a.box) + size(a.box) / 2 - (start(b.box) + size(b.box) / 2));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return [];
  const extent = start(last.box) + size(last.box) - start(first.box);
  const span = items.reduce((sum, item) => sum + size(item.box), 0);
  const step = (extent - span) / (items.length - 1);
  const changed: Element[] = [];
  if (step >= 0) {
    let cursor = start(first.box);
    for (const item of items) {
      const delta = cursor - start(item.box);
      if (delta !== 0) {
        for (const element of item.cluster) {
          changed.push(axis === "horizontal" ? moved(element, delta, 0) : moved(element, 0, delta));
        }
      }
      cursor += size(item.box) + step;
    }
    return changed;
  }
  // Overlapping: spread the centers between the outer two.
  const firstCenter = start(first.box) + size(first.box) / 2;
  const lastCenter = start(last.box) + size(last.box) / 2;
  const centerStep = (lastCenter - firstCenter) / (items.length - 1);
  items.forEach((item, i) => {
    if (i === 0 || i === items.length - 1) return;
    const target = firstCenter + centerStep * i;
    const delta = target - (start(item.box) + size(item.box) / 2);
    if (delta === 0) return;
    for (const element of item.cluster) {
      changed.push(axis === "horizontal" ? moved(element, delta, 0) : moved(element, 0, delta));
    }
  });
  return changed;
}

/** Puts every element in one new group (nested outside any group they share). */
export function groupElements(elements: ReadonlyArray<Element>, groupId: string): Element[] {
  if (elements.length < 2) return [];
  return elements.map((element) => ({
    ...element,
    groupIds: [...element.groupIds, groupId],
    version: element.version + 1,
  }));
}

/** Removes the outermost group from every element that has one. */
export function ungroupElements(elements: ReadonlyArray<Element>): Element[] {
  return elements
    .filter((element) => element.groupIds.length > 0)
    .map((element) => ({
      ...element,
      groupIds: element.groupIds.slice(0, -1),
      version: element.version + 1,
    }));
}

export interface DuplicateResult {
  readonly elements: Element[];
  /** Old id to new id. */
  readonly idMap: ReadonlyMap<ElementId, ElementId>;
}

/**
 * Copies elements with fresh ids, seeds and z-order keys above `topIndex`,
 * offset by `offset`. Group ids are remapped so the copies form their own
 * groups; bindings and frame membership are rewritten when both ends were
 * copied, and otherwise kept pointing at the original target.
 */
export function duplicateElements(
  elements: ReadonlyArray<Element>,
  options: { readonly rng: Rng; readonly aboveIndex: string | null; readonly offset: number },
): DuplicateResult {
  const idMap = new Map<ElementId, ElementId>();
  const groupMap = new Map<string, string>();
  for (const element of elements) {
    idMap.set(element.id, options.rng.nextId("el"));
    for (const groupId of element.groupIds) {
      if (!groupMap.has(groupId)) groupMap.set(groupId, options.rng.nextId("g"));
    }
  }
  const keys = keysBetween(options.aboveIndex, null, elements.length);
  const copies = elements.map((element, i): Element => {
    const base = {
      ...element,
      id: idMap.get(element.id) as ElementId,
      index: keys[i] as string,
      seed: options.rng.nextSeed(),
      version: 0,
      x: element.x + options.offset,
      y: element.y + options.offset,
      groupIds: element.groupIds.map((groupId) => groupMap.get(groupId) ?? groupId),
      frameId: element.frameId ? (idMap.get(element.frameId) ?? element.frameId) : null,
    };
    if (isLinearElement(base)) {
      return {
        ...base,
        startBinding: base.startBinding
          ? {
              ...base.startBinding,
              targetId: idMap.get(base.startBinding.targetId) ?? base.startBinding.targetId,
            }
          : null,
        endBinding: base.endBinding
          ? {
              ...base.endBinding,
              targetId: idMap.get(base.endBinding.targetId) ?? base.endBinding.targetId,
            }
          : null,
      };
    }
    return base;
  });
  return { elements: copies, idMap };
}
