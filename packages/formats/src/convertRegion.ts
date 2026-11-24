/**
 * One conversion step over a window of bytes, and the sequential pump built on
 * it. A region job gets its bytes plus an overhang past its end, the entry state
 * the engine resolved for it, and writes the output for the tokens (or rows) that
 * start inside it. The output of consecutive regions concatenates to the output
 * of the whole file (docs/internals/formats.md, "Streaming conversion").
 */
import { QUOTE, SCALAR_CHAR } from "@quipu/core/bytes";
import type { EntryState } from "@quipu/core/scan";

import { OffendingNode } from "./abort.ts";
import { ByteWriter } from "./byteWriter.ts";
import { ColumnCollector, ColumnIndex, CsvHandler, type CsvOptions } from "./csvEmit.ts";
import { CompactJsonHandler } from "./jsonEmit.ts";
import {
  type JsonHandler,
  newScanState,
  type ScanState,
  scanStateFromEntry,
  walkJson,
} from "./jsonScan.ts";
import { RegionStop } from "./regionStop.ts";
import { resetStringEndMemo, scanStringEnd } from "./stringEnd.ts";
import { TomlHandler } from "./tomlEmit.ts";
import { PLAIN_STRING_LIMIT, YamlHandler } from "./yamlEmit.ts";

/** Bytes a region reads past its end so the tokens it owns finish: a string of up to PLAIN_STRING_LIMIT. */
export const OVERHANG_BYTES = PLAIN_STRING_LIMIT + 64 * 1024;
/** The largest single token or row a target that needs whole tokens will hold. */
export const MAX_ROW_BYTES = 64 * 1024 * 1024;

export type Target =
  | { readonly kind: "yaml" }
  | { readonly kind: "toml" }
  | { readonly kind: "minify" }
  | { readonly kind: "ndjson" }
  | {
      readonly kind: "csv";
      readonly delimiter: number;
      readonly nested: CsvOptions["nested"];
      /** Column names as UTF-8 bytes. */
      readonly columns: ReadonlyArray<Uint8Array>;
    };

export interface Streaming extends JsonHandler {
  partialString?(bytes: Uint8Array, start: number, end: number): void;
  continueString?(bytes: Uint8Array, from: number, to: number, closed: boolean): void;
  rows?: number;
}

/** The emitter for a target, bound to the scan state and the end of the region it owns. */
const makeHandler = (
  target: Target,
  out: ByteWriter,
  st: ScanState,
  ownedEnd: number,
): Streaming => {
  switch (target.kind) {
    case "yaml":
      return new YamlHandler(out, st);
    case "toml":
      return new TomlHandler(out, st);
    case "minify":
      return new CompactJsonHandler(out, st, false);
    case "ndjson":
      return new CompactJsonHandler(out, st, true, ownedEnd);
    case "csv":
      return new CsvHandler(
        out,
        st,
        new ColumnIndex(target.columns),
        { delimiter: target.delimiter, nested: target.nested },
        ownedEnd,
      );
  }
};

export interface RegionResult {
  /** `needMore`: a token or row runs past the window; read more bytes past the region and run again. */
  readonly status: "ok" | "needMore";
  /** Rows (csv) or elements (ndjson) written. */
  readonly count: number;
  /** `needMore`: the absolute offset of the token that runs past the window. */
  readonly at?: number;
}

/**
 * Converts the tokens of a region. `window` holds the file from `base` through
 * the region's end plus an overhang; `ownedEnd` is the absolute end of the
 * region; `fileSize` tells whether the window reaches the end of the file.
 * `regionBytes` and `overhang` are the job's own, needed to tell which strings
 * the owner of an inherited string already wrote whole.
 */
