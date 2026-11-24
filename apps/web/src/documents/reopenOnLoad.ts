import { useDocumentSession } from "./documentSession.ts";
import { markedOpenDocument, markOpenDocument, reopenRecent } from "./recents.ts";

/**
 * Opens again, after a reload, the document this tab had open, when the
 * browser lets it be read without asking: a copy kept in the origin's storage,
 * or a handle whose permission is still granted. A handle that needs a prompt
 * waits at the top of the recent documents, since a prompt needs a click.
 * Unsaved edits come back through the document's journal as on any open.
 */
let attempted = false;

export async function reopenAfterReload(): Promise<void> {
  // Once per page load (a development build mounts effects twice); the desktop's main process
  // hands its documents over itself.
  if (attempted || window.desktopBridge !== undefined) return;
  attempted = true;
  const id = markedOpenDocument();
  if (id === null) return;
  const outcome = await reopenRecent(id).catch(() => null);
  if (outcome?.kind !== "file") return;
  const { session, openFile } = useDocumentSession.getState();
  // Something else was opened while the file was read: that one stays.
  if (session.phase !== "empty") return;
  await openFile(outcome.file, outcome.handle, { recentId: id });
}

/**
 * The desktop's half: the recent the window had open before it reloaded, given
 * once per page load to `documentsReady`, which has the main process open that
 * file again through a new port. Unsaved edits come back through its journal.
 */
let handedOver = false;

export function desktopReopenId(): string | null {
  if (handedOver) return null;
  handedOver = true;
  return markedOpenDocument();
}

// Closing the document leaves nothing to bring back on a reload.
if (typeof window !== "undefined") {
  useDocumentSession.subscribe((state, previous) => {
    if (state.session.phase === "empty" && previous.session.phase === "open")
      markOpenDocument(null);
  });
}
