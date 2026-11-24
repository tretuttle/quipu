/**
 * Editing a document from any view. A view asks to edit a node (`startNodeEdit`)
 * and the editor it renders commits through `editNode`; undo, redo and the
 * transforms go through the same path. After every change the views are
 * brought to the edited document here, in one place: the tree lists its open
 * rows again, the edited node is selected (so the Source view and the map
 * follow it), and search results are found again.
 */
import {
  EditRefusedError,
  type EditResult,
  type NodeKind,
  type NodeRef,
  type NodeSummary,
  type Transform,
} from "@quipu/contracts/engine";
import { commandTitle } from "@quipu/shared/commands";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { stackedToast } from "../components/ui/toastHelpers";
import { editableFormatNames } from "./formatNames.ts";
import { onJournalReplayed, type OpenDocument, useDocumentSession } from "./documentSession.ts";
import { useSearchStore } from "./searchStore.ts";
import { nodeBytes, useSelectionStore } from "./selectionStore.ts";
import { nodeId, type Selection, type TreeModel } from "./treeModel.ts";

/** Where an editor opens: inline in a tree row, over a Source view token, in the Inspector, or on the map. */
export type EditSurface = "tree" | "source" | "inspector" | "map";

export type EditMode = "value" | "key";

export interface NodeEditRequest {
  readonly documentId: number;
  readonly ref: NodeRef;
  readonly kind: NodeKind;
  /** The row that shows the node, so it stays open and selected under its new id. */
  readonly rowId: string | null;
  readonly mode: EditMode;
  readonly surface: EditSurface;
  /** Where a floating editor opens, in client pixels; null puts it where the surface decides. */
  readonly anchor: { readonly x: number; readonly y: number } | null;
}

/** The one editor open at a time. */
export const useNodeEditor = create<{ readonly request: NodeEditRequest | null }>(() => ({
  request: null,
}));

export type NodeChange =
  | { readonly kind: "value"; readonly json: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "transform"; readonly transform: Transform };

export type EditOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      /** A command that does what was meant, when the engine named one. */
      readonly remedy?: "sortArrayByField";
    };

/** The node a command acts on: the selected one, or the root when nothing is selected. */
export interface EditTarget {
  readonly node: NodeSummary;
  readonly rowId: string | null;
  /** The node lies inside a decoded value (base64, a JWT, a nested body): its bytes are not the file's. */
  readonly decoded: boolean;
}

export const openDocument = (): OpenDocument | null => {
  const { session } = useDocumentSession.getState();
  return session.phase === "open" ? session.document : null;
};

/** Why the open document cannot be edited at all, or null when it can. */
export function documentBlocker(document: OpenDocument | null): string | null {
  if (document === null)
    return `Open a file to edit it. ${editableFormatNames} files can be edited.`;
  if (document.tree === null) return "Plain text files are read-only.";
  if (!document.editable) return document.note ?? "This document is read-only.";
  if (document.edit.replaying) return "Unsaved edits are still being restored.";
  return null;
}

/** Why `mode` cannot be used on `target`, or null when it can. */
export function nodeBlocker(
  document: OpenDocument | null,
  target: EditTarget | null,
  mode: EditMode,
): string | null {
  const blocked = documentBlocker(document);
  if (blocked !== null) return blocked;
  if (target === null) return "Select a value first.";
  if (target.decoded) return "Decoded values are read-only.";
  if (mode === "key" && target.node.key === null) return "Only object members have a key.";
  return null;
}

/** The node the Inspector shows: the selection every view shares, or the root. */
export function selectedTarget(document: OpenDocument | null): EditTarget | null {
  const tree = document?.tree ?? null;
  return tree === null ? null : targetOf(tree, tree.selection());
}

/**
 * The target for a tree's selection. Components pass the selection they
 * subscribed to (`useSyncExternalStore(tree.subscribe, tree.selection)`), so a
 * memoized render sees it change.
 */
export function targetOf(tree: TreeModel, selection: Selection | null): EditTarget | null {
  if (selection === null) {
    const root = tree.summaryOf(tree.rootId);
    return root === undefined ? null : { node: root, rowId: tree.rootId, decoded: false };
  }
  return {
    node: selection.node,
    rowId: selection.id,
    decoded: selection.decoded || tree.isInsideDecoded(selection.id),
  };
}

const failure = (error: unknown, fallback: string) => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const text = (error as { message: unknown }).message;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return fallback;
};

const isRefusal = Schema.is(EditRefusedError);

