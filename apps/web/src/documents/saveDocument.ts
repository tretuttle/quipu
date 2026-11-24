import type {
  ConvertError,
  ConvertFormat,
  ConvertSettings,
  DocumentFormat,
  SaveSink,
} from "@quipu/contracts/engine";
import type { DesktopSaveStream } from "@quipu/contracts";

import { toastManager } from "../components/ui/toast";
import { stackedToast } from "../components/ui/toastHelpers";
import { DOCUMENT_FORMATS, nameWithExtension, savePickerTypes } from "./documentFormats.ts";
import {
  desktopJournalKey,
  getDocumentFileClient,
  type OpenDocument,
  savingBeforeLeaving,
  trackSave,
  useDocumentSession,
} from "./documentSession.ts";
import { journalKeyOf } from "./fingerprint.ts";
import type { FileHandle } from "./fileSystemAccess.ts";
import { useRecentDocuments } from "./recents.ts";
import { nodeBytes, useSelectionStore } from "./selectionStore.ts";

/**
 * Where a save or an export writes. A `file` is a File System Access handle,
 * written through a `FileSystemWritableFileStream` the engine opens in its
 * worker (the original stays intact until the stream closes). A `download`
 * streams into the browser's blob storage and is offered as a download when it
 * is complete. `desktop` is a path the desktop app's main process writes
 * through a temporary file and a rename.
 */
export type SaveDestination =
  | { readonly kind: "file"; readonly handle: FileHandle; readonly inPlace: boolean }
  | { readonly kind: "download"; readonly name: string; readonly mimeType: string }
  | { readonly kind: "desktop"; readonly path: string; readonly inPlace: boolean };

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: ReturnType<typeof savePickerTypes>;
  }) => Promise<FileHandle>;
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

const supportsSavePicker = () =>
  typeof (window as SavePickerWindow).showSaveFilePicker === "function";

/**
 * The desktop app's native save dialog (starting in the folder of the desktop
 * document `documentId`), else the browser's, else a download. Null when the
 * user cancels the dialog.
 */
async function pickDestination(
  suggestedName: string,
  format: DocumentFormat,
  documentId: string | null = null,
): Promise<SaveDestination | null> {
  const nativeDialog = window.desktopBridge?.showSaveDialog;
  if (nativeDialog !== undefined) {
    const entry = DOCUMENT_FORMATS[format];
    const path = await nativeDialog({
      suggestedName,
      documentId,
      filter: {
        name: `${entry.label} file`,
        extensions: entry.extensions.map((extension) => extension.slice(1)),
      },
    });
    return path === null ? null : { kind: "desktop", path, inPlace: false };
  }
  if (!supportsSavePicker()) {
    return { kind: "download", name: suggestedName, mimeType: DOCUMENT_FORMATS[format].mimeType };
  }
  try {
    const handle = await (window as SavePickerWindow).showSaveFilePicker!({
      suggestedName,
      types: savePickerTypes(format),
    });
    return { kind: "file", handle, inPlace: false };
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

/**
 * The file the document came from, when the browser lets Quipu write to it:
 * a handle from the picker or a drop, after the browser's permission prompt.
 */
async function inPlaceDestination(document: OpenDocument): Promise<SaveDestination | null> {
  const resolvePath = window.desktopBridge?.documentPath;
  if (document.desktopId !== null && resolvePath !== undefined) {
    const path = await resolvePath(document.desktopId);
    return path === null ? null : { kind: "desktop", path, inPlace: true };
  }
  const handle = document.handle;
  if (handle === null) return null;
  // A handle without the permission API (the private file system's) is writable as it is.
  const state =
    typeof handle.requestPermission === "function"
      ? await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied")
      : "granted";
  return state === "granted" ? { kind: "file", handle, inPlace: true } : null;
}

/** A writable stream whose bytes become a download once it closes, held as blob parts until then. */
function downloadStream(name: string, mimeType: string) {
  let parts: Blob[] = [];
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const stream = new WritableStream<Uint8Array>({
    write: (chunk) => {
      parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]));
    },
    close: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: mimeType }));
      parts = [];
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      // The download reads the blob after the click returns; the URL stays valid a while for it.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      settle.resolve();
    },
    abort: (reason) => {
      parts = [];
      settle.reject(reason);
    },
  });
  return { stream, done };
}

