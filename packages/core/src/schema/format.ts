import { STRING_FORMATS, type StringFormat } from "@quipu/contracts/schema";

export { STRING_FORMATS, type StringFormat };

const isAsciiDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAsciiAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiAlnum = (c: number): boolean => isAsciiAlpha(c) || isAsciiDigit(c);
const isAsciiHex = (c: number): boolean =>
  isAsciiDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

function parseDigits(s: string, start: number, end: number): number | null {
  if (end <= start) return null;
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (!isAsciiDigit(c)) return null;
    n = n * 10 + (c - 0x30);
  }
  return n;
}

function isDate(s: string, offset = 0): boolean {
  if (s.length - offset < 10) return false;
  if (s.charCodeAt(offset + 4) !== 0x2d || s.charCodeAt(offset + 7) !== 0x2d) return false;
  const y = parseDigits(s, offset, offset + 4);
  const m = parseDigits(s, offset + 5, offset + 7);
  const d = parseDigits(s, offset + 8, offset + 10);
  if (y === null || m === null || d === null) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  let days: number;
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      days = 31;
      break;
    case 4:
    case 6:
    case 9:
    case 11:
      days = 30;
      break;
    case 2:
      days = leap ? 29 : 28;
      break;
    default:
      return false;
  }
  return d >= 1 && d <= days;
}

function isDateTime(s: string): boolean {
  if (s.length < 20 || !isDate(s, 0)) return false;
  const sep = s.charCodeAt(10);
  if (sep !== 0x54 && sep !== 0x74) return false;
  if (s.charCodeAt(13) !== 0x3a || s.charCodeAt(16) !== 0x3a) return false;
  const h = parseDigits(s, 11, 13);
  const mi = parseDigits(s, 14, 16);
  const sec = parseDigits(s, 17, 19);
  if (h === null || mi === null || sec === null) return false;
  if (h > 23 || mi > 59 || sec > 59) return false;
  let pos = 19;
  if (pos < s.length && s.charCodeAt(pos) === 0x2e) {
    pos++;
    const fracStart = pos;
    while (pos < s.length && isAsciiDigit(s.charCodeAt(pos))) pos++;
    if (pos === fracStart) return false;
  }
  const rem = s.length - pos;
  if (rem === 1) {
    const z = s.charCodeAt(pos);
    return z === 0x5a || z === 0x7a;
  }
  if (rem === 6) {
    const sign = s.charCodeAt(pos);
    if ((sign !== 0x2b && sign !== 0x2d) || s.charCodeAt(pos + 3) !== 0x3a) return false;
    const zh = parseDigits(s, pos + 1, pos + 3);
    const zm = parseDigits(s, pos + 4, pos + 6);
    return zh !== null && zm !== null && zh <= 23 && zm <= 59;
  }
  return false;
}

function isUuid(s: string): boolean {
  if (s.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const c = s.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 0x2d) return false;
    } else if (!isAsciiHex(c)) {
      return false;
    }
  }
  return true;
}

const EMAIL_LOCAL_SPECIAL = new Set([..."!#$%&'*+/=?^_`{|}~-"].map((ch) => ch.charCodeAt(0)));

function isDotted(s: string, ok: (c: number) => boolean): boolean {
  if (s.length === 0) return false;
  let labelLen = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2e) {
      if (labelLen === 0) return false;
      labelLen = 0;
    } else {
      if (!ok(c)) return false;
      labelLen++;
    }
  }
  return labelLen > 0;
}

function isEmail(s: string): boolean {
  const at = s.indexOf("@");
  if (at <= 0 || at === s.length - 1) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64) return false;
  if (!isDotted(local, (c) => isAsciiAlnum(c) || EMAIL_LOCAL_SPECIAL.has(c))) return false;
  if (!domain.includes(".") || domain.includes("--")) return false;
  if (!isDotted(domain, (c) => isAsciiAlnum(c) || c === 0x2d)) return false;
  for (const label of domain.split(".")) {
    if (label.length > 63 || label.startsWith("-") || label.endsWith("-")) return false;
  }
  return true;
}

const URI_SCHEME_EXTRA = new Set([0x2b, 0x2d, 0x2e]);
const URI_PATH_SAFE = new Set([..."-._~:/?@!$&'()*+,;="].map((ch) => ch.charCodeAt(0)));

function isUri(s: string): boolean {
  const colon = s.indexOf(":");
  if (colon <= 0) return false;
  if (!isAsciiAlpha(s.charCodeAt(0))) return false;
  for (let i = 1; i < colon; i++) {
    const c = s.charCodeAt(i);
    if (!isAsciiAlnum(c) && !URI_SCHEME_EXTRA.has(c)) return false;
  }
  const restStart = colon + 1;
  if (
    s.length - restStart < 3 ||
    s.charCodeAt(restStart) !== 0x2f ||
    s.charCodeAt(restStart + 1) !== 0x2f
  ) {
    return false;
  }
  let hostEnd = s.length;
  for (let i = restStart + 2; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2f || c === 0x3f || c === 0x23) {
      hostEnd = i;
      break;
    }
  }
  let authority = s.slice(restStart + 2, hostEnd);
  const atPos = authority.lastIndexOf("@");
  if (atPos >= 0) authority = authority.slice(atPos + 1);
  const portColon = authority.indexOf(":");
  const host = portColon >= 0 ? authority.slice(0, portColon) : authority;
  const port = portColon >= 0 ? authority.slice(portColon + 1) : null;
  for (const label of host.split(".")) {
    if (label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      return false;
    }
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (!isAsciiAlnum(c) && c !== 0x2d) return false;
    }
  }
  if (port !== null) {
    if (port.length === 0 || port.length > 5) return false;
    for (let i = 0; i < port.length; i++) {
      if (!isAsciiDigit(port.charCodeAt(i))) return false;
    }
  }
  let fragment = false;
  let i = hostEnd;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      if (
        i + 2 >= s.length ||
        !isAsciiHex(s.charCodeAt(i + 1)) ||
        !isAsciiHex(s.charCodeAt(i + 2))
      ) {
        return false;
      }
      i += 3;
      continue;
    }
    if (c === 0x23) {
      if (fragment) return false;
      fragment = true;
    } else if (!isAsciiAlnum(c) && !URI_PATH_SAFE.has(c)) {
      return false;
    }
    i++;
  }
  return true;
}

/** Detects one of the 5 JSON Schema string formats (all pure ASCII). */
export function detectStringFormat(s: string): StringFormat | null {
  if (s.length < 6 || s.length > 2048) return null;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) return null;
  }
  const first = s.charCodeAt(0);
  if (isAsciiDigit(first)) {
    if (s.length === 10 && isDate(s)) return "date";
    if (isDateTime(s)) return "date-time";
  }
  if (isUuid(s)) return "uuid";
  if (isEmail(s)) return "email";
  if (isUri(s)) return "uri";
  return null;
}

function matchesStringFormat(format: StringFormat, s: string): boolean {
  return detectStringFormat(s) === format;
}
