import { BACKSLASH, QUOTE } from "@quipu/core/bytes";

// indexOf has no end bound; the next backslash is memoized per byte array so a
// document with few escapes does not rescan the window for every string
// (docs/internals/document-engine.md, "Native scans with memoized cursors").
let memoBytes: Uint8Array | null = null;
let memoFrom = 0;
let memoBackslash = 0;

const nextBackslash = (bytes: Uint8Array, from: number) => {
  if (bytes !== memoBytes || from < memoFrom || from > memoBackslash) {
    memoBytes = bytes;
    memoFrom = from;
    const at = bytes.indexOf(BACKSLASH, from);
    memoBackslash = at < 0 ? bytes.length : at;
  }
  return memoBackslash;
};

/** Forgets the memo; call when a buffer is reused with new contents. */
export const resetStringEndMemo = () => {
  memoBytes = null;
};

/**
 * The end (exclusive) of the string whose opening quote sits before `from`, or
 * -1 when it runs past `bytes`. Escapes are resolved by pair skipping.
 */
export const scanStringEnd = (bytes: Uint8Array, from: number): number => {
  const n = bytes.length;
  let j = from;
  while (j < n) {
    const q = bytes.indexOf(QUOTE, j);
    if (q < 0) return -1;
    let k = nextBackslash(bytes, j);
    if (k > q) return q + 1;
    while (k < q) {
      if (bytes[k] === BACKSLASH) k += 2;
      else {
        const next = nextBackslash(bytes, k);
        if (next > q) {
          k = q;
          break;
        }
        k = next;
      }
    }
    if (k === q) return q + 1;
    j = k;
  }
  return -1;
};
