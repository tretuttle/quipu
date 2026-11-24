/**
 * TOML onto the tape. smol-toml parses (and validates) the whole text but keeps
 * no source positions, so a byte scanner reads the same text for structure and
 * ranges: tables, arrays of tables, dotted keys, inline tables and arrays,
 * strings in all four forms, and scalars. The scanner builds the resolved table
 * tree (a dotted key and a `[table]` header that name the same table are one
 * object), and the tape is that tree in member order. A table's range is the
 * span of the source that defines it, so ranges of siblings may interleave when
 * the source defines a table in pieces.
 */
import { parse as parseToml } from "smol-toml";
import {
  KIND_ARRAY,
  KIND_FALSE,
  KIND_NUMBER,
  KIND_OBJECT,
  KIND_STRING,
  KIND_TRUE,
  NO_KEY,
  TapeBuilder,
} from "@quipu/core/tape";

import { FormatSyntaxError, FormatTooLargeError } from "./errors.ts";
import { byteOffsetOfLineColumn, decodeLargeText, TEXT_FORMAT_LIMIT } from "./textDocument.ts";
import type { TextIndex } from "./yamlTape.ts";

interface TomlNode {
  kind: number;
  start: number;
  end: number;
  keyStart: number;
  keyEnd: number;
  /** Members of a table (insertion order) or elements of an array. */
  children: TomlNode[];
  /** Table members by decoded key, for header and dotted-key lookup. */
  byKey?: Map<string, TomlNode>;
  /** An array of tables (headers add elements). */
  tables?: boolean;
}

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const HASH = 0x23;
const DQ = 0x22;
const SQ = 0x27;
const EQ = 0x3d;
const DOT = 0x2e;
const COMMA = 0x2c;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const BACKSLASH = 0x5c;

const isWs = (b: number) => b === SPACE || b === TAB;

class Scanner {
  readonly bytes: Uint8Array;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  fail(detail: string): never {
    throw new FormatSyntaxError({ format: "toml", offset: this.pos, detail });
  }

  skipWs() {
    const b = this.bytes;
    while (this.pos < b.length && isWs(b[this.pos] as number)) this.pos++;
  }

  /** White space, comments and line breaks. */
  skipTrivia() {
    const b = this.bytes;
    for (;;) {
      const c = b[this.pos];
      if (c === SPACE || c === TAB || c === LF || c === CR) this.pos++;
      else if (c === HASH) {
        const nl = b.indexOf(LF, this.pos);
        this.pos = nl < 0 ? b.length : nl + 1;
      } else return;
    }
  }

  /** A key part: bare or quoted. Returns its decoded text and byte range. */
  keyPart(): { text: string; start: number; end: number } {
    const b = this.bytes;
    const start = this.pos;
    const c = b[this.pos];
    if (c === DQ || c === SQ) {
      this.string();
      const raw = b.subarray(start, this.pos);
      return { text: decodeKeyString(raw), start, end: this.pos };
    }
    while (this.pos < b.length) {
      const d = b[this.pos] as number;
      if (
        (d >= 0x30 && d <= 0x39) ||
        (d >= 0x41 && d <= 0x5a) ||
        (d >= 0x61 && d <= 0x7a) ||
        d === 0x5f ||
        d === 0x2d
      ) {
        this.pos++;
      } else break;
    }
    if (this.pos === start) this.fail("expected a key");
    return { text: asciiText(b, start, this.pos), start, end: this.pos };
  }

  /** A dotted key: parts separated by dots, with white space around the dots. */
  dottedKey(): Array<{ text: string; start: number; end: number }> {
    const parts = [this.keyPart()];
    for (;;) {
      const save = this.pos;
      this.skipWs();
      if (this.bytes[this.pos] === DOT) {
        this.pos++;
        this.skipWs();
        parts.push(this.keyPart());
      } else {
        this.pos = save;
        return parts;
      }
    }
  }

  /** Advances past a string of any of the four forms; the opening quote is at `pos`. */
  string() {
    const b = this.bytes;
    const q = b[this.pos] as number;
    if (b[this.pos + 1] === q && b[this.pos + 2] === q) {
      // Multi-line: ends at the first closing triple that is not escaped (basic) and absorbs up to two extra quotes.
      this.pos += 3;
      for (;;) {
        if (this.pos >= b.length) this.fail("unterminated multi-line string");
        const c = b[this.pos] as number;
        if (q === DQ && c === BACKSLASH) {
          this.pos += 2;
          continue;
        }
        if (c === q && b[this.pos + 1] === q && b[this.pos + 2] === q) {
          this.pos += 3;
          while (b[this.pos] === q) this.pos++;
          return;
        }
        this.pos++;
      }
    }
    this.pos++;
    for (;;) {
      if (this.pos >= b.length) this.fail("unterminated string");
      const c = b[this.pos] as number;
      if (q === DQ && c === BACKSLASH) {
        this.pos += 2;
        continue;
      }
      if (c === q) {
        this.pos++;
        return;
      }
      if (c === LF) this.fail("a line break in a single-line string");
      this.pos++;
    }
  }

