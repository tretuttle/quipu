/**
 * Lazy decoding of XML tape tokens: names, attribute values, text and CDATA. The
 * tape holds raw byte ranges; entities are resolved here, when a value is shown
 * or converted, from a slice that is already bounded.
 */
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { MAX_KEY_BYTES } from "@quipu/core/decode";

const AMP = 0x26;
const SEMI = 0x3b;
const HASH = 0x23;

const WS = new Uint8Array(256);
WS[0x20] = WS[0x09] = WS[0x0a] = WS[0x0d] = 1;

/** End of the name starting at `at` (an element name after `<`, or an attribute name). */
export const nameEnd = (bytes: Uint8Array, at: number) => {
  let i = at;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (WS[b] === 1 || b === 0x3d || b === 0x3e || b === 0x2f) break;
    i++;
  }
  return i;
};

const writeCodePoint = (out: Uint8Array, o: number, code: number) => {
  if (code < 0x80) out[o++] = code;
  else if (code < 0x800) {
    out[o++] = 0xc0 | (code >> 6);
    out[o++] = 0x80 | (code & 0x3f);
  } else if (code < 0x10000) {
    out[o++] = 0xe0 | (code >> 12);
    out[o++] = 0x80 | ((code >> 6) & 0x3f);
    out[o++] = 0x80 | (code & 0x3f);
  } else {
    out[o++] = 0xf0 | (code >> 18);
    out[o++] = 0x80 | ((code >> 12) & 0x3f);
    out[o++] = 0x80 | ((code >> 6) & 0x3f);
    out[o++] = 0x80 | (code & 0x3f);
  }
  return o;
};

const NAMED: ReadonlyArray<readonly [string, number]> = [
  ["amp", 0x26],
  ["lt", 0x3c],
  ["gt", 0x3e],
  ["quot", 0x22],
  ["apos", 0x27],
];

/**
 * Resolves the predefined and numeric character references in `bytes[from, to)`
 * into `out` (which must hold `to - from` bytes) and returns the length. An
 * entity this does not know (one a DTD declared) is kept as written.
 */
export const unescapeXml = (
  bytes: Uint8Array,
  from: number,
  to: number,
  out: Uint8Array,
): number => {
  let o = 0;
  let i = from;
  while (i < to) {
    let amp = bytes.indexOf(AMP, i);
    if (amp < 0 || amp >= to) amp = to;
    if (amp > i) {
      out.set(bytes.subarray(i, amp), o);
      o += amp - i;
      i = amp;
      if (i >= to) break;
    }
    // At '&'.
    let semi = bytes.indexOf(SEMI, i + 1);
    if (semi < 0 || semi >= to || semi - i > 12) {
      out[o++] = AMP;
      i++;
      continue;
    }
    let code = -1;
    if (bytes[i + 1] === HASH) {
      const hex = bytes[i + 2] === 0x78 || bytes[i + 2] === 0x58;
      let v = 0;
      let ok = semi > i + (hex ? 3 : 2);
      for (let k = i + (hex ? 3 : 2); k < semi && ok; k++) {
        const c = bytes[k] as number;
        const d =
          c >= 0x30 && c <= 0x39
            ? c - 0x30
            : hex && (c | 0x20) >= 0x61 && (c | 0x20) <= 0x66
              ? (c | 0x20) - 0x61 + 10
              : -1;
        if (d < 0) ok = false;
        else v = v * (hex ? 16 : 10) + d;
      }
      if (ok && v >= 0 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) code = v;
    } else {
      const len = semi - i - 1;
      for (const [name, value] of NAMED) {
        if (name.length !== len) continue;
        let ok = true;
        for (let k = 0; k < len; k++) if (bytes[i + 1 + k] !== name.charCodeAt(k)) ok = false;
        if (ok) {
          code = value;
          break;
        }
      }
    }
    if (code < 0) {
      out[o++] = AMP;
      i++;
      continue;
    }
    o = writeCodePoint(out, o, code);
    i = semi + 1;
    semi = 0;
  }
  return o;
};

const CDATA_OPEN = 9;
const isCdata = (bytes: Uint8Array, start: number) =>
  bytes[start] === 0x3c &&
  bytes[start + 1] === 0x21 &&
  bytes[start + 2] === 0x5b &&
  bytes[start + 3] === 0x43;

/** The text of a text token (entities resolved) or CDATA token (unwrapped), as UTF-8 bytes. */
export const textBytes = (bytes: Uint8Array, start: number, end: number): Uint8Array => {
  if (isCdata(bytes, start))
    return bytes.slice(start + CDATA_OPEN, Math.max(start + CDATA_OPEN, end - 3));
  const out = new Uint8Array(end - start);
  return out.subarray(0, unescapeXml(bytes, start, end, out));
};

/** An attribute value token: quotes removed, entities resolved. */
export const attributeBytes = (bytes: Uint8Array, start: number, end: number): Uint8Array => {
  const quoted = bytes[start] === 0x22 || bytes[start] === 0x27;
  const from = quoted ? start + 1 : start;
  const to = quoted && end - 1 >= from && bytes[end - 1] === bytes[start] ? end - 1 : end;
  const out = new Uint8Array(Math.max(0, to - from));
  return out.subarray(0, unescapeXml(bytes, from, to, out));
};

export const decodeXmlText = (bytes: Uint8Array, start: number, end: number, limit?: number) =>
  decodeUtf8(textBytes(bytes, start, end), limit);

export const decodeXmlName = (bytes: Uint8Array, at: number) =>
  decodeUtf8(bytes.subarray(at, nameEnd(bytes, at)), MAX_KEY_BYTES);
