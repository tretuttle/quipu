/**
 * NDJSON / JSON Lines bodies. The tree shows a body of
 * lines as an array: each non-empty line is an element, and one that is not a
 * JSON value is carried as a string so the document always indexes.
 */
import { asciiBytes, concatBytes, jsonStringBytes } from "./jsonText.ts";
import { scanJson } from "./jsonScan.ts";

const isSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0d;

/** Byte ranges of the non-empty lines of `bytes`, whitespace trimmed. */
export const splitLines = (bytes: Uint8Array, maxLines = Number.POSITIVE_INFINITY) => {
  const lines: Array<readonly [number, number]> = [];
  let total = 0;
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x0a) continue;
    let from = start;
    let to = i;
    while (from < to && isSpace(bytes[from] as number)) from++;
    while (to > from && isSpace(bytes[to - 1] as number)) to--;
    if (to > from) {
      total++;
      if (lines.length < maxLines) lines.push([from, to]);
    }
    start = i + 1;
  }
  return { lines, total };
};

/** `[line, line, …]` for a body of JSON lines, and the number of lines. */
export const ndjsonToArray = (bytes: Uint8Array): { bytes: Uint8Array; lines: number } => {
  const { lines } = splitLines(bytes);
  const parts: Uint8Array[] = [asciiBytes("[")];
  lines.forEach(([from, to], index) => {
    if (index > 0) parts.push(asciiBytes(","));
    const line = bytes.subarray(from, to);
    parts.push(scanJson(line).status === "complete" ? line : jsonStringBytes(line));
  });
  parts.push(asciiBytes("]"));
  return { bytes: concatBytes(parts), lines: lines.length };
};
