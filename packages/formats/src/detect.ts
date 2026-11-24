/**
 * Format auto-detection from a bounded prefix of bytes. It never throws and never
 * refuses: whatever it cannot place is `text`, which opens with search.
 * Nothing here decodes the prefix to a string; every
 * decision is made on bytes, so it is the same on a 2 GiB file and a 2 KiB one.
 *
 * Order matters and is the rule the tests pin: BOM and binary check, then a JSON
 * probe (JSON, JSONC, HAR, NDJSON), then XML, then line-shape scoring for TOML and
 * YAML, then delimiter sniffing for CSV/TSV, then the extension as a hint, then text.
 */
import type { FormatId } from "./formatIds.ts";

/** How much of a file detection reads. */
export const DETECT_PREFIX_BYTES = 64 * 1024;

export type Confidence = "high" | "medium" | "low";

export interface Detection {
  readonly format: FormatId;
  /** The delimiter byte for csv and tsv, else 0. */
  readonly delimiter: number;
  readonly confidence: Confidence;
  /** Which rule fired; stable strings the tests pin. */
  readonly reason: string;
  /** Bytes of BOM at the start of the file (0 or 3). */
  readonly bomBytes: number;
}

export interface DetectHint {
  /** The file name, used only as a tie-breaker when the bytes say nothing. */
  readonly name?: string;
  /** True when `prefix` is shorter than the file, so a value cut at its end is not an error. */
  readonly truncated?: boolean;
}

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const APOS = 0x27;
const HASH = 0x23;
const COMMA = 0x2c;
const MINUS = 0x2d;
const SLASH = 0x2f;
const COLON = 0x3a;
const EQUALS = 0x3d;
const LT = 0x3c;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const BACKSLASH = 0x5c;

const isWs = (b: number) => b === SPACE || b === TAB || b === LF || b === CR;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isAlpha = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

const result = (
  format: FormatId,
  confidence: Confidence,
  reason: string,
  bomBytes: number,
  delimiter = 0,
): Detection => ({ format, delimiter, confidence, reason, bomBytes });

const bytesEqual = (b: Uint8Array, at: number, text: string) => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

interface JsonProbe {
  /** `complete`: one value ended inside the prefix; `truncated`: the prefix ended inside it. */
  readonly status: "complete" | "truncated" | "invalid";
  /** Index just past the value (complete) or past the last byte read. */
  readonly end: number;
  readonly jsonc: boolean;
  /** `log` at the root holding `entries`, or `version` and `creator`. */
  readonly har: boolean;
  /** What the root value is, so a bare number or literal is not mistaken for a document. */
  readonly root: "container" | "string" | "scalar" | "none";
}

// Container states. Objects: 0 key-or-close, 1 colon, 2 value, 3 comma-or-close, 5 key (after a comma).
// Arrays: 0 value-or-close, 3 comma-or-close, 4 value (after a comma).
const OBJ = 1;
const ARR = 2;

/**
 * Walks one JSON value starting at `from` (comments allowed: they mark JSONC).
 * Anything that is not JSON outside a string makes it invalid, which is how
 * prose that happens to start with `[` stays text.
 */
