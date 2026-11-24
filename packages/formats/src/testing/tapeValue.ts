import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { decodeString, scalarValue, stringEnd } from "@quipu/core/decode";
import {
  firstChild,
  KIND_ARRAY,
  KIND_OBJECT,
  KIND_STRING,
  NO_KEY,
  type Tape,
} from "@quipu/core/tape";

import { decodeFieldInto, fieldEnd } from "../csvField.ts";

export const children = (tape: Tape, i: number): number[] => {
  const out: number[] = [];
  for (let c = firstChild(tape, i); c >= 0; c = tape.next(c)) out.push(c);
  return out;
};

/** The JS value of a JSON-shaped subtree (NDJSON lines, or any tape of JSON bytes). */
export const jsonValueAt = (tape: Tape, bytes: Uint8Array, i: number): unknown => {
  const kind = tape.kind(i);
  if (kind === KIND_OBJECT) {
    const out: Record<string, unknown> = {};
    for (const c of children(tape, i)) {
      const ks = tape.keyStart(c);
      const ke = stringEnd(bytes, ks);
      out[decodeString(bytes, ks, ke)] = jsonValueAt(tape, bytes, c);
    }
    return out;
  }
  if (kind === KIND_ARRAY) return children(tape, i).map((c) => jsonValueAt(tape, bytes, c));
  return scalarValue(tape, i, bytes);
};

const fieldText = (bytes: Uint8Array, start: number, end: number) => {
  const out = new Uint8Array(end - start);
  return decodeUtf8(out.subarray(0, decodeFieldInto(bytes, start, end, out)));
};

/** The rows of a CSV tape as records keyed by the header, decoded from the source bytes. */
export const csvRowsAt = (
  tape: Tape,
  bytes: Uint8Array,
  delimiter: number,
): Array<Record<string, string>> => {
  const rows: Array<Record<string, string>> = [];
  for (const row of children(tape, 0)) {
    const record: Record<string, string> = {};
    children(tape, row).forEach((f, position) => {
      if (tape.kind(f) !== KIND_STRING) throw new Error("csv field is not a string token");
      const ks = tape.keyStart(f);
      const key =
        ks === NO_KEY ? `_${position}` : fieldText(bytes, ks, fieldEnd(bytes, ks, delimiter));
      record[key] = fieldText(bytes, tape.start(f), tape.end(f));
    });
    rows.push(record);
  }
  return rows;
};
