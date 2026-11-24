/**
 * Colors a byte range of a JSON document from its structural index: which token
 * each byte belongs to (key, string, number, literal, brace, …), how many
 * objects enclose it, and which container it sits in. The theme's syntax table
 * (packages/shared/src/syntaxTable.ts) maps that triple to a color, so the
 * structural-index painter and shiki agree on every theme.
 *
 * The tape knows every value's byte range and every member's key offset. What
 * it does not store is the punctuation between them (`:`, `,`, `}`, `]`,
 * whitespace) and the inside of a string (quotes, escapes). Those are read from
 * the bytes in the gaps between tokens, which is a bounded scan of the visible
 * range and never of the document.
 */
import type { SourceContainerKind, SourceTokenKind } from "@quipu/contracts/engine";

import {
  ARR_CLOSE,
  ARR_OPEN,
  BACKSLASH,
  COLON,
  COMMA,
  OBJ_CLOSE,
  OBJ_OPEN,
  QUOTE,
} from "./bytes.ts";
import { KIND_OBJECT, KIND_STRING, isContainer } from "./tape.ts";

/** A token as the painter needs it; `keyStart` is -1 for array elements and the root. */
export interface PaintToken {
  readonly kind: number;
  readonly start: number;
  readonly end: number;
  readonly keyStart: number;
}

/** A colored byte range, in absolute offsets of the document. */
export interface PaintSpan {
  readonly from: number;
  readonly to: number;
  readonly kind: SourceTokenKind;
  readonly depth: number;
  readonly container: SourceContainerKind;
}

export interface PaintInput {
  /** Bytes of the document starting at `base`; they cover `[base, to)` and a little before `from`. */
  readonly bytes: Uint8Array;
  readonly base: number;
  /** The range to color. */
  readonly from: number;
  readonly to: number;
  /** The tokens that contain `from`, outermost first. */
  readonly chain: ReadonlyArray<PaintToken>;
  /** The tokens after `from`, in document order, up to `to`. */
  readonly tokens: ReadonlyArray<PaintToken>;
}

const U = 0x75;
const isWhitespace = (byte: number) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigitOrMinus = (byte: number) => (byte >= 0x30 && byte <= 0x39) || byte === 0x2d;

