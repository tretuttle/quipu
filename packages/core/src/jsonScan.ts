/**
 * Byte-level JSON checks for format detection: a prefix validator
 * that says whether a head is the start of valid JSON, a complete value, or not
 * JSON at all, and a re-indenter that never parses values. Both are bounded by
 * the bytes they are given and never allocate per depth: nesting is a bit stack
 * capped at {@link MAX_SCAN_DEPTH}, which a head of 4 KiB cannot exceed anyway.
 */

const MAX_SCAN_DEPTH = 256;

const WS_BYTE = new Uint8Array(256);
WS_BYTE[0x20] = 1;
WS_BYTE[0x09] = 1;
WS_BYTE[0x0a] = 1;
WS_BYTE[0x0d] = 1;

const isWs = (byte: number) => WS_BYTE[byte] === 1;

/** The bytes that may follow a backslash other than `u`: " \ / b f n r t */
const ESCAPE_BYTE = new Uint8Array(256);
for (const byte of [0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]) ESCAPE_BYTE[byte] = 1;
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const isHex = (byte: number) =>
  isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);

export type JsonScanStatus =
  /** One complete value, then only whitespace. */
  | "complete"
  /** Valid so far; the input ends inside a token or before the value closes. */
  | "prefix"
  | "invalid";

export interface JsonScan {
  readonly status: JsonScanStatus;
  /** Bytes consumed: the end of the value for `complete`, the offending byte for `invalid`. */
  readonly end: number;
}

const INVALID = (end: number): JsonScan => ({ status: "invalid", end });

const LITERALS: ReadonlyArray<Uint8Array> = [
  Uint8Array.of(0x74, 0x72, 0x75, 0x65),
  Uint8Array.of(0x66, 0x61, 0x6c, 0x73, 0x65),
  Uint8Array.of(0x6e, 0x75, 0x6c, 0x6c),
];

/** Grammar states of the pushdown automaton. */
const VALUE = 0; // a value is expected
const VALUE_OR_END = 1; // just after `[`: a value or `]`
const KEY_OR_END = 2; // just after `{`: a key or `}`
const KEY = 3; // after `,` in an object
const COLON = 4;
const AFTER = 5; // a value just ended

/**
 * Scans `bytes[from, to)` as one JSON value. Strings are checked for control
 * bytes and escapes, numbers against the JSON grammar, literals against
 * true/false/null; nothing is decoded. Containers deeper than
 * {@link MAX_SCAN_DEPTH} are called a valid prefix and the scan stops there.
 */
export const scanJson = (bytes: Uint8Array, from = 0, to = bytes.length): JsonScan => {
  // 1 bit per level: 1 = object, 0 = array.
  const isObject = new Uint8Array(MAX_SCAN_DEPTH);
  let depth = 0;
  let state = VALUE;
  let i = from;
  while (i < to) {
    const byte = bytes[i] as number;
    if (isWs(byte)) {
      i++;
      continue;
    }
    switch (state) {
      case VALUE:
      case VALUE_OR_END:
      case KEY_OR_END:
      case KEY: {
        if (state === VALUE_OR_END && byte === 0x5d) {
          depth--;
          i++;
          state = AFTER;
          if (depth === 0) return finish(bytes, i, to);
          continue;
        }
        if (state === KEY_OR_END && byte === 0x7d) {
          depth--;
          i++;
          state = AFTER;
          if (depth === 0) return finish(bytes, i, to);
          continue;
        }
        if (state === KEY_OR_END || state === KEY) {
          if (byte !== 0x22) return INVALID(i);
          const end = scanString(bytes, i, to);
          if (end < 0) return end === -2 ? INVALID(i) : { status: "prefix", end: to };
          i = end;
          state = COLON;
          continue;
        }
        // A value.
        if (byte === 0x7b || byte === 0x5b) {
          if (depth >= MAX_SCAN_DEPTH) return { status: "prefix", end: to };
          isObject[depth++] = byte === 0x7b ? 1 : 0;
          i++;
          state = byte === 0x7b ? KEY_OR_END : VALUE_OR_END;
          continue;
        }
        if (byte === 0x22) {
          const end = scanString(bytes, i, to);
          if (end < 0) return end === -2 ? INVALID(i) : { status: "prefix", end: to };
          i = end;
        } else {
          const end = scanScalar(bytes, i, to);
          if (end < 0) return end === -2 ? INVALID(i) : { status: "prefix", end: to };
          i = end;
        }
        state = AFTER;
        if (depth === 0) return finish(bytes, i, to);
        continue;
      }
      case COLON:
        if (byte !== 0x3a) return INVALID(i);
        i++;
        state = VALUE;
        continue;
      case AFTER: {
        const object = isObject[depth - 1] === 1;
        if (byte === 0x2c) {
          i++;
          state = object ? KEY : VALUE;
          continue;
        }
        if (byte === (object ? 0x7d : 0x5d)) {
          depth--;
          i++;
          if (depth === 0) return finish(bytes, i, to);
          continue;
        }
        return INVALID(i);
      }
    }
  }
  return { status: "prefix", end: to };
};

/** After the root value: only whitespace may follow. */
const finish = (bytes: Uint8Array, at: number, to: number): JsonScan => {
  for (let i = at; i < to; i++) if (!isWs(bytes[i] as number)) return INVALID(i);
  return { status: "complete", end: at };
};

