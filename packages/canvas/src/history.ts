/**
 * Undo and redo as inverse deltas over element records: one entry per
 * gesture, batched while a pointer stream is open. Selection and camera are
 * not history, and a no-op commit does not clear the redo stack.
 */
import type { Element, ElementId } from "./elements.ts";

export interface HistoryEntry {
  /** Record before the change, or null when the element did not exist. */
  readonly before: ReadonlyMap<ElementId, Element | null>;
  /** Record after the change. */
  readonly after: ReadonlyMap<ElementId, Element>;
}

export interface History {
  /** Records that `id` is about to change from `previous` in the open batch. */
  readonly track: (id: ElementId, previous: Element | null, next: Element) => void;
  /** Closes the batch as one entry. Returns false when nothing changed. */
  readonly commit: () => boolean;
  /** Drops the open batch, returning the records to restore (before the batch). */
  readonly discard: () => ReadonlyMap<ElementId, Element | null>;
  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
  /** The entry to apply backwards, moved to the redo stack. */
  readonly undo: () => HistoryEntry | null;
  readonly redo: () => HistoryEntry | null;
  readonly isBatching: () => boolean;
  /** Forgets every entry and the open batch (after loading a document). */
  readonly clear: () => void;
}

export const MAX_HISTORY_ENTRIES = 200;

export function createHistory(): History {
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let before = new Map<ElementId, Element | null>();
  let after = new Map<ElementId, Element>();

  return {
    track(id, previous, next) {
      if (!before.has(id)) before.set(id, previous);
      after.set(id, next);
    },
    commit() {
      const changed = new Map<ElementId, Element>();
      for (const [id, next] of after) {
        if (before.get(id) !== next) changed.set(id, next);
      }
      const beforeChanged = new Map<ElementId, Element | null>();
      for (const id of changed.keys()) beforeChanged.set(id, before.get(id) ?? null);
      before = new Map();
      after = new Map();
      if (changed.size === 0) return false;
      undoStack.push({ before: beforeChanged, after: changed });
      if (undoStack.length > MAX_HISTORY_ENTRIES) undoStack.shift();
      redoStack.length = 0;
      return true;
    },
    discard() {
      const restore = before;
      before = new Map();
      after = new Map();
      return restore;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo() {
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push(entry);
      return entry;
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push(entry);
      return entry;
    },
    isBatching: () => before.size > 0,
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      before = new Map();
      after = new Map();
    },
  };
}
