import type { FileHandle } from "./fileSystemAccess.ts";

/**
 * The `quipu` IndexedDB database, version 1. This module reads and writes
 * `documents` and `handles`; `drawings` and `assets` belong to the drawing
 * code but are created here so the version never has to change for them.
 * Upgrades create what is missing and delete nothing.
 */
const DATABASE_NAME = "quipu";
const DATABASE_VERSION = 1;
const SCHEMA_VERSION = 1;

export interface DocumentRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: "handle" | "blob";
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly lastOpenedAt: number;
  /** The bytes are kept in the origin's private file system (a paste, or a file with no handle). */
  readonly hasCopy: boolean;
}

interface HandleRecord {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly handle: FileHandle;
}

export interface DocumentStorage {
  /** False when IndexedDB is unavailable and this session keeps its list in memory. */
  readonly durable: boolean;
  documents(): Promise<ReadonlyArray<DocumentRecord>>;
  putDocument(record: Omit<DocumentRecord, "schemaVersion">): Promise<void>;
  deleteDocuments(ids: ReadonlyArray<string>): Promise<void>;
  handles(): Promise<ReadonlyArray<{ documentId: string; handle: FileHandle }>>;
  getHandle(documentId: string): Promise<FileHandle | null>;
  putHandle(documentId: string, handle: FileHandle): Promise<void>;
  deleteHandles(documentIds: ReadonlyArray<string>): Promise<void>;
  /** A document that has a drawing keeps its handle when it leaves the recents list. */
  hasDrawing(documentId: string): Promise<boolean>;
}

const STORES = [
  ["documents", "id"],
  ["handles", "documentId"],
  ["drawings", "documentId"],
  ["assets", "id"],
] as const;

function memoryStorage(): DocumentStorage {
  const documents = new Map<string, DocumentRecord>();
  const handles = new Map<string, FileHandle>();
  return {
    durable: false,
    documents: async () => [...documents.values()],
    putDocument: async (record) => {
      documents.set(record.id, { ...record, schemaVersion: SCHEMA_VERSION });
    },
    deleteDocuments: async (ids) => {
      for (const id of ids) documents.delete(id);
    },
    handles: async () => [...handles].map(([documentId, handle]) => ({ documentId, handle })),
    getHandle: async (id) => handles.get(id) ?? null,
    putHandle: async (id, handle) => {
      handles.set(id, handle);
    },
    deleteHandles: async (ids) => {
      for (const id of ids) handles.delete(id);
    },
    hasDrawing: async () => false,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const [name, keyPath] of STORES) {
        if (!database.objectStoreNames.contains(name))
          database.createObjectStore(name, { keyPath });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // Another tab upgrading must not wait on this connection.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The Quipu database is blocked by another tab."));
  });
}

function run<T>(
  database: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    const request = work(transaction);
    // A commit that fails (a full disk, `QuotaExceededError`) aborts and fires no `error`.
    transaction.onabort = () => reject(transaction.error ?? new Error("The transaction aborted."));
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
  });
}

/**
 * Boards keep their records in the same `documents` store (kind "board"); the
 * recent-documents list, its eviction and its clear see only opened files.
 */
const isFileRecord = (record: { readonly kind: string }): record is DocumentRecord =>
  record.kind === "handle" || record.kind === "blob";

async function databaseStorage(): Promise<DocumentStorage> {
  const database = await openDatabase();
  return {
    durable: true,
    documents: async () =>
      (
        ((await run(database, ["documents"], "readonly", (t) =>
          t.objectStore("documents").getAll(),
        )) ?? []) as Array<{ readonly kind: string }>
      ).filter(isFileRecord),
    putDocument: async (record) => {
      await run(database, ["documents"], "readwrite", (t) => {
        t.objectStore("documents").put({ ...record, schemaVersion: SCHEMA_VERSION });
      });
    },
    deleteDocuments: async (ids) => {
      await run(database, ["documents"], "readwrite", (t) => {
        for (const id of ids) t.objectStore("documents").delete(id);
      });
    },
    handles: async () => {
      const rows = ((await run(database, ["handles"], "readonly", (t) =>
        t.objectStore("handles").getAll(),
      )) ?? []) as HandleRecord[];
      return rows.map(({ documentId, handle }) => ({ documentId, handle }));
    },
    getHandle: async (documentId) => {
      const row = (await run(database, ["handles"], "readonly", (t) =>
        t.objectStore("handles").get(documentId),
      )) as HandleRecord | undefined;
      return row?.handle ?? null;
    },
    putHandle: async (documentId, handle) => {
      await run(database, ["handles"], "readwrite", (t) => {
        t.objectStore("handles").put({ schemaVersion: SCHEMA_VERSION, documentId, handle });
      });
    },
    deleteHandles: async (ids) => {
      await run(database, ["handles"], "readwrite", (t) => {
        for (const id of ids) t.objectStore("handles").delete(id);
      });
    },
    hasDrawing: async (documentId) =>
      (await run(database, ["drawings"], "readonly", (t) =>
        t.objectStore("drawings").count(documentId),
      )) !== 0,
  };
}

let shared: Promise<DocumentStorage> | null = null;

/** The one connection this window uses; memory-only when IndexedDB cannot open. */
export function documentStorage(): Promise<DocumentStorage> {
  shared ??= (async () => {
    if (typeof indexedDB === "undefined") return memoryStorage();
    try {
      return await databaseStorage();
    } catch (error) {
      console.error("IndexedDB is unavailable; recents last for this session only.", error);
      return memoryStorage();
    }
  })();
  return shared;
}
