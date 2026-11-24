/**
 * Scan-worker job runner, platform-neutral: the worker entry gives it
 * `openSource` and forwards messages. A worker keeps the bytes of a region
 * between its summarize and structure jobs so each byte is read once, and holds
 * one region buffer, one step buffer and one tape builder for its whole life:
 * fresh ones per region left hundreds of MB of dead arrays for the GC.
 */
import { appendSource } from "./appendBuffer.ts";
import { Base64Decoder, base64MaxDecoded } from "./base64.ts";
import { PIECE_LOOKBEHIND, PIECE_TAIL, unescapePiece, unescapePieceInto } from "./decode.ts";
import { ByteWriter, formatChunk } from "./format.ts";
import { indexBytes } from "./indexBuffer.ts";
import { pieceSource, unpackPieces } from "./pieceSource.ts";
import type { Job, JobResult } from "./protocol.ts";
import { structure, summarize } from "./scan.ts";
import { searchChunk } from "./search.ts";
import type { ByteSource, SourceSpec } from "./source.ts";
import { TapeBuilder, transferList } from "./tape.ts";

export interface Platform {
  openSource(spec: SourceSpec): ByteSource;
}

export interface JobOutcome {
  readonly result: JobResult;
  readonly transfer: ArrayBuffer[];
}

