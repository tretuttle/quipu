/**
 * Drives a parallel structural index over a byte source. Regions go to workers
 * round-robin in file order. A worker summarizes its region (pass 1, keeping the
 * bytes), waits until every earlier region's summary has arrived so its entry
 * state is known, runs pass 2 and transfers the region's tape back; the
 * coordinator adopts region tapes in file order. Bytes in flight are bounded by
 * workers × regionBytes.
 *
 * Eager depth is a token budget: region 0 is structured at full depth first and
 * its token density projects the whole tape; when that would pass the budget the
 * depth comes down until it fits, and only then do the other regions' pass 2 run
 * (docs/internals/document-engine.md, "Eager depth is a token budget").
 */
import { type BucketAnchors, TapeMerger } from "./merge.ts";
import type { Pool } from "./pool.ts";
import type { StructureResult, SummarizeResult } from "./protocol.ts";
import { advanceEntry, INITIAL_ENTRY } from "./resolve.ts";
import { type EntryState, firstProblem, FULL_DEPTH, type SyntaxProblem } from "./scan.ts";
import type { MutableTape } from "./tape.ts";

export const DEFAULT_REGION_BYTES = 8 * 1024 * 1024;
/** About 400 MB of tape. */
export const DEFAULT_TOKEN_BUDGET = 16_000_000;

export interface IndexOptions<T extends MutableTape> {
  readonly target: T;
  readonly regionBytes?: number;
  readonly tokenBudget?: number;
  /** Called after region k is merged; region 0 is the first-paint proxy. */
  readonly onRegionMerged?: (region: number, regions: number) => void;
  /**
   * After each merge: the tokens a later region can still change. Everything
   * else on the tape is final, so a reader may answer from the merged prefix.
   */
  readonly onUnsettled?: (tokens: ReadonlyArray<number>) => void;
  /** State at the source's first byte: a re-indexed member starts inside its parent container. */
  readonly initialEntry?: EntryState;
}

export interface IndexStats<T extends MutableTape> {
  readonly tape: T;
  readonly bigStrings: ReadonlyArray<number>;
  readonly anchors: ReadonlyMap<number, BucketAnchors>;
  /** Entry state at the start of every region (what a streaming job needs to start mid-file). */
  readonly entries: ReadonlyArray<EntryState>;
  readonly regions: number;
  readonly regionBytes: number;
  /** The eager depth the budget allowed; FULL_DEPTH when everything fit. */
  readonly maxDepth: number;
  readonly childrenBeyondTape: number;
  /** The first byte that is not JSON, or null for a valid document (`scan.ts`, `SyntaxCode`). */
  readonly problem: SyntaxProblem | null;
}

const DEPTH_LADDER = [FULL_DEPTH, 16, 8, 4, 3, 2, 1, 0];

export const indexDocument = async <T extends MutableTape>(
  pool: Pool,
  sourceId: number,
  size: number,
  options: IndexOptions<T>,
): Promise<IndexStats<T>> => {
  const regionBytes = options.regionBytes ?? DEFAULT_REGION_BYTES;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const regions = Math.max(1, Math.ceil(size / regionBytes));

  // Entry states, resolved in file order as summaries arrive. Resolved at full depth:
  // a later, smaller eager depth only reads a prefix of the kinds.
  const entries: (EntryState | undefined)[] = Array.from({ length: regions });
  entries[0] = options.initialEntry ?? INITIAL_ENTRY;
  const summaries: (SummarizeResult | undefined)[] = Array.from({ length: regions });
  let resolvedUpTo = 0;
  const entryWaiters: Array<(() => void) | undefined> = Array.from({ length: regions });
  const advance = () => {
    while (resolvedUpTo + 1 < regions) {
      const summary = summaries[resolvedUpTo];
      if (!summary) break;
      const state = entries[resolvedUpTo] as EntryState;
      entries[resolvedUpTo + 1] = advanceEntry(
        state,
        summary.summary,
        resolvedUpTo * regionBytes,
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

  // The eager depth, decided on region 0 and awaited by every other region's pass 2.
  let maxDepth = FULL_DEPTH;
  let depthDecided!: () => void;
  const depthPromise = new Promise<void>((resolve) => {
    depthDecided = resolve;
  });
  let merger: TapeMerger | undefined;

  // Results merged in file order; out-of-order arrivals wait in `ready`.
  const ready: (StructureResult | undefined)[] = Array.from({ length: regions });
  let mergedUpTo = 0;
  let problem: SyntaxProblem | null = null;
  const drain = () => {
    while (mergedUpTo < regions && ready[mergedUpTo]) {
      const result = ready[mergedUpTo] as StructureResult;
      problem = firstProblem(problem, result.report.problem);
      ready[mergedUpTo] = undefined;
      (merger as TapeMerger).append(result.buffers, result.report);
      options.onUnsettled?.((merger as TapeMerger).unsettledTokens());
      options.onRegionMerged?.(mergedUpTo, regions);
      mergedUpTo++;
    }
  };

  const structureRegion0 = async (entry: EntryState) => {
    const end = Math.min(size, regionBytes);
    let result: StructureResult | undefined;
    for (let step = 0; step < DEPTH_LADDER.length; step++) {
      const depth = DEPTH_LADDER[step] as number;
      const last = step === DEPTH_LADDER.length - 1;
      result = await pool.call<StructureResult>(0, {
        type: "structure",
        sourceId,
        region: 0,
        start: 0,
        end,
        entry,
        maxDepth: depth,
        keepBytes: !last,
      });
      const projected = (result.buffers.count / end) * size;
      if (projected <= tokenBudget || last) {
        maxDepth = depth;
        break;
      }
    }
    merger = new TapeMerger(options.target, maxDepth);
    depthDecided();
    return result as StructureResult;
  };

  const workerLoop = async (worker: number) => {
    for (let k = worker; k < regions; k += pool.size) {
      const start = k * regionBytes;
      const end = Math.min(size, start + regionBytes);
      const summary = await pool.call<SummarizeResult>(worker, {
        type: "summarize",
        sourceId,
        region: k,
        start,
        end,
        maxDepth: FULL_DEPTH,
      });
      summaries[k] = summary;
      advance();
      const entry = await entryFor(k);
      let result: StructureResult;
      if (k === 0) result = await structureRegion0(entry);
      else {
        await depthPromise;
        result = await pool.call<StructureResult>(worker, {
          type: "structure",
          sourceId,
          region: k,
          start,
          end,
          entry,
          maxDepth,
          keepBytes: false,
        });
      }
      ready[k] = result;
      drain();
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool.size, regions) }, (_, w) => workerLoop(w)));
  drain();
  if (mergedUpTo !== regions) throw new Error(`merged ${mergedUpTo} of ${regions} regions`);
  const done = merger as TapeMerger;
  // What only the end of the file can say: a string or a container still open.
  const lastStart = (regions - 1) * regionBytes;
  const final = advanceEntry(
    entries[regions - 1] as EntryState,
    (summaries[regions - 1] as SummarizeResult).summary,
    lastStart,
    FULL_DEPTH,
  );
  if (final.inString) {
    problem = firstProblem(problem, {
      offset: Math.max(0, final.openStringStart),
      code: "unterminated",
    });
  } else if (final.depth > 0) problem = firstProblem(problem, { offset: size, code: "end" });
  return {
    problem,
    tape: options.target,
    bigStrings: done.bigStrings,
    anchors: done.anchors,
    entries: entries as EntryState[],
    regions,
    regionBytes,
    maxDepth,
    childrenBeyondTape: done.childrenBeyondTape,
  };
};
