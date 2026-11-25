import {
  DEFAULT_MAX_ENUM,
  DEFAULT_MAX_INFER_DEPTH,
  type ArrayShape,
  type EnumValueEntry,
  type FieldShape,
  type InferOptions,
  type ObjectShape,
  type Shape,
  type StringFormat,
  type StringShape,
} from "@quipu/contracts/schema";
import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";

import { decodeUtf8 } from "../boundedSlice.ts";
import { detectStringFormat, STRING_FORMATS } from "./format.ts";
import { JsonSyntaxError, type JsonObject, type JsonValue } from "./jsonValue.ts";

const MAX_ENUM_LEN = 40;
const DEFAULT_INFER_OPTIONS: InferOptions = {
  maxEnum: DEFAULT_MAX_ENUM,
  maxDepth: DEFAULT_MAX_INFER_DEPTH,
};

const ENUM_IDENT_RE = /^\p{L}[\p{L}\p{N}_.-]*$/u;

const utf8ByteLength = (s: string): number => {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

const FORMAT_INDEX: Readonly<Record<StringFormat, number>> = {
  "date-time": 0,
  date: 1,
  email: 2,
  uri: 3,
  uuid: 4,
};

export function emptyShape(): Shape {
  return {
    samples: 0,
    nulls: 0,
    bools: 0,
    integers: 0,
    floats: 0,
    string: null,
    array: null,
    object: null,
  };
}

function resolveOptions(options?: Partial<InferOptions>): InferOptions {
  return {
    maxEnum: options?.maxEnum ?? DEFAULT_INFER_OPTIONS.maxEnum,
    maxDepth: options?.maxDepth ?? DEFAULT_INFER_OPTIONS.maxDepth,
  };
}

export function stringShapeFormat(s: StringShape): StringFormat | null {
  for (let i = 0; i < STRING_FORMATS.length; i++) {
    const n = s.formats[i] ?? 0;
    if (n === s.count && n > 0) {
      return STRING_FORMATS[i] ?? null;
    }
  }
  return null;
}

export function stringShapeEnumValues(
  s: StringShape,
  maxEnum = DEFAULT_MAX_ENUM,
): ReadonlyArray<string> | null {
  if (s.values === null) return null;
  if (
    s.values.length < 2 ||
    s.values.length > maxEnum ||
    s.count < 3 ||
    s.values.length >= s.count ||
    stringShapeFormat(s) !== null
  ) {
    return null;
  }
  for (const entry of s.values) {
    if (!ENUM_IDENT_RE.test(entry.value)) return null;
  }
  return s.values.map((entry) => entry.value);
}

export function isFieldRequired(field: FieldShape, obj: ObjectShape): boolean {
  return field.present === obj.count;
}

function isShapeNullable(shape: Shape): boolean {
  return shape.nulls > 0 && shape.nulls < shape.samples;
}

function shapeTypeCount(shape: Shape): number {
  let count = 0;
  if (shape.bools > 0) count++;
  if (shape.integers + shape.floats > 0) count++;
  if (shape.string !== null) count++;
  if (shape.array !== null) count++;
  if (shape.object !== null) count++;
  return count;
}

function isShapeAny(shape: Shape): boolean {
  return shapeTypeCount(shape) === 0 && shape.nulls === 0;
}

function mergeStringShape(
  a: StringShape | null,
  b: StringShape | null,
  maxEnum: number,
): StringShape | null {
  if (a === null) return b;
  if (b === null) return a;
  const formats: [number, number, number, number, number] = [
    a.formats[0] + b.formats[0],
    a.formats[1] + b.formats[1],
    a.formats[2] + b.formats[2],
    a.formats[3] + b.formats[3],
    a.formats[4] + b.formats[4],
  ];
  let values: EnumValueEntry[] | null = null;
  if (a.values !== null && b.values !== null && maxEnum > 0) {
    const merged: EnumValueEntry[] = [];
    const indexByValue = new Map<string, number>();
    let exceeded = false;
    const pushEntry = (entry: EnumValueEntry) => {
      if (exceeded) return;
      const existingIdx = indexByValue.get(entry.value);
      if (existingIdx !== undefined) {
        const cur = merged[existingIdx]!;
        merged[existingIdx] = { value: cur.value, count: cur.count + entry.count };
        return;
      }
      if (merged.length >= maxEnum || utf8ByteLength(entry.value) > MAX_ENUM_LEN) {
        exceeded = true;
        return;
      }
      indexByValue.set(entry.value, merged.length);
      merged.push({ value: entry.value, count: entry.count });
    };
    for (const entry of a.values) pushEntry(entry);
    for (const entry of b.values) pushEntry(entry);
    if (!exceeded) values = merged;
  }
  return {
    count: a.count + b.count,
    formats,
    values,
  };
}

function mergeArrayShape(
  a: ArrayShape | null,
  b: ArrayShape | null,
  opts: InferOptions,
): ArrayShape | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    count: a.count + b.count,
    minLen: Math.min(a.minLen, b.minLen),
    maxLen: Math.max(a.maxLen, b.maxLen),
    items: mergeShape(a.items, b.items, opts),
  };
}

