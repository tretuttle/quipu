/**
 * The web journal store: OPFS through sync access handles, which only exist in
 * a dedicated worker, so this runs in the engine coordinator. One handle per
 * file stays open while a document is open (a second handle on the same file
 * fails, which is what keeps a second tab from writing the same log). `flush`
 * after every write is the durability call. A file is replaced by writing a
 * `.tmp` sibling and `move`-ing it over the target.
 */
import type { JournalStore } from "./journalStore.ts";

/** The sync access handle surface this store uses (the DOM lib does not declare it; the worker lib does). */
interface SyncAccessHandle {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface OpfsWritableFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
  move(name: string): Promise<void>;
}

/**
 * How long a journal waits for another context to let it go. A page that was
 * reloaded lets go as soon as the browser tears its worker down; one still held
 * after this belongs to a tab that has the same file open.
 */
const JOURNAL_LOCK_WAIT_MS = 10_000;

export const opfsJournalStore = (): JournalStore => {
  const handles = new Map<string, SyncAccessHandle>();
  /** Releases of the journal locks this context holds, by directory. */
  const held = new Map<string, () => void>();
  const root = () => navigator.storage.getDirectory();

  const directory = async (parts: string[], create: boolean) => {
    let dir = await root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  };
  const split = (path: string) => {
    const parts = path.split("/").filter((p) => p.length > 0);
    return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] as string };
  };
  const file = async (path: string, create: boolean) => {
    const { dirs, name } = split(path);
    const dir = await directory(dirs, create);
    return (await dir.getFileHandle(name, { create })) as OpfsWritableFileHandle;
  };
  const handle = async (path: string, create: boolean) => {
    let open = handles.get(path);
    if (!open) {
      open = await (await file(path, create)).createSyncAccessHandle();
      handles.set(path, open);
    }
    return open;
  };
  const exists = async (path: string) => {
    try {
      await file(path, false);
      return true;
    } catch {
      return false;
    }
  };
  const closeUnder = (path: string) => {
    for (const [key, open] of handles) {
      if (key === path || key.startsWith(`${path}/`)) {
        open.close();
        handles.delete(key);
      }
    }
  };

  return {
    size: async (path) => {
      if (handles.has(path)) return (handles.get(path) as SyncAccessHandle).getSize();
      if (!(await exists(path))) return -1;
      return (await handle(path, false)).getSize();
    },
    read: async (path, start, end) => {
      const open = await handle(path, false);
      const size = open.getSize();
      const from = Math.min(start, size);
      const to = Math.min(end, size);
      const out = new Uint8Array(Math.max(0, to - from));
      if (out.byteLength > 0) open.read(out, { at: from });
      return out;
    },
    append: async (path, bytes) => {
      const open = await handle(path, true);
      open.write(bytes, { at: open.getSize() });
      open.flush();
    },
    truncate: async (path, size) => {
      const open = await handle(path, true);
      open.truncate(size);
      open.flush();
    },
    replace: async (path, bytes) => {
      const { dirs, name } = split(path);
      const dir = await directory(dirs, true);
      const tmpName = `${name}.tmp`;
      closeUnder(`${dirs.join("/")}/${tmpName}`);
      const tmp = (await dir.getFileHandle(tmpName, { create: true })) as OpfsWritableFileHandle;
      const open = await tmp.createSyncAccessHandle();
      open.truncate(0);
      open.write(bytes, { at: 0 });
      open.flush();
      open.close();
      closeUnder(path);
      await tmp.move(name);
    },
    remove: async (path) => {
      closeUnder(path);
      const { dirs, name } = split(path);
      try {
        const dir = await directory(dirs, false);
        await dir.removeEntry(name, { recursive: true });
      } catch {
        // Already gone.
      }
    },
    list: async (path) => {
      try {
        const dir = await directory(
          path.split("/").filter((p) => p.length > 0),
          false,
        );
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
          names.push(name);
        return names;
      } catch {
        return [];
      }
    },
    blob: async (path) => (await file(path, false)).getFile(),
    close: (path) => {
      closeUnder(path);
      return Promise.resolve();
    },
    // One context at a time per journal: its sync access handles are exclusive, and a page that
    // was reloaded keeps them until the browser has torn its worker down. The lock goes with it.
    acquire: (path) =>
      new Promise<void>((granted, refused) => {
        navigator.locks
          .request(
            `quipu:journal:${path}`,
            { signal: AbortSignal.timeout(JOURNAL_LOCK_WAIT_MS) },
            () => {
              granted();
              return new Promise<void>((release) => held.set(path, release));
            },
          )
          .catch(refused);
      }),
    release: (path) => {
      held.get(path)?.();
      held.delete(path);
    },
  };
};
