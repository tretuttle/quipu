import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AppendBuffer } from "./appendBuffer.ts";
import { pieceSource } from "./pieceSource.ts";
import {
  APPEND_BUFFER,
  ORIGINAL_BUFFER,
  type Piece,
  PieceTable,
  type Splice,
} from "./pieceTable.ts";
import { memorySource } from "./source.ts";

const utf8 = new TextEncoder();

/** An edit script: each step deletes `del` of the bytes at `at` (both scaled to the document) and inserts `text`. */
const Step = Schema.Struct({
  at: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  del: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  text: Schema.String.check(Schema.isMaxLength(12)),
  undo: Schema.Boolean,
  redo: Schema.Boolean,
});
const Script = Schema.Struct({
  original: Schema.String.check(Schema.isMaxLength(40)),
  steps: Schema.Array(Step).check(Schema.isMaxLength(24)),
});
const script = Arbitrary.schema(Script);
const options = { arbitrary: { runs: 300 } };

/** The piece table, its buffers and a reader, driven alongside a plain string. */
const harness = (original: string) => {
  const originalBytes = utf8.encode(original);
  const table = new PieceTable(originalBytes.byteLength);
  const append = new AppendBuffer(7); // tiny chunks so inserts straddle them
  const buffers = [append.asSource(), memorySource(originalBytes)];
  const read = async (start = 0, end = table.size) =>
    pieceSource(table.slices(start, end), (i) => buffers[i] as never).read(0, end - start);
  return { table, append, read };
};

describe("the piece table against a naive string model", () => {
  // `it.prop` does not await a promise-returning property; the Effect form does.
  it.live.prop(
    "every edit sequence with undo and redo reads back the model's bytes",
    [script],
    ([{ original, steps }]) =>
      Effect.promise(async () => {
        const { table, append, read } = harness(original);
        let model: Uint8Array = utf8.encode(original);
        const history: Uint8Array[] = [model];
        const undone: Splice[] = [];
        const done: Splice[] = [];
        const bytesEqual = async () => {
          expect(Array.from(await read())).toEqual(Array.from(model));
          expect(table.size).toBe(model.byteLength);
        };
        for (const step of steps) {
          const at = Math.floor(step.at * model.byteLength);
          const del = Math.floor(step.del * (model.byteLength - at));
          const text = utf8.encode(step.text);
          const inserted = append.append(text);
          const removed = table.replaceRange(at, del, inserted);
          done.push({ at, removed, inserted });
          undone.length = 0;
          model = concat(model.subarray(0, at), text, model.subarray(at + del));
          history.push(model);
          await bytesEqual();
          if (step.undo && done.length > 0) {
            const splice = done.pop() as Splice;
            table.revert(splice);
            undone.push(splice);
            history.pop();
            model = history[history.length - 1] as Uint8Array;
            await bytesEqual();
          }
          if (step.redo && undone.length > 0) {
            const splice = undone.pop() as Splice;
            table.apply(splice);
            done.push(splice);
            model = concat(
              model.subarray(0, splice.at),
              await readPieces(splice.inserted, append, utf8.encode(original)),
              model.subarray(splice.at + piecesLength(splice.removed)),
            );
            history.push(model);
            await bytesEqual();
          }
        }
        // A sub-range reads the same bytes as the model's slice.
        const mid = model.byteLength >> 1;
        expect(Array.from(await read(mid >> 1, mid))).toEqual(
          Array.from(model.subarray(mid >> 1, mid)),
        );
      }),
    options,
  );

  it("starts as one piece over the original and merges abutting pieces", () => {
    const { table, append } = harness("hello world");
    expect(table.snapshot()).toEqual([{ buffer: ORIGINAL_BUFFER, start: 0, length: 11 }]);
    table.replaceRange(5, 0, append.append(utf8.encode(",")));
    table.replaceRange(6, 0, append.append(utf8.encode(" ")));
    // Two consecutive appends at adjacent positions are one piece into the append buffer.
    expect(table.snapshot()).toEqual([
      { buffer: ORIGINAL_BUFFER, start: 0, length: 5 },
      { buffer: APPEND_BUFFER, start: 0, length: 2 },
      { buffer: ORIGINAL_BUFFER, start: 5, length: 6 },
    ]);
    // Deleting the inserted bytes merges the original halves back into one piece.
    table.replaceRange(5, 2, []);
    expect(table.snapshot()).toEqual([{ buffer: ORIGINAL_BUFFER, start: 0, length: 11 }]);
  });

  it("refuses a splice outside the document", () => {
    const { table } = harness("abc");
    expect(() => table.replaceRange(2, 5, [])).toThrow(RangeError);
    expect(() => table.replaceRange(-1, 0, [])).toThrow(RangeError);
  });
});

const concat = (...parts: ReadonlyArray<Uint8Array<ArrayBufferLike>>) => {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

const piecesLength = (pieces: ReadonlyArray<Piece>) => pieces.reduce((n, p) => n + p.length, 0);

const readPieces = async (
  pieces: ReadonlyArray<Piece>,
  append: AppendBuffer,
  original: Uint8Array,
) => {
  const buffers = [append.asSource(), memorySource(original)];
  return pieceSource(pieces, (i) => buffers[i] as never).read(0, piecesLength(pieces));
};
