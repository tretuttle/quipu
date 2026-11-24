/**
 * Where boards, their drawings and their images are kept. In a browser, the
 * `quipu` IndexedDB database (`boardsDb.ts`). On the desktop, files in the
 * app's state directory, written by the main process through the bridge's
 * state-directory store: `drawings/boards.json` lists the boards,
 * `drawings/<kind>/<id>.json` holds a scene's JSON and
 * `drawings/assets/<sha256>` an image's bytes, because the Chromium profile
 * that holds IndexedDB is replaceable. With the bridge present a failed write
 * rejects; it never falls through to IndexedDB.
 */
import { decodeDrawingJson } from "@quipu/canvas/persistence";
import type { DesktopBridge } from "@quipu/contracts";
import * as Schema from "effect/Schema";

import * as BoardsDb from "./boardsDb";

type StateDirectoryStore = NonNullable<DesktopBridge["journal"]>;

const DRAWINGS_DIRECTORY = "drawings";
const ASSETS_DIRECTORY = "drawings/assets";
const BOARD_LIST_PATH = "drawings/boards.json";
/** The board list holds names and dates only; anything near this size is not one. */
const MAX_BOARD_LIST_BYTES = 4_194_304;

export type BoardRecord = BoardsDb.DocumentRecord;

/** The bridge's state-directory store; undefined in a browser. */
function stateDirectoryStore(): StateDirectoryStore | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.journal;
}

/**
 * `board:<uuid>` is stored as `drawings/board/<uuid>.json`. Anything else is
 * percent-encoded into one file name, which is safe on every file system.
 */
function drawingPath(documentId: string): string {
  const separator = documentId.indexOf(":");
  const kind = separator > 0 ? documentId.slice(0, separator) : "board";
  const id = separator > 0 ? documentId.slice(separator + 1) : documentId;
  const safe = (part: string) => encodeURIComponent(part).replace(/[%*.]/g, "_");
  return `drawings/${safe(kind)}/${safe(id)}.json`;
}

function assetPath(id: string): string {
  return `${ASSETS_DIRECTORY}/${id}`;
}

/** The whole file, or null when it does not exist. Refuses a file over `limit` bytes. */
async function readFile(
  store: StateDirectoryStore,
  path: string,
  limit: number,
): Promise<Uint8Array | null> {
  const size = (await store({ op: "size", path })) as number;
  if (size < 0) return null;
  if (size > limit) {
    throw new BoardsDb.BoardsStorageError(`read ${path}`, `${size} bytes is over the limit`);
  }
  return (await store({ op: "read", path, start: 0, end: size })) as Uint8Array;
}

