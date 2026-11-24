/**
 * JSON tokens to block-style YAML, one line per entry, written as bytes.
 *
 * The layout depends only on the depth and the kind of the open containers, so
 * a region of the file can be converted from its entry state alone and the
 * pieces concatenated (the engine's streaming-job rule). Every line ends with a
 * newline when its entry finishes; a container with children writes nothing at
 * its close, and an empty one writes `{}` or `[]` on the line its parent began.
 *
 * Strings are plain when that is certain to read back as the same string, and
 * otherwise the JSON double-quoted form, which is valid YAML as it stands. The
 * choice depends on the string's own bytes only, never on where a region ended,
 * so one input converts to one output however it was split.
 */
import { COLON, COMMA, OBJ_OPEN } from "@quipu/core/bytes";

import { OffendingNode } from "./abort.ts";
import type { ByteWriter } from "./byteWriter.ts";
import { type JsonHandler, KIND_ARRAY, KIND_OBJECT, type ScanState } from "./jsonScan.ts";

const ARR_OPEN = 0x5b;
const SPACE = 0x20;
const NEWLINE = 0x0a;
const DASH = 0x2d;

/** Deeper documents are refused: indentation grows without bound, and parsers cap it too. */
export const MAX_YAML_DEPTH = 1024;
/** A string longer than this (quotes included) is always double-quoted, so streaming it needs no look-ahead. */
export const PLAIN_STRING_LIMIT = 1024 * 1024;
/** YAML implicit keys may not exceed this many characters. */
const MAX_KEY_BYTES = 1024;

const PLAIN_FIRST = new Uint8Array(256);
for (let c = 0x41; c <= 0x5a; c++) PLAIN_FIRST[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) PLAIN_FIRST[c] = 1;
PLAIN_FIRST[0x5f] = 1;

const PLAIN_MID = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) PLAIN_MID[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) PLAIN_MID[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) PLAIN_MID[c] = 1;
for (const c of " _./-@+()=~$^%!?*&<>,;[]{}'") PLAIN_MID[c.charCodeAt(0)] = 1;

/** Words YAML 1.1 and 1.2 read as something other than a string. Compared case-insensitively. */
const RESERVED = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "nan",
  "inf",
]);

const lowerAscii = (b: number) => (b >= 0x41 && b <= 0x5a ? b | 0x20 : b);

const isReserved = (bytes: Uint8Array, from: number, to: number) => {
  const length = to - from;
  if (length > 5 || length === 0) return false;
  let word = "";
  for (let i = from; i < to; i++) word += String.fromCharCode(lowerAscii(bytes[i] as number));
  return RESERVED.has(word);
};

/**
 * Is the string content in `[from, to)` (between the quotes, no escapes) safe
 * as a plain scalar in a block mapping value or key? Conservative by design:
 * anything doubtful is quoted, which is always correct.
 */
export const isPlainSafe = (bytes: Uint8Array, from: number, to: number): boolean => {
  const n = to - from;
  if (n === 0 || n > 4096) return false;
  const first = bytes[from] as number;
  if (PLAIN_FIRST[first] !== 1 && first < 0x80) return false;
  const last = bytes[to - 1] as number;
  if (last === SPACE) return false;
  for (let i = from; i < to; i++) {
    const c = bytes[i] as number;
    if (c >= 0x80) {
      // Line separators and the byte-order mark end or confuse a plain scalar.
      if (c === 0xc2 && bytes[i + 1] === 0x85) return false;
      if (c === 0xe2 && bytes[i + 1] === 0x80 && (bytes[i + 2] === 0xa8 || bytes[i + 2] === 0xa9))
        return false;
      if (c === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) return false;
      continue;
    }
    if (c === COLON) {
      const next = i + 1 < to ? (bytes[i + 1] as number) : SPACE;
      if (next === SPACE || i + 1 >= to) return false;
      continue;
    }
    if (c === 0x23 && i > from && bytes[i - 1] === SPACE) return false;
    if (PLAIN_MID[c] !== 1) return false;
  }
  if (isReserved(bytes, from, to)) return false;
  return true;
};

/** Writes block YAML for the tokens of one JSON document, or of any region of one. */
export class YamlHandler implements JsonHandler {
  private readonly out: ByteWriter;
  private readonly st: ScanState;

