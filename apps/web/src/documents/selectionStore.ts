import type { ByteRange, NodeRef, NodeSummary, PathStep } from "@quipu/contracts/engine";
import { create } from "zustand";

import { nodeId } from "./treeModel.ts";

/**
 * Which view made the selection; the other views follow it and the maker does
 * not jump. `edit` is the node an edit, undo or transform changed: every view follows it.
 */
export type SelectionOrigin = "map" | "tree" | "source" | "search" | "edit";

export interface DocumentSelection {
  readonly documentId: number;
  readonly ref: NodeRef;
  /** The bytes the node occupies, from its key (when it has one) to the end of its value. */
  readonly range: ByteRange;
  readonly origin: SelectionOrigin;
  /**
   * The nodes from the root down to this one, when the source found it by byte
   * offset: how the tree and the map reach a node they have not listed yet.
   */
  readonly path: ReadonlyArray<PathStep> | null;
  /** Bumped by every selection, so choosing the same node again still scrolls to it. */
  readonly revision: number;
}

interface SelectionState {
  readonly selection: DocumentSelection | null;
  readonly select: (selection: Omit<DocumentSelection, "revision">) => void;
  readonly clear: () => void;
}

let revision = 0;

/**
 * The selection every view shares. The map and the tree set it from the focused
 * node, the source from a click and search from a hit; each follows the others
 * by reacting to a selection whose origin is not its own. A new document clears
 * it.
 */
export const useSelectionStore = create<SelectionState>((set) => ({
  selection: null,
  select: (selection) => set({ selection: { ...selection, revision: ++revision } }),
  clear: () => set({ selection: null }),
}));

/**
 * The node the user has narrowed things to, in `documentId`: the selection,
 * unless it is the root, which stands for the whole document (a view that
 * takes the keyboard on open selects its root row).
 */
export function narrowedSelection(
  selection: DocumentSelection | null,
  documentId: number,
): DocumentSelection | null {
  if (selection === null || selection.documentId !== documentId) return null;
  const root = selection.ref.tapeId === 0 && selection.ref.token === 0;
  return root ? null : selection;
}

/** The tree and map id of the selected node in a document, or null. */
export function selectedNodeId(
  selection: DocumentSelection | null,
  documentId: number,
): string | null {
  return selection !== null && selection.documentId === documentId ? nodeId(selection.ref) : null;
}

/**
 * The bytes a node occupies in the document as it is now, from its key (when it
 * has one) to the end of its value: `span` follows edits, and the key sits the
 * same distance before the value as it does on the tape.
 */
export function nodeBytes(node: NodeSummary): ByteRange {
  const keyLead = node.key === null ? 0 : node.range.start - node.key;
  return { start: node.span.start - keyLead, end: node.span.end };
}