const probeJson = (b: Uint8Array, from: number): JsonProbe => {
  const n = b.length;
  const kinds: number[] = [];
  const states: number[] = [];
  let jsonc = false;
  // HAR signals, tracked on the root object and its `log` member only.
  let rootKeyLog = false;
  let sawEntries = false;
  let sawVersion = false;
  let sawCreator = false;
  let i = from;
  let done = false;
  let root: JsonProbe["root"] = "none";

  const harKey = (level: number, start: number, end: number) => {
    // `level` is the depth of the object holding the key (1 = root).
    if (level === 1 && !rootKeyLog && end - start === 3 && bytesEqual(b, start, "log")) {
      rootKeyLog = true;
    } else if (level === 2 && rootKeyLog) {
      const len = end - start;
      if (len === 7 && bytesEqual(b, start, "entries")) sawEntries = true;
      else if (len === 7 && bytesEqual(b, start, "version")) sawVersion = true;
      else if (len === 7 && bytesEqual(b, start, "creator")) sawCreator = true;
    }
  };

  const valueDone = () => {
    const top = kinds.length - 1;
    if (top < 0) {
      done = true;
      return;
    }
    states[top] = 3;
  };

  /** Scans a string whose opening quote is at i; returns the index past it, or -1 if the prefix ends. */
  const scanString = (open: number) => {
    let j = open + 1;
    while (j < n) {
      const c = b[j] as number;
      if (c === BACKSLASH) {
        j += 2;
        continue;
      }
      if (c === QUOTE) return j + 1;
      if (c === LF || c === CR) return -2; // raw newline in a string is not JSON
      j++;
    }
    return -1;
  };

  const truncated = (): JsonProbe => ({
    status: "truncated",
    end: n,
    jsonc,
    har: sawEntries || (rootKeyLog && sawVersion && sawCreator),
    root,
  });
  const invalid = (): JsonProbe => ({ status: "invalid", end: i, jsonc, har: false, root });

  for (;;) {
    if (i >= n || done) break;
    const c = b[i] as number;
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === SLASH) {
      const d = i + 1 < n ? (b[i + 1] as number) : -1;
      if (d === SLASH) {
        jsonc = true;
        const eol = b.indexOf(LF, i);
        if (eol < 0) return truncated();
        i = eol + 1;
        continue;
      }
      if (d === 0x2a) {
        jsonc = true;
        let j = i + 2;
        let closed = false;
        while (j + 1 < n) {
          if (b[j] === 0x2a && b[j + 1] === SLASH) {
            closed = true;
            break;
          }
          j++;
        }
        if (!closed) return truncated();
        i = j + 2;
        continue;
      }
      if (d === -1) return truncated();
      return invalid();
    }
    const top = kinds.length - 1;
    const kind = top >= 0 ? (kinds[top] as number) : 0;
    const state = top >= 0 ? (states[top] as number) : 2;

    if (c === RBRACE || c === RBRACKET) {
      if (top < 0) return invalid();
      const wants = kind === OBJ ? RBRACE : RBRACKET;
      if (c !== wants) return invalid();
      if (state === 3 || state === 0) {
        // A close after a value, or of an empty container.
      } else if ((kind === OBJ && state === 5) || (kind === ARR && state === 4)) {
        jsonc = true; // trailing comma
      } else return invalid();
      kinds.pop();
      states.pop();
      valueDone();
      i++;
      continue;
    }
    if (c === COMMA) {
      if (top < 0 || state !== 3) return invalid();
      states[top] = kind === OBJ ? 5 : 4;
      i++;
      continue;
    }
    if (c === COLON) {
      if (top < 0 || kind !== OBJ || state !== 1) return invalid();
      states[top] = 2;
      i++;
      continue;
    }
    // A value or a key starts here.
    const isKeyPosition = kind === OBJ && (state === 0 || state === 5);
    const isValuePosition =
      top < 0 || (kind === OBJ && state === 2) || (kind === ARR && (state === 0 || state === 4));
    if (!isKeyPosition && !isValuePosition) return invalid();

    if (c === QUOTE) {
      const end = scanString(i);
      if (end === -1) return truncated();
      if (end === -2) return invalid();
      if (top < 0) root = "string";
      if (isKeyPosition) {
        harKey(kinds.length, i + 1, end - 1);
        states[top] = 1;
      } else valueDone();
      i = end;
      continue;
    }
    if (isKeyPosition) return invalid();
    if (c === LBRACE || c === LBRACKET) {
      if (top < 0) root = "container";
      kinds.push(c === LBRACE ? OBJ : ARR);
      states.push(0);
      i++;
      continue;
    }
    // Scalars: numbers and the three literals.
    if (top < 0) root = "scalar";
    let j = i;
    if (c === MINUS || isDigit(c)) {
      while (j < n) {
        const d = b[j] as number;
        if (isDigit(d) || d === MINUS || d === 0x2b || d === 0x2e || d === 0x65 || d === 0x45) j++;
        else break;
      }
    } else if (c === 0x74 || c === 0x66 || c === 0x6e) {
      const word = c === 0x74 ? "true" : c === 0x66 ? "false" : "null";
      if (i + word.length > n) {
        // Cut mid-literal at the end of the prefix: only a prefix of the word counts.
        for (let k = i; k < n; k++) if (b[k] !== word.charCodeAt(k - i)) return invalid();
        return truncated();
      }
      if (!bytesEqual(b, i, word)) return invalid();
      j = i + word.length;
    } else return invalid();
    if (j === n) return truncated();
    // A scalar must be followed by a delimiter, not by more letters.
    const after = b[j] as number;
    if (isAlpha(after) || after === QUOTE) return invalid();
    valueDone();
    i = j;
  }
  if (!done) return truncated();
  return {
    status: "complete",
    end: i,
    jsonc,
    har: sawEntries || (rootKeyLog && sawVersion && sawCreator),
    root,
  };
};

