/**
 * NDJSON bytes to a JSON array: non-blank lines comma-joined. Valid JSON lines
 * pass through byte for byte; malformed lines are serialized as JSON strings so
 * remaining lines still index and convert.
 */
import { scanJson } from "@quipu/core/jsonScan";

import { ByteWriter } from "./byteWriter.ts";
import { jsonEscapeInto } from "./csvToJson.ts";

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const QUOTE = 0x22;

export class NdjsonToJson {
  private readonly onOutput: (chunk: Uint8Array) => void;
  private readonly out = new ByteWriter(1 << 20);
  private pending: Uint8Array = new Uint8Array(0);
  private started = false;

  constructor(onOutput: (chunk: Uint8Array) => void) {
    this.onOutput = onOutput;
  }

  private line(data: Uint8Array, start: number, end: number) {
    let s = start;
    let e = end;
    while (s < e && (data[s] === SPACE || data[s] === TAB || data[s] === CR)) s++;
    while (e > s && (data[e - 1] === SPACE || data[e - 1] === TAB || data[e - 1] === CR)) e--;
    if (s >= e) return;
    this.out.byte(this.started ? 0x2c : 0x5b);
    this.started = true;
    const slice = data.subarray(s, e);
    if (scanJson(slice).status === "complete") {
      this.out.bytes(data, s, e);
    } else {
      this.out.byte(QUOTE);
      jsonEscapeInto(this.out, slice, slice.length);
      this.out.byte(QUOTE);
    }
  }

  push(chunk: Uint8Array) {
    let data = chunk;
    if (this.pending.length > 0) {
      data = new Uint8Array(this.pending.length + chunk.length);
      data.set(this.pending);
      data.set(chunk, this.pending.length);
    }
    let start = 0;
    for (let nl = data.indexOf(LF); nl >= 0; nl = data.indexOf(LF, start)) {
      this.line(data, start, nl);
      start = nl + 1;
    }
    this.pending = data.slice(start);
    if (this.out.length >= 1 << 20) this.onOutput(this.out.take());
  }

  end() {
    if (this.pending.length > 0) this.line(this.pending, 0, this.pending.length);
    if (!this.started) this.out.byte(0x5b);
    this.out.byte(0x5d);
    this.onOutput(this.out.take());
  }
}
