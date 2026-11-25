import { MAX_TRACE_VALUE_CHARS, type TraceOccurrence } from "@quipu/contracts/deepSearch";
import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";

import { useRightPanelStore } from "../rightPanelStore.ts";
import { stackedToast, toastManager } from "../components/ui/toast";
import {
  readNodeSummary,
  type OpenDocument,
  traceValue,
  useDocumentSession,
} from "./documentSession.ts";
import { useDeepHitStore, useMatchFilterStore } from "./hitFilter.ts";
import { useSelectionStore } from "./selectionStore.ts";
import { useTraceStore } from "./TracePanel.tsx";

const errorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return error instanceof Error ? error.message : fallback;
};

let traceGeneration = 0;

/** Traces the currently selected scalar value across the entire open document. */
export async function traceSelectedScalar(explicitDocument?: OpenDocument | null): Promise<void> {
  const { session } = useDocumentSession.getState();
  const doc = explicitDocument ?? (session.phase === "open" ? session.document : null);
  if (doc === null) return;

  const selection = useSelectionStore.getState().selection;
  if (selection === null || selection.documentId !== doc.documentId) {
    toastManager.add(
      stackedToast({
        type: "info",
        title: "Select a value first",
        description: "Pick a string, number, boolean, or null to trace every exact occurrence.",
      }),
    );
    return;
  }

  const treeSelection = doc.tree?.selection();
  const node =
    treeSelection !== null &&
    treeSelection !== undefined &&
    treeSelection.node.ref.tapeId === selection.ref.tapeId &&
    treeSelection.node.ref.token === selection.ref.token
      ? treeSelection.node
      : await readNodeSummary(selection.ref).catch(() => null);
  if (node !== null && (node.kind === "object" || node.kind === "array")) {
    useRightPanelStore.getState().showTab("trace");
    useTraceStore
      .getState()
      .setError("Select a scalar value (string, number, boolean, or null) to trace.");
    return;
  }

  const mine = ++traceGeneration;
  useRightPanelStore.getState().showTab("trace");
  useTraceStore.getState().setLoading(selection.range);

  try {
    const readLimit = Math.min(MAX_SLICE_BYTES, Math.max(1024, MAX_TRACE_VALUE_CHARS * 4));
    const valueResult = await doc.edits.text(selection.ref, readLimit);
    if (mine !== traceGeneration) return;
    if (valueResult.text.length > MAX_TRACE_VALUE_CHARS) {
      useTraceStore
        .getState()
        .setError(
          `Value exceeds the ${MAX_TRACE_VALUE_CHARS.toLocaleString("en-US")} character trace limit.`,
        );
      return;
    }
    const result = await traceValue(doc.documentId, {
      value: valueResult.text,
      originRef: selection.ref,
      originRange: selection.range,
    });
    if (mine !== traceGeneration) return;
    useTraceStore.getState().setResult(result, selection.range);
  } catch (error) {
    if (mine !== traceGeneration) return;
    useTraceStore.getState().setError(errorMessage(error, "Could not trace value."));
  }
}

/** Jumps the shared selection (and Tree/Source/Map) to a traced occurrence. */
export async function selectTraceOccurrence(
  doc: OpenDocument,
  occurrence: TraceOccurrence,
): Promise<void> {
  const found = await doc.source.nodeAt(occurrence.range.start).catch(() => null);
  const innermost = found?.path[found.path.length - 1];
  const ref = occurrence.ref ?? innermost?.node.ref ?? null;
  if (ref === null) return;
  useSelectionStore.getState().select({
    documentId: doc.documentId,
    ref,
    range: occurrence.range,
    origin: "search",
    path: found?.path ?? null,
  });
}

let lastDocId: number | null = null;
let lastDocRevision = 0;
useDocumentSession.subscribe((state) => {
  const doc = state.session.phase === "open" ? state.session.document : null;
  const docId = doc?.documentId ?? null;
  const rev = doc?.revision ?? 0;
  if (docId !== lastDocId) {
    lastDocId = docId;
    lastDocRevision = rev;
    traceGeneration++;
    useTraceStore.getState().clear();
    useDeepHitStore.getState().clear();
    useMatchFilterStore.getState().clear();
    return;
  }
  if (rev !== lastDocRevision) {
    lastDocRevision = rev;
    // Clear stale trace highlights/arcs on edits until the user re-traces.
    useTraceStore.getState().clear();
  }
});