/** Detects JSON, JSONC, HAR and NDJSON from the first non-whitespace byte on. Null when it is not JSON. */
const detectJsonFamily = (
  b: Uint8Array,
  from: number,
  truncated: boolean,
  bom: number,
  name: string,
): Detection | null => {
  const first = b[from] as number;
  if (first !== LBRACE && first !== LBRACKET && first !== QUOTE && first !== SLASH) return null;
  const one = probeJson(b, from);
  if (one.status === "invalid" || one.root === "scalar") return null;
  if (one.status === "truncated") {
    if (!truncated && one.end >= b.length) {
      // The whole file is one cut-off value: not valid JSON, but it is still the closest reading.
      return result(
        one.har ? "har" : one.jsonc ? "jsonc" : "json",
        "low",
        "json-unterminated",
        bom,
      );
    }
    if (one.har) return result("har", "high", "har-log", bom);
    return result(one.jsonc ? "jsonc" : "json", "medium", "json-truncated", bom);
  }
  // One value is complete. What follows decides JSON versus NDJSON.
  let i = one.end;
  let newline = false;
  while (i < b.length && isWs(b[i] as number)) {
    if (b[i] === LF || b[i] === CR) newline = true;
    i++;
  }
  if (i >= b.length) {
    if (one.root === "string") return result("json", "medium", "json-string", bom);
    if (one.har) return result("har", "high", "har-log", bom);
    if (/\.(ndjson|jsonl)$/i.test(name)) return result("ndjson", "medium", "ndjson-extension", bom);
    return result(one.jsonc ? "jsonc" : "json", "high", "json-document", bom);
  }
  if (one.root === "string") return null;
  const next = b[i] as number;
  if (next === LBRACE || next === LBRACKET) {
    const second = probeJson(b, i);
    if (second.status !== "invalid") {
      const reason = newline ? "ndjson-lines" : "ndjson-concatenated";
      return result("ndjson", newline ? "high" : "medium", reason, bom);
    }
  }
  return null;
};

const isNameStart = (b: number) => isAlpha(b) || b === 0x5f || b === COLON || b >= 0x80;

