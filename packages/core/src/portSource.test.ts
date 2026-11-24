import { type DocumentReadRequest, MAX_DOCUMENT_READ_BYTES } from "@quipu/contracts";
import { CHILDREN_PAGE_LIMIT, type NodeSummary } from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { portSource, servePortSource } from "./source.ts";
import { createPrng, harSample } from "./testing/samples.ts";

/**
 * A server over `bytes` on a fresh channel, recording every range it is asked
 * for. Its reads copy, as a file read would, so nothing aliases `bytes`.
 */
const served = (bytes: Uint8Array, maxRead?: number) => {
  const channel = new MessageChannel();
  const requests: Array<{ readonly start: number; readonly end: number }> = [];
  channel.port1.addEventListener("message", (event: MessageEvent<DocumentReadRequest>) => {
    requests.push({ start: event.data.start, end: event.data.end });
  });
  servePortSource(
    channel.port1,
    { size: bytes.byteLength, read: (start, end) => Promise.resolve(bytes.slice(start, end)) },
    maxRead === undefined ? {} : { maxRead },
  );
  const closed = new Promise<void>((resolve) => {
    channel.port1.addEventListener("close", () => resolve());
  });
  return { port: channel.port2, server: channel.port1, requests, closed };
};

const sample = (length: number) => {
  const prng = createPrng(length);
  return Uint8Array.from({ length }, () => prng.int(256));
};

const Range = Schema.Struct({
  length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300 })),
  window: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 })),
  from: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  to: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

describe("a document read through a port", () => {
  // `it.prop` does not await a promise-returning property; the Effect form does.
  it.live.prop(
    "reads the bytes a plain slice reads, never asking for more than one window",
    [Range],
    ([{ length, window, from, to }]) =>
      Effect.promise(async () => {
        const bytes = sample(length);
        const { port, server, requests } = served(bytes, window);
        const source = portSource(port, length, window);
        const start = Math.floor(Math.min(from, to) * length);
        const end = Math.floor(Math.max(from, to) * length);
        try {
          expect(Array.from(await source.read(start, end))).toEqual(
            Array.from(bytes.subarray(start, end)),
          );
          const into = await source.readInto(start, end, new ArrayBuffer(1));
          expect(Array.from(into.bytes)).toEqual(Array.from(bytes.subarray(start, end)));
          expect(requests.every((r) => r.end - r.start <= window)).toBe(true);
          expect(requests.length).toBeGreaterThanOrEqual(2 * Math.ceil((end - start) / window));
        } finally {
          source.close();
          server.close();
        }
      }),
    { arbitrary: { runs: 60 } },
  );

  it("splits a read longer than the window into reads of at most the window", async () => {
    const bytes = sample(100);
    const { port, server, requests } = served(bytes, 16);
    const source = portSource(port, 100, 16);
    expect(Array.from(await source.read(5, 100))).toEqual(Array.from(bytes.subarray(5, 100)));
    expect(requests).toEqual([
      { start: 5, end: 21 },
      { start: 21, end: 37 },
      { start: 37, end: 53 },
      { start: 53, end: 69 },
      { start: 69, end: 85 },
      { start: 85, end: 100 },
    ]);
    source.close();
    server.close();
  });

  it("serves a worker the same bytes through a forked port", async () => {
    const bytes = sample(64);
    const { port, server } = served(bytes);
    const source = portSource(port, 64);
    const worker = portSource(source.fork(), 64);
    expect(Array.from(await worker.read(10, 50))).toEqual(Array.from(bytes.subarray(10, 50)));
    worker.close();
    source.close();
    server.close();
  });

  it("refuses a read past the end or over the limit, and reads nothing after close", async () => {
    const bytes = sample(32);
    const { port, server } = served(bytes, 8);
    // A reader that believes the file is longer, or a larger window, than the server allows.
    const tooLong = portSource(port, 64, 64);
    await expect(tooLong.read(0, 40)).rejects.toThrow("outside a 32-byte document");
    await expect(tooLong.read(0, 16)).rejects.toThrow("over the 8-byte limit");
    tooLong.close();
    await expect(tooLong.read(0, 4)).rejects.toThrow("closed");
    server.close();
  });

  it("refuses a range outside the document before asking", async () => {
    const { port, server, requests } = served(sample(10));
    const source = portSource(port, 10);
    await expect(source.read(4, 11)).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
    source.close();
    server.close();
  });
});

describe("the engine over a document port", () => {
  const platform = { workers: 3, crossOriginIsolated: true, createPool: createLocalPool };
  const bytes = harSample(createPrng(7), { targetBytes: 200 * 1024 });

  const keysOf = async (host: EngineHost, node: NodeSummary) => {
    const page = await host.handle({
      _tag: "children",
      ref: node.ref,
      from: 0,
      count: CHILDREN_PAGE_LIMIT,
    });
    return Promise.all(page.nodes.map((child) => host.handle({ _tag: "keyText", ref: child.ref })));
  };

  const outline = async (host: EngineHost, documentId: number) => {
    const root = await host.handle({ _tag: "root", documentId });
    const log = (
      await host.handle({ _tag: "children", ref: root.ref, from: 0, count: CHILDREN_PAGE_LIMIT })
    ).nodes[0] as NodeSummary;
    return { root: await keysOf(host, root), log: await keysOf(host, log) };
  };

  it("indexes the same tree as the file, reads in bounded windows and lets go on close", async () => {
    const host = new EngineHost(platform, { regionBytes: 16 * 1024 });
    const blob = await host.handle({ _tag: "open", source: new Blob([bytes]), name: "a.har" });
    const { port, requests, closed } = served(bytes);
    const opened = await host.handle({
      _tag: "open",
      source: { _tag: "DocumentPort", port, size: bytes.byteLength },
      name: "a.har",
    });
    expect(opened.size).toBe(bytes.byteLength);
    expect(opened.format).toBe("har");
    const viaPort = await outline(host, opened.documentId);
    const viaBlob = await outline(host, blob.documentId);
    expect(viaPort.root).toEqual(viaBlob.root);
    expect(viaPort.log).toEqual(viaBlob.log);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.end - r.start <= MAX_DOCUMENT_READ_BYTES)).toBe(true);
    await host.handle({ _tag: "close", documentId: opened.documentId });
    await closed;
    await host.handle({ _tag: "close", documentId: blob.documentId });
  });
});