  /** A value at `pos`: returns its node (children filled for arrays and inline tables). */
  value(): TomlNode {
    const b = this.bytes;
    const start = this.pos;
    const c = b[this.pos];
    if (c === DQ || c === SQ) {
      this.string();
      return leaf(KIND_STRING, start, this.pos);
    }
    if (c === LBRACKET) {
      const node = container(KIND_ARRAY, start);
      this.pos++;
      for (;;) {
        this.skipTrivia();
        if (b[this.pos] === RBRACKET) {
          this.pos++;
          break;
        }
        node.children.push(this.value());
        this.skipTrivia();
        if (b[this.pos] === COMMA) this.pos++;
        else if (b[this.pos] !== RBRACKET) this.fail("expected , or ] in an array");
      }
      node.end = this.pos;
      return node;
    }
    if (c === LBRACE) {
      const node = container(KIND_OBJECT, start);
      this.pos++;
      for (;;) {
        this.skipTrivia();
        if (b[this.pos] === RBRACE) {
          this.pos++;
          break;
        }
        this.keyValue(node);
        this.skipTrivia();
        if (b[this.pos] === COMMA) this.pos++;
        else if (b[this.pos] !== RBRACE) this.fail("expected , or } in an inline table");
      }
      node.end = this.pos;
      return node;
    }
    // A number, boolean or date-time: up to a delimiter. A date-time may hold one space.
    while (this.pos < b.length) {
      const d = b[this.pos] as number;
      if (d === COMMA || d === RBRACKET || d === RBRACE || d === LF || d === CR || d === HASH)
        break;
      if (d === SPACE) {
        // "1979-05-27 07:32:00": a space between a date and a time stays in the value.
        const prev = b[this.pos - 1] as number;
        const next = b[this.pos + 1] as number;
        if (
          prev >= 0x30 &&
          prev <= 0x39 &&
          next >= 0x30 &&
          next <= 0x39 &&
          looksLikeDate(b, start, this.pos)
        ) {
          this.pos++;
          continue;
        }
        break;
      }
      if (d === TAB) break;
      this.pos++;
    }
    if (this.pos === start) this.fail("expected a value");
    const text = asciiText(b, start, this.pos);
    let kind = KIND_NUMBER;
    if (text === "true") kind = KIND_TRUE;
    else if (text === "false") kind = KIND_FALSE;
    else if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(text)) kind = KIND_STRING;
    return leaf(kind, start, this.pos);
  }

  /** `key = value` (dotted keys create the nested tables); adds into `table`. */
  keyValue(table: TomlNode) {
    const parts = this.dottedKey();
    this.skipWs();
    if (this.bytes[this.pos] !== EQ) this.fail("expected = after a key");
    this.pos++;
    this.skipWs();
    const value = this.value();
    let current = table;
    for (let i = 0; i < parts.length - 1; i++) {
      current = child(
        current,
        parts[i] as { text: string; start: number; end: number },
        KIND_OBJECT,
      );
    }
    const last = parts[parts.length - 1] as { text: string; start: number; end: number };
    value.keyStart = last.start;
    value.keyEnd = last.end;
    attach(current, last.text, value);
    const first = parts[0] as { start: number };
    widen(table, first.start, value.end);
  }
}

const leaf = (kind: number, start: number, end: number): TomlNode => ({
  kind,
  start,
  end,
  keyStart: NO_KEY,
  keyEnd: 0,
  children: [],
});

const container = (kind: number, start: number): TomlNode => ({
  kind,
  start,
  end: start,
  keyStart: NO_KEY,
  keyEnd: 0,
  children: [],
  ...(kind === KIND_OBJECT ? { byKey: new Map<string, TomlNode>() } : {}),
});

const widen = (node: TomlNode, start: number, end: number) => {
  if (node.children.length === 0 || start < node.start) node.start = Math.min(node.start, start);
  if (end > node.end) node.end = end;
};

/** The sub-table (or table array's last table) `part` names under `parent`, created when missing. */
const child = (
  parent: TomlNode,
  part: { text: string; start: number; end: number },
  kind: number,
): TomlNode => {
  const existing = parent.byKey?.get(part.text);
  if (existing) {
    if (existing.tables) return existing.children[existing.children.length - 1] as TomlNode;
    return existing;
  }
  const node = container(kind, part.start);
  node.keyStart = part.start;
  node.keyEnd = part.end;
  attach(parent, part.text, node);
  return node;
};

const attach = (parent: TomlNode, key: string, node: TomlNode) => {
  parent.children.push(node);
  parent.byKey?.set(key, node);
  if (node.start < parent.start || parent.children.length === 1)
    parent.start = Math.min(parent.start, node.start);
};

const asciiText = (b: Uint8Array, from: number, to: number) => {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i] as number);
  return s;
};