/**
 * The desktop main process's save stream, as the writable stream the engine
 * writes to. The stream crosses into the engine's worker, where its `close`
 * resolves once the worker has handed the bytes over, not once the main process
 * has renamed the file: `done` is what says the file is in place, or why not.
 */
function desktopWritable(save: DesktopSaveStream) {
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const failed = (error: unknown) => {
    settle.reject(error);
    throw error;
  };
  const stream = new WritableStream<Uint8Array>({
    write: (chunk) => save.write(chunk).catch(failed),
    close: async () => {
      await save.close().catch(failed);
      settle.resolve();
    },
    abort: async (reason) => {
      await save.abort().catch(() => {});
      settle.reject(reason ?? new Error("The save was stopped."));
    },
  });
  return { stream, done };
}

/** Runs `write` against the destination's sink and waits until the bytes are where they belong. */
async function writeTo(
  destination: SaveDestination,
  write: (sink: SaveSink) => Promise<number>,
): Promise<number> {
  switch (destination.kind) {
    case "file":
      return write({
        _tag: "fileHandle",
        handle: destination.handle as unknown as FileSystemFileHandle,
      });
    case "download": {
      const download = downloadStream(destination.name, destination.mimeType);
      const bytes = await write({ _tag: "writable", stream: download.stream });
      await download.done;
      return bytes;
    }
    case "desktop": {
      const create = window.desktopBridge?.createSaveStream;
      if (create === undefined) throw new Error("This version of the app can't save to a path.");
      const save = desktopWritable(create(destination.path));
      // The bytes are on disk once the main process answers the close; a refusal arrives there too.
      const [bytes] = await Promise.all([
        write({ _tag: "writable", stream: save.stream }),
        save.done,
      ]);
      return bytes;
    }
  }
}

/**
 * The journal key the file a save in place wrote opens under next time, so the
 * edits made after the save are offered back from there; null when it cannot be told.
 */
async function savedJournalKey(
  destination: SaveDestination,
  document: OpenDocument,
): Promise<string | null> {
  if (destination.kind === "file") return journalKeyOf(await destination.handle.getFile());
  if (destination.kind !== "desktop" || document.desktopId === null) return null;
  const stamp = await window.desktopBridge?.documentStamp?.(document.desktopId);
  return stamp ? desktopJournalKey({ id: document.desktopId, ...stamp }) : null;
}

const destinationName = (destination: SaveDestination) =>
  destination.kind === "file"
    ? destination.handle.name
    : destination.kind === "download"
      ? destination.name
      : (destination.path.split(/[\\/]/).pop() ?? destination.path);

const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "An unexpected error occurred.";

const openDocument = (): OpenDocument | null => {
  const { session } = useDocumentSession.getState();
  return session.phase === "open" ? session.document : null;
};

/** The name a Save As suggests: the document's own, with an extension when it has none. */
const saveAsName = (document: OpenDocument) =>
  document.name.includes(".") ? document.name : nameWithExtension(document.name, document.format);

/**
 * A byte of the selected node in the document's bytes, which are the saved
 * file's: the last byte of its value, which only that node and its parents hold.
 */
const selectedOffset = (documentId: number): number | null => {
  const selection = useSelectionStore.getState().selection;
  return selection !== null && selection.documentId === documentId
    ? Math.max(selection.range.start, selection.range.end - 1)
    : null;
};

/**
 * Selects again, in the document reopened from the saved file, the node that
 * was selected before the save: the views and the keyboard come back to it.
 */
async function selectAgain(offset: number | null): Promise<void> {
  const reopened = openDocument();
  if (offset === null || reopened === null) return;
  const found = await reopened.source.nodeAt(offset).catch(() => null);
  const innermost = found?.path[found.path.length - 1];
  if (found === null || innermost === undefined || openDocument() !== reopened) return;
  useSelectionStore.getState().select({
    documentId: reopened.documentId,
    ref: innermost.node.ref,
    range: nodeBytes(innermost.node),
    origin: "edit",
    path: found.path,
  });
}

/**
 * Save writes the document back where it came from when the browser allows it,
 * and otherwise behaves as Save As: the save dialog, or a download where there
 * is none. A save to a file reopens the document from it, so what is open is
 * what is on disk (the file Quipu was reading has changed under it).
 */
