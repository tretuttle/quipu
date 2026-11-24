import { DEFAULT_STYLE, type Element } from "@quipu/canvas/elements";
import { encodeDrawingJson, makeDrawingDocument } from "@quipu/canvas/persistence";
import type { JournalStoreRequest } from "@quipu/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  deleteDrawing,
  listBoards,
  putAsset,
  putBoard,
  readAsset,
  readDrawingScene,
  removeBoard,
  writeDrawing,
  type BoardRecord,
} from "./drawingStore";

/** The desktop state directory as the bridge serves it: relative paths to file bytes. */
function stubDesktopStateDirectory(options: { readonly failWrites?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  let writes = 0;
  const journal = async (request: JournalStoreRequest): Promise<unknown> => {
    switch (request.op) {
      case "size":
        return files.get(request.path)?.byteLength ?? -1;
      case "read":
        return (files.get(request.path) ?? new Uint8Array(0)).slice(request.start, request.end);
      case "replace":
        if (options.failWrites) throw new Error("disk full");
        writes += 1;
        files.set(request.path, request.bytes.slice());
        return undefined;
      case "remove":
        for (const path of files.keys()) {
          if (path === request.path || path.startsWith(`${request.path}/`)) files.delete(path);
        }
        return undefined;
      case "list": {
        const prefix = `${request.path}/`;
        const names = [...files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split("/")[0] ?? "");
        return [...new Set(names)];
      }
      default:
        throw new Error(`unexpected ${request.op}`);
    }
  };
  const openIndexedDb = vi.fn();
  vi.stubGlobal("window", { desktopBridge: { journal } });
  vi.stubGlobal("indexedDB", { open: openIndexedDb });
  return { files, writes: () => writes, openIndexedDb };
}

const record = (documentId: string, sceneJson: string) => ({
  schemaVersion: 1 as const,
  documentId,
  updatedAt: 1,
  sceneSchemaVersion: 1,
  sceneJson,
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** `sha256sum` of those twelve bytes, computed outside this code. */
const PNG_SHA256 = "4353a1de7e0dcc4e87350e22d5c9ee9f3e70e8ce9c31533ec991bee8870c4814";

describe("desktop drawing storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes a board's scene to drawings/board/<id>.json in the state directory and reads it back", async () => {
    const disk = stubDesktopStateDirectory();
    const scene = '{"type":"quipu-drawing","version":1,"elements":[],"note":"ünïcode"}';
    await writeDrawing(record("board:4f1c2b9e-0000-4000-8000-000000000001", scene));
    const bytes = disk.files.get("drawings/board/4f1c2b9e-0000-4000-8000-000000000001.json");
    expect(Buffer.from(bytes ?? []).toString("utf8")).toBe(scene);
    expect(await readDrawingScene("board:4f1c2b9e-0000-4000-8000-000000000001")).toBe(scene);
    expect(await readDrawingScene("board:never-saved")).toBeNull();
    expect(disk.openIndexedDb).not.toHaveBeenCalled();
  });

  it("stores an image once, under the SHA-256 of its bytes, and reads it back with its type", async () => {
    const disk = stubDesktopStateDirectory();
    const expectedId = PNG_SHA256;
    const id = await putAsset(new Blob([PNG], { type: "image/png" }));
    expect(id).toBe(expectedId);
    expect([...(disk.files.get(`drawings/assets/${expectedId}`) ?? [])]).toEqual([...PNG]);
    expect(await putAsset(new Blob([PNG], { type: "image/png" }))).toBe(expectedId);
    expect(disk.writes()).toBe(1);

    const asset = await readAsset(expectedId);
    expect(asset?.bytes.type).toBe("image/png");
    expect(new Uint8Array(await (asset?.bytes ?? new Blob()).arrayBuffer())).toEqual(PNG);
    expect(await readAsset("0".repeat(64))).toBeNull();

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svgAsset = await readAsset(await putAsset(new Blob([svg])));
    expect(svgAsset?.bytes.type).toBe("image/svg+xml");
    expect(disk.openIndexedDb).not.toHaveBeenCalled();
  });

  it("fails a write closed when the state directory refuses it, never falling back to IndexedDB", async () => {
    const disk = stubDesktopStateDirectory({ failWrites: true });
    await expect(writeDrawing(record("board:a", "{}"))).rejects.toThrow("disk full");
    await expect(putAsset(new Blob([PNG]))).rejects.toThrow("disk full");
    expect(disk.files.size).toBe(0);
    expect(disk.openIndexedDb).not.toHaveBeenCalled();
  });

  it("lists desktop boards from drawings/boards.json, where renames and deletes land", async () => {
    const disk = stubDesktopStateDirectory();
    const board = (id: string, name: string): BoardRecord => ({
      schemaVersion: 1,
      id,
      kind: "board",
      name,
      size: 0,
      lastModified: 1,
      lastOpenedAt: 2,
    });
    expect(await listBoards()).toEqual([]);
    await putBoard(board("board:a", "Board 1"));
    await putBoard(board("board:b", "Board 2"));
    await putBoard(board("board:a", "Plans"));
    await removeBoard("board:b");
    const file = JSON.parse(Buffer.from(disk.files.get("drawings/boards.json") ?? []).toString());
    expect(file).toEqual({
      version: 1,
      boards: [{ id: "board:a", name: "Plans", size: 0, lastModified: 1, lastOpenedAt: 2 }],
    });

    // Another process (a fresh bridge over the same files) reads the same list.
    const files = new Map(disk.files);
    const reopened = stubDesktopStateDirectory();
    for (const [path, bytes] of files) reopened.files.set(path, bytes);
    expect((await listBoards()).map((record) => [record.id, record.name])).toEqual([
      ["board:a", "Plans"],
    ]);
    expect(reopened.openIndexedDb).not.toHaveBeenCalled();
  });

  it("deletes a drawing with the images only it used, and a late save does not bring it back", async () => {
    const disk = stubDesktopStateDirectory();
    const image = (id: string, fileId: string, isDeleted = false): Element => ({
      id,
      type: "image",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      angle: 0,
      index: "V1111",
      seed: 1,
      version: 1,
      isDeleted,
      locked: false,
      groupIds: [],
      frameId: null,
      style: DEFAULT_STYLE,
      fileId,
    });
    const scene = (...elements: Element[]) => encodeDrawingJson(makeDrawingDocument(elements));
    const only = await putAsset(new Blob([PNG]));
    const shared = await putAsset(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])]));
    const undoable = await putAsset(new Blob([new Uint8Array([0x47, 0x49, 0x46, 2])]));
    await writeDrawing(
      record("board:gone", scene(image("i1", only), image("i2", shared), image("i3", undoable))),
    );
    // A drawing layer over a document still shows the shared image, and a
    // deleted image on another board can still be brought back with undo.
    await writeDrawing(record("document:blob:abc", scene(image("j1", shared))));
    await writeDrawing(record("board:kept", scene(image("k1", undoable, true))));

    await deleteDrawing("board:gone");
    expect(await readDrawingScene("board:gone")).toBeNull();
    expect(await readAsset(only)).toBeNull();
    expect(await readAsset(shared)).not.toBeNull();
    expect(await readAsset(undoable)).not.toBeNull();
    expect(await readDrawingScene("board:kept")).not.toBeNull();

    // The surface of a deleted board flushes its last save as it unmounts.
    await writeDrawing(record("board:gone", scene(image("i1", only))));
    expect(disk.files.has("drawings/board/gone.json")).toBe(false);
  });

  it("keeps every image when another drawing cannot be read", async () => {
    const disk = stubDesktopStateDirectory();
    const id = await putAsset(new Blob([PNG]));
    const scene = encodeDrawingJson(
      makeDrawingDocument([
        {
          id: "i1",
          type: "image",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          angle: 0,
          index: "V1111",
          seed: 1,
          version: 1,
          isDeleted: false,
          locked: false,
          groupIds: [],
          frameId: null,
          style: DEFAULT_STYLE,
          fileId: id,
        },
      ]),
    );
    await writeDrawing(record("board:one", scene));
    disk.files.set("drawings/board/broken.json", new TextEncoder().encode("{not json"));
    await deleteDrawing("board:one");
    expect(await readDrawingScene("board:one")).toBeNull();
    expect(await readAsset(id)).not.toBeNull();
  });
});