const detectXml = (b: Uint8Array, from: number, bom: number): Detection | null => {
  let i = from;
  let sawProlog = false;
  // Prolog: declaration, comments, processing instructions, doctype; then the root element.
  for (let guard = 0; guard < 64 && i < b.length; guard++) {
    while (i < b.length && isWs(b[i] as number)) i++;
    if (b[i] !== LT) return null;
    if (bytesEqual(b, i, "<?xml") && (isWs(b[i + 5] ?? 0) || b[i + 5] === 0x3f)) {
      sawProlog = true;
      const end = indexOfSeq(b, "?>", i + 5);
      if (end < 0) return result("xml", "high", "xml-declaration", bom);
      i = end + 2;
      continue;
    }
    if (bytesEqual(b, i, "<!--")) {
      const end = indexOfSeq(b, "-->", i + 4);
      if (end < 0) return sawProlog ? result("xml", "medium", "xml-comment", bom) : null;
      i = end + 3;
      sawProlog = true;
      continue;
    }
    if (b[i + 1] === 0x3f) {
      const end = indexOfSeq(b, "?>", i + 2);
      if (end < 0) return null;
      i = end + 2;
      sawProlog = true;
      continue;
    }
    if (bytesEqual(b, i, "<!DOCTYPE") || bytesEqual(b, i, "<!doctype")) {
      // HTML is not XML: it opens as text.
      let j = i + 9;
      while (j < b.length && isWs(b[j] as number)) j++;
      if (bytesEqual(b, j, "html") || bytesEqual(b, j, "HTML")) return null;
      const end = b.indexOf(0x3e, i);
      if (end < 0) return result("xml", "medium", "xml-doctype", bom);
      i = end + 1;
      sawProlog = true;
      continue;
    }
    break;
  }
  if (i >= b.length) return sawProlog ? result("xml", "medium", "xml-prolog", bom) : null;
  if (b[i] !== LT || !isNameStart(b[i + 1] as number)) return null;
  // The root element: a name, then attributes or `>`; an `html` root is HTML.
  let j = i + 1;
  const nameStart = j;
  while (
    j < b.length &&
    (isNameStart(b[j] as number) || isDigit(b[j] as number) || b[j] === MINUS || b[j] === 0x2e)
  )
    j++;
  const nameLength = j - nameStart;
  if (
    nameLength === 4 &&
    (bytesEqual(b, nameStart, "html") || bytesEqual(b, nameStart, "HTML")) &&
    !sawProlog
  ) {
    return null;
  }
  if (j >= b.length) return result("xml", "low", "xml-root-cut", bom);
  const c = b[j] as number;
  if (!(isWs(c) || c === 0x3e || c === SLASH)) return null;
  if (b.indexOf(0x3e, j) < 0 && b.length < 256) return null;
  return result("xml", sawProlog ? "high" : "medium", sawProlog ? "xml-prolog" : "xml-root", bom);
};

const indexOfSeq = (b: Uint8Array, seq: string, from: number) => {
  const first = seq.charCodeAt(0);
  let i = b.indexOf(first, from);
  while (i >= 0) {
    if (bytesEqual(b, i, seq)) return i;
    i = b.indexOf(first, i + 1);
  }
  return -1;
};

interface LineScan {
  /** Non-blank, non-comment lines looked at. */
  lines: number;
  tomlTables: number;
  tomlAssignments: number;
  yamlKeys: number;
  yamlItems: number;
  yamlDocumentStart: boolean;
  yamlDirective: boolean;
  /** Lines that fit none of the shapes (prose, markup, anything). */
  other: number;
  /** Assignments whose right side is not a TOML value (dotenv, INI free text). */
  tomlBadValues: number;
}

const BARE_KEY = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) BARE_KEY[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) BARE_KEY[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) BARE_KEY[c] = 1;
BARE_KEY[0x5f] = 1;
BARE_KEY[MINUS] = 1;

/** Does a TOML value start here? Strings, numbers, booleans, arrays, inline tables, dates. */
const looksLikeTomlValue = (b: Uint8Array, i: number, end: number) => {
  if (i >= end) return false;
  const c = b[i] as number;
  if (c === QUOTE || c === APOS || c === LBRACKET || c === LBRACE) return true;
  if (c === 0x2b || c === MINUS || isDigit(c)) return true;
  if (bytesEqual(b, i, "true") || bytesEqual(b, i, "false")) return true;
  if (bytesEqual(b, i, "inf") || bytesEqual(b, i, "nan")) return true;
  return false;
};

