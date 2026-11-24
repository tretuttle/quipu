/**
 * Conversion between JSON, YAML, TOML, XML, CSV, TSV and NDJSON, streamed
 * wherever the format allows. Every route is "the source as JSON bytes", then
 * "JSON bytes as the target". A JSON source into YAML, TOML, CSV, TSV, NDJSON or
 * minified JSON goes through the parallel region pipeline; every other route is
 * read once, in order, through a reader that writes JSON bytes into a sequential
 * target (CSV, NDJSON and XML sources stream; YAML and TOML sources hold their
 * text, which is refused above 256 MiB). Nothing here builds the document as one
 * string or one object graph. What the target cannot hold is a typed
 * `UnrepresentableError` with the JSON Pointer of the first offending node.
 */
import { type ByteSource, openSource, type SourceSpec } from "@quipu/core/source";

import { OffendingNode } from "./abort.ts";
import { ByteWriter } from "./byteWriter.ts";
import { collectColumns, JsonPump, MAX_ROW_BYTES, type Target } from "./convertRegion.ts";
import {
  type ConvertSink,
  convertJsonSource,
  type StreamOptions,
  type StreamStats,
} from "./convertSource.ts";
import { writeCsvField } from "./csvEmit.ts";
import { CsvToJson } from "./csvToJson.ts";
import { FormatSyntaxError, FormatTooLargeError, UnrepresentableError } from "./errors.ts";
import type { ConvertFormat } from "./formatIds.ts";
import type { FormatJob, FormatJobResult } from "./jobs.ts";
import { locatePointer, locatePointerFrom } from "./locate.ts";
import { NdjsonToJson } from "./ndjsonToJson.ts";
import type { FormatPool } from "./pool.ts";
import { jsonValueWriterFor } from "./valueSource.ts";
import { XmlHandler } from "./xmlEmit.ts";
import { XmlToJson } from "./xmlToJson.ts";
import { TEXT_FORMAT_LIMIT } from "./textDocument.ts";

export interface ConvertInput {
  readonly spec: SourceSpec;
  readonly size: number;
  /** A reader for the coordinator thread; defaults to opening `spec`. Hosts whose workers read a path pass one. */
  readonly source?: ByteSource;
}

export interface ConvertOptions extends Omit<StreamOptions, "columns"> {
  readonly pool: FormatPool<FormatJob, FormatJobResult>;
  readonly sink: ConvertSink;
  /** csv/tsv targets from a JSON source: `full` reads every row for the header (slower). */
  readonly columns?: "first" | "full" | ReadonlyArray<string>;
}

const STEP = 8 * 1024 * 1024;

/** The bytes of a source, in order, in bounded reads. */
const forEachChunk = async (input: ConvertInput, f: (chunk: Uint8Array) => void) => {
  const src = input.source ?? openSource(input.spec);
  try {
    for (let at = 0; at < input.size; at += STEP)
      f(await src.read(at, Math.min(input.size, at + STEP)));
  } finally {
    if (!input.source) src.close();
  }
};

const readAll = async (
  input: ConvertInput,
  limit: number,
  format: ConvertFormat,
): Promise<Uint8Array> => {
  if (input.size > limit) throw new FormatTooLargeError({ format, bytes: input.size, limit });
  const out = new Uint8Array(input.size);
  let at = 0;
  await forEachChunk(input, (chunk) => {
    out.set(chunk, at);
    at += chunk.length;
  });
  return out;
};

interface Stage {
  push(chunk: Uint8Array): void;
  end(): void;
}

const encoder = new TextEncoder();

/** The target stage for JSON bytes arriving as a stream. */
const stageFor = (
  to: ConvertFormat,
  out: (chunk: Uint8Array) => void,
  columns: ConvertOptions["columns"],
  nested: "json" | "error",
): Stage => {
  switch (to) {
    case "json":
      return { push: out, end: () => {} };
    case "yaml":
      return pumpStage(new JsonPump({ kind: "yaml" }, out));
    case "ndjson":
      return pumpStage(new JsonPump({ kind: "ndjson" }, out));
    case "xml":
      return pumpStage(
        new JsonPump((st, w) => new XmlHandler(w, st), out, { hold: MAX_ROW_BYTES }),
      );
    case "toml":
      return pumpStage(new JsonPump({ kind: "toml" }, out));
    case "csv":
    case "tsv": {
      const delimiter = to === "csv" ? 0x2c : 0x09;
      let pump: JsonPump | undefined;
      const held: Uint8Array[] = [];
      let heldBytes = 0;
      const start = (final: boolean) => {
        const all = new Uint8Array(heldBytes);
        let at = 0;
        for (const h of held) {
          all.set(h, at);
          at += h.length;
        }
        let names: Uint8Array[];
        if (columns && columns !== "first" && columns !== "full") {
          names = columns.map((c) => encoder.encode(c));
        } else names = collectColumns(all, 1024, final);
        const header = new ByteWriter(256);
        names.forEach((n, i) => {
          if (i > 0) header.byte(delimiter);
          writeCsvField(header, n, delimiter, names.length === 1);
        });
        if (names.length > 0) {
          header.byte(0x0a);
          out(header.take());
        }
        const target: Target = { kind: "csv", delimiter, nested, columns: names };
        pump = new JsonPump(target, out);
        pump.push(all);
        held.length = 0;
      };
      return {
        push: (chunk) => {
          if (pump) {
            pump.push(chunk);
            return;
          }
          held.push(chunk.slice());
          heldBytes += chunk.length;
          if (heldBytes >= 4 * 1024 * 1024) start(false);
        },
        end: () => {
          if (!pump) start(true);
          pump?.end();
        },
      };
    }
  }
};

