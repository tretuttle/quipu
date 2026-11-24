import type { DesktopRecentDocument } from "@quipu/contracts";
import { pushRecentDocument } from "@quipu/shared/recentDocuments";
import { create } from "zustand";

import { documentStorage, type DocumentRecord } from "./documentDatabase.ts";
import type { FileHandle } from "./fileSystemAccess.ts";
import { fingerprintFile } from "./fingerprint.ts";

/** A file with no handle is kept whole in the origin's private file system when it is this small. */
const COPY_LIMIT_BYTES = 8 * 1024 * 1024;
/** `isSameEntry` is the only way to recognize a picked file, so handles outlive their list rows. */
const MAX_RETAINED_HANDLES = 200;
const COPY_DIRECTORY = "quipu-recent-copies";
/** This tab's open document, by recent id: what a reload opens again. */
const OPEN_DOCUMENT_KEY = "quipu:open-document";

/** Marks the recent that is open in this tab, or clears the mark when nothing is. */
export function markOpenDocument(id: string | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(OPEN_DOCUMENT_KEY);
    else window.sessionStorage.setItem(OPEN_DOCUMENT_KEY, id);
  } catch {
    // Without session storage a reload starts empty.
  }
}

/** The recent that was open in this tab before the page loaded, if any. */
export function markedOpenDocument(): string | null {
  try {
    return window.sessionStorage.getItem(OPEN_DOCUMENT_KEY);
  } catch {
    return null;
  }
}

export interface RecentDocument {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly lastOpenedAt: number;
}

/** The key an open document has for this recent's file (see `OpenDocument.fileKey`). */
export const recentFileKey = (recent: RecentDocument) =>
  `${recent.name}:${recent.size}:${recent.lastModified}`;

export interface RecordOptions {
  /**
   * The file came back through Back or Forward: it keeps its place in the
   * list, and one the user removed from the list stays out of it.
   */
  readonly keepOrder?: boolean;
}

interface RecentsState {
  readonly documents: ReadonlyArray<RecentDocument>;
  /** False when this session keeps its list in memory only. */
  readonly durable: boolean;
  readonly hydrate: () => Promise<void>;
  /** Remembers an opened file; the desktop's main process does this itself for what it opens. */
  readonly record: (
    file: File,
    handle: FileHandle | null,
    options?: RecordOptions,
  ) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

const desktop = () => window.desktopBridge;

const toRecent = (record: DocumentRecord | DesktopRecentDocument): RecentDocument => ({
  id: record.id,
  name: record.name,
  size: record.size,
  lastModified: record.lastModified,
  lastOpenedAt: record.lastOpenedAt,
});

/** The handles seen this session: re-asking permission must start from a click with nothing awaited. */
const sessionHandles = new Map<string, FileHandle>();
const sessionFiles = new Map<string, File>();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** 128 random bits as hex: the id of a document whose handle the browser gave us. */
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer);

async function identify(file: File, handle: FileHandle | null) {
  const storage = await documentStorage();
  if (handle !== null) {
    for (const known of await storage.handles()) {
      try {
        if (await known.handle.isSameEntry(handle))
          return { id: known.documentId, kind: "handle" as const };
      } catch {
        // A handle the browser no longer honors cannot match.
      }
    }
    return { id: `handle:${randomToken()}`, kind: "handle" as const };
  }
  return { id: `blob:${await fingerprintFile(file)}`, kind: "blob" as const };
}

async function copyDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(COPY_DIRECTORY, { create: true });
}

const copyName = (id: string) => id.replace(/[^a-z0-9]/gi, "_");

