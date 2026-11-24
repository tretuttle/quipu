import { useMemo } from "react";

import type { OpenDocument } from "./documentSession.ts";
import { type HitSet, hitSetOf, useSearchStore } from "./searchStore.ts";

/**
 * The active search's hits for `document`, or null when nothing is lit. The
 * identity changes only when a new search finishes, so views refetch their
 * window once per search, not once per step.
 */
export function useHitSet(
  document: Pick<OpenDocument, "documentId" | "queries"> | null,
): HitSet | null {
  const phase = useSearchStore((state) => state.phase);
  const documentId = useSearchStore((state) => state.documentId);
  const summary = useSearchStore((state) => state.summary);
  const query = useSearchStore((state) => state.query);
  const queries = document?.queries ?? null;
  const id = document?.documentId ?? null;
  return useMemo(
    () =>
      id === null || queries === null
        ? null
        : hitSetOf(phase, documentId, summary, { documentId: id, queries }, query),
    [phase, documentId, summary, id, queries, query],
  );
}
