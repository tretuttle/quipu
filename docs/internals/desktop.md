# Desktop shell

The desktop app ([`apps/desktop`](../../apps/desktop/src)) is Electron around the same web app. The
renderer runs the same engine in the same workers; the main process owns what a browser page
cannot: file handles, atomic writes, a state directory, the native dialogs and the close of a
window. This page covers how a document is opened, read, saved, journaled and closed on the
desktop, and why it is done that way. The engine side is in [Document engine](document-engine.md).

## Serving the app

The renderer loads from a privileged custom scheme
([`ElectronProtocol.ts`](../../apps/desktop/src/electron/ElectronProtocol.ts)): `quipu://` serves the
built web app from disk, and `quipu-dev://` proxies to the Vite dev server. Both are registered as
standard and secure before Electron's `ready`, which is what gives the page a real origin.

Every response carries the Content Security Policy and the two cross-origin isolation headers
(`withDocumentHeaders`). They have to be set on the protocol response itself:
`webRequest.onHeadersReceived` never sees a custom-scheme document. Without isolation the engine has
no `SharedArrayBuffer`. The policy allows the page to talk only to itself, to `blob:` URLs and to
Open VSX for the theme browser; Open VSX answers its file URLs with a redirect to its file host, and
`connect-src` is checked on each hop, so both hosts are listed.

The dev proxy retries an idempotent request after 50 ms and again after 150 ms, because Vite briefly
refuses connections while it restarts. The packaged scheme falls back to `index.html` for unknown
paths so the router handles them, except for asset-shaped paths, which 404.

## Opening a file

[`DesktopDocuments.ts`](../../apps/desktop/src/documents/DesktopDocuments.ts) receives files from
every way the OS hands them over: the open dialog, the command line
([`launchPaths.ts`](../../apps/desktop/src/documents/launchPaths.ts)), a second launch
(`second-instance`, after the app took the single-instance lock), macOS `open-file` (which can arrive
before `ready`), and the recents list. Each file is recorded by its canonical path, with an id that
is a SHA-256 of that path (`path:<hash>`), in `recents.json` under Electron's user data directory.

Files wait in a queue until the page says it is ready, and then the newest waiting file opens; the
rest stay in the recents. A file that is not there, may not be read, or cannot be read for another
reason is not opened: the page is told (`onDocumentOpenFailed`, through the same queue, so a bad
path on the command line is reported once the page exists) and shows the notice a browser shows for
a recent it cannot read. The file stays in the recents to try again, and the user can remove it
from there (`removeRecentDocument`).

The page is not ready from the moment the window starts a new page (a reload, watched through
`did-start-navigation`) until that page says it is ready again, so a file that arrives during a
reload waits for the new page instead of being posted to the old one. The page remembers the recent
id of its open document in session storage, as the web app does, and passes it when it says it is
ready: the main process opens that file again and hands over a new port, unless a newer file is
waiting, which wins. Unsaved edits come back through the document's journal, as on any open.

The page never names a path to the main process. A file dropped or picked in the page is turned
into a path inside the preload (`webUtils.getPathForFile`) and sent from there; a pasted file has no
path and is not remembered.

## Reading: a port to the main process's file handle

The main process opens the file once and answers positional reads on a `MessagePort`
([`DesktopDocumentSource.ts`](../../apps/desktop/src/documents/DesktopDocumentSource.ts), contract in
[`documentSource.ts`](../../packages/contracts/src/documentSource.ts)). Reads run concurrently on one
Node `FileHandle`; a read past the size the file had when it was opened, or over
`MAX_DOCUMENT_READ_BYTES` (64 MiB), is refused, and a file that has become shorter fails the read
rather than returning short bytes. The file on disk stays the source of truth; the renderer never
holds it.

A port cannot cross `contextBridge`, so the preload posts it to the page with `window.postMessage`.
The page hands it to the engine in the `open` request, and the coordinator gives each scan worker a
fork of it. The handle closes when the other end of the port goes away: the document closed, or the
page reloaded or quit.

`MessagePortMain` cannot transfer a buffer, so every reply is a copy. That makes a port read slower
than a renderer `File`, which is why a file dropped onto the window, already a disk-backed `File`,
is read the web way.

## Saving

A save streams the engine's output over its own `MessagePort`
(`desktopBridge.createSaveStream`, [`preload.ts`](../../apps/desktop/src/preload.ts)), so chunks
never pass through `invoke`'s per-call serialization. One chunk is in flight at a time: the main
process acknowledges each chunk after writing it, which is the stream's backpressure, and answers
`close` with the byte count. Chunks are copied rather than transferred, because a transferred
`ArrayBuffer` does not arrive in `MessagePortMain` as the `Uint8Array` the save port decodes.

[`DesktopDocumentSave.ts`](../../apps/desktop/src/documents/DesktopDocumentSave.ts) writes a sibling
temp file (given the target's permissions first), syncs it, renames it over the target and syncs the
directory (skipped on Windows, which does not support it). A crash before the rename leaves the
original untouched; the rename is the commit. Settings files use the same temp-then-rename shape
without the syncs.

After a save to a file, the main process opens the saved file again and posts it to the page like any
opened document, because the file the engine was reading has changed under it.

## Journals

On the web, edit journals live in OPFS. On the desktop they live in the state directory instead
(`$QUIPU_HOME/userdata` when `QUIPU_HOME` is set, otherwise `~/.quipu/userdata`, or `~/.quipu/dev` in
development), because Electron's OPFS sits in a Chromium profile that is treated as replaceable.

The engine worker cannot reach the main process, so the renderer serves the journal store to it: a
`JournalStore` over `desktopBridge.journal`, one IPC call per operation, served on a `MessagePort` the
engine gets at start (`desktopJournalPort` in
[`desktopJournal.ts`](../../apps/web/src/engine/desktopJournal.ts), `serveJournalStore` in
[`journalStore.ts`](../../packages/core/src/journalStore.ts)). The main process writes the files
([`DesktopJournalStore.ts`](../../apps/desktop/src/documents/DesktopJournalStore.ts)) with `sync` as
the durability call, replaces a file through a `.tmp` sibling and a rename, and refuses any path that
leaves the state directory.

A desktop document's journal key is its recents id plus its size and modification time, so the same
file, unchanged, finds its unsaved edits on the next launch, and a file changed elsewhere starts
fresh.

The port store cannot hand the workers a `Blob` of a transform's spill file, so on the desktop a
pretty save of a sorted or reformatted document formats in the coordinator, and search over it is
refused until the document is saved.

## Closing with unsaved edits

Electron ignores a page's `beforeunload` text, so
[`DesktopCloseGuard.ts`](../../apps/desktop/src/window/DesktopCloseGuard.ts) holds a window's `close`
(and a quit) while it asks the page over IPC whether it may close. The page shows its own Save,
Discard or Cancel dialog, the same question it asks before replacing a document, and answers. A yes
closes the window and continues a quit that was under way; a no keeps the window and cancels the
quit. A page that cannot answer (still loading, or crashed) never blocks a close, and an answer to a
question that is no longer open is ignored.

## Packaging

`scripts/build-desktop-artifact.ts` builds the web app and the main process, stages a minimal app
and runs electron-builder on it; the electron-builder configuration lives in `createBuildConfig`
there, not in `apps/desktop/package.json`. `electron-updater` ships but checks for updates only when
the build was packed with an update feed (`QUIPU_DESKTOP_UPDATE_URL` or `--update-url`); no update
origin is written into the source.