/**
 * End (exclusive) of the string opening at `at`; -1 when the input ends inside
 * it (still a valid prefix), -2 when it is malformed.
 */
const scanString = (bytes: Uint8Array, at: number, to: number): number => {
  let i = at + 1;
  while (i < to) {
    const byte = bytes[i] as number;
    if (byte === 0x22) return i + 1;
    if (byte < 0x20) return -2;
    if (byte === 0x5c) {
      if (i + 1 >= to) return -1;
      const next = bytes[i + 1] as number;
      if (next === 0x75) {
        for (let k = 2; k <= 5; k++) {
          if (i + k >= to) return -1;
          if (!isHex(bytes[i + k] as number)) return -2;
        }
        i += 6;
        continue;
      }
      // " \ / b f n r t
      if (!ESCAPE_BYTE[next]) return -2;
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
};

/** End of the number or literal at `at`; -1 for a prefix, -2 malformed. */
const scanScalar = (bytes: Uint8Array, at: number, to: number): number => {
  const first = bytes[at] as number;
  if (first === 0x74 || first === 0x66 || first === 0x6e) {
    const word = LITERALS[first === 0x74 ? 0 : first === 0x66 ? 1 : 2] as Uint8Array;
    for (let k = 0; k < word.length; k++) {
      if (at + k >= to) return -1;
      if (bytes[at + k] !== word[k]) return -2;
    }
    const end = at + word.length;
    return end < to && isNameByte(bytes[end] as number) ? -2 : end;
  }
  let i = at;
  if (bytes[i] === 0x2d) i++;
  if (i >= to) return -1;
  if (bytes[i] === 0x30) i++;
  else if (isDigit(bytes[i] as number)) while (i < to && isDigit(bytes[i] as number)) i++;
  else return -2;
  if (i < to && bytes[i] === 0x2e) {
    i++;
    if (i >= to) return -1;
    if (!isDigit(bytes[i] as number)) return -2;
    while (i < to && isDigit(bytes[i] as number)) i++;
  }
  if (i < to && (bytes[i] === 0x65 || bytes[i] === 0x45)) {
    i++;
    if (i < to && (bytes[i] === 0x2b || bytes[i] === 0x2d)) i++;
    if (i >= to) return -1;
    if (!isDigit(bytes[i] as number)) return -2;
    while (i < to && isDigit(bytes[i] as number)) i++;
  }
  // A number that ends the input may continue; one followed by a name byte is not a number.
  if (i < to && isNameByte(bytes[i] as number)) return -2;
  return i >= to ? -1 : i;
};

const isNameByte = (byte: number) =>
  isDigit(byte) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2e ||
  byte === 0x2b ||
  byte === 0x2d ||
  byte === 0x5f;

/** Indentation depth {@link prettyJson} keeps; deeper levels stay on the line they open on. */
const PRETTY_MAX_DEPTH = 32;

/**
 * Re-indents JSON text (two spaces) without parsing values: whitespace outside
 * strings is dropped and rebuilt, strings and numbers are copied byte for byte.
 * It tolerates a prefix (a truncated head prints what it has) and returns the
 * input untouched when it is not JSON-shaped. Output is at most about
 * `bytes.length × (1 + 2 × PRETTY_MAX_DEPTH / 2)` in the worst case and is
 * clamped to `maxOutput` bytes.
 */
export const prettyJson = (bytes: Uint8Array, maxOutput = bytes.length * 4 + 64): Uint8Array => {
  const out = new Uint8Array(Math.min(maxOutput, bytes.length * 4 + 64));
  let o = 0;
  let depth = 0;
  let i = 0;
  const put = (byte: number) => {
    if (o < out.length) out[o++] = byte;
  };
  const newline = (level: number) => {
    put(0x0a);
    const spaces = Math.min(level, PRETTY_MAX_DEPTH) * 2;
    for (let s = 0; s < spaces; s++) put(0x20);
  };
  let pendingOpen = -1;
  while (i < bytes.length && o < out.length) {
    const byte = bytes[i] as number;
    if (isWs(byte)) {
      i++;
      continue;
    }
    if (byte === 0x22) {
      if (pendingOpen >= 0) {
        newline(depth);
        pendingOpen = -1;
      }
      const start = i;
      i++;
      while (i < bytes.length) {
        const c = bytes[i] as number;
        if (c === 0x5c) i += 2;
        else if (c === 0x22) {
          i++;
          break;
        } else i++;
      }
      for (let k = start; k < Math.min(i, bytes.length); k++) put(bytes[k] as number);
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (pendingOpen >= 0) {
        newline(depth);
      }
      put(byte);
      depth++;
      pendingOpen = byte;
      i++;
      continue;
    }
    if (byte === 0x7d || byte === 0x5d) {
      depth = Math.max(0, depth - 1);
      if (pendingOpen >= 0) {
        // `{}` and `[]` stay compact.
        pendingOpen = -1;
      } else {
        newline(depth);
      }
      put(byte);
      i++;
      continue;
    }
    if (byte === 0x2c) {
      put(byte);
      newline(depth);
      i++;
      continue;
    }
    if (byte === 0x3a) {
      put(byte);
      put(0x20);
      i++;
      continue;
    }
    if (pendingOpen >= 0) {
      newline(depth);
      pendingOpen = -1;
    }
    put(byte);
    i++;
  }
  return out.slice(0, o);
};
