/**
 * Indexes NDJSON and CSV/TSV onto the engine's tape through a pool of format
 * workers. The shape is the one `@quipu/core` builds: a segmented tape, a root
 * array whose children are the lines or the row objects, and, when the token
 * budget does not allow the rows (or fields) on the tape, a root with
 * `childCount` and anchors every LINE_BUCKET-th row so a page of rows is indexed
 * on demand from its own byte range (docs/internals/document-engine.md, "Eager
 * depth is a token budget").
 */
import { advanceCsvEntry as advance } from "./lineTape.ts";
import { KIND_ARRAY, NO_KEY, TapeBuilder } from "@quipu/core/tape";
import { SegmentedTape } from "@quipu/core/segmentedTape";
import type { SourceSpec } from "@quipu/core/source";

import { defaultGeometry, type FormatJob, type FormatJobResult } from "./jobs.ts";
import {
  CSV_INITIAL_ENTRY,
  type CsvEntry,
  type CsvHeader,
  LINE_BUCKET,
  type LineRegion,
} from "./lineTape.ts";
import type { FormatPool } from "./pool.ts";

export const DEFAULT_LINE_TOKEN_BUDGET = 16_000_000;

export interface LineIndex {
  readonly tape: SegmentedTape;
  /** Lines or rows in the file (blank lines excluded). */
  readonly rows: number;
  /** Eager depth: 1+ rows and fields (csv) or full lines, 0 rows only (csv) / line values (ndjson), -1 root only. */
  readonly depth: number;
  /** [row ordinal, absolute offset] pairs, ascending; empty unless depth is -1. */
  readonly anchors: ReadonlyArray<number>;
  readonly header: CsvHeader | undefined;
  readonly regions: number;
}

export interface LineIndexOptions {
  readonly kind: "ndjson" | "csv";
  readonly delimiter?: number;
  readonly regionBytes?: number;
  readonly tokenBudget?: number;
}

const EMPTY_HEADER: CsvHeader = { delimiter: 0x2c, dataStart: 0, fieldStarts: [] };

const NDJSON_LADDER = [1 << 20, 8, 4, 2, 1, 0, -1];
const CSV_LADDER = [1, 0, -1];

let nextSourceId = 1 << 20;

export const indexLineDocument = async (
  pool: FormatPool<FormatJob, FormatJobResult>,
  input: { readonly spec: SourceSpec; readonly size: number },
  options: LineIndexOptions,
): Promise<LineIndex> => {
  const geometry = defaultGeometry(options.regionBytes);
  const sourceId = nextSourceId++;
  const size = input.size;
  const budget = options.tokenBudget ?? DEFAULT_LINE_TOKEN_BUDGET;
  const csv = options.kind === "csv";
  await pool.broadcast({ type: "open", sourceId, spec: input.spec });
  try {
    const tape = new SegmentedTape();
    const rootBuilder = new TapeBuilder(1);
    rootBuilder.push(KIND_ARRAY, 0, -1, NO_KEY);
    rootBuilder.setEnd(0, size);
    tape.appendSegment(rootBuilder.detach(), (p) => p);
    if (size === 0) {
      return { tape, rows: 0, depth: 1 << 20, anchors: [], header: undefined, regions: 0 };
    }
    let header = EMPTY_HEADER;
    if (csv) {
      const found = (await pool.call(0, {
        type: "csvHeader",
        sourceId,
        delimiter: options.delimiter ?? 0x2c,
      })) as { header: CsvHeader };
      header = found.header;
    }
    const regions = Math.ceil(size / geometry.regionBytes);

    // Entry states (csv only): quote parity chains region to region.
    const entries: (CsvEntry | undefined)[] = Array.from({ length: regions });
    entries[0] = CSV_INITIAL_ENTRY;
    if (csv) {
      const summaries: ({ quoteParity: number; lastByte: number } | undefined)[] = Array.from({
        length: regions,
      });
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(pool.size, regions) }, async (_, w) => {
          for (let k = w; k < regions; k += pool.size) {
            summaries[k] = (await pool.call(w, {
              type: "csvSummarize",
              sourceId,
              region: k,
              geometry,
            })) as { quoteParity: number; lastByte: number };
            // Resolve as far as the chain is complete.
            while (next + 1 < regions && summaries[next]) {
              entries[next + 1] = advance(entries[next] as CsvEntry, summaries[next] as never);
              next++;
            }
          }
        }),
      );
    }

    const run = async (worker: number, region: number, depth: number) =>
      (
        (await pool.call(worker, {
          type: "lineRegion",
          sourceId,
          region,
          geometry,
          kind: options.kind,
          depth,
          entry: entries[region] as CsvEntry,
          header,
        })) as { region: LineRegion }
      ).region;

    // The eager depth is decided on region 0, as the engine does.
    const ladder = csv ? CSV_LADDER : NDJSON_LADDER;
    let depth = ladder[ladder.length - 1] as number;
    let first: LineRegion | undefined;
    const regionSpan = Math.min(size, geometry.regionBytes);
    for (const candidate of ladder) {
      const result = await run(0, 0, candidate);
      const projected = (result.buffers.count / regionSpan) * size;
      if (projected <= budget || candidate === ladder[ladder.length - 1]) {
        depth = candidate;
        first = result;
        break;
      }
    }

    const results: (LineRegion | undefined)[] = Array.from({ length: regions });
    results[0] = first;
    await Promise.all(
      Array.from({ length: Math.min(pool.size, regions) }, async (_, w) => {
        for (let k = w; k < regions; k += pool.size) {
          if (k === 0) continue;
          results[k] = await run(w, k, depth);
        }
      }),
    );

    let rows = 0;
    let previousLast = -1;
    const anchors: number[] = [];
    for (let k = 0; k < regions; k++) {
      const region = results[k] as LineRegion;
      const base = tape.count;
      tape.appendSegment(region.buffers, (p) => (p === -1 ? 0 : p + base));
      if (region.firstTop >= 0) {
        if (previousLast >= 0) tape.setNext(previousLast, base + region.firstTop);
        previousLast = base + region.lastTop;
      }
      for (let a = 0; a < region.anchors.length; a += 2) {
        anchors.push(rows + (region.anchors[a] as number), region.anchors[a + 1] as number);
      }
      rows += region.rows;
    }
    tape.setChildCount(0, rows);
    // Row-less depths report no top tokens; link the root's children only when they exist.
    return { tape, rows, depth, anchors, header: csv ? header : undefined, regions };
  } finally {
    await pool.broadcast({ type: "close", sourceId });
  }
};

export { LINE_BUCKET };
