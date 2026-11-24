/**
 * CSV field rules shared by the tape adapter and the converters. One rule makes
 * chunk boundaries resolvable by counting: a double quote toggles quoted state
 * wherever it appears, and a quote inside a quoted field is written doubled. The
 * state at any byte is therefore the parity of the quotes before it, so a
 * region's entry state is a prefix sum and no region is ever rescanned.
 */
export const QUOTE = 0x22;
export const LF = 0x0a;
export const CR = 0x0d;
export const BOM = [0xef, 0xbb, 0xbf] as const;

/** Bytes of UTF-8 byte-order mark at the start of `bytes`. */
export const bomLength = (bytes: Uint8Array) =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

/**
 * The end (exclusive) of the field starting at `start`: the first delimiter or
 * line break outside quotes, or `bytes.length`. A trailing CR before the LF is
 * not part of the field.
 */
export const fieldEnd = (bytes: Uint8Array, start: number, delimiter: number): number => {
  let inQuote = false;
  const n = bytes.length;
  for (let i = start; i < n; i++) {
    const b = bytes[i] as number;
    if (b === QUOTE) inQuote = !inQuote;
    else if (!inQuote) {
      if (b === delimiter) return i;
      if (b === LF) return i > start && bytes[i - 1] === CR ? i - 1 : i;
    }
  }
  return n;
};

/**
 * The text of the field `bytes[start, end)` as UTF-8: quotes removed and doubled
 * quotes collapsed. `out` must hold `end - start` bytes; returns the length.
 */
export const decodeFieldInto = (
  bytes: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
): number => {
  let o = 0;
  let inQuote = false;
  for (let i = start; i < end; i++) {
    const b = bytes[i] as number;
    if (b === QUOTE) {
      if (inQuote && i + 1 < end && bytes[i + 1] === QUOTE) {
        out[o++] = QUOTE;
        i++;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    out[o++] = b;
  }
  return o;
};
