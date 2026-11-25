import * as Schema from "effect/Schema";
import { create } from "zustand";

import type { DocumentView } from "./components/DocumentViewToggle";
import { useDocumentSession } from "./documents/documentSession";
import { resolveStorage } from "./lib/storage";

const STORAGE_KEY = "quipu:document-view";
export const AVAILABLE_DOCUMENT_VIEWS: ReadonlyArray<DocumentView> = [
  "map",
  "tree",
  "table",
  "compare",
  "source",
];
const StoredView = Schema.Literals(["map", "tree", "table", "compare", "source"]);
const decodeStored = Schema.decodeUnknownExit(StoredView);

const storage = () => resolveStorage(typeof window === "undefined" ? null : window.localStorage);

function readStored(): DocumentView {
  try {
    const decoded = decodeStored(storage().getItem(STORAGE_KEY));
    return decoded._tag === "Success" ? decoded.value : "map";
  } catch {
    return "map";
  }
}

interface DocumentViewState {
  readonly view: DocumentView;
  readonly setView: (view: DocumentView) => void;
}

/**
 * Which view an open document shows. The map is the default; the choice
 * persists in localStorage, and a shell command or the header toggle changes
 * it. Only a document with a structure offers a choice: Source on a text
 * document (its only view), or a view asked for with nothing open, is not
 * remembered.
 */
export const useDocumentView = create<DocumentViewState>((set) => ({
  view: readStored(),
  setView: (view) => {
    if (!AVAILABLE_DOCUMENT_VIEWS.includes(view)) return;
    const { session } = useDocumentSession.getState();
    const offersChoice =
      session.phase === "opening" ||
      (session.phase === "open" && session.document.structure !== "none");
    if (!offersChoice) return;
    try {
      storage().setItem(STORAGE_KEY, view);
    } catch {
      // Blocked storage still lets the session switch views.
    }
    set({ view });
  },
}));