/** The command an engine refusal offers instead, if any. */
const remedyOf = (error: unknown) => (isRefusal(error) ? error.remedy : undefined);

const reportFailure = (title: string, message: string) =>
  toastManager.add(stackedToast({ type: "error", title, description: message }));

/**
 * Opens an editor on a node, or says why it cannot. The editor itself commits
 * through `editNode`.
 */
export function startNodeEdit(
  target: EditTarget | null,
  mode: EditMode,
  surface: EditSurface,
  anchor: NodeEditRequest["anchor"] = null,
): boolean {
  const document = openDocument();
  const blocked = nodeBlocker(document, target, mode);
  if (blocked !== null || document === null || target === null) {
    reportFailure(
      mode === "key" ? "Can't rename this key" : "Can't edit this value",
      blocked ?? "",
    );
    return false;
  }
  useNodeEditor.setState({
    request: {
      documentId: document.documentId,
      ref: target.node.ref,
      kind: target.node.kind,
      rowId: target.rowId,
      mode,
      surface,
      anchor,
    },
  });
  return true;
}

export function stopNodeEdit() {
  useNodeEditor.setState({ request: null });
}

/** Every view reads the edited document again; the node the engine re-indexed is selected. */
async function afterEdit(document: OpenDocument, result: EditResult, rowId: string | null) {
  const tree = document.tree;
  const editedId = nodeId(result.node.ref);
  if (tree !== null) {
    await tree.reload(
      rowId !== null && rowId !== editedId ? new Map([[editedId, rowId]]) : undefined,
    );
  }
  const found = await document.edits.nodeAt(result.node.span.start).catch(() => null);
  const path = found?.path ?? [];
  const at = path.findIndex(
    (step) =>
      step.node.ref.tapeId === result.node.ref.tapeId &&
      step.node.ref.token === result.node.ref.token,
  );
  useSelectionStore.getState().select({
    documentId: document.documentId,
    ref: result.node.ref,
    range: nodeBytes(result.node),
    origin: "edit",
    path: at >= 0 ? path.slice(0, at + 1) : path.length > 0 ? path : null,
  });
  void useSearchStore.getState().documentChanged();
}

/** Runs one change against the open document and brings the views to it. */
async function change(
  run: (document: OpenDocument) => Promise<EditResult>,
  rowId: string | null,
  fallback: string,
): Promise<EditOutcome> {
  const document = openDocument();
  const blocked = documentBlocker(document);
  if (blocked !== null || document === null) return { ok: false, message: blocked ?? fallback };
  let result: EditResult;
  try {
    result = await run(document);
  } catch (error) {
    const remedy = remedyOf(error);
    return { ok: false, message: failure(error, fallback), ...(remedy ? { remedy } : {}) };
  }
  // The open document may have changed while the engine worked; its own views are gone then.
  if (openDocument()?.documentId === document.documentId) await afterEdit(document, result, rowId);
  return { ok: true };
}

/**
 * Changes one node: its value, its key, or a transform of it. Every view edits
 * through this, so each change is one undoable step that every view follows.
 */
export function editNode(
  target: { readonly ref: NodeRef; readonly rowId: string | null },
  edit: NodeChange,
): Promise<EditOutcome> {
  return change(
    (document) => {
      switch (edit.kind) {
        case "value":
          return document.edits.setValue(target.ref, edit.json);
        case "key":
          return document.edits.setKey(target.ref, edit.key);
        case "transform":
          return document.edits.transform(target.ref, edit.transform);
      }
    },
    target.rowId,
    "The edit could not be applied.",
  );
}

/** Undo or redo the document's last edit; a failure is reported as a toast. */
export async function stepHistory(direction: "undo" | "redo"): Promise<void> {
  const document = openDocument();
  if (document === null) return;
  const depth = direction === "undo" ? document.edit.undoDepth : document.edit.redoDepth;
  if (depth === 0 && documentBlocker(document) === null) return;
  const outcome = await change(
    (open) => (direction === "undo" ? open.edits.undo() : open.edits.redo()),
    null,
    `Nothing to ${direction}.`,
  );
  if (!outcome.ok)
    reportFailure(direction === "undo" ? "Can't undo" : "Can't redo", outcome.message);
}

export type TransformKind =
  | "sortKeys"
  | "sortKeysDescending"
  | "sortArray"
  | "sortArrayDescending"
  | "sortArrayByField"
  | "format"
  | "minify"
  | "formatDocument"
  | "minifyDocument";