function mergeObjectShape(
  a: ObjectShape | null,
  b: ObjectShape | null,
  opts: InferOptions,
): ObjectShape | null {
  if (a === null) return b;
  if (b === null) return a;
  const bIndex = new Map<string, FieldShape>();
  for (const f of b.fields) bIndex.set(f.name, f);
  const fields: FieldShape[] = [];
  const seen = new Set<string>();
  for (const fa of a.fields) {
    seen.add(fa.name);
    const fb = bIndex.get(fa.name);
    if (fb !== undefined) {
      fields.push({
        name: fa.name,
        present: fa.present + fb.present,
        shape: mergeShape(fa.shape, fb.shape, opts),
      });
    } else {
      fields.push(fa);
    }
  }
  for (const fb of b.fields) {
    if (!seen.has(fb.name)) fields.push(fb);
  }
  return {
    count: a.count + b.count,
    fields,
  };
}

/** Associative monoid merge of two inferred shapes. */
export function mergeShape(a: Shape, b: Shape, options?: Partial<InferOptions>): Shape {
  if (a.samples === 0) return b;
  if (b.samples === 0) return a;
  const opts = resolveOptions(options);
  return {
    samples: a.samples + b.samples,
    nulls: a.nulls + b.nulls,
    bools: a.bools + b.bools,
    integers: a.integers + b.integers,
    floats: a.floats + b.floats,
    string: mergeStringShape(a.string, b.string, opts.maxEnum),
    array: mergeArrayShape(a.array, b.array, opts),
    object: mergeObjectShape(a.object, b.object, opts),
  };
}

interface MutStringShape {
  count: number;
  formats: [number, number, number, number, number];
  values: { value: string; count: number }[] | null;
  valueIndex: Map<string, number> | null;
}

interface MutArrayShape {
  count: number;
  minLen: number;
  maxLen: number;
  items: MutShape;
}

interface MutField {
  readonly name: string;
  present: number;
  shape: MutShape;
  seenIn: number;
}

interface MutObjectShape {
  count: number;
  fields: MutField[];
  index: Map<string, number>;
}

interface MutShape {
  samples: number;
  nulls: number;
  bools: number;
  integers: number;
  floats: number;
  string: MutStringShape | null;
  array: MutArrayShape | null;
  object: MutObjectShape | null;
}

const makeMutShape = (): MutShape => ({
  samples: 0,
  nulls: 0,
  bools: 0,
  integers: 0,
  floats: 0,
  string: null,
  array: null,
  object: null,
});

function addStringToMut(target: MutShape, s: string, maxEnum: number, inArray: boolean): void {
  let str = target.string;
  if (str === null) {
    str = {
      count: 0,
      formats: [0, 0, 0, 0, 0],
      values: !inArray && maxEnum > 0 ? [] : null,
      valueIndex: !inArray && maxEnum > 0 ? new Map() : null,
    };
    target.string = str;
  }
  str.count += 1;
  const fmt = detectStringFormat(s);
  if (fmt !== null) {
    const fi = FORMAT_INDEX[fmt];
    str.formats[fi] = (str.formats[fi] ?? 0) + 1;
  }
  if (str.values !== null && str.valueIndex !== null) {
    const idx = str.valueIndex.get(s);
    if (idx !== undefined) {
      str.values[idx]!.count += 1;
    } else if (str.values.length < maxEnum && utf8ByteLength(s) <= MAX_ENUM_LEN) {
      str.valueIndex.set(s, str.values.length);
      str.values.push({ value: s, count: 1 });
    } else {
      str.values = null;
      str.valueIndex = null;
    }
  }
}

