/**
 * Where edit journals live: a directory per document under
 * `journals/<kind>/<id>/`, holding small files the engine appends to and
 * replaces atomically. The store is a handful of byte operations so one journal
 * implementation runs over OPFS (a dedicated worker's sync access handles), the
 * desktop state directory (Node's fs in the main process, reached over a
 * MessagePort), and memory (tests). Durability is the store's: OPFS flushes,
 * the desktop syncs.
 */
export interface JournalStore {
  /** Size of a file, or -1 when it does not exist. */
  size(path: string): Promise<number>;
  /** Bytes [start, end) of a file (clipped to its size). */
  read(path: string, start: number, end: number): Promise<Uint8Array>;
  /** Appends bytes to a file (creating it) and makes them durable. */
  append(path: string, bytes: Uint8Array): Promise<void>;
  /** Cuts a file to `size` bytes and makes that durable. */
  truncate(path: string, size: number): Promise<void>;
  /** Replaces a file's content atomically (a temp file moved over it). */
  replace(path: string, bytes: Uint8Array): Promise<void>;
  /** Removes a file or a whole directory; a missing path is fine. */
  remove(path: string): Promise<void>;
  /** Names in a directory, or [] when it does not exist. */
  list(path: string): Promise<string[]>;
  /** A Blob over a file, when the store can hand one out (OPFS can; a port cannot). Workers read spill files through it. */
  blob?(path: string): Promise<Blob>;
  /** Releases handles the store keeps for a directory. */
  close(path: string): Promise<void>;
  /**
   * Waits until no other context (another tab, or the page this one replaced on a
   * reload) holds the journal in directory `path`, then holds it until `release`.
   * Rejects when it stays held too long. A store only this context can reach leaves it out.
   */
  acquire?(path: string): Promise<void>;
  /** Lets the journal in `path` go; nothing happens when it is not held. */
  release?(path: string): void;
}

/** An in-memory store for tests; `crashAfterWrites` lets a test cut the power after N durable writes. */
export const memoryJournalStore = (): JournalStore & {
  readonly files: Map<string, Uint8Array>;
  /** Throws from the next durable write once the counter reaches zero. */
  failAfter: number;
} => {
  const files = new Map<string, Uint8Array>();
  const store = {
    files,
    failAfter: Number.POSITIVE_INFINITY,
    size: (path: string) => Promise.resolve(files.get(path)?.byteLength ?? -1),
    read: (path: string, start: number, end: number) => {
      const file = files.get(path) ?? new Uint8Array(0);
      return Promise.resolve(
        file.slice(Math.min(start, file.byteLength), Math.min(end, file.byteLength)),
      );
    },
    append: (path: string, bytes: Uint8Array) => {
      const file = files.get(path) ?? new Uint8Array(0);
      const grown = new Uint8Array(file.byteLength + bytes.byteLength);
      grown.set(file);
      grown.set(bytes, file.byteLength);
      return store.durable(() => files.set(path, grown));
    },
    truncate: (path: string, size: number) =>
      store.durable(() => files.set(path, (files.get(path) ?? new Uint8Array(0)).slice(0, size))),
    replace: (path: string, bytes: Uint8Array) =>
      store.durable(() => files.set(path, bytes.slice())),
    remove: (path: string) => {
      for (const key of Array.from(files.keys()))
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      return Promise.resolve();
    },
    list: (path: string) => {
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(`${path}/`))
          names.add(key.slice(path.length + 1).split("/")[0] as string);
      }
      return Promise.resolve([...names]);
    },
    blob: (path: string) =>
      Promise.resolve(
        new Blob([(files.get(path) ?? new Uint8Array(0)) as Uint8Array<ArrayBuffer>]),
      ),
    close: () => Promise.resolve(),
    durable: (write: () => void) => {
      if (store.failAfter <= 0) return Promise.reject(new Error("the store lost power"));
      store.failAfter--;
      write();
      return Promise.resolve();
    },
  };
  return store;
};

/** The request/reply protocol a store speaks over a MessagePort (worker → renderer → desktop main). */
export type JournalStoreRequest =
  | { readonly op: "size"; readonly path: string }
  | { readonly op: "read"; readonly path: string; readonly start: number; readonly end: number }
  | { readonly op: "append"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly op: "truncate"; readonly path: string; readonly size: number }
  | { readonly op: "replace"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "list"; readonly path: string }
  | { readonly op: "close"; readonly path: string };

export interface JournalPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  start?(): void;
}

interface PortEnvelope {
  readonly id: number;
  readonly request: JournalStoreRequest;
}
type PortReply =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The client end: a store whose every call is one round trip on the port. */
export const portJournalStore = (port: JournalPortLike): JournalStore => {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  port.addEventListener("message", (event) => {
    const reply = event.data as PortReply;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new Error(reply.error));
  });
  port.start?.();
  const call = <T>(request: JournalStoreRequest, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ id, request } satisfies PortEnvelope, transfer);
    });
  return {
    size: (path) => call<number>({ op: "size", path }),
    read: (path, start, end) => call<Uint8Array>({ op: "read", path, start, end }),
    append: (path, bytes) => call<void>({ op: "append", path, bytes }),
    truncate: (path, size) => call<void>({ op: "truncate", path, size }),
    replace: (path, bytes) => call<void>({ op: "replace", path, bytes }),
    remove: (path) => call<void>({ op: "remove", path }),
    list: (path) => call<string[]>({ op: "list", path }),
    close: (path) => call<void>({ op: "close", path }),
  };
};

/** The server end: answers a port's requests with a real store. */
export const serveJournalStore = (port: JournalPortLike, store: JournalStore) => {
  port.addEventListener("message", async (event) => {
    const { id, request } = event.data as PortEnvelope;
    try {
      const result = await dispatch(store, request);
      const transfer =
        result instanceof Uint8Array && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
      port.postMessage({ id, ok: true, result } satisfies PortReply, transfer);
    } catch (error) {
      port.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PortReply);
    }
  });
  port.start?.();
};

const dispatch = (store: JournalStore, request: JournalStoreRequest): Promise<unknown> => {
  switch (request.op) {
    case "size":
      return store.size(request.path);
    case "read":
      return store.read(request.path, request.start, request.end).then((bytes) => bytes.slice());
    case "append":
      return store.append(request.path, request.bytes);
    case "truncate":
      return store.truncate(request.path, request.size);
    case "replace":
      return store.replace(request.path, request.bytes);
    case "remove":
      return store.remove(request.path);
    case "list":
      return store.list(request.path);
    case "close":
      return store.close(request.path);
  }
};