const FORMAT_INDENT = 2;

/** The node a transform acts on: the whole document for the `…Document` ones, else `selected`. */
function transformTarget(
  document: OpenDocument | null,
  kind: TransformKind,
  selected: EditTarget | null,
): EditTarget | null {
  if (kind === "formatDocument" || kind === "minifyDocument") {
    const tree = document?.tree ?? null;
    const root = tree?.summaryOf(tree.rootId);
    return tree === null || root === undefined
      ? null
      : { node: root, rowId: tree.rootId, decoded: false };
  }
  return selected;
}

/** Why a transform cannot run on `selected` (or the whole document), or null when it can. */
export function transformBlocker(
  document: OpenDocument | null,
  kind: TransformKind,
  selected: EditTarget | null,
): string | null {
  const target = transformTarget(document, kind, selected);
  const blocked = nodeBlocker(document, target, "value");
  if (blocked !== null || target === null) return blocked;
  switch (kind) {
    case "sortKeys":
    case "sortKeysDescending":
      return target.node.kind === "object" ? null : "Select an object to sort its keys.";
    case "sortArray":
    case "sortArrayDescending":
    case "sortArrayByField":
      return target.node.kind === "array" ? null : "Select an array to sort it.";
    default:
      return null;
  }
}

const TRANSFORM_TITLES: Readonly<Record<TransformKind, string>> = {
  sortKeys: "Can't sort keys",
  sortKeysDescending: "Can't sort keys",
  sortArray: "Can't sort the array",
  sortArrayDescending: "Can't sort the array",
  sortArrayByField: "Can't sort the array",
  format: "Can't format",
  minify: "Can't minify",
  formatDocument: "Can't format",
  minifyDocument: "Can't minify",
};

/** The engine's transform for a kind; `field` names what `sortArrayByField` sorts by. */
function transformOf(kind: TransformKind, field: string | null, descending: boolean): Transform {
  switch (kind) {
    case "sortKeys":
    case "sortKeysDescending":
      return { _tag: "sortKeys", descending: kind === "sortKeysDescending" };
    case "sortArray":
    case "sortArrayDescending":
      return { _tag: "sortArray", field: null, descending: kind === "sortArrayDescending" };
    case "sortArrayByField":
      return { _tag: "sortArray", field, descending };
    case "format":
    case "formatDocument":
      return { _tag: "format", indent: FORMAT_INDENT };
    case "minify":
    case "minifyDocument":
      return { _tag: "minify" };
  }
}

/** The question `SortFieldDialog` asks before an array is sorted by a field of its elements. */
export const useSortFieldPrompt = create<{ readonly open: boolean }>(() => ({ open: false }));

/**
 * Runs a transform on its target as one undoable edit. `sortArrayByField`
 * first asks for the field (`SortFieldDialog` calls back with it).
 */
export async function runTransform(
  kind: TransformKind,
  field: string | null = null,
  descending = false,
): Promise<void> {
  const document = openDocument();
  const selected = selectedTarget(document);
  const blocked = transformBlocker(document, kind, selected);
  const target = transformTarget(document, kind, selected);
  if (blocked !== null || target === null) {
    reportFailure(TRANSFORM_TITLES[kind], blocked ?? "");
    return;
  }
  if (kind === "sortArrayByField" && field === null) {
    useSortFieldPrompt.setState({ open: true });
    return;
  }
  const outcome = await editNode(
    { ref: target.node.ref, rowId: target.rowId },
    { kind: "transform", transform: transformOf(kind, field, descending) },
  );
  if (outcome.ok) return;
  if (outcome.remedy !== "sortArrayByField") {
    reportFailure(TRANSFORM_TITLES[kind], outcome.message);
    return;
  }
  // An array of objects sorts by one of their fields: offer that right here.
  const id = toastManager.add(
    stackedToast({
      type: "error",
      title: TRANSFORM_TITLES[kind],
      description: outcome.message,
      actionProps: {
        children: commandTitle("transform.sortArrayByField"),
        onClick: () => {
          toastManager.close(id);
          void runTransform("sortArrayByField", null, kind === "sortArrayDescending");
        },
      },
    }),
  );
}

/** Brings the views to a document whose recovered journal finished replaying. */
async function refreshAfterReplay(document: OpenDocument) {
  await document.tree?.reload();
  void useSearchStore.getState().documentChanged();
}

onJournalReplayed((document) => void refreshAfterReplay(document));
