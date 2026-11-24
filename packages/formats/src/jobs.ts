/**
 * The format worker's job runner, platform-neutral like the engine's
 * (`createJobRunner` in @quipu/core/jobs): the worker entry gives it
 * `openSource` and forwards messages. A worker keeps the window of a region
 * between its summarize and convert jobs so each byte is read once, and owns one
 * window buffer and one output writer for its whole life.
 */
import { summarize } from "@quipu/core/scan";
import type { BoundarySummary, EntryState } from "@quipu/core/scan";
import { FULL_DEPTH } from "@quipu/core/scan";
import type { ByteSource, SourceSpec } from "@quipu/core/source";

import { OffendingNode } from "./abort.ts";
import { ByteWriter } from "./byteWriter.ts";
import {
  collectColumns,
  convertRegion,
  MAX_ROW_BYTES,
  OVERHANG_BYTES,
  type Target,
} from "./convertRegion.ts";
import { bomLength } from "./csvField.ts";
import {
  type CsvEntry,
  type CsvHeader,
  type LineDepth,
  type LineRegion,
  readCsvHeader,
  structureCsv,
  structureNdjson,
  summarizeCsv,
} from "./lineTape.ts";
import type { JobFailure } from "./pool.ts";
import { type TapeBuffers, TapeBuilder, transferList } from "@quipu/core/tape";
import { advanceXml, scanXml, type XmlEntry } from "./xmlTape.ts";

export interface Geometry {
  readonly regionBytes: number;
  readonly overhang: number;
}

export type FormatJob =
  | { readonly type: "open"; readonly sourceId: number; readonly spec: SourceSpec }
  | { readonly type: "close"; readonly sourceId: number }
  | {
      readonly type: "summarize";
      readonly sourceId: number;
      readonly region: number;
      readonly geometry: Geometry;
    }
  | {
      readonly type: "convert";
      readonly sourceId: number;
      readonly region: number;
      readonly entry: EntryState;
      readonly target: Target;
      readonly geometry: Geometry;
    }
  | {
      readonly type: "columns";
      readonly sourceId: number;
      readonly maxRows: number;
      readonly bytes: number;
    }
  | {
      readonly type: "xmlLex";
      readonly sourceId: number;
      readonly region: number;
      readonly geometry: Geometry;
      readonly entry: XmlEntry;
    }
  | {
      readonly type: "xmlRegion";
      readonly sourceId: number;
      readonly region: number;
      readonly geometry: Geometry;
      readonly entry: XmlEntry;
      readonly maxLevel: number;
    }
  | { readonly type: "csvHeader"; readonly sourceId: number; readonly delimiter: number }
  | {
      readonly type: "csvSummarize";
      readonly sourceId: number;
      readonly region: number;
      readonly geometry: Geometry;
    }
  | {
      readonly type: "lineRegion";
      readonly sourceId: number;
      readonly region: number;
      readonly geometry: Geometry;
      readonly kind: "ndjson" | "csv";
      readonly depth: LineDepth;
      readonly entry: CsvEntry;
      readonly header: CsvHeader;
    };

export type FormatJobResult =
  | null
  | { readonly summary: BoundarySummary }
  | { readonly output: Uint8Array; readonly count: number }
  | { readonly columns: ReadonlyArray<Uint8Array>; readonly size: number }
  | { readonly header: CsvHeader; readonly complete: boolean }
  | { readonly quoteParity: number; readonly lastByte: number }
  | { readonly region: LineRegion }
  | { readonly exit: XmlEntry }
  | {
      readonly buffers: TapeBuffers;
      readonly closes: number[];
      readonly cutInherited: number;
      readonly elements: number;
    };

export interface Platform {
  openSource(spec: SourceSpec): ByteSource;
}

export interface JobOutcome {
  readonly result: FormatJobResult;
  readonly transfer: ArrayBuffer[];
}

export const defaultGeometry = (regionBytes = 8 * 1024 * 1024): Geometry => ({
  regionBytes,
  overhang: OVERHANG_BYTES,
});