const scanLines = (b: Uint8Array, from: number, maxLines: number): LineScan => {
  const scan: LineScan = {
    lines: 0,
    tomlTables: 0,
    tomlAssignments: 0,
    yamlKeys: 0,
    yamlItems: 0,
    yamlDocumentStart: false,
    yamlDirective: false,
    other: 0,
    tomlBadValues: 0,
  };
  let pos = from;
  let seen = 0;
  while (pos < b.length && scan.lines < maxLines) {
    let eol = b.indexOf(LF, pos);
    if (eol < 0) eol = b.length;
    let s = pos;
    let e = eol;
    pos = eol + 1;
    while (s < e && (b[s] === SPACE || b[s] === TAB)) s++;
    while (e > s && (b[e - 1] === CR || b[e - 1] === SPACE || b[e - 1] === TAB)) e--;
    if (s >= e) continue;
    seen++;
    if (b[s] === HASH) continue;
    if (seen === 1 || scan.lines === 0) {
      if (bytesEqual(b, s, "---") && (e - s === 3 || isWs(b[s + 3] as number))) {
        scan.yamlDocumentStart = true;
        continue;
      }
      if (b[s] === 0x25 && bytesEqual(b, s, "%YAML")) {
        scan.yamlDirective = true;
        continue;
      }
    }
    scan.lines++;
    const c = b[s] as number;
    if (c === LBRACKET) {
      // `[table]` / `[[array.of.tables]]`: bare or quoted dotted keys, nothing else.
      let j = s + 1;
      if (b[j] === LBRACKET) j++;
      let ok = true;
      let k = j;
      let sawKey = false;
      while (k < e && b[k] !== RBRACKET) {
        const d = b[k] as number;
        if (BARE_KEY[d] === 1) sawKey = true;
        else if (d === 0x2e || d === SPACE) {
          // A dot or a space between key parts.
        } else if (d === QUOTE || d === APOS) {
          const close = b.indexOf(d, k + 1);
          if (close < 0 || close >= e) {
            ok = false;
            break;
          }
          sawKey = true;
          k = close;
        } else {
          ok = false;
          break;
        }
        k++;
      }
      if (ok && sawKey && k < e && b[k] === RBRACKET) {
        let t = k + 1;
        if (b[j - 1] === LBRACKET && b[t] === RBRACKET) t++;
        while (t < e && (b[t] === SPACE || b[t] === TAB)) t++;
        if (t >= e || b[t] === HASH) {
          scan.tomlTables++;
          continue;
        }
      }
      // A whole-line flow sequence (`[a, b]`) is YAML; a bracket that starts prose is not.
      if (b[e - 1] === RBRACKET) scan.yamlItems++;
      else scan.other++;
      continue;
    }
    if (c === MINUS && (s + 1 === e || b[s + 1] === SPACE)) {
      scan.yamlItems++;
      continue;
    }
    // key = value or key: value. Find the first of `=` / `: ` outside quotes.
    let k = s;
    let eq = -1;
    let colon = -1;
    if (c === QUOTE || c === APOS) {
      const close = b.indexOf(c, s + 1);
      k = close > 0 && close < e ? close + 1 : e;
    }
    for (; k < e; k++) {
      const d = b[k] as number;
      if (d === EQUALS) {
        eq = k;
        break;
      }
      if (d === COLON && (k + 1 === e || b[k + 1] === SPACE)) {
        colon = k;
        break;
      }
      if (d === HASH && k > s && b[k - 1] === SPACE) break;
    }
    if (eq > s) {
      // TOML needs a key made of bare/quoted/dotted parts and a TOML value.
      let keyOk = true;
      for (let m = s; m < eq && keyOk; m++) {
        const d = b[m] as number;
        if (BARE_KEY[d] === 1 || d === 0x2e || d === SPACE || d === QUOTE || d === APOS) continue;
        keyOk = d >= 0x80;
      }
      let v = eq + 1;
      while (v < e && b[v] === SPACE) v++;
      if (keyOk) {
        if (looksLikeTomlValue(b, v, e)) scan.tomlAssignments++;
        else {
          scan.tomlBadValues++;
          scan.other++;
        }
        continue;
      }
    }
    if (colon > s) {
      scan.yamlKeys++;
      continue;
    }
    // A key with nothing after the colon at the end of a line.
    if (e - 1 > s && b[e - 1] === COLON) {
      scan.yamlKeys++;
      continue;
    }
    scan.other++;
  }
  return scan;
};

const CANDIDATE_DELIMITERS = [COMMA, TAB, 0x3b, 0x7c] as const;
const MAX_SNIFF_RECORDS = 100;

interface Sniff {
  readonly delimiter: number;
  readonly fields: number;
  readonly records: number;
  readonly consistency: number;
  readonly firstFieldBytes: number;
  readonly firstEndsLikeProse: boolean;
}

