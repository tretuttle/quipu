import { create } from "zustand";

export type UnsavedChoice = "save" | "discard" | "cancel";

interface UnsavedPromptState {
  /** The document being asked about; null while no question is open. */
  readonly name: string | null;
  readonly respond: (choice: UnsavedChoice) => void;
}

let pending: ((choice: UnsavedChoice) => void) | null = null;

/** The question `UnsavedChangesDialog` shows; one at a time, a second one cancels the first. */
export const useUnsavedPrompt = create<UnsavedPromptState>((set) => ({
  name: null,
  respond: (choice) => {
    const resolve = pending;
    pending = null;
    set({ name: null });
    resolve?.(choice);
  },
}));

let hosts = 0;

/** Called by the dialog while it is mounted, so a question is only asked when it can be seen. */
export function registerUnsavedChangesHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    if (hosts === 0) useUnsavedPrompt.getState().respond("cancel");
  };
}

/**
 * Asks what to do with a document's unsaved edits before it is replaced or
 * closed: save them, discard them, or keep the document open. Without a
 * mounted dialog the answer is "discard": the edits stay in the journal and
 * come back the next time the file is opened.
 */
export function askAboutUnsavedChanges(name: string): Promise<UnsavedChoice> {
  if (hosts === 0) return Promise.resolve("discard");
  pending?.("cancel");
  return new Promise((resolve) => {
    pending = resolve;
    useUnsavedPrompt.setState({ name });
  });
}
