// @effect-diagnostics nodeBuiltinImport:off - reads the bench result file and prints its table.
/**
 * Renders the markdown table for a bench result file: `vp run bench:table
 * [bench/results/chromium.json]`. The file is local output of `vp run bench`;
 * without one there is nothing to render, and the command says so.
 */
import * as NodeFS from "node:fs";

import { type BenchFile, type BenchRow, decodeBenchFile } from "./schema.ts";

const format = (value: number, unit: BenchRow["unit"]) =>
  unit === "ms"
    ? `${value.toFixed(1)} ms`
    : unit === "bytes"
      ? `${Math.round(value / 1e6)} MB`
      : `${value.toFixed(1)} MiB/s`;

export const renderTable = (file: BenchFile) => {
  const lines = [
    "| # | Measure | Fixture | Budget | Median | Min | Max | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of file.results) {
    const budget = `${row.comparator === "lte" ? "≤" : "≥"} ${format(row.budget, row.unit)}`;
    const result = row.pass ? "PASS" : row.invalid === null ? "FAIL" : `INVALID (${row.invalid})`;
    const statistic =
      row.statistic === "median"
        ? ""
        : ` (${row.statistic} ${format(row.statistic === "max" ? row.max : row.p95, row.unit)})`;
    lines.push(
      `| ${row.row} | ${row.title} | ${row.fixture} | ${budget} | ${format(row.median, row.unit)} | ${format(row.min, row.unit)} | ${format(row.max, row.unit)} | ${result}${statistic} |`,
    );
  }
  return lines.join("\n");
};

export const renderHeader = (file: BenchFile) =>
  `${file.surface} ${file.browser}${file.headless ? " (headless)" : ""}, ${file.workers} scan workers, ${file.results[0]?.runs.length ?? 0} runs, ${file.machine.cpu}, governor ${file.machine.governor} (${file.machine.energyPerformancePreference})`;

if (process.argv[1]?.endsWith("table.ts")) {
  const path = process.argv[2] ?? "bench/results/chromium.json";
  if (NodeFS.existsSync(path)) {
    const file = decodeBenchFile(JSON.parse(NodeFS.readFileSync(path, "utf8")));
    process.stdout.write(`${renderHeader(file)}\n\n${renderTable(file)}\n`);
  } else process.stdout.write(`no bench result at ${path}; run \`vp run bench\` first\n`);
}