/** Field counts per record for one delimiter; a quote toggles quoting wherever it appears (the adapter's rule). */
const sniffDelimiter = (
  b: Uint8Array,
  from: number,
  delimiter: number,
  truncated: boolean,
): Sniff => {
  const counts: number[] = [];
  let inQuote = false;
  let fields = 1;
  let recordStart = from;
  let firstFieldBytes = 0;
  let firstFieldDone = false;
  let fieldStart = from;
  let firstEndsLikeProse = false;
  let sawContent = false;
  const flush = (end: number) => {
    if (sawContent || fields > 1) counts.push(fields);
    if (counts.length === 1) {
      let e = end;
      while (e > recordStart && (b[e - 1] === CR || b[e - 1] === SPACE)) e--;
      const last = e > recordStart ? (b[e - 1] as number) : 0;
      firstEndsLikeProse = last === 0x2e || last === 0x3f || last === 0x21;
    }
    fields = 1;
    sawContent = false;
  };
  for (let i = from; i < b.length && counts.length < MAX_SNIFF_RECORDS; i++) {
    const c = b[i] as number;
    if (c === QUOTE) {
      inQuote = !inQuote;
      sawContent = true;
      continue;
    }
    if (inQuote) continue;
    if (c === delimiter) {
      if (!firstFieldDone && counts.length === 0) {
        firstFieldBytes = Math.max(firstFieldBytes, i - fieldStart);
      }
      fields++;
      fieldStart = i + 1;
      sawContent = true;
      continue;
    }
    if (c === LF) {
      if (counts.length === 0) {
        firstFieldBytes = Math.max(firstFieldBytes, i - fieldStart);
        firstFieldDone = true;
      }
      flush(i);
      recordStart = i + 1;
      fieldStart = i + 1;
      continue;
    }
    if (c !== CR) sawContent = true;
  }
  // The last record counts only when the prefix really is the whole file and is non-empty.
  if (!truncated && !inQuote && sawContent && counts.length < MAX_SNIFF_RECORDS) flush(b.length);
  if (counts.length === 0) {
    return {
      delimiter,
      fields: 0,
      records: 0,
      consistency: 0,
      firstFieldBytes,
      firstEndsLikeProse,
    };
  }
  const tally = new Map<number, number>();
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
  let modal = 0;
  let modalCount = 0;
  for (const [count, times] of tally) {
    if (times > modalCount || (times === modalCount && count > modal)) {
      modal = count;
      modalCount = times;
    }
  }
  return {
    delimiter,
    fields: modal,
    records: counts.length,
    consistency: modalCount / counts.length,
    firstFieldBytes,
    firstEndsLikeProse,
  };
};

const detectDelimited = (b: Uint8Array, from: number, truncated: boolean): Sniff | null => {
  let best: Sniff | null = null;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const s = sniffDelimiter(b, from, delimiter, truncated);
    if (s.fields < 2 || s.records < 2) continue;
    if (s.consistency < 0.9) continue;
    // Two records of prose that happen to share a comma count are not a table.
    if (s.records < 3 && (s.firstEndsLikeProse || s.firstFieldBytes > 64)) continue;
    if (
      best === null ||
      s.consistency > best.consistency ||
      (s.consistency === best.consistency && s.fields > best.fields)
    ) {
      best = s;
    }
  }
  return best;
};

const EXTENSION_FORMATS: ReadonlyArray<readonly [RegExp, FormatId]> = [
  [/\.har$/i, "har"],
  [/\.jsonc$/i, "jsonc"],
  [/\.(ndjson|jsonl)$/i, "ndjson"],
  [/\.json$/i, "json"],
  [/\.(ya?ml)$/i, "yaml"],
  [/\.toml$/i, "toml"],
  [/\.(xml|svg|xhtml|plist|rss|atom)$/i, "xml"],
  [/\.csv$/i, "csv"],
  [/\.(tsv|tab)$/i, "tsv"],
];