const pumpStage = (pump: JsonPump): Stage => ({ push: (c) => pump.push(c), end: () => pump.end() });

/** Converts `input` (in format `from`) to `to`, writing to `options.sink` in order. */
export const convert = async (
  from: ConvertFormat,
  to: ConvertFormat,
  input: ConvertInput,
  options: ConvertOptions,
): Promise<StreamStats> => {
  const nested = options.nested ?? "json";
  let bytesOut = 0;
  const sinkWrites: Array<Promise<void> | void> = [];
  const out = (chunk: Uint8Array) => {
    bytesOut += chunk.length;
    sinkWrites.push(options.sink.write(chunk));
  };
  const finish = async (rows = 0): Promise<StreamStats> => {
    await Promise.all(sinkWrites);
    return { bytesIn: input.size, bytesOut, rows, regions: 1 };
  };

  // JSON sources with a byte-level target run through the parallel region pipeline.
  if (
    from === "json" &&
    (to === "yaml" ||
      to === "toml" ||
      to === "csv" ||
      to === "tsv" ||
      to === "ndjson" ||
      to === "json")
  ) {
    const target = to === "json" ? "minify" : to;
    let columns = options.columns;
    if (columns === "full" && (to === "csv" || to === "tsv")) {
      const names = await discoverColumns(input);
      columns = names;
    }
    const streamOptions: StreamOptions = {
      ...(options.regionBytes === undefined ? {} : { regionBytes: options.regionBytes }),
      ...(options.firstRows === undefined ? {} : { firstRows: options.firstRows }),
      ...(columns === undefined || columns === "full" ? {} : { columns }),
      nested,
      from: "json",
    };
    return convertJsonSource(options.pool, input, target, options.sink, streamOptions);
  }

  const stage = stageFor(to, out, options.columns, nested);
  try {
    await streamAsJson(from, input, (c) => stage.push(c));
    stage.end();
  } catch (error) {
    throw await relocate(error, from, to, input);
  }
  return finish();
};

/** Reads `input` (in format `from`) and hands its JSON bytes, in order, to `push`. */
const streamAsJson = async (
  from: ConvertFormat,
  input: ConvertInput,
  push: (chunk: Uint8Array) => void,
) => {
  switch (from) {
    case "json":
      await forEachChunk(input, push);
      return;
    case "ndjson": {
      const reader = new NdjsonToJson(push);
      await forEachChunk(input, (c) => reader.push(c));
      reader.end();
      return;
    }
    case "csv":
    case "tsv": {
      const reader = new CsvToJson(from === "csv" ? 0x2c : 0x09, push, from);
      await forEachChunk(input, (c) => reader.push(c));
      reader.end();
      return;
    }
    case "xml": {
      const reader = new XmlToJson(push);
      await forEachChunk(input, (c) => reader.push(c));
      reader.end();
      return;
    }
    case "yaml":
    case "toml": {
      const bytes = await readAll(input, TEXT_FORMAT_LIMIT, from);
      jsonValueWriterFor(from, bytes)(push);
      return;
    }
  }
};

/** Thrown into a source reader to stop it once the pointer is known. */
class Enough extends Error {}

/**
 * An emitter's byte offset becomes a JSON Pointer in the (JSON) stream it was
 * reading. The offset is into the JSON bytes the source stage produced, which
 * are not the input's bytes unless the input is JSON itself, so the source stage
 * runs again into a locator that keeps only the path to the node.
 */
const relocate = async (
  error: unknown,
  from: ConvertFormat,
  to: ConvertFormat,
  input: ConvertInput,
) => {
  if (!(error instanceof OffendingNode)) return error;
  let pointer: string;
  if (from === "json") {
    const src = input.source ?? openSource(input.spec);
    try {
      pointer = await locatePointer(src, error.offset);
    } finally {
      if (!input.source) src.close();
    }
  } else {
    pointer = await locatePointerFrom(error.offset, async (push) => {
      try {
        await streamAsJson(from, input, (c) => {
          if (push(c)) throw new Enough();
        });
      } catch (stop) {
        if (!(stop instanceof Enough)) throw stop;
      }
    });
  }
  return new UnrepresentableError({
    from,
    to,
    reason: error.reason,
    pointer,
    detail: error.detail,
  });
};

/** Every key of a JSON array of objects, in first-seen order (the `full` header), one pass. */
const discoverColumns = async (input: ConvertInput): Promise<string[]> => {
  const { ColumnCollector } = await import("./csvEmit.ts");
  const { decodeUtf8 } = await import("@quipu/core/boundedSlice");
  const names: Uint8Array[] = [];
  let collector: InstanceType<typeof ColumnCollector> | undefined;
  const pump = new JsonPump(
    (st) => {
      collector = new ColumnCollector(st, Number.POSITIVE_INFINITY);
      return collector;
    },
    () => {},
    { hold: MAX_ROW_BYTES },
  );
  await forEachChunk(input, (c) => pump.push(c));
  pump.end();
  names.push(...(collector?.names ?? []));
  return names.map((n) => decodeUtf8(n));
};

export { FormatSyntaxError };
