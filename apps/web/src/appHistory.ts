import type { AnyRouter, HistoryLocation, RouterHistory } from "@tanstack/react-router";

import { type OpenDocument, useDocumentSession } from "./documents/documentSession";
import { recentFileKey, useRecentDocuments } from "./documents/recents";

/**
 * Quipu's own back and forward. Every screen the user moves to is a history
 * entry: a board, a settings page, and each document opened on the home page.
 * A home entry names the document it showed (`quipuDocument`), or "none" for
 * the empty state, so walking back to it opens that document again.
 *
 * Only entries this page created count. The entry the app was loaded on is
 * the first, so Back never leaves Quipu for whatever page came before it.
 * A document the user takes off the recent list leaves the history too: Back
 * and Forward step over its entries.
 */
declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The document a home entry showed: a key of `entries`, or "none" for the empty state. */
    quipuDocument?: string;
  }
}

const NO_DOCUMENT = "none";
const HOME = "/";

interface DocumentEntry {
  readonly fileKey: string;
  readonly reopen: () => Promise<void>;
}

/** The documents this page has shown, by entry key. A reload forgets them, so their entries stay put. */
const entries = new Map<string, DocumentEntry>();
const keyByDocumentId = new Map<number, string>();
/** Entries whose document was removed from the recent list; Back and Forward pass over them. */
const forgotten = new Set<string>();

let router: AnyRouter | null = null;
/** The furthest entry the page has visited: Forward is possible below it. */
let furthest = 0;
/** The entry whose document a Back or Forward is opening again. */
let restoring: string | null = null;
let nextKey = 0;

const indexOf = (location: HistoryLocation) => location.state.__TSR_index ?? 0;

export function canGoBack(): boolean {
  return router !== null && indexOf(router.history.location) > 0;
}

export function canGoForward(): boolean {
  return router !== null && indexOf(router.history.location) < furthest;
}

export function goBack(): void {
  if (canGoBack()) router?.history.back();
}

export function goForward(): void {
  if (canGoForward()) router?.history.forward();
}

export function currentPathname(): string {
  return router?.history.location.pathname ?? HOME;
}

function openDocumentOf(): OpenDocument | null {
  const { session } = useDocumentSession.getState();
  return session.phase === "open" ? session.document : null;
}

function keyOfShown(): string {
  const document = openDocumentOf();
  return document === null
    ? NO_DOCUMENT
    : (keyByDocumentId.get(document.documentId) ?? NO_DOCUMENT);
}

/** Rewrites the current entry to name `key`, keeping its place in the history. */
function tagCurrentEntry(key: string) {
  if (router === null) return;
  const { location } = router.history;
  if (location.state.quipuDocument === key) return;
  router.history.replace(location.href, { ...location.state, quipuDocument: key });
}

/** Forgets every entry of the file: it was removed from the recent list. */
function forgetFile(fileKey: string) {
  for (const [key, entry] of entries) {
    if (entry.fileKey !== fileKey) continue;
    entries.delete(key);
    forgotten.add(key);
  }
}

/** A Back or Forward landed on a home entry: show the document it showed. */
function restoreEntry(key: string, step: -1 | 1) {
  if (forgotten.has(key)) {
    // Its document is gone from the list: keep going the same way, or stay where the list allows.
    if (step < 0 && canGoBack()) goBack();
    else if (step > 0 && canGoForward()) goForward();
    else tagCurrentEntry(keyOfShown());
    return;
  }
  if (key === keyOfShown()) return;
  if (key === NO_DOCUMENT) {
    void useDocumentSession
      .getState()
      .closeDocument()
      .then((closed) => {
        // Kept open (its unsaved edits were not settled): the entry says what is showing.
        if (!closed) tagCurrentEntry(keyOfShown());
      });
    return;
  }
  const entry = entries.get(key);
  if (entry === undefined) return;
  restoring = key;
  void entry.reopen().finally(() => {
    // The desktop opens it later, through its own channel; on the web the open has settled.
    if (window.desktopBridge !== undefined || restoring !== key) return;
    restoring = null;
    tagCurrentEntry(keyOfShown());
  });
}

function onDocumentShown(document: OpenDocument) {
  if (router === null) return;
  const { location } = router.history;
  const restored = restoring === null ? undefined : entries.get(restoring);
  if (restoring !== null && restored?.fileKey === document.fileKey) {
    keyByDocumentId.set(document.documentId, restoring);
    entries.set(restoring, { fileKey: document.fileKey, reopen: document.reopen });
    restoring = null;
    return;
  }
  restoring = null;
  const shownKey = location.pathname === HOME ? location.state.quipuDocument : undefined;
  const shown = shownKey === undefined ? undefined : entries.get(shownKey);
  // The same file again (Discard on restored edits): it keeps its entry.
  if (shownKey !== undefined && shown?.fileKey === document.fileKey) {
    keyByDocumentId.set(document.documentId, shownKey);
    entries.set(shownKey, { fileKey: document.fileKey, reopen: document.reopen });
    return;
  }
  const key = `document-${++nextKey}`;
  entries.set(key, { fileKey: document.fileKey, reopen: document.reopen });
  keyByDocumentId.set(document.documentId, key);
  void router.navigate({ to: HOME, state: { quipuDocument: key } });
}

/** Starts tracking the router's history. Mounted once, by the shell. */
export function installAppHistory(next: AnyRouter): () => void {
  router = next;
  furthest = indexOf(next.history.location);
  if (next.history.location.pathname === HOME) tagCurrentEntry(keyOfShown());

  const history: RouterHistory = next.history;
  const stopHistory = history.subscribe(({ location, action }) => {
    const index = indexOf(location);
    furthest = action.type === "PUSH" ? index : Math.max(furthest, index);
    if (location.pathname !== HOME) return;
    const key = location.state.quipuDocument;
    if (action.type === "PUSH" || action.type === "REPLACE") {
      // A plain link home: the entry shows whatever is open.
      if (key === undefined) queueMicrotask(() => tagCurrentEntry(keyOfShown()));
      return;
    }
    if (key === undefined) return;
    const step =
      action.type === "BACK"
        ? -1
        : action.type === "FORWARD"
          ? 1
          : "index" in action && action.index < 0
            ? -1
            : 1;
    restoreEntry(key, step);
  });

  const stopRecents = useRecentDocuments.subscribe((state, previous) => {
    const listed = new Set(state.documents.map((recent) => recent.id));
    for (const recent of previous.documents) {
      if (!listed.has(recent.id)) forgetFile(recentFileKey(recent));
    }
  });

  const stopSession = useDocumentSession.subscribe((state, previous) => {
    const document = state.session.phase === "open" ? state.session.document : null;
    const before = previous.session.phase === "open" ? previous.session.document : null;
    if (document?.documentId === before?.documentId) return;
    if (document !== null) {
      onDocumentShown(document);
    } else if (state.session.phase === "empty" && currentPathname() === HOME) {
      // Closing replaces what the entry shows: Back then goes to the screen before it.
      tagCurrentEntry(NO_DOCUMENT);
    }
  });

  return () => {
    stopHistory();
    stopSession();
    stopRecents();
    if (router === next) router = null;
  };
}