/** The saved scene JSON for a board, or null when it has never been saved. */
export async function readDrawingScene(documentId: string): Promise<string | null> {
  const store = stateDirectoryStore();
  if (!store) return (await BoardsDb.readDrawing(documentId))?.sceneJson ?? null;
  const bytes = await readFile(store, drawingPath(documentId), BoardsDb.MAX_SCENE_BYTES);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * Drawings deleted in this session. A surface that unmounts after its board
 * was deleted still flushes its last save, and that save must not bring the
 * drawing back.
 */
const retiredDrawings = new Set<string>();

/** Saves still in flight, so a delete can wait for them instead of racing them. */
const pendingWrites = new Map<string, Promise<void>>();

export function writeDrawing(record: BoardsDb.DrawingRecord): Promise<void> {
  if (retiredDrawings.has(record.documentId)) return Promise.resolve();
  const write = (async () => {
    const store = stateDirectoryStore();
    if (!store) return BoardsDb.writeDrawing(record);
    const bytes = new TextEncoder().encode(record.sceneJson);
    if (bytes.byteLength > BoardsDb.MAX_SCENE_BYTES) {
      throw new BoardsDb.SceneTooLargeError(bytes.byteLength);
    }
    await store({ op: "replace", path: drawingPath(record.documentId), bytes });
  })();
  // Waits for any earlier save of the same drawing too; never rejects.
  const previous = pendingWrites.get(record.documentId) ?? Promise.resolve();
  const settled = previous.then(() =>
    write.then(
      () => undefined,
      () => undefined,
    ),
  );
  pendingWrites.set(record.documentId, settled);
  void settled.then(() => {
    if (pendingWrites.get(record.documentId) === settled) pendingWrites.delete(record.documentId);
  });
  return write;
}

/**
 * The image types the image tool accepts, by their leading bytes. A desktop
 * asset file holds bytes only; an SVG needs its type for the browser to draw it.
 */
const IMAGE_SIGNATURES: ReadonlyArray<
  readonly [mime: string, matches: (b: Uint8Array) => boolean]
> = [
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  [
    "image/webp",
    (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42,
  ],
  ["image/svg+xml", (b) => /^(﻿)?\s*</.test(String.fromCharCode(...b.subarray(0, 64)))],
];

function sniffImageType(bytes: Uint8Array): string {
  return IMAGE_SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? "";
}

export async function readAsset(id: string): Promise<BoardsDb.AssetRecord | null> {
  const store = stateDirectoryStore();
  if (!store) return BoardsDb.readAsset(id);
  const bytes = await readFile(store, assetPath(id), BoardsDb.MAX_ASSET_BYTES);
  if (bytes === null) return null;
  const mime = sniffImageType(bytes);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return {
    schemaVersion: 1,
    id,
    mime,
    byteLength: bytes.byteLength,
    bytes: new Blob([copy.buffer], { type: mime }),
  };
}

/** Stores image bytes under their content hash and returns that id. */
export async function putAsset(blob: Blob): Promise<string> {
  const store = stateDirectoryStore();
  if (!store) return BoardsDb.putAsset(blob);
  if (blob.size > BoardsDb.MAX_ASSET_BYTES) {
    throw new BoardsDb.BoardsStorageError(
      "store image",
      `${blob.size} bytes is over the ${BoardsDb.MAX_ASSET_BYTES} byte limit.`,
    );
  }
  const buffer = await blob.arrayBuffer();
  const id = await BoardsDb.sha256Hex(buffer);
  const path = assetPath(id);
  if (((await store({ op: "size", path })) as number) >= 0) return id;
  await store({ op: "replace", path, bytes: new Uint8Array(buffer) });
  return id;
}

const BoardListFile = Schema.Struct({
  version: Schema.Literal(1),
  boards: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      lastModified: Schema.Number,
      lastOpenedAt: Schema.Number,
    }),
  ),
});
const BoardListJson = Schema.fromJsonString(BoardListFile);
const decodeBoardList = Schema.decodeUnknownSync(BoardListJson);
const encodeBoardList = Schema.encodeSync(BoardListJson);

/**
 * The desktop list as last read or written, for the store it came from. Every
 * change rewrites the whole file; writes run one after another so the file
 * always ends at the latest list.
 */
let desktopBoards: {
  readonly store: StateDirectoryStore;
  readonly boards: Map<string, BoardRecord>;
} | null = null;
let desktopListWrite: Promise<void> = Promise.resolve();

async function desktopBoardList(store: StateDirectoryStore): Promise<Map<string, BoardRecord>> {
  if (desktopBoards?.store === store) return desktopBoards.boards;
  const bytes = await readFile(store, BOARD_LIST_PATH, MAX_BOARD_LIST_BYTES);
  const boards = new Map<string, BoardRecord>();
  if (bytes === null) {
    // Earlier desktop builds listed boards in IndexedDB: carry them over once.
    const earlier = await BoardsDb.listDocuments().catch(() => []);
    for (const record of earlier) if (record.kind === "board") boards.set(record.id, record);
  } else {
    for (const board of decodeBoardList(new TextDecoder().decode(bytes)).boards) {
      boards.set(board.id, { schemaVersion: 1, kind: "board", ...board });
    }
  }
  desktopBoards = { store, boards };
  if (bytes === null && boards.size > 0) await saveDesktopBoardList(store, boards);
  return boards;
}