export const convertRegion = (
  window: Uint8Array,
  base: number,
  ownedEnd: number,
  fileSize: number,
  entry: EntryState,
  target: Target,
  out: ByteWriter,
  geometry: { readonly regionBytes: number; readonly overhang: number },
): RegionResult => {
  resetStringEndMemo();
  const st = scanStateFromEntry(entry);
  const handler = makeHandler(target, out, st, ownedEnd - base);
  const windowIsEof = base + window.length >= fileSize;
  const limit = ownedEnd - base;
  let pos = 0;

  if (entry.inString) {
    const from = entry.escaped ? 1 : 0;
    const end = scanStringEnd(window, from);
    const ownerEnd = Math.min(
      fileSize,
      (Math.floor(entry.openStringStart / geometry.regionBytes) + 1) * geometry.regionBytes +
        geometry.overhang,
    );
    const absEnd = end < 0 ? Number.POSITIVE_INFINITY : base + end;
    // A target with no `continueString` needs whole tokens, so its owner read past its end
    // (growing the overhang up to MAX_ROW_BYTES) until the string was whole, or failed the job.
    if (handler.continueString && absEnd > ownerEnd) {
      const stop = end < 0 ? Math.min(window.length, limit) : Math.min(end, limit);
      const closed = end >= 0 && end <= limit;
      handler.continueString(window, 0, stop, closed);
      if (!closed) return { status: "ok", count: 0 };
      pos = end;
      st.prevSig = QUOTE;
    } else {
      pos = end < 0 ? window.length : end;
      if (end >= 0) st.prevSig = QUOTE;
    }
  } else if (entry.lastByte !== 0 && SCALAR_CHAR[entry.lastByte] === 1) {
    while (pos < window.length && SCALAR_CHAR[window[pos] as number] === 1) pos++;
    if (pos > 0) st.prevSig = window[pos - 1] as number;
  }

  try {
    let guard = 0;
    for (;;) {
      // Row-level targets stop themselves at the first element past the region (they must
      // finish the element they started); token-level targets are bounded by the walker.
      const rowLevel = target.kind === "csv" || target.kind === "ndjson";
      const r = walkJson(window, pos, rowLevel ? window.length : limit, st, handler, windowIsEof);
      if (!r.incomplete) break;
      const at = r.pos;
      if (window[at] === QUOTE && handler.partialString) {
        // Only what this region owns: the next one continues the string from its own start.
        handler.partialString(window, at, Math.min(window.length, Math.max(at, limit)));
        return { status: "ok", count: handler.rows ?? 0 };
      }
      if (windowIsEof || guard++ > 0) break;
      return { status: "needMore", count: 0, at: base + at };
    }
  } catch (error) {
    if (error instanceof OffendingNode) {
      // Offsets inside a window are relative to it; the coordinator wants file offsets.
      throw new OffendingNode(error.offset + base, error.reason, error.detail);
    }
    if (!(error instanceof RegionStop)) throw error;
  }
  return { status: "ok", count: rowsOf(handler) };
};

const rowsOf = (handler: Streaming) => {
  if (handler instanceof CsvHandler) return handler.rows;
  if (handler instanceof CompactJsonHandler) return handler.elements;
  return 0;
};

/** Collects column names from the first `maxRows` rows of a window that holds the start of the file. */
export const collectColumns = (
  window: Uint8Array,
  maxRows: number,
  windowIsEof: boolean,
): Uint8Array[] => {
  resetStringEndMemo();
  const st = newScanState();
  const collector = new ColumnCollector(st, maxRows);
  try {
    walkJson(window, 0, window.length, st, collector, windowIsEof);
  } catch (error) {
    if (!(error instanceof RegionStop)) throw error;
  }
  return collector.names;
};

/** Converts a whole in-memory JSON document. The bytes are the document; there is one region. */
export const convertWhole = (bytes: Uint8Array, target: Target, out: ByteWriter) => {
  resetStringEndMemo();
  const st = newScanState();
  const handler = makeHandler(target, out, st, Number.POSITIVE_INFINITY);
  try {
    const r = walkJson(bytes, 0, bytes.length, st, handler, true);
    void r;
  } catch (error) {
    if (!(error instanceof RegionStop)) throw error;
  }
};

/**
 * A sequential converter fed in chunks of any size. It holds back the last
 * OVERHANG_BYTES of what it has seen so a token it starts is whole, writes
 * output through `onOutput` as it goes, and carries a string longer than its
 * window through the target without holding it.
 */
export class JsonPump {
  private buf = new Uint8Array(1 << 20);
  private len = 0;
  private pos = 0;
  private readonly st = newScanState();
  private readonly out: ByteWriter;
  private readonly handler: Streaming;
  private readonly onOutput: (chunk: Uint8Array) => void;
  private readonly flushAt: number;
  private readonly hold: number;
  private bigString = false;
  private bigEscaped = false;
  private offset = 0;

  /** Bytes consumed so far: the absolute offset of the next token to read. */
  get consumed() {
    return this.offset + this.pos;
  }

  /** The absolute offset of the first byte of the held window, which handler callbacks index into. */
  get windowOffset() {
    return this.offset;
  }

