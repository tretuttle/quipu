/**
 * `application/x-www-form-urlencoded` bodies: pairs split on `&`, names and
 * values percent-decoded with `+` as a space. A sequence that is not valid
 * percent-encoding stays literal, as browsers do.
 */
import { decodeUtf8 } from "./boundedSlice.ts";
import { asciiBytes, concatBytes, jsonStringBytes } from "./jsonText.ts";

/** A form body above this is shown as plain text. */
export const MAX_FORM_BYTES = 8 * 1024 * 1024;

export interface FormField {
  readonly name: string;
  readonly value: string;
}

const hex = (byte: number) =>
  byte >= 0x30 && byte <= 0x39
    ? byte - 0x30
    : (byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x66
      ? (byte | 0x20) - 0x61 + 10
      : -1;

/** Percent-decodes `bytes[from, to)` to raw bytes; `+` is a space. */
const percentDecode = (bytes: Uint8Array, from: number, to: number): Uint8Array => {
  const out = new Uint8Array(to - from);
  let o = 0;
  for (let i = from; i < to; i++) {
    const byte = bytes[i] as number;
    if (byte === 0x2b) out[o++] = 0x20;
    else if (
      byte === 0x25 &&
      i + 2 < to &&
      hex(bytes[i + 1] as number) >= 0 &&
      hex(bytes[i + 2] as number) >= 0
    ) {
      out[o++] = (hex(bytes[i + 1] as number) << 4) | hex(bytes[i + 2] as number);
      i += 2;
    } else out[o++] = byte;
  }
  return out.subarray(0, o);
};

interface RawPair {
  readonly name: Uint8Array;
  readonly value: Uint8Array;
}

const rawPairs = (bytes: Uint8Array, maxPairs: number): { pairs: RawPair[]; total: number } => {
  const pairs: RawPair[] = [];
  let total = 0;
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0x26) continue;
    if (i > start) {
      total++;
      if (pairs.length < maxPairs) {
        let eq = start;
        while (eq < i && bytes[eq] !== 0x3d) eq++;
        pairs.push({
          name: percentDecode(bytes, start, eq),
          value: eq < i ? percentDecode(bytes, eq + 1, i) : new Uint8Array(0),
        });
      }
    }
    start = i + 1;
  }
  return { pairs, total };
};

/** The first `maxFields` fields as strings, and how many the body has. */
export const parseForm = (
  bytes: Uint8Array,
  maxFields = 200,
): { fields: FormField[]; total: number } => {
  const { pairs, total } = rawPairs(bytes, maxFields);
  return {
    fields: pairs.map((p) => ({ name: decodeUtf8(p.name), value: decodeUtf8(p.value) })),
    total,
  };
};

/**
 * The body as a JSON object, in order, repeats kept (`a=1&a=2` is two `a`
 * members): the child document the tree shows. Values are strings, as sent.
 */
export const formToJson = (bytes: Uint8Array): Uint8Array => {
  const { pairs } = rawPairs(bytes, Number.POSITIVE_INFINITY);
  const parts: Uint8Array[] = [asciiBytes("{")];
  pairs.forEach((pair, index) => {
    if (index > 0) parts.push(asciiBytes(","));
    parts.push(jsonStringBytes(pair.name), asciiBytes(":"), jsonStringBytes(pair.value));
  });
  parts.push(asciiBytes("}"));
  return concatBytes(parts);
};
