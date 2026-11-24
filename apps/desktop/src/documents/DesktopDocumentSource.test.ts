// @effect-diagnostics nodeBuiltinImport:off - the server is driven over Node's own MessageChannel and a real file.
import { describe, expect, it } from "@effect/vitest";
import { portSource } from "@quipu/core/source";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import {
  type DocumentPortLike,
  type DocumentReader,
  openDocumentReader,
  serveDocumentReads,
} from "./DesktopDocumentSource.ts";

/** Node's port speaks `on("message", data)`; Electron's `MessagePortMain` hands over `{ data }`. */
const asMainPort = (port: NodeWorkerThreads.MessagePort): DocumentPortLike => ({
  on: ((event: "message" | "close", listener: (event?: { data: unknown }) => void) => {
    if (event === "message") port.on("message", (data: unknown) => listener({ data }));
    else port.on("close", () => listener());
  }) as DocumentPortLike["on"],
  postMessage: (message) => port.postMessage(message),
  start: () => port.start(),
});

const withFile = async (bytes: Uint8Array, run: (path: string) => Promise<void>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-source-"));
  const path = NodePath.join(dir, "doc.json");
  NodeFS.writeFileSync(path, bytes);
  try {
    await run(path);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const sample = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 251);

/** Serves `reader` on a fresh channel; the other end is what the page's engine would hold. */
const serve = (reader: DocumentReader, maxRead: number) => {
  const channel = new NodeWorkerThreads.MessageChannel();
  const requests: Array<number> = [];
  channel.port1.on("message", (data: { start: number; end: number }) =>
    requests.push(data.end - data.start),
  );
  let closes = 0;
  const counted: DocumentReader = {
    ...reader,
    close: () => {
      closes++;
      return reader.close();
    },
  };
  serveDocumentReads(asMainPort(channel.port1), counted, maxRead);
  const closed = new Promise<void>((resolve) => channel.port1.once("close", () => resolve()));
  return { client: channel.port2, requests, closed, closes: () => closes };
};

/** A raw request on the client port and its one reply. */
const ask = (port: NodeWorkerThreads.MessagePort, request: unknown) =>
  new Promise<{ ok: boolean; error?: string; bytes?: Uint8Array }>((resolve) => {
    port.once("message", resolve);
    port.postMessage(request);
  });

describe("the desktop document source", () => {
  it("serves a file larger than one read window, in windows, to the engine's reader", async () => {
    const bytes = sample(1000);
    await withFile(bytes, async (path) => {
      const reader = await openDocumentReader(path);
      expect(reader.size).toBe(1000);
      expect(reader.lastModified).toBe(NodeFS.statSync(path).mtimeMs);
      const { client, requests, closed, closes } = serve(reader, 64);
      const source = portSource(client as unknown as MessagePort, reader.size, 64);
      expect(Array.from(await source.read(0, 1000))).toEqual(Array.from(bytes));
      expect(Array.from(await source.read(900, 1000))).toEqual(Array.from(bytes.subarray(900)));
      expect(requests.length).toBe(Math.ceil(1000 / 64) + 2);
      expect(Math.max(...requests)).toBeLessThanOrEqual(64);
      // The engine closing the document lets go of the port, and the file closes.
      source.close();
      await closed;
      expect(closes()).toBe(1);
    });
  });

  it("refuses a read past the opened size or over the window, and a malformed request", async () => {
    await withFile(sample(100), async (path) => {
      const reader = await openDocumentReader(path);
      const { client, closed } = serve(reader, 16);
      expect(await ask(client, { id: 1, start: 90, end: 101 })).toEqual({
        id: 1,
        ok: false,
        error: "bytes [90, 101) are outside a 100-byte document",
      });
      expect(await ask(client, { id: 2, start: 0, end: 17 })).toEqual({
        id: 2,
        ok: false,
        error: "a read of 17 bytes is over the 16-byte limit",
      });
      expect(await ask(client, { id: 3, start: 5, end: 3 })).toMatchObject({ id: 3, ok: false });
      // Not a request at all: no reply, and the next request is still answered.
      client.postMessage({ id: -1, start: "a" }, []);
      const reply = await ask(client, { id: 4, start: 0, end: 4 });
      expect(reply).toMatchObject({ id: 4, ok: true });
      expect(Array.from(reply.bytes as Uint8Array)).toEqual([7, 38, 69, 100]);
      client.close();
      await closed;
    });
  });

  it("fails a read when the file is shorter than when it was opened", async () => {
    await withFile(sample(100), async (path) => {
      const reader = await openDocumentReader(path);
      NodeFS.truncateSync(path, 50);
      const { client, closed } = serve(reader, 64);
      expect(await ask(client, { id: 1, start: 40, end: 60 })).toEqual({
        id: 1,
        ok: false,
        error: "the file is shorter than when it was opened",
      });
      client.close();
      await closed;
    });
  });
});