  constructor(
    target: Target | ((st: ScanState, out: ByteWriter) => Streaming),
    onOutput: (chunk: Uint8Array) => void,
    options: { readonly flushBytes?: number; readonly hold?: number } = {},
  ) {
    this.out = new ByteWriter(1 << 20);
    this.handler =
      typeof target === "function"
        ? target(this.st, this.out)
        : makeHandler(target, this.out, this.st, Number.POSITIVE_INFINITY);
    this.onOutput = onOutput;
    this.flushAt = options.flushBytes ?? 1 << 20;
    this.hold =
      options.hold ??
      (typeof target !== "function" && target.kind === "yaml" ? OVERHANG_BYTES : MAX_ROW_BYTES);
  }

  push(chunk: Uint8Array) {
    if (this.bigString) {
      this.continueBig(chunk);
      return;
    }
    this.append(chunk);
    this.drive(false);
  }

  end() {
    if (this.bigString) {
      // The file ended inside a string; the bytes were already written raw.
      this.flush(true);
      return;
    }
    this.drive(true);
    this.flush(true);
  }

  private append(chunk: Uint8Array) {
    const needed = this.len + chunk.length;
    if (needed > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < needed) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(this.pos, this.len));
      this.len -= this.pos;
      this.offset += this.pos;
      this.pos = 0;
      this.buf = next;
    } else if (this.pos > 0 && this.pos > this.buf.length / 2) {
      this.buf.copyWithin(0, this.pos, this.len);
      this.len -= this.pos;
      this.offset += this.pos;
      this.pos = 0;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }

  private drive(final: boolean) {
    for (;;) {
      resetStringEndMemo();
      const window = this.buf.subarray(0, this.len);
      const ownedEnd = final ? this.len : this.len - this.hold;
      if (!final && ownedEnd <= this.pos) break;
      let r;
      try {
        r = walkJson(window, this.pos, ownedEnd, this.st, this.handler, final);
      } catch (error) {
        if (error instanceof OffendingNode) {
          throw new OffendingNode(error.offset + this.offset, error.reason, error.detail);
        }
        throw error;
      }
      this.pos = r.pos;
      this.flush(false);
      if (!r.incomplete) break;
      const at = r.pos;
      if (
        window[at] === QUOTE &&
        this.handler.partialString &&
        this.len - at > PLAIN_STRING_LIMIT
      ) {
        this.handler.partialString(window, at, this.len);
        this.bigString = true;
        this.bigEscaped = trailingBackslashesOdd(window, at + 1, this.len);
        this.pos = this.len;
        this.flush(false);
      } else if (this.len - at > this.hold && !this.handler.partialString) {
        throw new OffendingNode(
          this.offset + at,
          "token-too-large",
          "a value larger than the conversion window",
        );
      }
      break;
    }
  }

  private continueBig(chunk: Uint8Array) {
    const handler = this.handler;
    resetStringEndMemo();
    const from = this.bigEscaped ? 1 : 0;
    const end = chunk.length === 0 ? -1 : scanStringEnd(chunk, from);
    if (end < 0) {
      this.bigEscaped = nextEscaped(chunk, this.bigEscaped);
      handler.continueString?.(chunk, 0, chunk.length, false);
      this.flush(false);
      return;
    }
    handler.continueString?.(chunk, 0, end, true);
    this.bigString = false;
    this.bigEscaped = false;
    this.st.prevSig = QUOTE;
    this.buf = new Uint8Array(Math.max(this.buf.length, 1 << 20));
    this.len = 0;
    this.pos = 0;
    this.offset += end;
    const rest = chunk.subarray(end);
    if (rest.length > 0) {
      this.append(rest);
      this.drive(false);
    }
    this.flush(false);
  }

  private flush(force: boolean) {
    if (this.out.length === 0) return;
    if (force || this.out.length >= this.flushAt) this.onOutput(this.out.take());
  }
}

const trailingBackslashesOdd = (b: Uint8Array, from: number, to: number) => {
  let n = 0;
  for (let i = to - 1; i >= from && b[i] === 0x5c; i--) n++;
  return (n & 1) === 1;
};

/** Is the first byte after `chunk` escaped, given whether the first byte of `chunk` was? */
const nextEscaped = (chunk: Uint8Array, escapedIn: boolean) => {
  let run = 0;
  for (let i = chunk.length - 1; i >= 0 && chunk[i] === 0x5c; i--) run++;
  if (run === chunk.length && escapedIn) run++;
  return (run & 1) === 1;
};