export const createJobRunner = (platform: Platform) => {
  const sources = new Map<number, ByteSource>();
  const regionBytes = new Map<string, Uint8Array>();
  let regionBuffer = new ArrayBuffer(0);
  let stepBuffer = new ArrayBuffer(0);
  const builder = new TapeBuilder(1 << 16);
  const readRegion = async (src: ByteSource, start: number, end: number) => {
    const r = await src.readInto(start, end, regionBuffer);
    regionBuffer = r.buffer;
    return r.bytes;
  };
  const readStep = async (src: ByteSource, start: number, end: number) => {
    const r = await src.readInto(start, end, stepBuffer);
    stepBuffer = r.buffer;
    return r.bytes;
  };
  const source = (id: number) => {
    const s = sources.get(id);
    if (!s) throw new Error(`source ${id} is not open in this worker`);
    return s;
  };
  // Edited documents arrive as pieces over sources this worker already has; the
  // buffers are resolved per read so a re-shared append buffer is picked up.
  const openSpec = (spec: SourceSpec): ByteSource => {
    switch (spec.kind) {
      case "append": {
        const chunks = spec.chunks.map((chunk) => new Uint8Array(chunk));
        return appendSource(chunks, spec.chunkBytes, () => spec.length);
      }
      case "pieces": {
        const buffers = spec.buffers;
        return pieceSource(unpackPieces(spec.pieces), (index) => source(buffers[index] as number));
      }
      default:
        return platform.openSource(spec);
    }
  };

  return async (job: Job): Promise<JobOutcome> => {
    switch (job.type) {
      case "open": {
        sources.get(job.sourceId)?.close();
        sources.set(job.sourceId, openSpec(job.spec));
        return { result: null, transfer: [] };
      }
      case "closeSource": {
        sources.get(job.sourceId)?.close();
        sources.delete(job.sourceId);
        for (const key of regionBytes.keys()) {
          if (key.startsWith(`${job.sourceId}:`)) regionBytes.delete(key);
        }
        return { result: null, transfer: [] };
      }
      case "summarize": {
        const bytes = await readRegion(source(job.sourceId), job.start, job.end);
        if (!job.dropBytes) regionBytes.set(`${job.sourceId}:${job.region}`, bytes);
        return { result: { summary: summarize(bytes, job.start, job.maxDepth) }, transfer: [] };
      }
      case "format": {
        const key = `${job.sourceId}:${job.region}`;
        let bytes = regionBytes.get(key);
        regionBytes.delete(key);
        if (!bytes) bytes = await readRegion(source(job.sourceId), job.start, job.end);
        // Pretty output of a chunk is rarely over 1.25× its input; a bigger buffer grows once and travels on.
        const writer = new ByteWriter(
          job.into.byteLength > 0
            ? job.into
            : new ArrayBuffer(Math.ceil(bytes.byteLength * 1.25) + 4096),
        );
        const state = formatChunk(bytes, job.state, { indent: job.indent }, writer);
        const out = writer.finish();
        return { result: { bytes: out, state }, transfer: [out.buffer] };
      }
      case "structure": {
        const key = `${job.sourceId}:${job.region}`;
        let bytes = regionBytes.get(key);
        if (!job.keepBytes) regionBytes.delete(key);
        if (!bytes) {
          bytes = await readRegion(source(job.sourceId), job.start, job.end);
          if (job.keepBytes) regionBytes.set(key, bytes);
        }
        builder.reset();
        const report = structure(bytes, job.start, job.entry, job.maxDepth, builder);
        const buffers = builder.detach();
        return { result: { buffers, report }, transfer: transferList(buffers) };
      }
      case "indexRange": {
        const bytes = await readStep(source(job.sourceId), job.start, job.end);
        const result = indexBytes(bytes, job.start, {
          maxDepth: job.maxDepth,
          chunkBytes: Math.max(1, bytes.length),
          entry: job.entry,
        });
        const buffers = result.tape.detach();
        return {
          result: { buffers, bigStrings: [...result.bigStrings] },
          transfer: transferList(buffers),
        };
      }
      case "search": {
        const src = source(job.sourceId);
        const result = await searchChunk(
          (start, end) => readStep(src, start, end),
          job.size,
          job.start,
          job.end,
          job.decode,
          job.spec,
          job.options,
          job.resumeAt,
        );
        return { result, transfer: [result.hits.buffer as ArrayBuffer] };
      }
      case "unescape": {
        const src = source(job.sourceId);
        const from = Math.max(job.contentStart, job.start - PIECE_LOOKBEHIND);
        const tailEnd = Math.min(job.contentEnd, job.end + PIECE_TAIL);
        const bytes = await readStep(src, from, tailEnd);
        if (job.target !== undefined) {
          const out = new Uint8Array(job.target);
          const length = unescapePieceInto(
            bytes,
            from,
            job.start,
            job.end,
            out,
            job.targetOffset ?? 0,
          );
          return { result: { length }, transfer: [] };
        }
        const exact = unescapePiece(bytes, from, job.start, job.end);
        return { result: exact, transfer: [exact.buffer as ArrayBuffer] };
      }
      case "base64Head": {
        // Escapes (`\/`) make the text longer than 4/3 of the bytes it decodes to, so read
        // a little more than the aligned count, and never past the end of the string.
        const chars = Math.ceil(job.decodedBytes / 3) * 4;
        const to = Math.min(job.end, job.start + chars + (chars >> 3) + 16);
        const text = await source(job.sourceId).read(job.start, to);
        const out = new Uint8Array(base64MaxDecoded(text.length));
        const n = new Base64Decoder().push(text, 0, text.length, out, 0);
        const exact = out.slice(0, Math.min(n, job.decodedBytes));
        return { result: exact, transfer: [exact.buffer as ArrayBuffer] };
      }
      case "base64Piece": {
        const text = await readStep(source(job.sourceId), job.start, job.end);
        const out = new Uint8Array(base64MaxDecoded(text.length));
        const decoder = new Base64Decoder();
        const n = decoder.push(text, 0, text.length, out, 0);
        const bytes = out.slice(0, n);
        return {
          result: { bytes, invalid: decoder.invalid, shifted: decoder.shifted },
          transfer: [bytes.buffer as ArrayBuffer],
        };
      }
      case "base64Blob": {
        const src = source(job.sourceId);
        const decoder = new Base64Decoder();
        const parts: Uint8Array[] = [];
        for (let at = job.start; at < job.end; at += job.stepBytes) {
          const text = await readStep(src, at, Math.min(job.end, at + job.stepBytes));
          const out = new Uint8Array(base64MaxDecoded(text.length));
          parts.push(out.subarray(0, decoder.push(text, 0, text.length, out, 0)));
        }
        return {
          result: new Blob(parts as BlobPart[], { type: job.mime }),
          transfer: [],
        };
      }
      case "readSlice": {
        const bytes = (await source(job.sourceId).read(job.start, job.end)).slice();
        return { result: bytes, transfer: [bytes.buffer as ArrayBuffer] };
      }
    }
  };
};
