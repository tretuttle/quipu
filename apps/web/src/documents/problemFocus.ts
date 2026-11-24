import { create } from "zustand";

/**
 * "Show the problem": the byte the Source view should scroll to the next time
 * it is on screen for that document. The view takes it and clears it.
 */
export const useProblemFocus = create<{
  readonly pending: { readonly documentId: number; readonly offset: number } | null;
  readonly show: (documentId: number, offset: number) => void;
  readonly take: (documentId: number) => number | null;
}>((set, get) => ({
  pending: null,
  show: (documentId, offset) => set({ pending: { documentId, offset } }),
  take: (documentId) => {
    const pending = get().pending;
    if (pending === null || pending.documentId !== documentId) return null;
    set({ pending: null });
    return pending.offset;
  },
}));