async function storeCopy(id: string, file: File) {
  try {
    const directory = await copyDirectory();
    // A blob id is the file's fingerprint: a copy under it already holds these bytes. Writing it
    // again would also make a File read from it (a reopened recent, open in the engine) unreadable.
    const existing = await directory.getFileHandle(copyName(id)).catch(() => null);
    if (existing !== null && (await existing.getFile()).size === file.size) return true;
    const handle = await directory.getFileHandle(copyName(id), { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

async function readCopy(id: string, name: string, lastModified: number): Promise<File | null> {
  try {
    const directory = await copyDirectory();
    const handle = await directory.getFileHandle(copyName(id));
    const stored = await handle.getFile();
    return new File([stored], name, { lastModified });
  } catch {
    return null;
  }
}

async function dropCopies(ids: ReadonlyArray<string>) {
  try {
    const directory = await copyDirectory();
    for (const id of ids) await directory.removeEntry(copyName(id)).catch(() => undefined);
  } catch {
    // Nothing was stored.
  }
}

export const useRecentDocuments = create<RecentsState>((set, get) => {
  let hydrated: Promise<void> | null = null;
  return {
    documents: [],
    durable: true,
    hydrate: () => {
      hydrated ??= (async () => {
        const bridge = desktop();
        if (bridge) {
          set({ documents: (await bridge.getRecentDocuments()).map(toRecent) });
          bridge.onRecentDocumentsChange((documents) =>
            set({ documents: documents.map(toRecent) }),
          );
          return;
        }
        const storage = await documentStorage();
        const records = await storage.documents();
        set({
          durable: storage.durable,
          documents: records.map(toRecent).toSorted((a, b) => b.lastOpenedAt - a.lastOpenedAt),
        });
      })();
      return hydrated;
    },
    record: async (file, handle, options = {}) => {
      const bridge = desktop();
      if (bridge) {
        // A pasted file has no path and no id: a reload cannot bring it back.
        markOpenDocument(await bridge.recordOpenedFile(file));
        return;
      }
      await get().hydrate();
      const storage = await documentStorage();
      const { id, kind } = await identify(file, handle);
      const keepCopy =
        handle === null && file.size <= COPY_LIMIT_BYTES && (await storeCopy(id, file));
      if (handle !== null) {
        sessionHandles.set(id, handle);
        await storage.putHandle(id, handle);
      } else if (!keepCopy) {
        sessionFiles.set(id, file);
      }
      const current = (await storage.documents()) as ReadonlyArray<DocumentRecord>;
      const listed = current.find((row) => row.id === id);
      if (options.keepOrder === true && listed === undefined) {
        markOpenDocument(id);
        return;
      }
      const entry: DocumentRecord = {
        schemaVersion: 1,
        id,
        kind,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        lastOpenedAt:
          options.keepOrder === true && listed !== undefined ? listed.lastOpenedAt : Date.now(),
        hasCopy: keepCopy,
      };
      const { list, evicted } = pushRecentDocument(current, entry);
      await storage.putDocument(entry);
      markOpenDocument(id);
      if (evicted.length > 0) {
        await storage.deleteDocuments(evicted.map((row) => row.id));
        await dropCopies(evicted.filter((row) => row.hasCopy).map((row) => row.id));
        const retained = await storage.handles();
        const overflow = retained.length - MAX_RETAINED_HANDLES;
        if (overflow > 0) {
          const listed = new Set(list.map((row) => row.id));
          const removable: string[] = [];
          for (const held of retained) {
            if (listed.has(held.documentId) || removable.length >= overflow) continue;
            if (!(await storage.hasDrawing(held.documentId))) removable.push(held.documentId);
          }
          await storage.deleteHandles(removable);
        }
      }
      set({ documents: list.map(toRecent) });
    },
    remove: async (id) => {
      const bridge = desktop();
      if (bridge) {
        // The main process publishes the shorter list back through onRecentDocumentsChange.
        await bridge.removeRecentDocument(id);
        return;
      }
      const storage = await documentStorage();
      const removed = (await storage.documents()).find((row) => row.id === id);
      await storage.deleteDocuments([id]);
      if (removed?.hasCopy) await dropCopies([id]);
      if (!(await storage.hasDrawing(id))) await storage.deleteHandles([id]);
      sessionHandles.delete(id);
      sessionFiles.delete(id);
      set({ documents: get().documents.filter((row) => row.id !== id) });
    },
    clear: async () => {
      const bridge = desktop();
      if (bridge) {
        await bridge.clearRecentDocuments();
        return;
      }
      const storage = await documentStorage();
      const rows = await storage.documents();
      await storage.deleteDocuments(rows.map((row) => row.id));
      await dropCopies(rows.filter((row) => row.hasCopy).map((row) => row.id));
      const keep: string[] = [];
      for (const held of await storage.handles()) {
        if (!(await storage.hasDrawing(held.documentId))) keep.push(held.documentId);
      }
      await storage.deleteHandles(keep);
      sessionHandles.clear();
      sessionFiles.clear();
      set({ documents: [] });
    },
  };
});

export type ReopenOutcome =
  | { readonly kind: "file"; readonly file: File; readonly handle: FileHandle | null }
  /** The browser wants the user to allow access again; `ask` must run from a click. */
  | { readonly kind: "needs-permission"; readonly name: string; readonly handle: FileHandle }
  | { readonly kind: "denied" | "missing"; readonly name: string }
  | { readonly kind: "desktop" };

/**
 * Reopens a recent document. On the desktop the main process stages the file
 * itself. On the web a handle is queried for permission: granted opens it,
 * and "prompt" returns `needs-permission` so the caller can show a button whose
 * click calls `requestPermission` with nothing awaited before it.
 */
export async function reopenRecent(id: string): Promise<ReopenOutcome> {
  const bridge = desktop();
  if (bridge) {
    await bridge.openRecentDocument(id);
    return { kind: "desktop" };
  }
  const row = (await (await documentStorage()).documents()).find(
    (candidate) => candidate.id === id,
  );
  if (row === undefined) return { kind: "missing", name: id };
  const session = sessionFiles.get(id);
  if (session !== undefined) return { kind: "file", file: session, handle: null };
  const handle = sessionHandles.get(id) ?? (await (await documentStorage()).getHandle(id));
  if (handle !== null) {
    sessionHandles.set(id, handle);
    const state = await handle.queryPermission({ mode: "read" });
    if (state === "granted") {
      // A file moved or deleted since keeps its handle, which then cannot be read.
      const file = await handle.getFile().catch(() => null);
      return file === null ? { kind: "missing", name: row.name } : { kind: "file", file, handle };
    }
    if (state === "prompt") return { kind: "needs-permission", name: row.name, handle };
    return { kind: "denied", name: row.name };
  }
  if (row.hasCopy) {
    const file = await readCopy(id, row.name, row.lastModified);
    if (file !== null) return { kind: "file", file, handle: null };
  }
  return { kind: "missing", name: row.name };
}
