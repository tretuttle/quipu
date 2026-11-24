/**
 * Runs one search across a pool: cuts the file into chunks, gives each worker
 * the next chunk when it is idle, and merges the chunks' hits in file order into
 * the hit list a sequential scan would have produced (see search.ts for the
 * chunk rules). Platform-neutral: the pool is the only thing it touches.
 */
import { BudgetExceededError, type Pool } from "./pool.ts";
import type { ChunkOptions, ChunkResult, SearchSpec } from "./search.ts";

export interface SearchRunOptions {
  /** Nominal bytes per chunk. */
  readonly chunkBytes: number;
  readonly chunk: ChunkOptions;
  /** Time a chunk may take before its worker is stopped; null for no limit. */
  readonly budgetMs: number | null;
  /** Chunks that may overrun their budget before the search gives up. */
  readonly maxSkipped: number;
  /** Hits kept in the list; the count is exact beyond it. */
  readonly maxRetained: number;
  /** How many of the pool's workers take chunks; all by default. */
  readonly workers?: number;
  readonly isCancelled: () => boolean;
}

export interface SkippedRange {
  readonly start: number;
  readonly end: number;
}

export interface SearchOutcome {
  /** Every hit, exactly. */
  readonly count: number;
  /** Retained hits as `start, end` pairs in file order. */
  readonly hits: Float64Array;
  /** Every hit that starts before this offset is in `hits`. */
  readonly retainedUntil: number;
  readonly skipped: ReadonlyArray<SkippedRange>;
  /** Hits whose match may have been cut at the end of the lookahead. */
  readonly limited: number;
  /** `partial`: the search stopped early, after too many chunks overran their budget. */
  readonly status: "complete" | "partial" | "cancelled";
}

export interface SearchTarget {
  readonly sourceId: number;
  /** Size of the whole source. */
  readonly size: number;
  readonly decode: boolean;
  /** Search only `[start, end)`; the whole source by default. */
  readonly start?: number;
  readonly end?: number;
}

export const runSearch = async (
  pool: Pool,
  target: SearchTarget,
  spec: SearchSpec,
  options: SearchRunOptions,
): Promise<SearchOutcome> => {
  const { size } = target;
  const from = target.start ?? 0;
  const to = target.end ?? size;
  const chunkCount = Math.max(0, Math.ceil((to - from) / options.chunkBytes));
  const results: Array<ChunkResult | null | undefined> = Array.from({ length: chunkCount });
  const skipped: SkippedRange[] = [];
  let next = 0;
  const abort = { stopped: false };

  const chunkJob = (a: number, b: number, resumeAt: number | null) =>
    ({
      type: "search",
      sourceId: target.sourceId,
      start: a,
      end: b,
      size,
      decode: target.decode,
      spec,
      options: options.chunk,
      resumeAt,
    }) as const;
  const nominal = (index: number) => ({
    a: from + index * options.chunkBytes,
    b: Math.min(to, from + (index + 1) * options.chunkBytes),
  });
  /** One chunk on one worker; null when it overran its budget. */
  const run = async (worker: number, index: number, resumeAt: number | null) => {
    const { a, b } = nominal(index);
    try {
      return await pool.call<ChunkResult>(worker, chunkJob(a, b, resumeAt), [], options.budgetMs);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      skipped.push({ start: resumeAt ?? a, end: b });
      if (skipped.length >= options.maxSkipped) abort.stopped = true;
      return null;
    }
  };

  await Promise.all(
    pool.workers.slice(0, options.workers ?? pool.size).map(async (_, worker) => {
      while (!abort.stopped && !options.isCancelled()) {
        const index = next++;
        if (index >= chunkCount) return;
        results[index] = await run(worker, index, null);
      }
    }),
  );

  // Merge in file order. `carry` is where a sequential scan would resume: the end
  // of the last hit so far. A chunk whose first hit starts inside the previous
  // chunk's last hit was scanned from the wrong place and is scanned again.
  let carry = 0;
  let count = 0;
  let limited = 0;
  let retained = 0;
  let retainedUntil = size;
  let holes = false;
  const kept: Float64Array[] = [];
  for (let index = 0; index < chunkCount; index++) {
    let result = results[index];
    if (result === undefined || result === null) continue;
    if (result.count > 0 && (result.hits[0] as number) < carry) {
      if (carry >= result.end) {
        result = { ...result, count: 0, hits: new Float64Array(0), limited: 0 };
      } else {
        const again = await run(index % (options.workers ?? pool.size), index, carry);
        if (again === null) continue;
        result = again;
      }
    }
    count += result.count;
    limited += result.limited;
    if (result.count > 0) carry = Math.max(carry, result.lastEnd);
    if (holes) continue;
    const room = Math.max(0, options.maxRetained - retained);
    const stored = result.hits.length / 2;
    if (stored <= room && result.count === stored) {
      kept.push(result.hits);
      retained += stored;
      continue;
    }
    // This chunk's hits do not all fit (or the chunk itself kept fewer than it found):
    // keep what fits and stop retaining, so the list never has a hole in the middle.
    const take = Math.min(stored, room);
    kept.push(result.hits.subarray(0, take * 2));
    retained += take;
    retainedUntil = take > 0 ? (result.hits[take * 2 - 1] as number) : result.start;
    holes = true;
  }
  const hits = new Float64Array(retained * 2);
  let at = 0;
  for (const part of kept) {
    hits.set(part, at);
    at += part.length;
  }
  const status = options.isCancelled() ? "cancelled" : abort.stopped ? "partial" : "complete";
  return { count, hits, retainedUntil, skipped, limited, status };
};
