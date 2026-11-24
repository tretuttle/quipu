/**
 * JSON tokens to TOML 1.0, written as bytes.
 *
 * The layout depends only on the depth and the kind of the open containers, so a
 * region of the file can be converted from its entry state alone and the pieces
 * concatenated (the engine's streaming-job rule), the same way YAML is. That rules
 * out `[table]` headers, which need the key path to a region that starts
 * mid-document and cannot know it. So the root's members are lines
 * (`key = value`), an array directly under the root is one element per line, and
 * everything deeper is an inline table or an inline array.
 *
 * What TOML cannot hold is an error with the byte offset of the first offending
 * node: a root that is not an object (a TOML document is a table), and null.
 * Whole tokens only: a string or number longer than the conversion window is
 * `token-too-large`, as for CSV. Integers outside 64 bits are written as floats
 * with every digit kept, and a lone surrogate escape (which has no UTF-8 form) is
 * refused rather than replaced.
 */
import { BACKSLASH } from "@quipu/core/bytes";
import { unescapeBytes } from "@quipu/core/decode";

import { OffendingNode } from "./abort.ts";
import type { ByteWriter } from "./byteWriter.ts";
import {
  type JsonHandler,
  KIND_ARRAY,
  KIND_NULL,
  KIND_NUMBER,
  KIND_OBJECT,
  type ScanState,
} from "./jsonScan.ts";

/** Deeper documents are refused: a TOML reader recurses per inline table and caps its depth. */
const MAX_TOML_DEPTH = 1024;

const ARR_OPEN = 0x5b;
const OBJ_OPEN = 0x7b;
const COMMA = 0x2c;
const QUOTE = 0x22;
const SPACE = 0x20;
const NEWLINE = 0x0a;
const DEL = 0x7f;
const MINUS = 0x2d;
const DOT = 0x2e;
const LOWER_E = 0x65;
const UPPER_E = 0x45;

const BARE_KEY = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) BARE_KEY[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) BARE_KEY[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) BARE_KEY[c] = 1;
BARE_KEY[0x5f] = 1;
BARE_KEY[MINUS] = 1;

const HEX = "0123456789ABCDEF";
const I64_MAX = "9223372036854775807";
const I64_MIN_MAGNITUDE = "9223372036854775808";

/** Does an integer token (digits after an optional sign) fit in a signed 64-bit integer? */
const fitsInt64 = (bytes: Uint8Array, start: number, end: number) => {
  const negative = bytes[start] === MINUS;
  const from = negative ? start + 1 : start;
  const length = end - from;
  if (length < 19) return true;
  if (length > 19) return false;
  const limit = negative ? I64_MIN_MAGNITUDE : I64_MAX;
  for (let i = 0; i < 19; i++) {
    const d = bytes[from + i] as number;
    const l = limit.charCodeAt(i);
    if (d !== l) return d < l;
  }
  return true;
};

export class TomlHandler implements JsonHandler {
  private readonly out: ByteWriter;
  private readonly st: ScanState;
  private scratch = new Uint8Array(256);

  constructor(out: ByteWriter, st: ScanState) {
    this.out = out;
    this.st = st;
  }

  /** An element's line prefix: an indented line under a root member's array, a comma inline. */
  private elementPrefix(parentDepth: number) {
    const st = this.st;
    const first = st.prevSig === ARR_OPEN;
    if (parentDepth === 2) {
      if (first) this.out.byte(NEWLINE);
      this.out.spaces(2);
    } else if (!first) {
      this.out.byte(COMMA);
      this.out.byte(SPACE);
    }
  }

  /** What ends a value whose container is `parentDepth` levels deep. */
  private suffix(parentDepth: number) {
    if (parentDepth === 1) this.out.byte(NEWLINE);
    else if (parentDepth === 2 && this.st.kinds[1] === KIND_ARRAY) {
      this.out.byte(COMMA);
      this.out.byte(NEWLINE);
    }
  }

  /** The start of a scalar, string or container: the prefix its container gives it. */
  private beforeValue(pos: number) {
    const st = this.st;
    const depth = st.depth;
    if (depth === 0) {
      throw new OffendingNode(
        pos,
        "not-a-table",
        "a TOML document is a table: the root must be an object",
      );
    }
    if (st.kinds[depth - 1] === KIND_ARRAY) this.elementPrefix(depth);
  }

  open(kind: number, pos: number) {
    const st = this.st;
    if (st.depth === 0) {
      if (kind !== KIND_OBJECT) {
        throw new OffendingNode(
          pos,
          "not-a-table",
          "a TOML document is a table: the root must be an object, not an array",
        );
      }
      return;
    }
    if (st.depth >= MAX_TOML_DEPTH) {
      throw new OffendingNode(pos, "too-deep", `nesting deeper than ${MAX_TOML_DEPTH} levels`);
    }
    this.beforeValue(pos);
    this.out.byte(kind === KIND_OBJECT ? OBJ_OPEN : ARR_OPEN);
  }

