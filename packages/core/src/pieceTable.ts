/**
 * The piece table (VS Code's 2018 design, adapted to bytes): the document is a
 * sequence of pieces, each a byte range of one buffer. Buffer 0 is the append
 * buffer (new bytes, append-only), buffer 1 is the original file, and higher
 * buffers are spill files a transform wrote (a formatted copy is one piece into
 * one spill file, never 2 GiB of RAM).
 * Nothing here holds bytes; reading goes through pieceSource.ts.
 *
 * Pieces live in a flat array with a parallel array of logical starts. Lookup is
 * a binary search, a splice is one array splice plus a prefix rebuild from the
 * edit point. VS Code's red-black tree makes that O(log P); here P is bounded by
 * the number of edits, the splice is native memmove, and at 10^5 pieces an edit
 * still costs well under a millisecond, so the tree is not worth its code. The
 * decision and the number are in docs/internals/document-engine.md.
 *
 * `replaceRange` returns exactly the pieces it removed, so an undo record is
 * `{ at, removed, inserted }` and undo is the same splice with the lists
 * swapped: no bytes are copied for history.
 */
export interface Piece {
  readonly buffer: number;
  readonly start: number;
  readonly length: number;
}

export const APPEND_BUFFER = 0;
export const ORIGINAL_BUFFER = 1;

/** A piece splice: what undo, redo and the journal replay. */
export interface Splice {
  readonly at: number;
  readonly removed: ReadonlyArray<Piece>;
  readonly inserted: ReadonlyArray<Piece>;
}

export const piecesLength = (pieces: ReadonlyArray<Piece>) => {
  let n = 0;
  for (const piece of pieces) n += piece.length;
  return n;
};

export class PieceTable {
  private pieces: Piece[] = [];
  /** Logical start of each piece; `starts[i] + pieces[i].length === starts[i + 1]`. */
  private starts: number[] = [];
  size = 0;

  constructor(originalLength: number) {
    if (originalLength > 0)
      this.replaceRange(0, 0, [{ buffer: ORIGINAL_BUFFER, start: 0, length: originalLength }]);
  }

  get pieceCount() {
    return this.pieces.length;
  }

  /** The pieces in order; the array is shared, do not mutate. */
  snapshot(): ReadonlyArray<Piece> {
    return this.pieces;
  }

  /** Index of the piece containing logical offset `at` (the piece after the last one when at === size). */
  private pieceAt(at: number): number {
    let lo = 0;
    let hi = this.pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.starts[mid] as number) + (this.pieces[mid] as Piece).length <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The pieces covering logical [start, end), clipped to that range. */
  slices(start: number, end: number): Piece[] {
    const out: Piece[] = [];
    if (end <= start) return out;
    let i = this.pieceAt(start);
    while (i < this.pieces.length) {
      const piece = this.pieces[i] as Piece;
      const pieceStart = this.starts[i] as number;
      if (pieceStart >= end) break;
      const from = Math.max(start, pieceStart) - pieceStart;
      const to = Math.min(end, pieceStart + piece.length) - pieceStart;
      out.push({ buffer: piece.buffer, start: piece.start + from, length: to - from });
      i++;
    }
    return out;
  }

  /**
   * Replaces logical [at, at + deleteLength) with `inserted`, returning the exact
   * pieces removed. Boundary pieces are split; pieces of one buffer that abut are
   * merged so a typing session does not leave one piece per keystroke.
   */
  replaceRange(at: number, deleteLength: number, inserted: ReadonlyArray<Piece>): Piece[] {
    if (at < 0 || deleteLength < 0 || at + deleteLength > this.size) {
      throw new RangeError(
        `splice [${at}, ${at + deleteLength}) is outside the ${this.size}-byte document`,
      );
    }
    const end = at + deleteLength;
    const first = this.pieceAt(at);
    const removed: Piece[] = [];
    const replacement: Piece[] = [];
    // Prefix of the first touched piece that stays.
    if (first < this.pieces.length) {
      const piece = this.pieces[first] as Piece;
      const pieceStart = this.starts[first] as number;
      if (pieceStart < at)
        replacement.push({ buffer: piece.buffer, start: piece.start, length: at - pieceStart });
    }
    let last = first;
    while (last < this.pieces.length && (this.starts[last] as number) < end) {
      const piece = this.pieces[last] as Piece;
      const pieceStart = this.starts[last] as number;
      const from = Math.max(at, pieceStart) - pieceStart;
      const to = Math.min(end, pieceStart + piece.length) - pieceStart;
      if (to > from)
        removed.push({ buffer: piece.buffer, start: piece.start + from, length: to - from });
      last++;
    }
    for (const piece of inserted) if (piece.length > 0) replacement.push(piece);
    // Suffix of the last touched piece that stays.
    if (last > first) {
      const piece = this.pieces[last - 1] as Piece;
      const pieceStart = this.starts[last - 1] as number;
      const pieceEnd = pieceStart + piece.length;
      if (pieceEnd > end)
        replacement.push({
          buffer: piece.buffer,
          start: piece.start + (end - pieceStart),
          length: pieceEnd - end,
        });
    }
    // Merge abutting pieces of one buffer, including with the untouched neighbours.
    const before = first > 0 ? (this.pieces[first - 1] as Piece) : undefined;
    const after = last < this.pieces.length ? (this.pieces[last] as Piece) : undefined;
    const merged: Piece[] = [];
    let spliceFrom = first;
    let spliceCount = last - first;
    const push = (piece: Piece) => {
      const prev = merged[merged.length - 1];
      if (prev && prev.buffer === piece.buffer && prev.start + prev.length === piece.start) {
        merged[merged.length - 1] = {
          buffer: prev.buffer,
          start: prev.start,
          length: prev.length + piece.length,
        };
      } else merged.push(piece);
    };
    if (before) {
      push(before);
      spliceFrom--;
      spliceCount++;
    }
    for (const piece of replacement) push(piece);
    if (after) {
      push(after);
      spliceCount++;
    }
    this.pieces.splice(spliceFrom, spliceCount, ...merged);
    this.size += piecesLength(inserted) - deleteLength;
    let offset =
      spliceFrom > 0
        ? (this.starts[spliceFrom - 1] as number) + (this.pieces[spliceFrom - 1] as Piece).length
        : 0;
    this.starts.length = this.pieces.length;
    for (let i = spliceFrom; i < this.pieces.length; i++) {
      this.starts[i] = offset;
      offset += (this.pieces[i] as Piece).length;
    }
    return removed;
  }

  /** Applies a splice as recorded; returns the pieces it displaced. */
  apply(splice: Splice): Piece[] {
    return this.replaceRange(splice.at, piecesLength(splice.removed), splice.inserted);
  }

  /** Applies the inverse of a splice. */
  revert(splice: Splice): Piece[] {
    return this.replaceRange(splice.at, piecesLength(splice.inserted), splice.removed);
  }
}
