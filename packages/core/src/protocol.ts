/** Messages between the engine coordinator and its scan workers. */
import type { FormatState } from "./format.ts";
import type { BoundarySummary, EntryState, StructureReport } from "./scan.ts";
import type { InferOptions, Shape } from "@quipu/contracts/schema";
import type { DeepChunkResult, ParityResult } from "./deepSearch.ts";
import type { HarEntryPrint } from "./diff/har.ts";
import type { HarTableRawRow } from "./tableIndex.ts";
import type { ChunkOptions, ChunkResult, SearchSpec } from "./search.ts";
import type { SourceSpec } from "./source.ts";
import type { TapeBuffers } from "./tape.ts";

export type Job =
  | { readonly type: "open"; readonly sourceId: number; readonly spec: SourceSpec }
  | { readonly type: "closeSource"; readonly sourceId: number }
  | {
      readonly type: "summarize";
      readonly sourceId: number;
      readonly region: number;
      readonly start: number;
      readonly end: number;
      readonly maxDepth: number;
      /** Drop the region bytes after summarizing (a save formats them in another job). */
      readonly dropBytes?: boolean;
    }
  | {
      /** Pretty-prints or minifies one region of a source given the state at its first byte (save.ts). */
      readonly type: "format";
      readonly sourceId: number;
      readonly region: number;
      readonly start: number;
      readonly end: number;
      readonly state: FormatState;
      readonly indent: number;
      /** A buffer to format into, handed back with the result; the coordinator recycles them. */
      readonly into: ArrayBuffer;
    }
  | {
      readonly type: "structure";
      readonly sourceId: number;
      readonly region: number;
      readonly start: number;
      readonly end: number;
      readonly entry: EntryState;
      readonly maxDepth: number;
      /** Keep the region bytes for another structure pass (the depth decision on region 0). */
      readonly keepBytes: boolean;
    }
  | {
      readonly type: "indexRange";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly entry: EntryState;
      readonly maxDepth: number;
    }
  | {
      readonly type: "search";
      readonly sourceId: number;
      /** The chunk's nominal edges; the worker moves them to safe positions. */
      readonly start: number;
      readonly end: number;
      readonly size: number;
      /** Escapes inside JSON strings are matched as the characters they stand for. */
      readonly decode: boolean;
      readonly spec: SearchSpec;
      readonly options: ChunkOptions;
      /** Scan from here instead of from `start`: a token boundary a previous hit ended on. */
      readonly resumeAt: number | null;
    }
  | {
      readonly type: "quoteParity";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly size: number;
      readonly decode: boolean;
    }
  | {
      readonly type: "deepSearch";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly size: number;
      readonly decode: boolean;
      readonly spec: SearchSpec;
      readonly options: ChunkOptions;
      readonly resumeAt: number | null;
      readonly entryInString: boolean;
    }
  | {
      readonly type: "unescape";
      readonly sourceId: number;
      readonly contentStart: number;
      readonly contentEnd: number;
      readonly start: number;
      readonly end: number;
      /** Write into this buffer at `targetOffset` (it needs end - start + 8 bytes there) and answer the length. */
      readonly target?: SharedArrayBuffer;
      readonly targetOffset?: number;
    }
  | {
      readonly type: "base64Head";
      readonly sourceId: number;
      readonly start: number;
      /** End of the base64 text: the head never reads past the string. */
      readonly end: number;
      readonly decodedBytes: number;
    }
  | {
      /** Decodes the base64 text [start, end) of a source; the coordinator aligns pieces on 4 characters. */
      readonly type: "base64Piece";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** Streams the base64 text [start, end) through the decoder into a Blob, `stepBytes` of text at a time. */
      readonly type: "base64Blob";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly mime: string;
      readonly stepBytes: number;
    }
  | {
      readonly type: "readSlice";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: "harTableWindow";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly baseIndex: number;
      readonly expectedCount: number;
      readonly stepBytes: number;
    }
  | {
      readonly type: "harTableSlices";
      readonly sourceId: number;
      readonly items: ReadonlyArray<{
        readonly index: number;
        readonly start: number;
        readonly end: number;
      }>;
    }
  | {
      readonly type: "harPrintWindow";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly baseIndex: number;
      readonly stepBytes: number;
    }
  | {
      readonly type: "harPrintSlices";
      readonly sourceId: number;
      readonly items: ReadonlyArray<{
        readonly index: number;
        readonly start: number;
        readonly end: number;
      }>;
    }
  | {
      readonly type: "hashSourceRange";
      readonly sourceId: number;
      readonly start: number;
      readonly end: number;
      readonly stepBytes: number;
    }
  | {
      readonly type: "inferBatch";
      readonly buffer: ArrayBuffer;
      readonly items: ReadonlyArray<{ readonly start: number; readonly end: number }>;
      readonly options?: Partial<InferOptions>;
    };

export interface SummarizeResult {
  readonly summary: BoundarySummary;
}

export interface StructureResult {
  readonly buffers: TapeBuffers;
  readonly report: StructureReport;
}

export interface IndexRangeResult {
  readonly buffers: TapeBuffers;
  readonly bigStrings: ReadonlyArray<number>;
}

export interface Base64PieceResult {
  readonly bytes: Uint8Array;
  /** Bytes in the piece that are not base64 (escapes and whitespace excepted). */
  readonly invalid: number;
  /** Escapes and whitespace in the piece: any makes piecewise decoding unreliable. */
  readonly shifted: number;
}

export interface Unescaped {
  readonly length: number;
}

export interface FormatResult {
  readonly bytes: Uint8Array;
  readonly state: FormatState;
}

export interface HarTableWindowResult {
  readonly baseIndex: number;
  readonly rows: ReadonlyArray<HarTableRawRow | null>;
}

export interface HarTableColumnarWindowResult {
  readonly baseIndex: number;
  readonly count: number;
  readonly nums: Float64Array;
  readonly methods: ReadonlyArray<string | null>;
  readonly urls: ReadonlyArray<string | null>;
  readonly mimeTypes: ReadonlyArray<string | null>;
  readonly startedDateTimes: ReadonlyArray<string | null>;
}

export interface HarPrintWindowResult {
  readonly baseIndex: number;
  readonly prints: ReadonlyArray<HarEntryPrint | null>;
  readonly oversized: ReadonlyArray<{
    readonly entryIndex: number;
    readonly start: number;
    readonly end: number;
  }>;
}

export interface HashSourceRangeResult {
  readonly hash: bigint;
}

export type JobResult =
  | SummarizeResult
  | Unescaped
  | Base64PieceResult
  | Blob
  | StructureResult
  | IndexRangeResult
  | ChunkResult
  | DeepChunkResult
  | ParityResult
  | FormatResult
  | HarTableWindowResult
  | HarTableColumnarWindowResult
  | HarPrintWindowResult
  | HashSourceRangeResult
  | Shape
  | Uint8Array
  | null;

export interface Request {
  readonly id: number;
  readonly job: Job;
}

export type Reply =
  | { readonly id: number; readonly ok: true; readonly result: JobResult }
  | { readonly id: number; readonly ok: false; readonly error: string };
