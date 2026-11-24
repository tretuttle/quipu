/**
 * JSON tokens back to compact JSON bytes: minify, or one element per line for
 * NDJSON. Whitespace between tokens is dropped and everything else is copied
 * byte for byte, so numbers and escapes survive exactly.
 */
import { COLON, COMMA } from "@quipu/core/bytes";

import type { ByteWriter } from "./byteWriter.ts";
import { type JsonHandler, KIND_OBJECT, type ScanState } from "./jsonScan.ts";
import { RegionStop } from "./regionStop.ts";

const NEWLINE = 0x0a;
const ARR_OPEN = 0x5b;

export class CompactJsonHandler implements JsonHandler {
  private readonly out: ByteWriter;
  private readonly st: ScanState;
  private readonly lines: boolean;
  private readonly ownedEnd: number;
  /** Elements written (lines mode). */
  elements = 0;
  stoppedAt = -1;
  /** Inside an element this handler owns (lines mode); a region that starts mid-element skips it. */
  private inElement = false;

  /**
   * `lines`: when the root is an array, write each element on its own line and
   * drop the array's brackets and commas. `ownedEnd` bounds the elements a
   * region starts (Infinity for a whole document).
   */
  constructor(out: ByteWriter, st: ScanState, lines: boolean, ownedEnd = Number.POSITIVE_INFINITY) {
    this.out = out;
    this.st = st;
    this.lines = lines;
    this.ownedEnd = ownedEnd;
  }

  private rootIsArray() {
    return this.lines && this.st.kinds[0] === 2;
  }

  /** The depth the entries of the root array have, or 0 when the root is not being split. */
  private element(pos: number) {
    const st = this.st;
    if (st.depth === 1 && this.rootIsArray()) {
      if (pos >= this.ownedEnd) {
        this.stoppedAt = pos;
        throw new RegionStop(pos);
      }
      return true;
    }
    return false;
  }

  private separator() {
    const st = this.st;
    if (st.prevSig === COMMA && !(st.depth === 1 && this.rootIsArray())) this.out.byte(COMMA);
  }

  open(kind: number, pos: number) {
    const st = this.st;
    if (st.depth === 0) {
      if (kind === 2 && this.lines) return; // the root array's brackets are dropped
      this.out.byte(kind === KIND_OBJECT ? 0x7b : 0x5b);
      return;
    }
    if (this.element(pos)) this.inElement = true;
    else if (this.lines && this.rootIsArray() && !this.inElement) return;
    this.separator();
    this.out.byte(kind === KIND_OBJECT ? 0x7b : 0x5b);
  }

  close(kind: number, _pos: number) {
    const st = this.st;
    if (st.depth === 1) {
      if (kind === 2 && this.lines) return;
      this.out.byte(kind === KIND_OBJECT ? 0x7d : 0x5d);
      return;
    }
    if (this.lines && this.rootIsArray() && !this.inElement) return;
    this.out.byte(kind === KIND_OBJECT ? 0x7d : 0x5d);
    if (st.depth === 2 && this.rootIsArray()) {
      this.out.byte(NEWLINE);
      this.elements++;
      this.inElement = false;
    }
  }

  key(bytes: Uint8Array, start: number, end: number) {
    if (this.lines && this.rootIsArray() && !this.inElement) return;
    this.separator();
    this.out.bytes(bytes, start, end);
    this.out.byte(COLON);
  }

  string(bytes: Uint8Array, start: number, end: number) {
    this.value(bytes, start, end);
  }

  scalar(bytes: Uint8Array, start: number, end: number, _kind: number) {
    this.value(bytes, start, end);
  }

  private value(bytes: Uint8Array, start: number, end: number) {
    const st = this.st;
    const atElement = this.element(start);
    if (!atElement && this.lines && this.rootIsArray() && !this.inElement) return;
    if (st.prevSig !== COLON) this.separator();
    this.out.bytes(bytes, start, end);
    if (atElement) {
      this.out.byte(NEWLINE);
      this.elements++;
    }
  }
}

export { ARR_OPEN };