/** A quoted key's text, by letting smol-toml read `"…" = 1` (quoted keys are short). */
const decodeKeyString = (raw: Uint8Array): string => {
  const text = decodeLargeText(raw);
  const parsed = parseToml(`${text} = 1`);
  return Object.keys(parsed)[0] ?? "";
};

const looksLikeDate = (b: Uint8Array, start: number, end: number) => {
  const s = asciiText(b, start, end);
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
};

/** smol-toml's message with its code excerpt dropped: the line and column are in `offset`. */
export const tomlErrorDetail = (error: unknown) => {
  const message = error instanceof Error ? error.message : "invalid TOML";
  return message.split("\n\n")[0] ?? message;
};

/** The byte offset smol-toml's line and column name, or -1 when it names none. */
export const tomlErrorOffset = (bytes: Uint8Array, error: unknown) => {
  const e = error as { line?: unknown; column?: unknown };
  return typeof e.line === "number" && typeof e.column === "number"
    ? byteOffsetOfLineColumn(bytes, e.line, e.column)
    : -1;
};

/** Indexes TOML bytes; throws FormatSyntaxError when smol-toml rejects the text. */
export const indexToml = (bytes: Uint8Array): TextIndex => {
  if (bytes.length > TEXT_FORMAT_LIMIT) {
    throw new FormatTooLargeError({
      format: "toml",
      bytes: bytes.length,
      limit: TEXT_FORMAT_LIMIT,
    });
  }
  try {
    // Integers past 2^53 are valid TOML; read them as bigint rather than refuse the file.
    parseToml(decodeLargeText(bytes), { integersAsBigInt: "asNeeded" });
  } catch (error) {
    throw new FormatSyntaxError({
      format: "toml",
      offset: tomlErrorOffset(bytes, error),
      detail: tomlErrorDetail(error),
    });
  }
  const sc = new Scanner(bytes);
  const root = container(KIND_OBJECT, 0);
  root.end = bytes.length;
  let table = root;
  for (;;) {
    sc.skipTrivia();
    if (sc.pos >= bytes.length) break;
    if (bytes[sc.pos] === LBRACKET) {
      const isArray = bytes[sc.pos + 1] === LBRACKET;
      const headerStart = sc.pos;
      sc.pos += isArray ? 2 : 1;
      sc.skipWs();
      const parts = sc.dottedKey();
      sc.skipWs();
      sc.pos += isArray ? 2 : 1;
      let current = root;
      for (let i = 0; i < parts.length - 1; i++) {
        current = child(
          current,
          parts[i] as { text: string; start: number; end: number },
          KIND_OBJECT,
        );
      }
      const last = parts[parts.length - 1] as { text: string; start: number; end: number };
      if (isArray) {
        let holder = current.byKey?.get(last.text);
        if (!holder) {
          holder = container(KIND_ARRAY, headerStart);
          holder.tables = true;
          holder.keyStart = last.start;
          holder.keyEnd = last.end;
          attach(current, last.text, holder);
        }
        const element = container(KIND_OBJECT, headerStart);
        holder.children.push(element);
        widen(holder, headerStart, headerStart);
        table = element;
      } else {
        table = child(current, last, KIND_OBJECT);
        if (table.start > headerStart) table.start = headerStart;
      }
      continue;
    }
    sc.keyValue(table);
    sc.skipWs();
    // A table's range covers its key/value lines; propagate to the ancestors lazily below.
  }
  return flatten(root, bytes.length);
};

/** Ranges of containers are the span of their members. */
const fit = (node: TomlNode): number => {
  let end = node.end;
  for (const c of node.children) end = Math.max(end, fit(c));
  node.end = end;
  return end;
};

const flatten = (root: TomlNode, size: number): TextIndex => {
  fit(root);
  root.start = 0;
  root.end = size;
  const tape = new TapeBuilder(1024);
  let keyEnds = new Uint32Array(1024);
  const stack: Array<{ node: TomlNode; token: number; next: number; last: number }> = [];
  const push = (node: TomlNode, parent: number) => {
    const t = tape.push(node.kind, node.start, parent, node.keyStart);
    tape.setEnd(t, node.end);
    tape.setChildCount(t, node.children.length);
    if (t >= keyEnds.length) {
      const grown = new Uint32Array(keyEnds.length * 2);
      grown.set(keyEnds);
      keyEnds = grown;
    }
    keyEnds[t] = node.keyEnd;
    return t;
  };
  const rootToken = push(root, -1);
  stack.push({ node: root, token: rootToken, next: 0, last: -1 });
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as (typeof stack)[number];
    if (frame.next >= frame.node.children.length) {
      stack.pop();
      continue;
    }
    const childNode = frame.node.children[frame.next++] as TomlNode;
    const t = push(childNode, frame.token);
    if (frame.last >= 0) tape.setNext(frame.last, t);
    frame.last = t;
    if (childNode.children.length > 0) stack.push({ node: childNode, token: t, next: 0, last: -1 });
  }
  return { tape, keyEnds: keyEnds.slice(0, tape.count), documents: 1 };
};
