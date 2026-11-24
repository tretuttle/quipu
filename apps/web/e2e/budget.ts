// @effect-diagnostics nodeBuiltinImport:off - appends timing lines to a file from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";

import { expect } from "vite-plus/test";

/** Every time budget is checked against the median of this many runs, so one slow sample does not decide it. */
const BUDGET_RUNS = 5;

/**
 * Budgets fail a test only when `QUIPU_ENFORCE_BUDGETS=1`. They are meant for
 * a quiet machine with all its cores; on a busy or smaller one the numbers say
 * little about the product, so by default they are measured and printed only.
 */
const BUDGETS_ENFORCED = process.env.QUIPU_ENFORCE_BUDGETS?.trim() === "1";

function median(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) throw new Error("the median of no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Runs `measure` {@link BUDGET_RUNS} times, one after another, and returns what each run measured. */
export async function sampleRuns<A>(measure: (run: number) => Promise<A>): Promise<A[]> {
  const samples: A[] = [];
  for (let run = 0; run < BUDGET_RUNS; run++) samples.push(await measure(run));
  return samples;
}

/**
 * Checks a time budget (≤ `budgetMs`) on the median of its {@link BUDGET_RUNS}
 * samples. Every sample is printed and appended to `$QUIPU_E2E_TIMINGS` when it
 * is set (the reporter hides a passing test's console); a median within 5 % of
 * the budget is marked as worth a look. With {@link BUDGETS_ENFORCED}, a miss
 * fails the test without stopping it, so every budget a test measures is
 * recorded; without it, a miss is only printed.
 */
export function expectMedianWithin(
  label: string,
  samples: ReadonlyArray<number>,
  budgetMs: number,
  record: (line: string) => void = () => {},
): void {
  expect(samples, `${label}: one sample per run`).toHaveLength(BUDGET_RUNS);
  const middle = median(samples);
  const near = middle <= budgetMs && middle > budgetMs * 0.95;
  const note =
    middle > budgetMs
      ? BUDGETS_ENFORCED
        ? " (over budget)"
        : " (over budget; not enforced without QUIPU_ENFORCE_BUDGETS=1)"
      : near
        ? " (median within 5 % of the budget)"
        : "";
  const line = `${label}: samples=[${samples.map((s) => s.toFixed(1)).join(", ")}] ms, median=${middle.toFixed(1)} ms, budget ${budgetMs} ms${note}`;
  console.log(line);
  if (process.env.QUIPU_E2E_TIMINGS)
    NodeFS.appendFileSync(process.env.QUIPU_E2E_TIMINGS, `${line}\n`);
  record(line);
  if (BUDGETS_ENFORCED) expect.soft(middle, line).toBeLessThanOrEqual(budgetMs);
}