function getMutField(obj: MutObjectShape, key: string): MutField {
  const existing = obj.index.get(key);
  if (existing !== undefined) return obj.fields[existing]!;
  const field: MutField = {
    name: key,
    present: 0,
    shape: makeMutShape(),
    seenIn: 0,
  };
  obj.index.set(key, obj.fields.length);
  obj.fields.push(field);
  return field;
}

function freezeMutShape(mut: MutShape): Shape {
  return {
    samples: mut.samples,
    nulls: mut.nulls,
    bools: mut.bools,
    integers: mut.integers,
    floats: mut.floats,
    string:
      mut.string === null
        ? null
        : {
            count: mut.string.count,
            formats: [...mut.string.formats],
            values: mut.string.values === null ? null : mut.string.values.map((v) => ({ ...v })),
          },
    array:
      mut.array === null
        ? null
        : {
            count: mut.array.count,
            minLen: mut.array.minLen,
            maxLen: mut.array.maxLen,
            items: freezeMutShape(mut.array.items),
          },
    object:
      mut.object === null
        ? null
        : {
            count: mut.object.count,
            fields: mut.object.fields.map((f) => ({
              name: f.name,
              present: f.present,
              shape: freezeMutShape(f.shape),
            })),
          },
  };
}

/** Infers a Shape from an in-memory JS value (iterative stack, depth-bounded). */
export function inferValue(value: unknown, options?: Partial<InferOptions>): Shape {
  const opts = resolveOptions(options);
  const root = makeMutShape();
  let objectStamp = 0;

  interface WorkItem {
    readonly target: MutShape;
    readonly value: unknown;
    readonly depth: number;
    readonly inArray: boolean;
  }

  const stack: WorkItem[] = [{ target: root, value, depth: 0, inArray: false }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    const { target, value: val, depth, inArray } = item;
    target.samples += 1;
    if (depth > opts.maxDepth) continue;

    if (val === null || val === undefined) {
      target.nulls += 1;
    } else if (typeof val === "boolean") {
      target.bools += 1;
    } else if (typeof val === "number") {
      if (Number.isInteger(val)) target.integers += 1;
      else target.floats += 1;
    } else if (typeof val === "string") {
      addStringToMut(target, val, opts.maxEnum, inArray);
    } else if (Array.isArray(val)) {
      const len = val.length;
      let arr = target.array;
      if (arr === null) {
        arr = { count: 0, minLen: len, maxLen: len, items: makeMutShape() };
        target.array = arr;
      } else {
        if (len < arr.minLen) arr.minLen = len;
        if (len > arr.maxLen) arr.maxLen = len;
      }
      arr.count += 1;
      for (let i = len - 1; i >= 0; i--) {
        stack.push({ target: arr.items, value: val[i], depth: depth + 1, inArray: true });
      }
    } else if (typeof val === "object") {
      objectStamp += 1;
      const stamp = objectStamp;
      let obj = target.object;
      if (obj === null) {
        obj = { count: 0, fields: [], index: new Map() };
        target.object = obj;
      }
      obj.count += 1;
      const record = val as Record<string, unknown>;
      const keys = Object.keys(record);
      const pending: WorkItem[] = [];
      for (const k of keys) {
        const field = getMutField(obj, k);
        if (field.seenIn !== stamp) {
          field.seenIn = stamp;
          field.present += 1;
        }
        pending.push({ target: field.shape, value: record[k], depth: depth + 1, inArray: false });
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        stack.push(pending[i]!);
      }
    }
  }
  return freezeMutShape(root);
}

export function observeValue(shape: Shape, value: unknown, options?: Partial<InferOptions>): Shape {
  return mergeShape(shape, inferValue(value, options), options);
}

/**
 * Infers a Shape directly from raw JSON text without allocating a JS object graph.
 * Preserves the raw lexical integer vs float distinction (e.g. `1.0` -> float, `1` -> integer).
 */