export function paintJson(input: PaintInput): PaintSpan[] {
  const { bytes, base, from, to } = input;
  const spans: PaintSpan[] = [];
  const top = base + bytes.length;
  const byteAt = (at: number) => bytes[at - base] as number;
  // Containers enclosing the position: true for an object, false for an array.
  const stack: boolean[] = [];
  let objects = 0;
  let pos = from;

  const container = (): SourceContainerKind =>
    stack.length === 0 ? "root" : stack[stack.length - 1] ? "object" : "array";
  const parentContainer = (): SourceContainerKind =>
    stack.length < 2 ? "root" : stack[stack.length - 2] ? "object" : "array";

  const emit = (
    a: number,
    b: number,
    kind: SourceTokenKind,
    depth: number,
    where: SourceContainerKind,
  ) => {
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (lo >= hi) return;
    const last = spans[spans.length - 1];
    if (
      last !== undefined &&
      last.to === lo &&
      last.kind === kind &&
      last.depth === depth &&
      last.container === where &&
      kind !== "brace" &&
      kind !== "bracket" &&
      kind !== "comma" &&
      kind !== "colon"
    ) {
      spans[spans.length - 1] = { ...last, to: hi };
      return;
    }
    spans.push({ from: lo, to: hi, kind, depth, container: where });
  };

  const open = (at: number, isObject: boolean) => {
    if (isObject) {
      emit(at, at + 1, "brace", objects + 1, container());
      objects += 1;
    } else {
      emit(at, at + 1, "bracket", objects, container());
    }
    stack.push(isObject);
  };

  const close = (at: number) => {
    const isObject = stack.length > 0 && stack[stack.length - 1] === true;
    if (isObject) {
      emit(at, at + 1, "brace", objects, parentContainer());
      objects -= 1;
    } else {
      emit(at, at + 1, "bracket", objects, parentContainer());
    }
    stack.pop();
  };

  /**
   * Quotes, escapes and body of the string whose opening quote is at `start`.
   * `end` is the offset just past its closing quote, or -1 when the index does
   * not say (a key): the closing quote is then found in the bytes. Returns the
   * offset just past the string, or where reading stopped at the range's end.
   */
  const paintString = (
    start: number,
    end: number,
    isKey: boolean,
    depth: number,
    where: SourceContainerKind,
  ): number => {
    const body: SourceTokenKind = isKey ? "key" : "string";
    const quote: SourceTokenKind = isKey ? "keyQuote" : "stringQuote";
    const known = end >= 0;
    // Start where the bytes begin if the string opened before them; step back to a
    // byte that follows a non-backslash so escape pairing is right from there.
    let p = start + 1;
    if (p < from) {
      p = Math.max(from - 64, base, p);
      while (p > Math.max(start + 1, base) && byteAt(p - 1) === BACKSLASH) p -= 1;
    }
    if (start >= base) emit(start, start + 1, quote, depth, where);
    const limit = Math.min(known ? end - 1 : top, to, top);
    while (p < limit) {
      if (byteAt(p) === BACKSLASH) {
        const length = p + 1 < top && byteAt(p + 1) === U ? 6 : 2;
        const escapeEnd = Math.min(p + length, known ? end - 1 : top);
        emit(p, escapeEnd, "escape", depth, where);
        p = escapeEnd;
        continue;
      }
      if (!known && byteAt(p) === QUOTE) {
        emit(p, p + 1, quote, depth, where);
        return p + 1;
      }
      let q = p + 1;
      while (q < limit) {
        const next = byteAt(q);
        if (next === BACKSLASH || (!known && next === QUOTE)) break;
        q += 1;
      }
      emit(p, q, body, depth, where);
      p = q;
    }
    if (known) {
      emit(end - 1, end, quote, depth, where);
      return end;
    }
    return p;
  };

  /** Punctuation, whitespace and anything unindexed in `[a, b)`. */
  const gap = (a: number, b: number) => {
    let p = Math.max(a, from);
    const limit = Math.min(b, to);
    while (p < limit) {
      const byte = byteAt(p);
      if (isWhitespace(byte)) {
        let q = p + 1;
        while (q < limit && isWhitespace(byteAt(q))) q += 1;
        emit(p, q, "whitespace", 0, container());
        p = q;
      } else if (byte === COMMA) {
        emit(p, p + 1, "comma", objects, container());
        p += 1;
      } else if (byte === COLON) {
        emit(p, p + 1, "colon", objects, "object");
        p += 1;
      } else if (byte === OBJ_CLOSE || byte === ARR_CLOSE) {
        close(p);
        p += 1;
      } else if (byte === OBJ_OPEN || byte === ARR_OPEN) {
        open(p, byte === OBJ_OPEN);
        p += 1;
      } else if (byte === QUOTE) {
        // A string the index does not hold: read to its closing quote.
        p = paintString(p, -1, container() === "object", objects, container());
      } else {
        let q = p + 1;
        while (q < limit) {
          const next = byteAt(q);
          if (
            isWhitespace(next) ||
            next === COMMA ||
            next === COLON ||
            next === OBJ_CLOSE ||
            next === ARR_CLOSE
          ) {
            break;
          }
          q += 1;
        }
        emit(p, q, isDigitOrMinus(byte) ? "number" : "literal", objects, container());
        p = q;
      }
    }
    return limit;
  };

  const scalar = (token: PaintToken, isKey: boolean) => {
    if (token.kind === KIND_STRING) {
      paintString(token.start, token.end, isKey, objects, container());
      return;
    }
    // Numbers are one kind; true, false and null are literals.
    const kind: SourceTokenKind = isDigitOrMinus(byteAt(token.start)) ? "number" : "literal";
    emit(token.start, token.end, kind, objects, container());
  };

  const enter = (token: PaintToken) => {
    open(token.start, token.kind === KIND_OBJECT);
    pos = token.start + 1;
  };

  // Seed the stack with the containers that already hold `from`.
  const deepest = input.chain[input.chain.length - 1];
  for (const token of input.chain) {
    if (!isContainer(token.kind)) continue;
    if (token.start >= from) {
      // The container opens exactly at the start of the range.
      enter(token);
    } else {
      stack.push(token.kind === KIND_OBJECT);
      if (token.kind === KIND_OBJECT) objects += 1;
    }
  }
  if (deepest !== undefined && !isContainer(deepest.kind)) {
    // The range begins inside a scalar. Its key (if any) lies before it.
    scalar(deepest, false);
    pos = deepest.end;
  } else if (deepest !== undefined && deepest.start >= from) {
    pos = deepest.start + 1;
  }

  for (const token of input.tokens) {
    const hasKey = token.keyStart >= 0;
    const region = hasKey ? token.keyStart : token.start;
    if (region >= to) break;
    if (pos < region) pos = gap(pos, region);
    if (hasKey) {
      const keyEnd = paintString(token.keyStart, -1, true, objects, "object");
      pos = Math.max(pos, keyEnd);
      if (pos < token.start) pos = gap(pos, token.start);
    }
    if (isContainer(token.kind)) {
      enter(token);
    } else {
      scalar(token, false);
      pos = Math.max(pos, token.end);
    }
  }
  if (pos < to) gap(pos, to);
  return spans;
}