export async function saveOpenDocument(mode: "save" | "saveAs"): Promise<void> {
  const document = openDocument();
  if (document === null) return;
  // Asked for by the unsaved-changes question: what comes next replaces the document.
  const leaving = savingBeforeLeaving(document.documentId);
  let destination: SaveDestination | null = null;
  const tracked = trackSave(document.documentId);
  let saved = false;
  try {
    destination =
      (mode === "save" ? await inPlaceDestination(document) : null) ??
      (await pickDestination(saveAsName(document), document.format, document.desktopId));
    if (destination === null) return;
    const client = getDocumentFileClient(document.documentId);
    // Writing over the file the document reads would leave it unreadable to the browser (a
    // `File` of a replaced file cannot be read); the engine moves onto a copy first, so the
    // document, its history and Undo carry on after the save.
    if (destination.kind === "file" && destination.inPlace) await client.detach();
    const inPlace = destination.kind !== "download" && destination.inPlace;
    let written = false;
    try {
      await writeTo(destination, async (sink) => {
        const bytes = await client.save(sink, inPlace);
        written = true;
        return bytes;
      });
    } finally {
      // Edits from here on belong to the saved file: they are journaled under its key.
      if (inPlace && written) {
        const key = await savedJournalKey(destination, document).catch(() => null);
        await client.rekeyJournal(key).catch(() => {});
      }
    }
    saved = true;
    // A save in place keeps the document as it is, history and all: what is on disk is the
    // document at its save point. A save to another file makes that file the document, under
    // that file's identity (recents and the edit journal), so it opens from it. Saved for the
    // unsaved-changes question, the next document (or the window closing) follows instead.
    if (!leaving && destination.kind === "file") {
      const handle = destination.handle;
      if (destination.inPlace) {
        const saved = await handle.getFile();
        void useRecentDocuments.getState().record(saved, handle);
        const now = useDocumentSession.getState().session;
        if (now.phase === "open" && now.document.documentId === document.documentId) {
          useDocumentSession.setState({
            session: { phase: "open", document: { ...now.document, file: saved } },
          });
        }
      }
      if (!destination.inPlace) {
        // The new file opens: the node that was selected is selected again in it.
        const kept = selectedOffset(document.documentId);
        await useDocumentSession.getState().openFile(await handle.getFile(), handle);
        await selectAgain(kept);
      }
    } else if (!leaving && destination.kind === "desktop" && !destination.inPlace) {
      // The main process opens the new file and posts it back like any opened document.
      await window.desktopBridge?.openDocumentPath?.(destination.path);
    }
    toastManager.add({
      type: "success",
      title: `Saved ${destinationName(destination)}`,
      timeout: 2500,
    });
  } catch (error) {
    toastManager.add(
      stackedToast({
        type: "error",
        title: `Could not save ${destination === null ? document.name : destinationName(destination)}`,
        description: messageOf(error),
      }),
    );
  } finally {
    tracked.end(saved);
  }
}

export type ExportOutcome =
  | { readonly kind: "done"; readonly name: string }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "refused";
      readonly message: string;
      /** The JSON Pointer of the node the target could not hold. */
      readonly pointer: string | null;
      readonly line: number | null;
    };

const isConvertError = (error: unknown): error is ConvertError =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "ConvertError";

/** Converts the open document into a new file (or a download). The document itself is not saved by it. */
export async function exportOpenDocument(
  to: ConvertFormat,
  settings: ConvertSettings,
): Promise<ExportOutcome> {
  const document = openDocument();
  if (document === null) return { kind: "cancelled" };
  try {
    const destination = await pickDestination(
      nameWithExtension(document.name, to),
      to,
      document.desktopId,
    );
    if (destination === null) return { kind: "cancelled" };
    const client = getDocumentFileClient(document.documentId);
    await writeTo(destination, (sink) => client.convert(to, settings, sink));
    const name = destinationName(destination);
    toastManager.add({ type: "success", title: `Exported ${name}`, timeout: 2500 });
    return { kind: "done", name };
  } catch (error) {
    if (isConvertError(error)) {
      return { kind: "refused", message: error.detail, pointer: error.pointer, line: error.line };
    }
    return { kind: "refused", message: messageOf(error), pointer: null, line: null };
  }
}
