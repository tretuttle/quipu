/**
 * CSV/TSV bytes to a JSON array of row objects, as bytes, fed in chunks. Every
 * value is a string (CSV has no types). The first row names the keys; a blank
 * line is skipped; a row with more fields than the header names the extras
 * `_<position>` (the same name the tape adapter reports); a row with fewer simply
 * lacks the keys. A header that repeats a name cannot be an object's keys, which
 * is the one thing a table has that JSON does not: that is an error.
 */
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { MAX_KEY_BYTES } from "@quipu/core/decode";

import { ByteWriter } from "./byteWriter.ts";
import { bomLength, CR, LF, QUOTE, decodeFieldInto } from "./csvField.ts";
import { UnrepresentableError } from "./errors.ts";
import type { ConvertFormat } from "./formatIds.ts";

const BACKSLASH = 0x5c;
const HEX = "0123456789abcdef";

/** Appends `bytes` as the body of a JSON string (no quotes). */
export const jsonEscapeInto = (out: ByteWriter, bytes: Uint8Array, length: number) => {
  let run = 0;
  for (let i = 0; i < length; i++) {
    const b = bytes[i] as number;
    if (b >= 0x20 && b !== QUOTE && b !== BACKSLASH) continue;
    out.bytes(bytes, run, i);
    run = i + 1;
    if (b === QUOTE) out.ascii('\\"');
    else if (b === BACKSLASH) out.ascii("\\\\");
    else if (b === 0x0a) out.ascii("\\n");
    else if (b === 0x0d) out.ascii("\\r");
    else if (b === 0x09) out.ascii("\\t");
    else out.ascii(`\\u00${HEX[b >> 4]}${HEX[b & 15]}`);
  }
  out.bytes(bytes, run, length);
};

export class CsvToJson {
  private readonly delimiter: number;
  private readonly onOutput: (chunk: Uint8Array) => void;
  private readonly from: ConvertFormat;
  private readonly out = new ByteWriter(1 << 20);
  private pending: Uint8Array = new Uint8Array(0);
  private header: Uint8Array[] | undefined;
  private rows = 0;
  private started = false;
  private atFileStart = true;
  private scratch = new Uint8Array(1024);

  constructor(
    delimiter: number,
    onOutput: (chunk: Uint8Array) => void,
    from: ConvertFormat = "csv",
  ) {
    this.delimiter = delimiter;
    this.onOutput = onOutput;
    this.from = from;
  }

  push(chunk: Uint8Array) {
    let data = chunk;
    if (this.pending.length > 0) {
      data = new Uint8Array(this.pending.length + chunk.length);
      data.set(this.pending);
      data.set(chunk, this.pending.length);
    }
    if (this.atFileStart && data.length > 0) {
      if (data.length < 3 && data[0] === 0xef) {
        this.pending = data;
        return;
      }
      const bom = bomLength(data);
      data = data.subarray(bom);
      this.atFileStart = false;
    }
    let rowStart = 0;
    let inQuote = false;
    for (let i = 0; i < data.length; i++) {
      const b = data[i] as number;
      if (b === QUOTE) inQuote = !inQuote;
      else if (b === LF && !inQuote) {
        this.row(data, rowStart, i > rowStart && data[i - 1] === CR ? i - 1 : i);
        rowStart = i + 1;
      }
    }
    this.pending = data.slice(rowStart);
    if (this.out.length >= 1 << 20) this.onOutput(this.out.take());
  }

  end() {
    if (this.pending.length > 0) {
      let e = this.pending.length;
      if (this.pending[e - 1] === CR) e--;
      this.row(this.pending, 0, e);
      this.pending = new Uint8Array(0);
    }
    if (!this.started) this.out.byte(0x5b);
    this.out.byte(0x5d);
    this.onOutput(this.out.take());
  }

  private row(data: Uint8Array, start: number, end: number) {
    if (end === start) return;
    // Split into fields (quotes toggle).
    const fields: number[] = [];
    let inQuote = false;
    let fieldStart = start;
    for (let i = start; i < end; i++) {
      const b = data[i] as number;
      if (b === QUOTE) inQuote = !inQuote;
      else if (!inQuote && b === this.delimiter) {
        fields.push(fieldStart, i);
        fieldStart = i + 1;
      }
    }
    fields.push(fieldStart, end);
    const count = fields.length / 2;
    if (!this.header) {
      const names: Uint8Array[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < count; k++) {
        const s = fields[k * 2] as number;
        const e = fields[k * 2 + 1] as number;
        const buf = new Uint8Array(e - s);
        const name = buf.subarray(0, decodeFieldInto(data, s, e, buf)).slice();
        const text = decodeUtf8(name, MAX_KEY_BYTES);
        if (seen.has(text)) {
          throw new UnrepresentableError({
            from: this.from,
            to: "json",
            reason: "duplicate-key",
            pointer: `/0/${text.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            detail: "the header names a column twice, so a row cannot be an object",
          });
        }
        seen.add(text);
        names.push(name);
      }
      this.header = names;
      return;
    }
    const out = this.out;
    if (!this.started) {
      out.byte(0x5b);
      this.started = true;
    } else out.byte(0x2c);
    out.byte(0x7b);
    for (let k = 0; k < count; k++) {
      if (k > 0) out.byte(0x2c);
      out.byte(QUOTE);
      const name = this.header[k];
      if (name) jsonEscapeInto(out, name, name.length);
      else out.ascii(`_${k}`);
      out.ascii('":"');
      const s = fields[k * 2] as number;
      const e = fields[k * 2 + 1] as number;
      if (this.scratch.length < e - s) this.scratch = new Uint8Array((e - s) * 2);
      const n = decodeFieldInto(data, s, e, this.scratch);
      jsonEscapeInto(out, this.scratch, n);
      out.byte(QUOTE);
    }
    out.byte(0x7d);
    this.rows++;
  }
}
