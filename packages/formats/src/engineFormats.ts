/**
 * The engine's format platform (`FormatPlatform` in @quipu/core/document):
 * detection, the JSON bytes a YAML, TOML, XML, CSV, TSV, NDJSON or JSONC file is
 * indexed through, and conversion of JSON bytes to every target. The engine
 * worker builds it with a pool of format workers and somewhere to write bytes;
 * nothing here runs on the UI thread.
 *
 * A file opens through JSON because the engine's index, its queries and its
 * edits are JSON's. Each reader below streams: bytes in, JSON bytes out to the
 * scratch file, read in 8 MiB steps and written before the next step, so the
 * document is never one string or one object graph (YAML and TOML excepted, up
 * to their 256 MiB limit, as `convert` has them).
 */
import { ConvertError, type ConvertFormat, type ConvertSettings } from "@quipu/contracts/engine";
import * as Schema from "effect/Schema";
import type { FormatDetection, FormatPlatform, JsonView, ScratchFile } from "@quipu/core/document";
import type { Sink } from "@quipu/core/save";
import { type ByteSource, blobSource } from "@quipu/core/source";
import { MAX_TAPE_SOURCE_BYTES } from "@quipu/core/tape";

import { convert } from "./convert.ts";
import { CsvToJson } from "./csvToJson.ts";
import { DETECT_PREFIX_BYTES, detectFormat, formatOfName } from "./detect.ts";
import { FormatSyntaxError, FormatTooLargeError, UnrepresentableError } from "./errors.ts";
import type { FormatJob, FormatJobResult } from "./jobs.ts";
import { JsoncBlanker } from "./jsoncBlank.ts";
import { NdjsonToJson } from "./ndjsonToJson.ts";
import type { FormatPool } from "./pool.ts";
import { TEXT_FORMAT_LIMIT } from "./textDocument.ts";
import { jsonValueWriterFor } from "./valueSource.ts";
import { XmlToJson } from "./xmlToJson.ts";

const STEP = 8 * 1024 * 1024;
const LF = 0x0a;

const LABELS = {
  json: "JSON",
  jsonc: "JSONC",
  har: "HAR",
  ndjson: "NDJSON",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
  text: "Text",
} as const;

export interface EngineFormatsOptions {
  /** A pool of format workers for one conversion; terminated when it ends. */
  readonly createPool: () =>
    | FormatPool<FormatJob, FormatJobResult>
    | Promise<FormatPool<FormatJob, FormatJobResult>>;
  readonly scratch: () => Promise<ScratchFile>;
  /** The largest JSON a file may become before it opens as text; the engine's tape limit by default. */
  readonly maxJsonBytes?: number;
}

/** A reader that turns one format's bytes into JSON bytes, fed in order. */
interface Reader {
  push(chunk: Uint8Array): void;
  end(): void;
}

class TooLarge extends Error {}

const isSyntax = Schema.is(FormatSyntaxError);
const isUnrepresentable = Schema.is(UnrepresentableError);
const isTooLarge = Schema.is(FormatTooLargeError);
const isConvertError = Schema.is(ConvertError);

/** Scratch bytes in memory: what tests and a browser without OPFS write a conversion to. */
export const memoryScratch = async (): Promise<ScratchFile> => {
  let parts: Blob[] = [];
  let blob: Blob | null = null;
  return {
    sink: {
      // Each chunk moves into the browser's blob storage as it arrives.
      write: async (bytes) => {
        parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      },
      close: async () => {},
      abort: async () => {
        parts = [];
      },
    },
    finish: async () => {
      blob ??= new Blob(parts);
      parts = [];
      return blob;
    },
    release: async () => {
      parts = [];
      blob = null;
    },
  };
};

/** 1-based line of a byte offset, counting line feeds in bounded reads. */
const lineAt = async (source: ByteSource, offset: number): Promise<number> => {
  let line = 1;
  for (let at = 0; at < offset; at += STEP) {
    const bytes = await source.read(at, Math.min(offset, at + STEP));
    for (const byte of bytes) if (byte === LF) line++;
  }
  return line;
};

/** saxes reports `line:column: message`; the line is the first number. */
const lineInDetail = (detail: string): number | null => {
  const match = /^(\d+):\d+:/.exec(detail);
  return match ? Number(match[1]) : null;
};

const cut = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * Where a syntax or mapping error is, for a sentence: `line 12`, `/rows/3`, or
 * nothing. Offsets are into the bytes the reader was given.
 */