export function inferJsonText(text: string, options?: Partial<InferOptions>): Shape {
  const opts = resolveOptions(options);
  const root = makeMutShape();
  let at = 0;
  const len = text.length;
  let objectStamp = 0;

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

  const readNumberIsFloat = (): boolean => {
    let isFloat = false;
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
      isFloat = true;
      at++;
      const fracStart = at;
      while (at < len && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
      if (at === fracStart) fail("expected fraction digits");
    }
    if (text[at] === "e" || text[at] === "E") {
      isFloat = true;
      at++;
      if (text[at] === "+" || text[at] === "-") at++;
      const expStart = at;
      while (at < len && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
      if (at === expStart) fail("expected exponent digits");
    }
    return isFloat;
  };

  type OpenFrame =
    | {
        readonly kind: "object";
        readonly target: MutShape | null;
        readonly depth: number;
        readonly stamp: number;
        currentField: MutShape | null;
      }
    | {
        readonly kind: "array";
        readonly target: MutShape | null;
        readonly depth: number;
        length: number;
      };

  const stack: OpenFrame[] = [];

  const nextTarget = (): { target: MutShape | null; depth: number; inArray: boolean } => {
    const top = stack[stack.length - 1];
    if (top === undefined) return { target: root, depth: 0, inArray: false };
    if (top.kind === "object") {
      return { target: top.currentField, depth: top.depth + 1, inArray: false };
    }
    return {
      target: top.target?.array ? top.target.array.items : null,
      depth: top.depth + 1,
      inArray: true,
    };
  };

  const enterObjectKey = (frame: Extract<OpenFrame, { kind: "object" }>) => {
    skipSpace();
    if (text[at] !== '"') fail("expected property name");
    const key = readString();
    skipSpace();
    if (text[at] !== ":") fail("expected colon");
    at++;
    if (frame.target !== null && frame.target.object !== null) {
      const field = getMutField(frame.target.object, key);
      if (field.seenIn !== frame.stamp) {
        field.seenIn = frame.stamp;
        field.present += 1;
      }
      frame.currentField = field.shape;
    } else {
      frame.currentField = null;
    }
  };

  for (;;) {
    skipSpace();
    const { target, depth, inArray } = nextTarget();
    const withinDepth = depth <= opts.maxDepth;
    const ch = text[at];
    let finishedValue = false;

    if (ch === "{") {
      at++;
      if (target !== null) target.samples += 1;
      let objTarget: MutShape | null = null;
      if (target !== null && withinDepth) {
        if (target.object === null) {
          target.object = { count: 0, fields: [], index: new Map() };
        }
        target.object.count += 1;
        objTarget = target;
      }
      skipSpace();
      if (text[at] === "}") {
        at++;
        finishedValue = true;
      } else {
        objectStamp += 1;
        const frame: OpenFrame = {
          kind: "object",
          target: objTarget,
          depth,
          stamp: objectStamp,
          currentField: null,
        };
        enterObjectKey(frame);
        stack.push(frame);
      }
    } else if (ch === "[") {
      at++;
      if (target !== null) target.samples += 1;
      let arrTarget: MutShape | null = null;
      if (target !== null && withinDepth) {
        if (target.array === null) {
          target.array = {
            count: 0,
            minLen: Number.MAX_SAFE_INTEGER,
            maxLen: 0,
            items: makeMutShape(),
          };
        }
        target.array.count += 1;
        arrTarget = target;
      }
      skipSpace();
      if (text[at] === "]") {
        at++;
        if (arrTarget?.array) {
          if (0 < arrTarget.array.minLen) arrTarget.array.minLen = 0;
        }
        finishedValue = true;
      } else {
        stack.push({ kind: "array", target: arrTarget, depth, length: 0 });
      }
    } else if (ch === '"') {
      const s = readString();
      if (target !== null) {
        target.samples += 1;
        if (withinDepth) addStringToMut(target, s, opts.maxEnum, inArray);
      }
      finishedValue = true;
    } else if (text.startsWith("true", at)) {
      at += 4;
      if (target !== null) {
        target.samples += 1;
        if (withinDepth) target.bools += 1;
      }
      finishedValue = true;
    } else if (text.startsWith("false", at)) {
      at += 5;
      if (target !== null) {
        target.samples += 1;
        if (withinDepth) target.bools += 1;
      }
      finishedValue = true;
    } else if (text.startsWith("null", at)) {
      at += 4;
      if (target !== null) {
        target.samples += 1;
        if (withinDepth) target.nulls += 1;
      }
      finishedValue = true;
    } else {
      const isFloat = readNumberIsFloat();
      if (target !== null) {
        target.samples += 1;
        if (withinDepth) {
          if (isFloat) target.floats += 1;
          else target.integers += 1;
        }
      }
      finishedValue = true;
    }

    while (finishedValue) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        skipSpace();
        if (at !== len) fail("trailing characters after JSON value");
        return freezeMutShape(root);
      }
      if (top.kind === "array") {
        top.length += 1;
      }
      skipSpace();
      if (text[at] === ",") {
        at++;
        if (top.kind === "object") enterObjectKey(top);
        finishedValue = false;
      } else if (text[at] === (top.kind === "array" ? "]" : "}")) {
        at++;
        if (top.kind === "array" && top.target?.array) {
          if (top.length < top.target.array.minLen) top.target.array.minLen = top.length;
          if (top.length > top.target.array.maxLen) top.target.array.maxLen = top.length;
        }
        stack.pop();
      } else {
        fail(`expected ',' or '${top.kind === "array" ? "]" : "}"}'`);
      }
    }
  }
}