const fromExtension = (name: string): FormatId | null => {
  for (const [pattern, format] of EXTENSION_FORMATS) if (pattern.test(name)) return format;
  return null;
};

/** Extensions of files that are prose, whatever their lines look like. */
const PLAIN_TEXT = /\.(txt|text|log|md|markdown|rst)$/i;

/**
 * The format a file's name says it is: a data format for its extension, `text`
 * for a plain-text one, null when the name says nothing (no extension, or one
 * Quipu does not know). The name decides before the bytes do.
 */
export const formatOfName = (name: string): FormatId | null =>
  PLAIN_TEXT.test(name) ? "text" : fromExtension(name);

/** Detects the format of a file from its first bytes. Pass at most DETECT_PREFIX_BYTES. */
export const detectFormat = (prefix: Uint8Array, hint: DetectHint = {}): Detection => {
  const name = hint.name ?? "";
  const truncated = hint.truncated ?? false;
  let bom = 0;
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) bom = 3;
  // UTF-16 and UTF-32 BOMs: the bytes are not a text encoding the adapters read.
  if (
    prefix.length >= 2 &&
    ((prefix[0] === 0xff && prefix[1] === 0xfe) || (prefix[0] === 0xfe && prefix[1] === 0xff))
  ) {
    return result("text", "high", "utf16-bom", 0);
  }
  const b = bom > 0 ? prefix.subarray(bom) : prefix;
  // Binary: a NUL byte, or a body of control characters.
  let controls = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i] as number;
    if (c === 0) return result("text", "high", "binary", bom);
    if (c < 0x20 && c !== TAB && c !== LF && c !== CR && c !== 0x0c) controls++;
  }
  if (b.length > 0 && controls * 8 > b.length) return result("text", "high", "binary", bom);

  let from = 0;
  while (from < b.length && isWs(b[from] as number)) from++;
  if (from >= b.length) return result("text", "high", "empty", bom);

  const first = b[from] as number;
  const json = detectJsonFamily(b, from, truncated, bom, name);
  if (json) return json;
  if (first === LT) {
    const xml = detectXml(b, from, bom);
    if (xml) return xml;
  }

  const lines = scanLines(b, from, 200);
  const shaped = lines.lines;
  const tomlFit =
    lines.tomlTables + lines.tomlAssignments > 0 &&
    lines.tomlBadValues === 0 &&
    lines.yamlKeys === 0 &&
    lines.yamlItems === 0 &&
    (lines.tomlTables + lines.tomlAssignments) / Math.max(1, shaped) >= 0.7;
  if (tomlFit) {
    return result("toml", lines.tomlAssignments > 0 ? "high" : "medium", "toml-lines", bom);
  }
  const yamlLines = lines.yamlKeys + lines.yamlItems;
  const yamlFit =
    lines.yamlDocumentStart ||
    lines.yamlDirective ||
    (yamlLines > 0 && lines.tomlAssignments === 0 && yamlLines / Math.max(1, shaped) >= 0.6);
  // Tables of values separated by commas are CSV even when one cell has a colon.
  const delimited = detectDelimited(b, from, truncated);
  if (yamlFit && !(delimited && yamlLines / Math.max(1, shaped) < 0.9 && lines.yamlKeys === 0)) {
    const strong = lines.yamlDocumentStart || lines.yamlDirective || yamlLines >= 3;
    return result("yaml", strong ? "high" : "medium", "yaml-lines", bom);
  }
  if (delimited) {
    if (delimited.delimiter === TAB) return result("tsv", "high", "delimited-tab", bom, TAB);
    return result(
      "csv",
      delimited.records >= 3 ? "high" : "medium",
      "delimited",
      bom,
      delimited.delimiter,
    );
  }
  const byName = fromExtension(name);
  if (byName) {
    if (byName === "csv") return result("csv", "low", "extension", bom, COMMA);
    if (byName === "tsv") return result("tsv", "low", "extension", bom, TAB);
    // A hint cannot turn prose into JSON or XML; it only settles formats with no marker bytes.
    if (byName === "yaml" || byName === "toml") return result(byName, "low", "extension", bom);
  }
  return result("text", "low", "text", bom);
};
