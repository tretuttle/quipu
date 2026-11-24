/**
 * The coordinator for streamed JSON conversion: the engine's region pipeline
 * (summarize, resolve, then the per-region job) with a conversion job in place
 * of the structural pass. Regions go to workers round-robin in file order, a
 * worker summarizes its region and waits for its entry state, converts, and the
 * coordinator writes outputs to the sink strictly in file order. Bytes in flight
 * are bounded by workers × (region + overhang) plus the outputs not yet written.
 */
import { advanceEntry, INITIAL_ENTRY } from "@quipu/core/resolve";
import { FULL_DEPTH, type EntryState } from "@quipu/core/scan";
import { type ByteSource, openSource, type SourceSpec } from "@quipu/core/source";

import { ByteWriter } from "./byteWriter.ts";
import type { Target } from "./convertRegion.ts";
import { UnrepresentableError } from "./errors.ts";
import type { ConvertFormat } from "./formatIds.ts";
import { defaultGeometry, type FormatJob, type FormatJobResult } from "./jobs.ts";
import { locatePointer } from "./locate.ts";
import { type FormatPool, type JobFailure, JobFailedError } from "./pool.ts";
import { writeCsvField } from "./csvEmit.ts";

export interface ConvertSink {
  /** Called with output in file order. The chunk is the sink's to keep. */
  write(chunk: Uint8Array): void | Promise<void>;
}

export interface SourceInput {
  readonly spec: SourceSpec;
  readonly size: number;
  /** A reader for the coordinator's own use (naming a failure's node); defaults to opening `spec`. */
  readonly source?: ByteSource;
}

export interface StreamOptions {
  readonly regionBytes?: number;
  /** csv/tsv: `first` reads the header from the first rows, an array names the columns. */
  readonly columns?: "first" | ReadonlyArray<string>;
  readonly firstRows?: number;
  readonly nested?: "json" | "error";
  /** The format names the error reports. */
  readonly from?: ConvertFormat;
}

export interface StreamStats {
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly rows: number;
  readonly regions: number;
}

export type StreamTarget = "yaml" | "toml" | "csv" | "tsv" | "ndjson" | "minify";

const COMMA = 0x2c;
const TAB = 0x09;
const NEWLINE = 0x0a;

const encoder = new TextEncoder();

