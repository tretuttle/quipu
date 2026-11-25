import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";

import { decodeUtf8 } from "../boundedSlice.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Iterative bounded JSON parser (stack-safe for deep trees, no JSON.parse). */
export function parseJsonValue(text: string, maxChars = MAX_SLICE_BYTES): JsonValue {
  if (text.length > maxChars) {
    throw new JsonSyntaxError(`JSON text exceeds ${maxChars} characters`);
  }
  let at = 0;
  const len = text.length;

  const fail = (what: string): never => {
    throw new JsonSyntaxError(`${what} at offset ${at}`);
  };

  const skipSpace = () => {
    while (at < len) {
      const c = text.charCodeAt(at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      at++;
    }
  };

  const readString = (): string => {
    at++;
    let out = "";
    let chunkStart = at;
    while (at < len) {
      const code = text.charCodeAt(at);
      if (code === 0x22) {
        if (at > chunkStart) out += text.slice(chunkStart, at);
        at++;
        return out;
      }
      if (code < 0x20) fail("unescaped control character in string");
      if (code !== 0x5c) {
        at++;
        continue;
      }
      if (at > chunkStart) out += text.slice(chunkStart, at);
      const esc = text[at + 1];
      at += 2;
      switch (esc) {
        case '"':
        case "\\":
        case "/":
          out += esc;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          at += 4;
          break;
        }
        default:
          fail("invalid escape sequence");
      }
      chunkStart = at;
    }
    return fail("unterminated string");
  };

  const readScalar = (): JsonPrimitive => {
    const ch = text[at];
    if (ch === '"') return readString();
    if (text.startsWith("true", at)) {
      at += 4;
      return true;
    }
    if (text.startsWith("false", at)) {
      at += 5;
      return false;
    }
    if (text.startsWith("null", at)) {
      at += 4;
      return null;
    }
    const start = at;
    if (text[at] === "-") at++;
    if (at >= len) fail("unexpected end of number");
    if (text[at] === "0") {
      at++;
    } else if (text.charCodeAt(at) >= 0x31 && text.charCodeAt(at) <= 0x39) {
      while (at < len && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
    } else {
      fail("unexpected character");
    }
    if (text[at] === ".") {
      at++;
      const fracStart = at;
      while (at < len && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
      if (at === fracStart) fail("expected fraction digits");
    }
    if (text[at] === "e" || text[at] === "E") {
      at++;
      if (text[at] === "+" || text[at] === "-") at++;
      const expStart = at;
      while (at < len && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
      if (at === expStart) fail("expected exponent digits");
    }
    return Number(text.slice(start, at));
  };

  type Frame =
    | { readonly kind: "array"; readonly value: JsonValue[] }
    | { readonly kind: "object"; readonly value: Record<string, JsonValue>; key: string };

  const stack: Frame[] = [];

  const defineMember = (obj: Record<string, JsonValue>, key: string, val: JsonValue) => {
    Object.defineProperty(obj, key, {
      value: val,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };

  const readNextKey = (frame: Extract<Frame, { kind: "object" }>) => {
    skipSpace();
    if (text[at] !== '"') fail("expected property name");
    frame.key = readString();
    skipSpace();
    if (text[at] !== ":") fail("expected colon");
    at++;
  };

  for (;;) {
    skipSpace();
    let done: JsonValue;
    let complete = false;
    if (text[at] === "{") {
      at++;
      skipSpace();
      if (text[at] === "}") {
        at++;
        done = {};
        complete = true;
      } else {
        const frame: Frame = { kind: "object", value: {}, key: "" };
        readNextKey(frame);
        stack.push(frame);
        continue;
      }
    } else if (text[at] === "[") {
      at++;
      skipSpace();
      if (text[at] === "]") {
        at++;
        done = [];
        complete = true;
      } else {
        stack.push({ kind: "array", value: [] });
        continue;
      }
    } else {
      done = readScalar();
      complete = true;
    }

    while (complete) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        skipSpace();
        if (at !== len) fail("trailing characters after JSON value");
        return done;
      }
      if (top.kind === "array") {
        top.value.push(done);
      } else {
        defineMember(top.value, top.key, done);
      }
      skipSpace();
      if (text[at] === ",") {
        at++;
        if (top.kind === "object") readNextKey(top);
        complete = false;
      } else if (text[at] === (top.kind === "array" ? "]" : "}")) {
        at++;
        stack.pop();
        done = top.value;
      } else {
        fail(`expected ',' or '${top.kind === "array" ? "]" : "}"}'`);
      }
    }
  }
}

export function parseJsonBytes(bytes: Uint8Array, maxBytes = MAX_SLICE_BYTES): JsonValue {
  return parseJsonValue(decodeUtf8(bytes, maxBytes), maxBytes);
}

/** Quotes a string as a JSON literal matching serde_json escaping. */
export function quoteJsonString(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let esc: string | undefined;
    if (code === 0x22) esc = '\\"';
    else if (code === 0x5c) esc = "\\\\";
    else if (code === 0x08) esc = "\\b";
    else if (code === 0x0c) esc = "\\f";
    else if (code === 0x0a) esc = "\\n";
    else if (code === 0x0d) esc = "\\r";
    else if (code === 0x09) esc = "\\t";
    else if (code < 0x20) esc = `\\u${code.toString(16).padStart(4, "0")}`;
    if (esc !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += esc;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  out += '"';
  return out;
}

export function formatJsonCompact(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return quoteJsonString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatJsonCompact(item)).join(",")}]`;
  }
  const obj = value as Record<string, JsonValue>;
  const entries = Object.keys(obj).map(
    (k) => `${quoteJsonString(k)}:${formatJsonCompact(obj[k]!)}`,
  );
  return `{${entries.join(",")}}`;
}

/** Formats JSON matching serde_json::to_string_pretty (2-space indent). */
export function formatJsonPretty(value: JsonValue, indentSize = 2): string {
  const formatAt = (val: JsonValue, depth: number): string => {
    if (val === null) return "null";
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "null";
    if (typeof val === "string") return quoteJsonString(val);
    const pad = " ".repeat(depth * indentSize);
    const childPad = " ".repeat((depth + 1) * indentSize);
    if (Array.isArray(val)) {
      if (val.length === 0) return "[]";
      const lines = val.map((item) => `${childPad}${formatAt(item, depth + 1)}`);
      return `[\n${lines.join(",\n")}\n${pad}]`;
    }
    const obj = val as Record<string, JsonValue>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    const lines = keys.map(
      (k) => `${childPad}${quoteJsonString(k)}: ${formatAt(obj[k]!, depth + 1)}`,
    );
    return `{\n${lines.join(",\n")}\n${pad}}`;
  };
  return formatAt(value, 0);
}
