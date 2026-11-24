/**
 * The `quipu` IndexedDB database: `documents`, `handles`, `drawings` and
 * `assets`. It is opened with raw `indexedDB.open`, an upgrade that creates
 * missing stores and never deletes unknown ones, `versionchange` closing the
 * connection so another tab can upgrade, and writes that listen for `abort`
 * because a failed commit (QuotaExceededError) fires no `error`.
 */
const DATABASE_NAME = "quipu";
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const HANDLES_STORE = "handles";
const DRAWINGS_STORE = "drawings";
const ASSETS_STORE = "assets";
/**
 * Every store keys on a field of its record, the same shape
 * documents/documentDatabase.ts creates; whichever module opens first creates
 * them, so the two must agree.
 */
const STORES = [
  [DOCUMENTS_STORE, "id"],
  [HANDLES_STORE, "documentId"],
  [DRAWINGS_STORE, "documentId"],
  [ASSETS_STORE, "id"],
] as const;

/** One scene is at most 32 MiB of UTF-8 JSON; one asset at most 16 MiB. */
export const MAX_SCENE_BYTES = 33_554_432;
export const MAX_ASSET_BYTES = 16_777_216;

export interface DocumentRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: "board";
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly lastOpenedAt: number;
}

export interface DrawingRecord {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly updatedAt: number;
  readonly sceneSchemaVersion: number;
  readonly sceneJson: string;
}

export interface AssetRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mime: string;
  readonly byteLength: number;
  readonly bytes: Blob;
}

export class BoardsStorageError extends Error {
  override readonly name = "BoardsStorageError";
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super(`Could not ${operation}: ${String(cause)}`);
    this.operation = operation;
  }
}

let shared: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new BoardsStorageError("open", "IndexedDB is unavailable in this browser context."));
      return;
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        for (const [store, keyPath] of STORES) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store, { keyPath });
          }
        }
      });
      request.addEventListener("error", () => {
        reject(new BoardsStorageError("open", request.error ?? "Unknown IndexedDB error"));
      });
      request.addEventListener("success", () => resolve(request.result));
    } catch (cause) {
      reject(new BoardsStorageError("open", cause));
    }
  });
}

