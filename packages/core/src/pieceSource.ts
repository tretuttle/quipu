/**
 * The logical bytes of an edited document as a ByteSource: a window over a
 * piece list whose buffers are other sources (the original file, the append
 * buffer, spill files). A read gathers the pieces it crosses; a read inside one
 * piece aliases that buffer's bytes. Workers open the same shape from a
 * transferred `pieces` spec, so every job that scans or copies bytes (re-index,
 * search, save) runs over edited bytes unchanged.
 */
import type { Piece } from "./pieceTable.ts";
import type { ByteSource, ReadInto } from "./source.ts";

/** A piece list packed for transfer: [buffer, start, length] triples. */
export const packPieces = (pieces: ReadonlyArray<Piece>): Float64Array => {
  const packed = new Float64Array(pieces.length * 3);
  pieces.forEach((piece, i) => {
    packed[3 * i] = piece.buffer;
    packed[3 * i + 1] = piece.start;
    packed[3 * i + 2] = piece.length;
  });
  return packed;
};

export const unpackPieces = (packed: Float64Array): Piece[] =>
  Array.from({ length: packed.length / 3 }, (_, i) => ({
    buffer: packed[3 * i] as number,
    start: packed[3 * i + 1] as number,
    length: packed[3 * i + 2] as number,
  }));

/**
 * Bytes [start, end) of the logical document described by `pieces`, read from
 * `buffers`; `pieces` must already be clipped to the window (PieceTable.slices).
 */
export const pieceSource = (
  pieces: ReadonlyArray<Piece>,
  buffer: (index: number) => ByteSource,
): ByteSource => {
  const starts: number[] = [];
  let size = 0;
  for (const piece of pieces) {
    starts.push(size);
    size += piece.length;
  }
  const pieceAt = (at: number) => {
    let lo = 0;
    let hi = pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) + (pieces[mid] as Piece).length <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const readInto = async (start: number, end: number, target: ArrayBuffer): Promise<ReadInto> => {
    const from = Math.max(0, Math.min(start, size));
    const to = Math.max(from, Math.min(end, size));
    const length = to - from;
    let i = pieceAt(from);
    // One piece covers the range: read it into the caller's buffer (a memory buffer aliases, a file fills it).
    if (i < pieces.length) {
      const piece = pieces[i] as Piece;
      const pieceStart = starts[i] as number;
      if (pieceStart + piece.length >= to) {
        return buffer(piece.buffer).readInto(
          piece.start + (from - pieceStart),
          piece.start + (to - pieceStart),
          target,
        );
      }
    }
    const out =
      target.byteLength >= length ? new Uint8Array(target, 0, length) : new Uint8Array(length);
    let at = from;
    while (at < to && i < pieces.length) {
      const piece = pieces[i] as Piece;
      const pieceStart = starts[i] as number;
      const pieceFrom = at - pieceStart;
      const n = Math.min(to, pieceStart + piece.length) - at;
      const bytes = await buffer(piece.buffer).read(
        piece.start + pieceFrom,
        piece.start + pieceFrom + n,
      );
      out.set(bytes, at - from);
      at += n;
      i++;
    }
    return { bytes: out, buffer: out.buffer as ArrayBuffer };
  };
  return {
    size,
    read: async (start, end) => (await readInto(start, end, new ArrayBuffer(0))).bytes,
    readInto,
    close: () => {},
  };
};
