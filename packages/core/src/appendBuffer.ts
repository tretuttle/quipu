/**
 * The piece table's append buffer: every byte an edit introduces, in order,
 * never rewritten (undo keeps its bytes; a later edit appends after them). It is
 * chunked so it grows without copying and so the scan workers can see it: each
 * chunk is a SharedArrayBuffer on an isolated page, handed to the workers once
 * and never again. A piece never crosses a chunk, which keeps every read of a
 * piece one subarray.
 */
import type { Piece } from "./pieceTable.ts";
import { APPEND_BUFFER } from "./pieceTable.ts";
import type { ByteSource } from "./source.ts";

const DEFAULT_APPEND_CHUNK_BYTES = 16 * 1024 * 1024;

const allocateShared = (bytes: number): ArrayBufferLike =>
  typeof SharedArrayBuffer === "function" ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);

export class AppendBuffer {
  readonly chunkBytes: number;
  readonly chunks: Uint8Array[] = [];
  /** Bytes written so far. */
  length = 0;

  constructor(chunkBytes = DEFAULT_APPEND_CHUNK_BYTES) {
    this.chunkBytes = chunkBytes;
  }

  /** Appends `bytes`, returning the pieces that address them (one per chunk touched). */
  append(bytes: Uint8Array): Piece[] {
    const pieces: Piece[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      const chunkIndex = Math.floor(this.length / this.chunkBytes);
      const within = this.length - chunkIndex * this.chunkBytes;
      let chunk = this.chunks[chunkIndex];
      if (!chunk) {
        chunk = new Uint8Array(allocateShared(this.chunkBytes));
        this.chunks.push(chunk);
      }
      const n = Math.min(bytes.byteLength - offset, this.chunkBytes - within);
      chunk.set(bytes.subarray(offset, offset + n), within);
      pieces.push({ buffer: APPEND_BUFFER, start: this.length, length: n });
      this.length += n;
      offset += n;
    }
    return pieces;
  }

  /** Bytes [start, end); aliases the chunk when the range sits in one. */
  read(start: number, end: number): Uint8Array {
    const first = Math.floor(start / this.chunkBytes);
    const last = Math.floor(Math.max(start, end - 1) / this.chunkBytes);
    if (first === last) {
      const chunk = this.chunks[first];
      if (!chunk) return new Uint8Array(0);
      const base = first * this.chunkBytes;
      return chunk.subarray(start - base, end - base);
    }
    const out = new Uint8Array(end - start);
    let at = start;
    while (at < end) {
      const index = Math.floor(at / this.chunkBytes);
      const base = index * this.chunkBytes;
      const chunk = this.chunks[index] as Uint8Array;
      const n = Math.min(end, base + this.chunkBytes) - at;
      out.set(chunk.subarray(at - base, at - base + n), at - start);
      at += n;
    }
    return out;
  }

  asSource(): ByteSource {
    return appendSource(this.chunks, this.chunkBytes, () => this.length);
  }
}

/** The worker side: reads over the chunk list the coordinator shared. */
export const appendSource = (
  chunks: ReadonlyArray<Uint8Array>,
  chunkBytes: number,
  length: () => number,
): ByteSource => {
  const read = (start: number, end: number) => {
    const first = Math.floor(start / chunkBytes);
    const last = Math.floor(Math.max(start, end - 1) / chunkBytes);
    if (first === last) {
      const chunk = chunks[first];
      if (!chunk) return new Uint8Array(0);
      return chunk.subarray(start - first * chunkBytes, end - first * chunkBytes);
    }
    const out = new Uint8Array(end - start);
    let at = start;
    while (at < end) {
      const index = Math.floor(at / chunkBytes);
      const base = index * chunkBytes;
      const n = Math.min(end, base + chunkBytes) - at;
      out.set((chunks[index] as Uint8Array).subarray(at - base, at - base + n), at - start);
      at += n;
    }
    return out;
  };
  return {
    get size() {
      return length();
    },
    read: (start, end) => Promise.resolve(read(start, end)),
    readInto: (start, end, buffer) => Promise.resolve({ bytes: read(start, end), buffer }),
    close: () => {},
  };
};