const placeOf = async (error: unknown, source: ByteSource) => {
  if (isSyntax(error)) {
    if (error.offset >= 0) return { line: await lineAt(source, error.offset), pointer: null };
    return { line: lineInDetail(error.detail), pointer: null };
  }
  if (isUnrepresentable(error)) return { line: null, pointer: error.pointer };
  return { line: null, pointer: null };
};

const readerFor = (
  detection: FormatDetection,
  bytes: number,
  push: (chunk: Uint8Array) => void,
): Reader | "whole-text" => {
  switch (detection.format) {
    case "jsonc":
      return new JsoncBlanker(push);
    case "ndjson":
      return new NdjsonToJson(push);
    case "csv":
    case "tsv":
      return new CsvToJson(
        detection.delimiter || (detection.format === "tsv" ? 0x09 : 0x2c),
        push,
        detection.format,
      );
    case "xml":
      return new XmlToJson(push);
    case "yaml":
    case "toml":
      if (bytes > TEXT_FORMAT_LIMIT) {
        throw new FormatTooLargeError({
          format: detection.format,
          bytes,
          limit: TEXT_FORMAT_LIMIT,
        });
      }
      return "whole-text";
    default:
      throw new Error(`${detection.format} is not read through JSON`);
  }
};

/** Writes the file's JSON form to a scratch file, step by step, and answers the bytes written. */
const writeJson = async (
  source: ByteSource,
  detection: FormatDetection,
  sink: Sink,
  limit: number,
) => {
  let pending: Uint8Array[] = [];
  let written = 0;
  const push = (chunk: Uint8Array) => {
    written += chunk.length;
    if (written > limit) throw new TooLarge();
    // A reader reuses its output buffer only after it hands the chunk over; keep a copy.
    pending.push(chunk.slice());
  };
  const flush = async () => {
    const out = pending;
    pending = [];
    for (const chunk of out) await sink.write(chunk);
  };
  const reader = readerFor(detection, source.size, push);
  if (reader === "whole-text") {
    const format = detection.format as "yaml" | "toml";
    const bytes = new Uint8Array(source.size);
    for (let at = 0; at < source.size; at += STEP) {
      bytes.set(await source.read(at, Math.min(source.size, at + STEP)), at);
    }
    jsonValueWriterFor(format, bytes)(push);
    await flush();
    return written;
  }
  for (let at = 0; at < source.size; at += STEP) {
    reader.push(await source.read(at, Math.min(source.size, at + STEP)));
    await flush();
  }
  reader.end();
  await flush();
  return written;
};

/** Why a file of a known format opens as text, as one sentence. */
const textNote = async (
  error: unknown,
  detection: FormatDetection,
  source: ByteSource,
): Promise<string> => {
  const label = LABELS[detection.format];
  if (isTooLarge(error)) {
    return `${label} files over ${TEXT_FORMAT_LIMIT / (1024 * 1024)} MiB open as text.`;
  }
  if (error instanceof TooLarge)
    return `This ${label} file is too large to show as a tree, so it opens as text.`;
  const place = await placeOf(error, source);
  const where =
    place.line !== null
      ? ` at line ${place.line}`
      : place.pointer !== null && place.pointer !== ""
        ? ` at ${place.pointer}`
        : "";
  const detail =
    isSyntax(error) || isUnrepresentable(error)
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error);
  if (detection.format === "yaml" && isSyntax(error)) {
    const plain = plainYamlProblem(detail);
    const near = place.line === null ? "" : ` near line ${place.line}`;
    return plain === null
      ? `This file could not be read as YAML${near}, so it opens as text.`
      : `This YAML file has ${plain}${where}, so it opens as text.`;
  }
  return cut(`This ${label} file has a problem${where}, so it opens as text: ${detail}`, 500);
};

/** The YAML parser's common messages, in words; null for the rest, which get a plain fallback. */
const YAML_PROBLEMS: ReadonlyArray<readonly [string, string]> = [
  ["Implicit keys need to be on a single line", "a key that runs over more than one line"],
  ["Implicit map keys need to be on a single line", "a key that runs over more than one line"],
  ["Implicit map keys need to be followed by map values", "a key with no value after it"],
  [
    "Nested mappings are not allowed in compact mappings",
    "a key and value inside another on one line",
  ],
  ["Flow sequence in block collection", "a list in [ ] that is not closed or not indented enough"],
  ["Flow map in block collection", "a map in { } that is not closed or not indented enough"],
  ["Map keys must be unique", "a key that appears twice"],
  ["All mapping items must start at the same column", "keys that do not line up"],
  ["All collection items must start at the same column", "items that do not line up"],
  ["Tabs are not allowed as indentation", "a tab used for indentation"],
  ["Missing closing", "quoted text that is not closed"],
];
const plainYamlProblem = (detail: string): string | null =>
  YAML_PROBLEMS.find(([prefix]) => detail.startsWith(prefix))?.[1] ?? null;