function saveDesktopBoardList(
  store: StateDirectoryStore,
  boards: ReadonlyMap<string, BoardRecord>,
): Promise<void> {
  const write = desktopListWrite.then(() => {
    const json = encodeBoardList({
      version: 1,
      boards: [...boards.values()].map(({ id, name, size, lastModified, lastOpenedAt }) => ({
        id,
        name,
        size,
        lastModified,
        lastOpenedAt,
      })),
    });
    return store({
      op: "replace",
      path: BOARD_LIST_PATH,
      bytes: new TextEncoder().encode(`${json}\n`),
    }) as Promise<void>;
  });
  // A failed write rejects for its caller; the next write still runs.
  desktopListWrite = write.catch(() => undefined);
  return write;
}

export async function listBoards(): Promise<BoardRecord[]> {
  const store = stateDirectoryStore();
  if (!store) {
    return (await BoardsDb.listDocuments()).filter((record) => record.kind === "board");
  }
  return [...(await desktopBoardList(store)).values()];
}

export async function putBoard(record: BoardRecord): Promise<void> {
  const store = stateDirectoryStore();
  if (!store) return BoardsDb.putDocument(record);
  const boards = await desktopBoardList(store);
  boards.set(record.id, record);
  await saveDesktopBoardList(store, boards);
}

export async function removeBoard(id: string): Promise<void> {
  const store = stateDirectoryStore();
  if (!store) return BoardsDb.deleteDocument(id);
  const boards = await desktopBoardList(store);
  boards.delete(id);
  await saveDesktopBoardList(store, boards);
}

/**
 * The image assets a scene refers to, tombstoned images included (undo can
 * bring them back). Null when the scene cannot be read, so nothing it might
 * refer to is deleted.
 */
function imageAssetIds(sceneJson: string): Set<string> | null {
  try {
    const ids = new Set<string>();
    for (const element of decodeDrawingJson(sceneJson).elements) {
      if (element.type === "image") ids.add(element.fileId);
    }
    return ids;
  } catch {
    return null;
  }
}

/** Every saved scene except `documentId`'s: boards and drawing layers alike. */
async function otherScenes(documentId: string): Promise<string[]> {
  const store = stateDirectoryStore();
  if (!store) {
    return (await BoardsDb.listDrawings())
      .filter((record) => record.documentId !== documentId)
      .map((record) => record.sceneJson);
  }
  const skip = drawingPath(documentId);
  const scenes: string[] = [];
  const kinds = (await store({ op: "list", path: DRAWINGS_DIRECTORY })) as string[];
  for (const kind of kinds) {
    const directory = `${DRAWINGS_DIRECTORY}/${kind}`;
    if (directory === ASSETS_DIRECTORY || directory === BOARD_LIST_PATH) continue;
    for (const name of (await store({ op: "list", path: directory })) as string[]) {
      const path = `${directory}/${name}`;
      if (!name.endsWith(".json") || path === skip) continue;
      const bytes = await readFile(store, path, BoardsDb.MAX_SCENE_BYTES);
      if (bytes !== null) scenes.push(new TextDecoder().decode(bytes));
    }
  }
  return scenes;
}

/**
 * Deletes a drawing and the images no other drawing uses. When any remaining
 * drawing cannot be read, every image is kept: a stray file costs less than
 * a missing picture.
 */
export async function deleteDrawing(documentId: string): Promise<void> {
  retiredDrawings.add(documentId);
  await pendingWrites.get(documentId);
  const scene = await readDrawingScene(documentId);
  const store = stateDirectoryStore();
  if (store) await store({ op: "remove", path: drawingPath(documentId) });
  else await BoardsDb.deleteDrawing(documentId);

  const orphans = scene === null ? null : imageAssetIds(scene);
  if (orphans === null || orphans.size === 0) return;
  for (const other of await otherScenes(documentId)) {
    const used = imageAssetIds(other);
    if (used === null) return;
    for (const id of used) orphans.delete(id);
  }
  for (const id of orphans) {
    if (store) await store({ op: "remove", path: assetPath(id) });
    else await BoardsDb.deleteAsset(id);
  }
}