  close(kind: number, _pos: number) {
    const st = this.st;
    const depth = st.depth;
    if (depth <= 1) return;
    const empty = st.prevSig === OBJ_OPEN || st.prevSig === ARR_OPEN;
    if (kind === KIND_OBJECT) {
      if (!empty) this.out.byte(SPACE);
      this.out.byte(0x7d);
    } else this.out.byte(0x5d);
    this.suffix(depth - 1);
  }

  key(bytes: Uint8Array, start: number, end: number) {
    const st = this.st;
    if (st.depth > 1) {
      if (st.prevSig === OBJ_OPEN) this.out.byte(SPACE);
      else {
        this.out.byte(COMMA);
        this.out.byte(SPACE);
      }
    }
    this.quoted(bytes, start, end, true);
    this.out.byte(SPACE);
    this.out.byte(0x3d);
    this.out.byte(SPACE);
  }

  string(bytes: Uint8Array, start: number, end: number) {
    this.beforeValue(start);
    this.quoted(bytes, start, end, false);
    this.suffix(this.st.depth);
  }

  scalar(bytes: Uint8Array, start: number, end: number, kind: number) {
    this.beforeValue(start);
    if (kind === KIND_NULL) {
      throw new OffendingNode(start, "null-value", "TOML has no null");
    }
    if (kind === KIND_NUMBER) this.number(bytes, start, end);
    else this.out.bytes(bytes, start, end);
    this.suffix(this.st.depth);
  }

  private number(bytes: Uint8Array, start: number, end: number) {
    const out = this.out;
    let integer = true;
    for (let i = start; i < end; i++) {
      const b = bytes[i] as number;
      if (b === DOT || b === LOWER_E || b === UPPER_E) {
        integer = false;
        break;
      }
    }
    if (!integer || fitsInt64(bytes, start, end)) {
      out.bytes(bytes, start, end);
      return;
    }
    // Past 64 bits: the same digits as a float, d.ddd followed by an exponent.
    let at = start;
    if (bytes[at] === MINUS) {
      out.byte(MINUS);
      at++;
    }
    out.byte(bytes[at] as number);
    out.byte(DOT);
    out.bytes(bytes, at + 1, end);
    out.byte(LOWER_E);
    out.ascii(String(end - at - 1));
  }

  /**
   * A JSON string token as a TOML basic string, or as a bare key when it is one
   * and `asKey`. Bytes that need no change are copied; the rest go through
   * unescape and TOML's own escapes.
   */
  private quoted(bytes: Uint8Array, start: number, end: number, asKey: boolean) {
    const out = this.out;
    let plain = true;
    let bare = asKey && end - start > 2;
    for (let i = start + 1; i < end - 1; i++) {
      const b = bytes[i] as number;
      if (b === BACKSLASH || b === DEL || (b < 0x20 && b !== 0x09)) {
        plain = false;
        bare = false;
        break;
      }
      if (bare && BARE_KEY[b] !== 1) bare = false;
    }
    if (bare) {
      out.bytes(bytes, start + 1, end - 1);
      return;
    }
    if (plain) {
      out.bytes(bytes, start, end);
      return;
    }
    if (this.scratch.length < end - start) this.scratch = new Uint8Array((end - start) * 2);
    const text = this.scratch;
    const length = unescapeBytes(bytes, start + 1, end - 1, text, 0);
    out.byte(QUOTE);
    let run = 0;
    for (let i = 0; i < length; i++) {
      const b = text[i] as number;
      if (b >= 0x20 && b !== QUOTE && b !== BACKSLASH && b !== DEL) {
        if (b === 0xed && (text[i + 1] as number) >= 0xa0) {
          throw new OffendingNode(
            start,
            "invalid-input",
            "a lone surrogate escape has no UTF-8 form",
          );
        }
        continue;
      }
      out.bytes(text, run, i);
      run = i + 1;
      switch (b) {
        case QUOTE:
          out.byte(BACKSLASH);
          out.byte(QUOTE);
          break;
        case BACKSLASH:
          out.byte(BACKSLASH);
          out.byte(BACKSLASH);
          break;
        case 0x08:
          out.ascii("\\b");
          break;
        case 0x09:
          out.ascii("\\t");
          break;
        case 0x0a:
          out.ascii("\\n");
          break;
        case 0x0c:
          out.ascii("\\f");
          break;
        case 0x0d:
          out.ascii("\\r");
          break;
        default:
          out.ascii(`\\u00${HEX[b >> 4]}${HEX[b & 15]}`);
      }
    }
    out.bytes(text, run, length);
    out.byte(QUOTE);
  }
}