/** Converts a refusal from the converter into the engine's error, with the place it happened. */
const convertErrorOf = async (
  error: unknown,
  to: ConvertFormat,
  source: ByteSource,
): Promise<unknown> => {
  if (isConvertError(error)) return error;
  const label = LABELS[to];
  if (isUnrepresentable(error)) {
    const where = error.pointer === "" ? "the top level" : error.pointer;
    return new ConvertError({
      to,
      reason: error.reason,
      pointer: error.pointer,
      line: null,
      detail: cut(`${label} cannot hold the value at ${where}: ${error.detail}`, 4000),
    });
  }
  if (isSyntax(error)) {
    const place = await placeOf(error, source);
    return new ConvertError({
      to,
      reason: "syntax",
      pointer: null,
      line: place.line,
      detail: cut(
        `The document is not valid ${LABELS[error.format]}${place.line === null ? "" : ` at line ${place.line}`}: ${error.detail}`,
        4000,
      ),
    });
  }
  if (isTooLarge(error)) {
    return new ConvertError({
      to,
      reason: "too-large",
      pointer: null,
      line: null,
      detail: error.message,
    });
  }
  return error;
};

/**
 * A sink that counts the writes still in flight, and a source over the JSON
 * that waits for them before each read: the converter writes without waiting,
 * so the next read is where it waits for the destination to catch up.
 */
const pacedPair = (json: Blob, sink: Sink) => {
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;
  const drain = async () => {
    while (inFlight.size > 0) await Promise.race(inFlight);
    if (failure !== null) throw failure;
  };
  const raw = blobSource(json);
  const source: ByteSource = {
    ...raw,
    read: async (start, end) => {
      await drain();
      return raw.read(start, end);
    },
    readInto: async (start, end, buffer) => {
      await drain();
      return raw.readInto(start, end, buffer);
    },
  };
  let bytes = 0;
  const write = (chunk: Uint8Array) => {
    bytes += chunk.length;
    const promise = sink.write(chunk).then(
      () => {
        inFlight.delete(promise);
      },
      (error: unknown) => {
        failure ??= error;
        inFlight.delete(promise);
      },
    );
    inFlight.add(promise);
    return promise;
  };
  return { source, write, drain, written: () => bytes };
};

export const createEngineFormats = (options: EngineFormatsOptions): FormatPlatform => {
  const maxJsonBytes = options.maxJsonBytes ?? MAX_TAPE_SOURCE_BYTES;
  return {
    prefixBytes: DETECT_PREFIX_BYTES,
    detect: (prefix, name, truncated) => {
      const detection = detectFormat(prefix, { name, truncated });
      return {
        format: detection.format,
        delimiter: detection.delimiter,
        named: formatOfName(name),
      };
    },
    jsonView: async (source, detection): Promise<JsonView> => {
      const scratch = await options.scratch();
      try {
        await writeJson(source, detection, scratch.sink, maxJsonBytes);
        await scratch.sink.close();
        const json = await scratch.finish();
        return {
          kind: "json",
          blob: json,
          offsets: detection.format === "jsonc" ? "same" : "converted",
          release: () => scratch.release(),
        };
      } catch (error) {
        await scratch.sink.abort().catch(() => {});
        await scratch.release();
        // Too large is a limit; anything else means the bytes are not this format after all.
        const invalid = !(error instanceof TooLarge) && !isTooLarge(error);
        return { kind: "text", note: await textNote(error, detection, source), invalid };
      }
    },
    convert: async (json, to, settings: ConvertSettings, sink) => {
      const pool = await options.createPool();
      const paced = pacedPair(json, sink);
      try {
        await convert(
          "json",
          to,
          { spec: { kind: "blob", blob: json }, size: json.size, source: paced.source },
          {
            pool,
            sink: { write: paced.write },
            columns: settings.columns,
            nested: settings.nested,
          },
        );
        await paced.drain();
        return paced.written();
      } catch (error) {
        throw await convertErrorOf(error, to, blobSource(json));
      } finally {
        await pool.terminate();
      }
    },
    scratch: options.scratch,
  };
};