  constructor(out: ByteWriter, st: ScanState) {
    this.out = out;
    this.st = st;
  }

  /** The line prefix of an entry of the innermost container: a line break and indent, or nothing when inline. */
  private entryPrefix() {
    const st = this.st;
    const depth = st.depth;
    if (depth === 0) return;
    const level = depth - 1;
    const prev = st.prevSig;
    const first = prev === OBJ_OPEN || prev === ARR_OPEN;
    if (first) {
      if (level === 0) return;
      if (st.kinds[level - 1] === KIND_ARRAY) return; // inline after the parent's "- "
      this.out.byte(NEWLINE);
      this.out.spaces(2 * level);
      return;
    }
    this.out.spaces(2 * level);
  }

  open(kind: number, pos: number) {
    const st = this.st;
    if (st.depth >= MAX_YAML_DEPTH) {
      throw new OffendingNode(pos, "too-deep", `nesting deeper than ${MAX_YAML_DEPTH} levels`);
    }
    if (st.depth > 0 && st.kinds[st.depth - 1] === KIND_ARRAY) {
      this.entryPrefix();
      this.out.byte(DASH);
      this.out.byte(SPACE);
    }
    void kind;
  }

  close(kind: number, _pos: number) {
    const st = this.st;
    const prev = st.prevSig;
    if (prev !== OBJ_OPEN && prev !== ARR_OPEN) return;
    const out = this.out;
    const level = st.depth - 1;
    if (level > 0 && st.kinds[level - 1] === KIND_OBJECT) out.byte(SPACE);
    out.byte(kind === KIND_OBJECT ? 0x7b : 0x5b);
    out.byte(kind === KIND_OBJECT ? 0x7d : 0x5d);
    out.byte(NEWLINE);
  }

  key(bytes: Uint8Array, start: number, end: number) {
    this.entryPrefix();
    const out = this.out;
    const inner = end - start - 2;
    if (inner > 0 && inner <= MAX_KEY_BYTES && isPlainSafe(bytes, start + 1, end - 1)) {
      out.bytes(bytes, start + 1, end - 1);
    } else {
      if (inner > MAX_KEY_BYTES) {
        throw new OffendingNode(
          start,
          "key-too-long",
          `a key of ${inner} bytes; YAML implicit keys stop at ${MAX_KEY_BYTES}`,
        );
      }
      out.bytes(bytes, start, end);
    }
    out.byte(COLON);
  }

  string(bytes: Uint8Array, start: number, end: number) {
    this.valuePrefix();
    const out = this.out;
    if (end - start <= PLAIN_STRING_LIMIT && isPlainSafe(bytes, start + 1, end - 1)) {
      out.bytes(bytes, start + 1, end - 1);
    } else out.bytes(bytes, start, end);
    out.byte(NEWLINE);
  }

  scalar(bytes: Uint8Array, start: number, end: number, _kind: number) {
    this.valuePrefix();
    this.out.bytes(bytes, start, end);
    this.out.byte(NEWLINE);
  }

  /**
   * A string longer than the window started here: its bytes so far are written
   * raw, in the JSON double-quoted form, and `continueString` writes the rest.
   */
  partialString(bytes: Uint8Array, start: number, end: number) {
    const st = this.st;
    const prev = st.prevSig;
    const isKey =
      st.depth > 0 &&
      st.kinds[st.depth - 1] === KIND_OBJECT &&
      (prev === OBJ_OPEN || prev === COMMA);
    if (isKey) {
      throw new OffendingNode(
        start,
        "key-too-long",
        "a key longer than the window; YAML implicit keys stop at 1024",
      );
    }
    this.valuePrefix();
    this.out.bytes(bytes, start, end);
  }

  /** The rest of a string `partialString` began; `closed` when its closing quote is the last byte. */
  continueString(bytes: Uint8Array, from: number, to: number, closed: boolean) {
    this.out.bytes(bytes, from, to);
    if (closed) this.out.byte(NEWLINE);
  }

  /** What precedes a scalar: the space after `key:`, the `- ` of an item, or nothing at the root. */
  private valuePrefix() {
    const st = this.st;
    if (st.depth === 0) return;
    if (st.prevSig === COLON) {
      this.out.byte(SPACE);
      return;
    }
    this.entryPrefix();
    this.out.byte(DASH);
    this.out.byte(SPACE);
  }
}