export function inferJsonSlice(
  bytes: Uint8Array,
  options?: Partial<InferOptions>,
  limit = MAX_SLICE_BYTES,
): Shape {
  return inferJsonText(decodeUtf8(bytes, limit), options);
}

function shapeSchemaBody(shape: Shape, maxEnum: number): JsonObject {
  const alternatives: Record<string, JsonValue>[] = [];

  if (shape.bools > 0) {
    alternatives.push({ type: "boolean" });
  }
  if (shape.floats > 0) {
    alternatives.push({ type: "number" });
  } else if (shape.integers > 0) {
    alternatives.push({ type: "integer" });
  }
  if (shape.string !== null) {
    const m: Record<string, JsonValue> = { type: "string" };
    const fmt = stringShapeFormat(shape.string);
    if (fmt !== null) m.format = fmt;
    const enums = stringShapeEnumValues(shape.string, maxEnum);
    if (enums !== null) m.enum = [...enums];
    alternatives.push(m);
  }
  if (shape.array !== null) {
    const m: Record<string, JsonValue> = { type: "array" };
    if (shape.array.items.samples > 0) {
      m.items = shapeSchemaBody(shape.array.items, maxEnum);
    }
    alternatives.push(m);
  }
  if (shape.object !== null) {
    const props: Record<string, JsonValue> = {};
    const required: string[] = [];
    for (const f of shape.object.fields) {
      Object.defineProperty(props, f.name, {
        value: shapeSchemaBody(f.shape, maxEnum),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (isFieldRequired(f, shape.object)) {
        required.push(f.name);
      }
    }
    const m: Record<string, JsonValue> = {
      type: "object",
      properties: props,
    };
    if (required.length > 0) {
      m.required = required;
    }
    alternatives.push(m);
  }

  const nullable = shape.nulls > 0;
  if (alternatives.length === 0) {
    return nullable ? { type: "null" } : {};
  }
  if (alternatives.length === 1) {
    const m = alternatives[0]!;
    if (nullable) {
      const t = m.type;
      m.type = [t ?? "null", "null"];
      if (Array.isArray(m.enum)) {
        m.enum = [...m.enum, null];
      }
    }
    const ordered: Record<string, JsonValue> = {};
    if (m.type !== undefined) ordered.type = m.type;
    for (const k of Object.keys(m)) {
      if (k !== "type") {
        Object.defineProperty(ordered, k, {
          value: m[k],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return ordered;
  }
  const anyOf: JsonValue[] = [...alternatives];
  if (nullable) anyOf.push({ type: "null" });
  return { anyOf };
}

/** Converts an inferred Shape to a JSON Schema (draft 2020-12) document. */
export function shapeToJsonSchema(
  shape: Shape,
  title = "Root",
  maxEnum = DEFAULT_MAX_ENUM,
): JsonObject {
  const root: Record<string, JsonValue> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
  };
  const body = shapeSchemaBody(shape, maxEnum);
  for (const key of Object.keys(body)) {
    Object.defineProperty(root, key, {
      value: body[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return root;
}
