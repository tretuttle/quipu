/**
 * Streamed save: bytes in through the pieces, bytes out
 * to a sink, never the document in memory. As-is output is a chunked copy. A
 * pretty-printed or minified save runs the formatter in the scan workers with
 * the shape of the index pipeline: every worker summarizes its chunk (pass 1,
 * keeping the bytes), the entry states chain in order, and the chunk is
 * formatted from its true state and sent back; the coordinator writes outputs
 * in file order. A worker does not start a chunk until the output window has
 * room, which bounds memory to the window plus one chunk per worker
 * (docs/internals/document-engine.md, "Edits").
 */
import type { FormatState } from "./format.ts";
import type { Pool } from "./pool.ts";
import type { FormatResult, SummarizeResult } from "./protocol.ts";
import { advanceEntry } from "./resolve.ts";
import { type EntryState, FULL_DEPTH } from "./scan.ts";
import type { ByteSource } from "./source.ts";

/** Where saved bytes go; both web sinks and the desktop stream fit it. */
export interface Sink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type SinkSpec =
  | { readonly kind: "fileHandle"; readonly handle: FileSystemFileHandle }
  | { readonly kind: "writable"; readonly stream: WritableStream<Uint8Array> };

export const openSink = async (spec: SinkSpec): Promise<Sink> => {
  const stream = spec.kind === "fileHandle" ? await spec.handle.createWritable() : spec.stream;
  const writer = stream.getWriter();
  return {
    write: (bytes) => writer.write(bytes),
    close: () => writer.close(),
    abort: () => writer.abort(),
  };
};

const SAVE_CHUNK_BYTES = 2 * 1024 * 1024;
/** Formatted chunks waiting to be written in order, at most. */
const OUTPUT_WINDOW = 16;

/** Copies [start, end) of a source to the sink in chunks, reusing one buffer. Returns bytes written. */
export const copyRange = async (
  source: ByteSource,
  start: number,
  end: number,
  sink: Sink,
  chunkBytes = SAVE_CHUNK_BYTES * 4,
) => {
  let buffer = new ArrayBuffer(Math.min(chunkBytes, Math.max(0, end - start)));
  let written = 0;
  for (let at = start; at < end; at += chunkBytes) {
    const to = Math.min(end, at + chunkBytes);
    const r = await source.readInto(at, to, buffer);
    buffer = r.buffer;
    // A write settles once the sink has taken the bytes (OPFS copies them, a transferred stream
    // clones them), so the buffer is reused for the next chunk without a copy.
    await sink.write(r.bytes);
    written += r.bytes.byteLength;
  }
  return written;
};

const entryFromFormat = (state: FormatState): EntryState => ({
  depth: state.depth,
  inString: state.inString,
  escaped: state.escaped,
  prevSig: state.lastSig,
  lastByte: 0,
  kinds: new Uint8Array(0),
  openStringStart: -1,
  openStringPrevSig: 0,
});

const formatFromEntry = (entry: EntryState): FormatState => ({
  depth: entry.depth,
  inString: entry.inString,
  escaped: entry.escaped,
  lastSig: entry.prevSig,
});

export interface FormatThroughPoolOptions {
  readonly indent: number;
  readonly state: FormatState;
  readonly chunkBytes?: number;
}

/**
 * Formats `size` bytes of worker source `sourceId` through the pool into the
 * sink, returning the state at the end and the bytes written.
 */
export const formatThroughPool = async (
  pool: Pool,
  sourceId: number,
  size: number,
  sink: Sink,
  options: FormatThroughPoolOptions,
): Promise<{ state: FormatState; written: number }> => {
  const chunkBytes = options.chunkBytes ?? SAVE_CHUNK_BYTES;
  const chunks = Math.max(1, Math.ceil(size / chunkBytes));
  if (size === 0) return { state: options.state, written: 0 };

  const entries: (EntryState | undefined)[] = Array.from({ length: chunks });
  entries[0] = entryFromFormat(options.state);
  const summaries: (SummarizeResult | undefined)[] = Array.from({ length: chunks });
  let resolvedUpTo = 0;
  const entryWaiters: Array<(() => void) | undefined> = Array.from({ length: chunks });
  const advance = () => {
    while (resolvedUpTo + 1 < chunks) {
      const summary = summaries[resolvedUpTo];
      if (!summary) break;
      entries[resolvedUpTo + 1] = advanceEntry(
        entries[resolvedUpTo] as EntryState,
        summary.summary,
        resolvedUpTo * chunkBytes,
        FULL_DEPTH,
      );
      resolvedUpTo++;
      entryWaiters[resolvedUpTo]?.();
      entryWaiters[resolvedUpTo] = undefined;
    }
  };
  const entryFor = (k: number) =>
    new Promise<EntryState>((resolve) => {
      const known = entries[k];
      if (known) resolve(known);
      else entryWaiters[k] = () => resolve(entries[k] as EntryState);
    });

  // Outputs are written in chunk order; a worker waits for window room before reading its next chunk.
  // Output buffers cycle: written ones go back to the worker that filled them for its next chunk.
  const spare: ArrayBuffer[][] = Array.from({ length: pool.size }, () => []);
  const ready: (FormatResult | undefined)[] = Array.from({ length: chunks });
  let writtenUpTo = 0;
  let written = 0;
  let lastState = options.state;
  let writing: Promise<void> = Promise.resolve();
  const roomWaiters: Array<() => void> = [];
  const drain = () => {
    writing = writing.then(async () => {
      while (writtenUpTo < chunks && ready[writtenUpTo]) {
        const result = ready[writtenUpTo] as FormatResult;
        ready[writtenUpTo] = undefined;
        await sink.write(result.bytes);
        written += result.bytes.byteLength;
        lastState = result.state;
        (spare[writtenUpTo % pool.size] as ArrayBuffer[]).push(result.bytes.buffer as ArrayBuffer);
        writtenUpTo++;
        for (const wake of roomWaiters.splice(0)) wake();
      }
    });
    return writing;
  };
  const waitForRoom = (k: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (k < writtenUpTo + OUTPUT_WINDOW) resolve();
        else roomWaiters.push(check);
      };
      check();
    });

  const workerLoop = async (worker: number) => {
    for (let k = worker; k < chunks; k += pool.size) {
      await waitForRoom(k);
      const start = k * chunkBytes;
      const end = Math.min(size, start + chunkBytes);
      const summary = await pool.call<SummarizeResult>(worker, {
        type: "summarize",
        sourceId,
        region: k,
        start,
        end,
        maxDepth: 0,
      });
      summaries[k] = summary;
      advance();
      const entry = await entryFor(k);
      const into = (spare[worker] as ArrayBuffer[]).pop() ?? new ArrayBuffer(0);
      const result = await pool.call<FormatResult>(
        worker,
        {
          type: "format",
          sourceId,
          region: k,
          start,
          end,
          state: formatFromEntry(entry),
          indent: options.indent,
          into,
        },
        into.byteLength > 0 ? [into] : [],
      );
      ready[k] = result;
      void drain();
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool.size, chunks) }, (_, w) => workerLoop(w)));
  await drain();
  if (writtenUpTo !== chunks) throw new Error(`wrote ${writtenUpTo} of ${chunks} chunks`);
  return { state: lastState, written };
};