/** The failure a thrown value becomes on its way back to the coordinator. */
export const toFailure = (error: unknown): JobFailure =>
  error instanceof OffendingNode
    ? { kind: "offending", offset: error.offset, reason: error.reason, detail: error.detail }
    : {
        kind: "error",
        message: error instanceof Error ? (error.stack ?? error.message) : `${error as string}`,
      };

export const createFormatJobRunner = (platform: Platform) => {
  const sources = new Map<number, ByteSource>();
  const windows = new Map<string, { bytes: Uint8Array; length: number }>();
  let windowBuffer = new ArrayBuffer(0);
  const writer = new ByteWriter(1 << 20);
  const builder = new TapeBuilder(1 << 16);

  const source = (id: number) => {
    const s = sources.get(id);
    if (!s) throw new Error(`source ${id} is not open in this worker`);
    return s;
  };

  const readWindow = async (
    src: ByteSource,
    start: number,
    end: number,
    overhang: number,
    from = start,
  ): Promise<Uint8Array> => {
    const to = Math.min(src.size, end + overhang);
    const r = await src.readInto(from, to, windowBuffer);
    windowBuffer = r.buffer;
    return r.bytes;
  };

  return async (job: FormatJob): Promise<JobOutcome> => {
    switch (job.type) {
      case "open": {
        sources.get(job.sourceId)?.close();
        sources.set(job.sourceId, platform.openSource(job.spec));
        return { result: null, transfer: [] };
      }
      case "close": {
        sources.get(job.sourceId)?.close();
        sources.delete(job.sourceId);
        for (const key of windows.keys())
          if (key.startsWith(`${job.sourceId}:`)) windows.delete(key);
        return { result: null, transfer: [] };
      }
      case "summarize": {
        const src = source(job.sourceId);
        const start = job.region * job.geometry.regionBytes;
        const end = Math.min(src.size, start + job.geometry.regionBytes);
        const bytes = await readWindow(src, start, end, job.geometry.overhang);
        windows.set(`${job.sourceId}:${job.region}`, { bytes, length: end - start });
        const summary = summarize(bytes.subarray(0, end - start), start, FULL_DEPTH);
        return { result: { summary }, transfer: [] };
      }
      case "convert": {
        const src = source(job.sourceId);
        const start = job.region * job.geometry.regionBytes;
        const end = Math.min(src.size, start + job.geometry.regionBytes);
        const key = `${job.sourceId}:${job.region}`;
        let window = windows.get(key)?.bytes;
        windows.delete(key);
        if (!window) window = await readWindow(src, start, end, job.geometry.overhang);
        let overhang = job.geometry.overhang;
        for (;;) {
          writer.reset();
          const r = convertRegion(window, start, end, src.size, job.entry, job.target, writer, {
            regionBytes: job.geometry.regionBytes,
            overhang: job.geometry.overhang,
          });
          if (r.status === "ok") {
            const output = writer.take();
            return { result: { output, count: r.count }, transfer: [output.buffer as ArrayBuffer] };
          }
          overhang *= 2;
          if (overhang > MAX_ROW_BYTES) {
            throw new OffendingNode(
              r.at ?? start,
              "token-too-large",
              "a row or value larger than 64 MiB",
            );
          }
          window = await readWindow(src, start, end, overhang);
        }
      }
      case "xmlLex": {
        const src = source(job.sourceId);
        const start = job.region * job.geometry.regionBytes;
        const end = Math.min(src.size, start + job.geometry.regionBytes);
        let overhang = job.geometry.overhang;
        let window = await readWindow(src, start, end, overhang);
        for (;;) {
          const r = advanceXml(window, start, end, src.size, job.entry);
          if (!r.needMore) {
            windows.set(`${job.sourceId}:${job.region}`, { bytes: window, length: end - start });
            return { result: { exit: r.exit }, transfer: [] };
          }
          overhang *= 2;
          if (overhang > MAX_ROW_BYTES) {
            throw new OffendingNode(start, "token-too-large", "a tag larger than 64 MiB");
          }
          window = await readWindow(src, start, end, overhang);
        }
      }
      case "xmlRegion": {
        const src = source(job.sourceId);
        const start = job.region * job.geometry.regionBytes;
        const end = Math.min(src.size, start + job.geometry.regionBytes);
        const key = `${job.sourceId}:${job.region}`;
        let window = windows.get(key)?.bytes;
        windows.delete(key);
        let overhang = job.geometry.overhang;
        if (!window) window = await readWindow(src, start, end, overhang);
        for (;;) {
          builder.reset();
          const r = scanXml(window, start, end, src.size, job.entry, builder, job.maxLevel);
          if (!r.needMore) {
            const buffers = builder.detach();
            return {
              result: {
                buffers,
                closes: r.closes,
                cutInherited: r.cutInherited,
                elements: r.elements,
              },
              transfer: transferList(buffers),
            };
          }
          overhang *= 2;
          if (overhang > MAX_ROW_BYTES) {
            throw new OffendingNode(start, "token-too-large", "a tag larger than 64 MiB");
          }
          window = await readWindow(src, start, end, overhang);
        }
      }
      case "csvHeader": {
        const src = source(job.sourceId);
        let size = Math.min(src.size, 1 << 20);
        for (;;) {
          const bytes = await src.read(0, size);
          const found = readCsvHeader(bytes, bomLength(bytes), job.delimiter);
          if (found.complete || size >= src.size || size >= MAX_ROW_BYTES) {
            return { result: found, transfer: [] };
          }
          size = Math.min(src.size, size * 2);
        }
      }
      case "csvSummarize": {
        const src = source(job.sourceId);
        const start = job.region * job.geometry.regionBytes;
        const end = Math.min(src.size, start + job.geometry.regionBytes);
        const from = Math.max(0, start - 1);
        // The window is not kept: every region is summarized before any is structured, and
        // the worker's one window buffer is reused by the next read.
        const bytes = await readWindow(src, from, end, 0, from);
        const result = summarizeCsv(bytes.subarray(start - from, end - from));
        return { result, transfer: [] };
      }
      case "lineRegion": {
        const src = source(job.sourceId);
        const start = job.region * job.geometry.regionBytes;
        const end = Math.min(src.size, start + job.geometry.regionBytes);
        const from = Math.max(0, start - 1);
        const key = `${job.sourceId}:${job.region}`;
        let window = windows.get(key)?.bytes;
        windows.delete(key);
        let overhang = job.geometry.overhang;
        if (!window) window = await readWindow(src, from, end, overhang, from);
        for (;;) {
          const region: LineRegion =
            job.kind === "ndjson"
              ? structureNdjson(window, from, start, end, src.size, job.depth, builder)
              : structureCsv(
                  window,
                  from,
                  start,
                  end,
                  src.size,
                  job.entry,
                  job.header,
                  job.depth,
                  builder,
                );
          if (!region.needMore) {
            return { result: { region }, transfer: transferList(region.buffers) };
          }
          overhang *= 2;
          if (overhang > MAX_ROW_BYTES) {
            throw new OffendingNode(start, "token-too-large", "a row or line larger than 64 MiB");
          }
          window = await readWindow(src, from, end, overhang, from);
        }
      }
      case "columns": {
        const src = source(job.sourceId);
        const size = Math.min(src.size, job.bytes);
        let window = await src.read(0, size);
        let names = collectColumns(window, job.maxRows, size >= src.size);
        let grown = size;
        // A first row bigger than the prefix: read more until it fits or the file ends.
        while (names.length === 0 && grown < src.size && grown < MAX_ROW_BYTES) {
          grown = Math.min(src.size, grown * 2);
          window = await src.read(0, grown);
          names = collectColumns(window, job.maxRows, grown >= src.size);
        }
        return { result: { columns: names.map((n) => n.slice()), size: src.size }, transfer: [] };
      }
    }
  };
};
