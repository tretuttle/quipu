/**
 * The map view that currently owns the keyboard, for the shell's map commands
 * (parent, child, siblings, expand all…), the way `boardEditorRegistry` hands
 * drawing commands to the active editor: one registered target at a time.
 */
export interface MapController {
  readonly focusSibling: (step: 1 | -1) => void;
  readonly focusFirstSibling: () => void;
  readonly focusLastSibling: () => void;
  /** Right: opens a closed node, else moves to its first child. */
  readonly focusChild: () => void;
  /** Left: closes an open node, else moves to its parent. */
  readonly focusParent: () => void;
  readonly toggleFocused: () => void;
  /** Opens the whole map, from its root. */
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  /** Opens, or closes, everything under the current node. */
  readonly expandUnder: () => void;
  readonly collapseUnder: () => void;
  /** The document nodes the current node stands for: what "in selection" commands act on. */
  readonly selectionScope: () => ReadonlyArray<string>;
}

let active: MapController | null = null;

export function registerMapController(controller: MapController): () => void {
  active = controller;
  return () => {
    if (active === controller) active = null;
  };
}

export function getActiveMapController(): MapController | null {
  return active;
}

/** True when a map node has the focus (the `mapNodeActive` context key). */
export function isMapNodeActive(target: EventTarget | null): boolean {
  const element =
    target instanceof Element
      ? target
      : document.activeElement instanceof Element
        ? document.activeElement
        : null;
  return element !== null && element.closest("[data-map-node]") !== null;
}