/** Converts a JSON document held by `input` to `target`, streaming through `pool`. */
export const convertJsonSource = async (
  pool: FormatPool<FormatJob, FormatJobResult>,
  input: SourceInput,
  targetKind: StreamTarget,
  sink: ConvertSink,
  options: StreamOptions = {},
): Promise<StreamStats> => {
  const geometry = defaultGeometry(options.regionBytes);
  const sourceId = nextSourceId++;
  const size = input.size;
  let bytesOut = 0;
  let rows = 0;
  const from = options.from ?? "json";
  const toFormat: ConvertFormat = targetKind === "minify" ? "json" : targetKind;

  await pool.broadcast({ type: "open", sourceId, spec: input.spec });
  const close = () => pool.broadcast({ type: "close", sourceId });

  try {
    if (size === 0) return { bytesIn: 0, bytesOut: 0, rows: 0, regions: 0 };

    let target: Target;
    if (targetKind === "csv" || targetKind === "tsv") {
      const delimiter = targetKind === "csv" ? COMMA : TAB;
      let columns: Uint8Array[];
      if (options.columns && options.columns !== "first") {
        columns = options.columns.map((c) => encoder.encode(c));
      } else {
        try {
          const found = await pool.call<{ columns: Uint8Array[]; size: number }>(0, {
            type: "columns",
            sourceId,
            maxRows: options.firstRows ?? 1024,
            bytes: 4 * 1024 * 1024,
          });
          columns = [...found.columns];
        } catch (error) {
          if (error instanceof JobFailedError && error.failure.kind === "offending") {
            throw await unrepresentable(input, from, toFormat, error.failure);
          }
          throw error;
        }
      }
      target = { kind: "csv", delimiter, nested: options.nested ?? "json", columns };
      // The header row.
      const header = new ByteWriter(256);
      columns.forEach((name, index) => {
        if (index > 0) header.byte(delimiter);
        writeCsvField(header, name, delimiter, columns.length === 1);
      });
      if (columns.length > 0) {
        header.byte(NEWLINE);
        const chunk = header.take();
        bytesOut += chunk.length;
        await sink.write(chunk);
      }
    } else target = { kind: targetKind };

    const regions = Math.ceil(size / geometry.regionBytes);
    const entries: (EntryState | undefined)[] = Array.from({ length: regions });
    entries[0] = INITIAL_ENTRY;
    const summaries: (Extract<FormatJobResult, { summary: unknown }> | undefined)[] = Array.from({
      length: regions,
    });
    const entryWaiters: Array<(() => void) | undefined> = Array.from({ length: regions });
    /** Workers inside summarize. They register with `entryFor` only after that call returns. */
    const summarizeWaiters: Array<(() => void) | undefined> = Array.from({ length: regions });
    const summarizeReleased: boolean[] = Array.from({ length: regions }, () => false);
    let resolvedUpTo = 0;
    const advance = () => {
      while (resolvedUpTo + 1 < regions) {
        const summary = summaries[resolvedUpTo];
        if (!summary) break;
        const state = entries[resolvedUpTo] as EntryState;
        entries[resolvedUpTo + 1] = advanceEntry(
          state,
          summary.summary,
          resolvedUpTo * geometry.regionBytes,
          FULL_DEPTH,
        );
        summaries[resolvedUpTo] = undefined;
        resolvedUpTo++;
        entryWaiters[resolvedUpTo]?.();
        entryWaiters[resolvedUpTo] = undefined;
      }
    };
    /**
     * Set by `releaseWaiters` when a failure closes the entry chain. The worker
     * that failed returns without summarizing the regions it still owns, so a
     * later entry never arrives. A worker inside `pool.call` of summarize has
     * not registered in `entryWaiters` yet; the closed chain is its release.
     */
    let entryChainClosed = false;
    // Resolves to undefined when the region no longer matters (see `stopped`).
    const entryFor = (k: number) =>
      new Promise<EntryState | undefined>((resolve) => {
        if (summarizeReleased[k] || (entryChainClosed && stopped(k))) {
          resolve(undefined);
          return;
        }
        const known = entries[k];
        if (known) resolve(known);
        else entryWaiters[k] = () => resolve(entries[k]);
      });

    // Outputs wait in `ready` until every earlier region has been written.
    const ready: ({ output: Uint8Array; count: number } | undefined)[] = Array.from({
      length: regions,
    });
    let written = 0;
    let draining: Promise<void> = Promise.resolve();
    let drainWaiters: Array<() => void> = [];
    const drain = () => {
      draining = draining.then(async () => {
        while (written < regions && ready[written]) {
          const result = ready[written] as { output: Uint8Array; count: number };
          ready[written] = undefined;
          written++;
          rows += result.count;
          bytesOut += result.output.length;
          if (result.output.length > 0) await sink.write(result.output);
        }
        const waiting = drainWaiters;
        drainWaiters = [];
        for (const resume of waiting) resume();
      });
      return draining;
    };
    // The earliest failing region wins; regions after it need not run.
    let firstFailure:
      | { region: number; offset: number; reason: string; detail: string }
      | undefined;
    let hardFailure: unknown;
    /** A region after the first failure, or any region once a job has failed hard, need not run. */
    const stopped = (k: number) =>
      hardFailure !== undefined || (firstFailure !== undefined && k > firstFailure.region);
    /**
     * Wakes what waits on a region that will never come: a worker that stopped at a failure
     * skips its later regions, so the entry states and written positions after it never arrive.
     */
    const releaseWaiters = () => {
      for (let k = 0; k < regions; k++) {
        const waiter = entryWaiters[k];
        if (waiter && stopped(k)) {
          entryWaiters[k] = undefined;
          waiter();
        }
        const inflight = summarizeWaiters[k];
        if (inflight && stopped(k)) {
          summarizeWaiters[k] = undefined;
          inflight();
        }
      }
      entryChainClosed = true;
      const waiting = drainWaiters;
      drainWaiters = [];
      for (const resume of waiting) resume();
    };
    const waitForRoom = async (k: number) => {
      while (k - written >= pool.size * 3 && !stopped(k)) {
        await new Promise<void>((resolve) => drainWaiters.push(resolve));
      }
    };

    const workerLoop = async (worker: number) => {
      for (let k = worker; k < regions; k += pool.size) {
        if (stopped(k)) return;
        await waitForRoom(k);
        if (stopped(k)) return;
        try {
          summarizeWaiters[k] = () => {
            summarizeReleased[k] = true;
          };
          const summary = (await pool.call(worker, {
            type: "summarize",
            sourceId,
            region: k,
            geometry,
          })) as Extract<FormatJobResult, { summary: unknown }>;
          summarizeWaiters[k] = undefined;
          summaries[k] = summary;
          advance();
          const entry = await entryFor(k);
          if (!entry) return;
          const result = (await pool.call(worker, {
            type: "convert",
            sourceId,
            region: k,
            entry,
            target,
            geometry,
          })) as { output: Uint8Array; count: number };
          ready[k] = result;
          drain();
        } catch (error) {
          summarizeWaiters[k] = undefined;
          if (error instanceof JobFailedError && error.failure.kind === "offending") {
            if (!firstFailure || k < firstFailure.region) {
              firstFailure = {
                region: k,
                offset: error.failure.offset,
                reason: error.failure.reason,
                detail: error.failure.detail,
              };
            }
            // Later regions of this worker cannot matter; earlier ones on other workers still do.
            releaseWaiters();
            continue;
          }
          hardFailure = error;
          releaseWaiters();
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(pool.size, regions) }, (_, w) => workerLoop(w)),
    );
    if (hardFailure !== undefined) throw hardFailure;
    await draining;
    if (firstFailure) {
      // Everything before the failing region was written; name the node.
      throw await unrepresentable(input, from, toFormat, {
        kind: "offending",
        offset: firstFailure.offset,
        reason: firstFailure.reason,
        detail: firstFailure.detail,
      });
    }
    if (written !== regions) throw new Error(`wrote ${written} of ${regions} regions`);
    return { bytesIn: size, bytesOut, rows, regions };
  } finally {
    await close();
  }
};

let nextSourceId = 1;

const unrepresentable = async (
  input: SourceInput,
  from: ConvertFormat,
  to: ConvertFormat,
  failure: Extract<JobFailure, { kind: "offending" }>,
) => {
  const source = input.source ?? openSource(input.spec);
  let pointer: string;
  try {
    pointer = await locatePointer(source, failure.offset);
  } finally {
    if (!input.source) source.close();
  }
  return new UnrepresentableError({
    from,
    to,
    reason: failure.reason as UnrepresentableError["reason"],
    pointer,
    detail: failure.detail,
  });
};