/** The shared connection, reopened after the browser or another tab closes it. */
async function getDatabase(): Promise<IDBDatabase> {
  if (shared !== null) return shared;
  if (opening !== null) return opening;
  opening = openDatabase()
    .then((database) => {
      shared = database;
      const forget = () => {
        if (shared === database) shared = null;
      };
      database.addEventListener("close", forget);
      database.addEventListener("versionchange", () => {
        forget();
        database.close();
      });
      return database;
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

/**
 * Runs `use` on the shared connection; a connection the browser already
 * closed throws InvalidStateError, so that case drops it and retries once.
 */
async function withDatabase<A>(use: (database: IDBDatabase) => Promise<A>): Promise<A> {
  const database = await getDatabase();
  try {
    return await use(database);
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      if (shared === database) shared = null;
      return use(await getDatabase());
    }
    throw error;
  }
}

function read<A>(store: string, key: IDBValidKey): Promise<A | null> {
  return withDatabase(
    (database) =>
      new Promise<A | null>((resolve, reject) => {
        try {
          const request = database.transaction(store, "readonly").objectStore(store).get(key);
          request.addEventListener("error", () =>
            reject(new BoardsStorageError(`read ${store}`, request.error ?? "Unknown error")),
          );
          request.addEventListener("success", () => resolve((request.result as A) ?? null));
        } catch (cause) {
          reject(new BoardsStorageError(`read ${store}`, cause));
        }
      }),
  );
}

function readAll<A>(store: string): Promise<A[]> {
  return withDatabase(
    (database) =>
      new Promise<A[]>((resolve, reject) => {
        try {
          const request = database.transaction(store, "readonly").objectStore(store).getAll();
          request.addEventListener("error", () =>
            reject(new BoardsStorageError(`list ${store}`, request.error ?? "Unknown error")),
          );
          request.addEventListener("success", () => resolve(request.result as A[]));
        } catch (cause) {
          reject(new BoardsStorageError(`list ${store}`, cause));
        }
      }),
  );
}

/** Writes a record; its key is the field the store keys on. */
function write(store: string, value: unknown): Promise<void> {
  return withDatabase(
    (database) =>
      new Promise<void>((resolve, reject) => {
        try {
          const transaction = database.transaction(store, "readwrite");
          // Every failed write fires "abort"; a failed commit such as
          // QuotaExceededError fires only "abort" and no "error".
          transaction.addEventListener("abort", () =>
            reject(new BoardsStorageError(`write ${store}`, transaction.error ?? "Unknown error")),
          );
          transaction.addEventListener("complete", () => resolve());
          transaction.objectStore(store).put(value);
        } catch (cause) {
          reject(new BoardsStorageError(`write ${store}`, cause));
        }
      }),
  );
}

function remove(store: string, key: IDBValidKey): Promise<void> {
  return withDatabase(
    (database) =>
      new Promise<void>((resolve, reject) => {
        try {
          const transaction = database.transaction(store, "readwrite");
          transaction.addEventListener("abort", () =>
            reject(new BoardsStorageError(`delete ${store}`, transaction.error ?? "Unknown error")),
          );
          transaction.addEventListener("complete", () => resolve());
          transaction.objectStore(store).delete(key);
        } catch (cause) {
          reject(new BoardsStorageError(`delete ${store}`, cause));
        }
      }),
  );
}

export function deleteDocument(id: string): Promise<void> {
  return remove(DOCUMENTS_STORE, id);
}

/** Every saved drawing: boards and the drawing layers over documents. */
export function listDrawings(): Promise<DrawingRecord[]> {
  return readAll<DrawingRecord>(DRAWINGS_STORE);
}

export function deleteDrawing(documentId: string): Promise<void> {
  return remove(DRAWINGS_STORE, documentId);
}

export function deleteAsset(id: string): Promise<void> {
  return remove(ASSETS_STORE, id);
}

export function listDocuments(): Promise<DocumentRecord[]> {
  return readAll<DocumentRecord>(DOCUMENTS_STORE);
}

export function putDocument(record: DocumentRecord): Promise<void> {
  return write(DOCUMENTS_STORE, record);
}

export function readDrawing(documentId: string): Promise<DrawingRecord | null> {
  return read<DrawingRecord>(DRAWINGS_STORE, documentId);
}

/** UTF-8 length of a string without materializing the bytes. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export class SceneTooLargeError extends Error {
  override readonly name = "SceneTooLargeError";
  constructor(bytes: number) {
    super(`This drawing is ${bytes} bytes; the limit is ${MAX_SCENE_BYTES} bytes.`);
  }
}

export function writeDrawing(record: DrawingRecord): Promise<void> {
  const bytes = utf8ByteLength(record.sceneJson);
  if (bytes > MAX_SCENE_BYTES) return Promise.reject(new SceneTooLargeError(bytes));
  return write(DRAWINGS_STORE, record);
}

export function readAsset(id: string): Promise<AssetRecord | null> {
  return read<AssetRecord>(ASSETS_STORE, id);
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stores image bytes under their content hash and returns that id. */
export async function putAsset(blob: Blob): Promise<string> {
  if (blob.size > MAX_ASSET_BYTES) {
    throw new BoardsStorageError(
      "store image",
      `${blob.size} bytes is over the ${MAX_ASSET_BYTES} byte limit.`,
    );
  }
  const id = await sha256Hex(await blob.arrayBuffer());
  const existing = await readAsset(id);
  if (existing) return id;
  await write(ASSETS_STORE, {
    schemaVersion: 1,
    id,
    mime: blob.type,
    byteLength: blob.size,
    bytes: blob,
  } satisfies AssetRecord);
  return id;
}
