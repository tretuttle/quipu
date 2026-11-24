// The engine coordinator worker: decodes requests with the contracts, answers
// them through @quipu/core's EngineHost over a pool of scan workers, and pushes
// index progress as events. The UI thread only ever talks to client.ts.
import {
  EngineError,
  EngineEventEnvelope,
  type EngineReplyEnvelope,
  EngineRequestEnvelope,
  EngineWorkerError,
} from "@quipu/contracts/engine";
import {
  EngineHost,
  type HostPlatform,
  type JqOutcome,
  type ScratchFile,
} from "@quipu/core/document";
import { portJournalStore } from "@quipu/core/journalStore";
import { opfsJournalStore } from "@quipu/core/opfsJournalStore";
import { createPoolFromWorkers } from "@quipu/core/pool";
import { createEngineFormats, memoryScratch } from "@quipu/formats/engineFormats";
import type { FormatJob, FormatJobResult } from "@quipu/formats/jobs";
import { FormatPool, type WorkerLike } from "@quipu/formats/pool";
import * as Schema from "effect/Schema";

import type { JqRunReply, JqRunRequest } from "./jq.worker.ts";

const MAX_SCAN_WORKERS = 16;

const decodeRequest = Schema.decodeUnknownSync(EngineRequestEnvelope);
const encodeError = Schema.encodeSync(EngineError);
const encodeEvent = Schema.encodeSync(EngineEventEnvelope);

const spawnScanWorker = () =>
  new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });

const spawnFormatWorker = (): WorkerLike<FormatJob, FormatJobResult> => {
  const worker = new Worker(new URL("./format.worker.ts", import.meta.url), { type: "module" });
  return {
    postMessage: (message, transfer = []) => worker.postMessage(message, { transfer }),
    onMessage: (handler) => worker.addEventListener("message", (event) => handler(event.data)),
    terminate: () => worker.terminate(),
  };
};

/**
 * Conversions write their JSON to OPFS, one directory per engine worker held
 * by a Web Lock: a directory whose lock is free belongs to a closed tab, and
 * the first conversion of the next session removes it. Without OPFS the bytes
 * go to blob storage.
 */
const SCRATCH_DIRECTORY = "conversions";
// Unique enough to tell this worker's directory from another tab's; the lock is what makes it safe.
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let nextScratch = 1;
let scratchDirectory: Promise<FileSystemDirectoryHandle | null> | null = null;

const openScratchDirectory = async (): Promise<FileSystemDirectoryHandle | null> => {
  if (typeof navigator.storage?.getDirectory !== "function" || !navigator.locks) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const all = await root.getDirectoryHandle(SCRATCH_DIRECTORY, { create: true });
    await new Promise<void>((held) => {
      void navigator.locks.request(`quipu:${SCRATCH_DIRECTORY}:${session}`, () => {
        held();
        return new Promise<never>(() => {});
      });
    });
    const entries = (all as unknown as { keys(): AsyncIterable<string> }).keys();
    for await (const name of entries) {
      if (name === session) continue;
      await navigator.locks.request(
        `quipu:${SCRATCH_DIRECTORY}:${name}`,
        { ifAvailable: true },
        async (lock) => {
          if (lock) await all.removeEntry(name, { recursive: true }).catch(() => {});
        },
      );
    }
    return await all.getDirectoryHandle(session, { create: true });
  } catch {
    return null;
  }
};

const scratch = async (): Promise<ScratchFile> => {
  scratchDirectory ??= openScratchDirectory();
  const directory = await scratchDirectory;
  if (directory === null) return memoryScratch();
  const name = `${nextScratch++}.json`;
  try {
    const handle = await directory.getFileHandle(name, { create: true });
    const writer = (await handle.createWritable()).getWriter();
    return {
      sink: {
        write: (bytes) => writer.write(bytes as Uint8Array<ArrayBuffer>),
        close: () => writer.close(),
        abort: () => writer.abort(),
      },
      finish: () => handle.getFile(),
      release: () => directory.removeEntry(name).catch(() => {}),
    };
  } catch {
    await directory.removeEntry(name).catch(() => {});
    return memoryScratch();
  }
};

/** Runs one jq program in its own worker and stops the worker at the time budget. */
const runJq = (
  input: Uint8Array,
  program: string,
  timeoutMs: number,
  outputLimit: number,
): Promise<JqOutcome> =>
  new Promise((resolve) => {
    const worker = new Worker(new URL("./jq.worker.ts", import.meta.url), { type: "module" });
    const finish = (outcome: JqOutcome) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        finish({
          status: "timeout",
          output: "",
          truncated: false,
          message: `jq did not finish in ${timeoutMs} ms and was stopped.`,
        }),
      timeoutMs,
    );
    worker.addEventListener("message", (event: MessageEvent<JqRunReply>) => finish(event.data));
    worker.addEventListener("error", (event) =>
      finish({ status: "error", output: "", truncated: false, message: event.message }),
    );
    const buffer = input.buffer as ArrayBuffer;
    const request: JqRunRequest = { input: buffer, program, outputLimit };
    worker.postMessage(request, [buffer]);
  });

// Journals go to OPFS on the web (sync access handles exist here, in a dedicated worker). The
// desktop renderer hands over a MessagePort to its state directory instead, before the first open.
const workerCount = Math.max(1, Math.min(MAX_SCAN_WORKERS, navigator.hardwareConcurrency || 4));
const platform: HostPlatform = {
  workers: workerCount,
  crossOriginIsolated: self.crossOriginIsolated,
  createPool: (workers) =>
    createPoolFromWorkers(Array.from({ length: workers }, spawnScanWorker), {
      spawn: spawnScanWorker,
      timer: (ms, fire) => {
        const id = setTimeout(fire, ms);
        return () => clearTimeout(id);
      },
    }),
  runJq,
  journalStore:
    typeof navigator.storage?.getDirectory === "function" ? opfsJournalStore() : undefined,
  formats: createEngineFormats({
    createPool: () =>
      new FormatPool<FormatJob, FormatJobResult>(
        Array.from({ length: workerCount }, spawnFormatWorker),
      ),
    scratch,
  }),
};
const host = new EngineHost(platform);

const isJournalPortMessage = (data: unknown): data is { journalPort: MessagePort } =>
  typeof data === "object" &&
  data !== null &&
  "journalPort" in data &&
  (data as { journalPort: unknown }).journalPort instanceof MessagePort;

host.onEvent = (event) => {
  self.postMessage(encodeEvent({ event }), { transfer: [] });
};

const transferables = (result: unknown): ArrayBuffer[] =>
  result instanceof Uint8Array && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];

self.addEventListener("message", async (event: MessageEvent<unknown>) => {
  if (isJournalPortMessage(event.data)) {
    platform.journalStore = portJournalStore(event.data.journalPort);
    return;
  }
  const { id, request } = decodeRequest(event.data);
  let reply: EngineReplyEnvelope;
  let transfer: ArrayBuffer[] = [];
  try {
    const result = await host.handle(request);
    transfer = transferables(result);
    reply = { id, ok: true, result };
  } catch (error) {
    reply = {
      id,
      ok: false,
      error: Schema.is(EngineError)(error)
        ? error
        : new EngineWorkerError({ detail: error instanceof Error ? error.message : String(error) }),
    };
  }
  self.postMessage(reply.ok ? reply : { ...reply, error: encodeError(reply.error) }, { transfer });
});
