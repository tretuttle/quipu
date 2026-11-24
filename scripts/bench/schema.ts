/**
 * The bench result file (`bench/results/<surface>.json`, ignored by git): one
 * row per measure with its samples, statistics, budget and result. `pass` is
 * computed from the samples by `summarize`, never written by hand.
 */
import * as Schema from "effect/Schema";

export const BenchUnit = Schema.Literals(["ms", "bytes", "MiB/s"]);
export const BenchComparator = Schema.Literals(["lte", "gte"]);
export const BenchStatistic = Schema.Literals(["median", "p95", "max"]);

export const BenchRow = Schema.Struct({
  measure: Schema.String,
  /** The budget's number in the table, counted from 1; two measures of one budget share it. */
  row: Schema.Int,
  title: Schema.String,
  fixture: Schema.String,
  fixtureBytes: Schema.Int,
  budget: Schema.Number,
  unit: BenchUnit,
  comparator: BenchComparator,
  statistic: BenchStatistic,
  runs: Schema.Array(Schema.Number),
  median: Schema.Number,
  p95: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  pass: Schema.Boolean,
  invalid: Schema.NullOr(Schema.String),
});
export type BenchRow = typeof BenchRow.Type;

export const BenchFile = Schema.Struct({
  version: Schema.Literal(1),
  surface: Schema.Literals(["chromium", "electron"]),
  browser: Schema.String,
  headless: Schema.Boolean,
  guard: Schema.String,
  machine: Schema.Struct({
    cpu: Schema.String,
    logicalCpus: Schema.Int,
    governor: Schema.String,
    energyPerformancePreference: Schema.String,
    freqKHz: Schema.Struct({ min: Schema.Number, median: Schema.Number, max: Schema.Number }),
    ramBytes: Schema.Int,
  }),
  workers: Schema.Int,
  results: Schema.Array(BenchRow),
  /** Numbers worth keeping that have no budget: tokens, hit counts, process memory. */
  diagnostics: Schema.Record(Schema.String, Schema.Unknown),
});
export type BenchFile = typeof BenchFile.Type;

export const decodeBenchFile = Schema.decodeUnknownSync(BenchFile);
export const encodeBenchFile = Schema.encodeSync(BenchFile);

/** Nearest-rank percentile, clamped to the last sample. */
export const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ] as number;

export const median = (sorted: ReadonlyArray<number>) => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** Timer noise below this median is not a variance finding. */
const VARIANCE_FLOOR_MS = 100;

export const summarize = (
  base: Omit<BenchRow, "runs" | "median" | "p95" | "min" | "max" | "pass" | "invalid">,
  runs: ReadonlyArray<number>,
  invalidReason: string | null,
): BenchRow => {
  const sorted = [...runs].sort((a, b) => a - b);
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  const med = median(sorted);
  const p95 = percentile(sorted, 95);
  let invalid = invalidReason;
  // A 2× spread between runs means the machine, not the engine, was measured.
  if (
    invalid === null &&
    base.unit === "ms" &&
    med >= VARIANCE_FLOOR_MS &&
    min > 0 &&
    max / min > 2
  ) {
    invalid = `max/min = ${(max / min).toFixed(2)} exceeds 2`;
  }
  const statistic = base.statistic === "median" ? med : base.statistic === "p95" ? p95 : max;
  const withinBudget =
    base.comparator === "lte" ? statistic <= base.budget : statistic >= base.budget;
  return {
    ...base,
    runs: [...runs],
    median: med,
    p95,
    min,
    max,
    pass: invalid === null && withinBudget,
    invalid,
  };
};
