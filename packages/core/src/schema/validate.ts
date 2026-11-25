import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";
import {
  MAX_SCHEMA_FAILURES as MAX_FAILURES,
  SchemaContractError,
  type HarValidationFilter,
  type SchemaErrorKind,
  type SchemaFailure,
  type ValidationResult,
} from "@quipu/contracts/schema";

import { Base64Decoder, base64MaxDecoded } from "../base64.ts";
import {
  formatJsonCompact,
  isJsonObject,
  JsonSyntaxError,
  parseJsonBytes,
  parseJsonValue,
  quoteJsonString,
  type JsonValue,
} from "./jsonValue.ts";

export { MAX_FAILURES };

const MAX_REF_DEPTH = 256;

export class SchemaParseError extends Error {
  readonly kind: SchemaErrorKind;
  readonly detail: string;

  constructor(kind: SchemaErrorKind, detail: string, message: string) {
    super(message);
    this.name = "SchemaParseError";
    this.kind = kind;
    this.detail = detail;
  }

  toContractError(): SchemaContractError {
    return new SchemaContractError({
      kind: this.kind,
      detail: this.detail,
      message: this.message,
    });
  }
}

export class RemoteRefError extends SchemaParseError {
  readonly uri: string;

  constructor(uri: string) {
    super(
      "remote-ref",
      uri,
      `remote $ref refused: ${uri} is another document, and schemas are never fetched`,
    );
    this.name = "RemoteRefError";
    this.uri = uri;
  }
}

const ONE_SUBSCHEMA = [
  "additionalProperties",
  "propertyNames",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
] as const;

const LIST_SUBSCHEMAS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

const MAP_SUBSCHEMAS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
] as const;

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hasScheme(r: string): boolean {
  for (let i = 0; i < r.length; i++) {
    const ch = r[i]!;
    if (ch === ":") {
      if (i === 0) return false;
      const first = r.charCodeAt(0);
      return (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
    }
    if (ch === "/" || ch === "?" || ch === "#") return false;
  }
  return false;
}

/** Resolves `ref` against `base` per RFC 3986 (without query handling), dropping fragment. */
export function resolveUri(base: string, ref: string): string {
  const hash = ref.indexOf("#");
  const r = hash >= 0 ? ref.slice(0, hash) : ref;
  if (r.length === 0) return base;
  if (hasScheme(r) || base.length === 0) return r;
  const colon = base.indexOf(":");
  const schemeEnd = colon >= 0 ? colon + 1 : 0;
  if (r.startsWith("//")) return `${base.slice(0, schemeEnd)}${r}`;
  let authEnd = schemeEnd;
  if (base.startsWith("//", schemeEnd)) {
    const slash = base.indexOf("/", schemeEnd + 2);
    authEnd = slash >= 0 ? slash : base.length;
  }
  const head = base.slice(0, authEnd);
  const path = base.slice(authEnd);
  let joined: string;
  if (r.startsWith("/")) {
    joined = r;
  } else {
    const lastSlash = path.lastIndexOf("/");
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
    joined = `${dir}${r}`;
  }
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return `${head}${parts.join("/")}`;
}

function resolvePointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let cur: JsonValue = root;
  const segments = pointer.slice(1).split("/");
  for (const raw of segments) {
    const token = unescapePointerToken(raw);
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const idx = Number(token);
      if (idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx]!;
    } else if (isJsonObject(cur)) {
      if (!Object.hasOwn(cur, token)) return undefined;
      cur = cur[token]!;
    } else {
      return undefined;
    }
  }
  return cur;
}

interface RefEntry {
  readonly node: object;
  readonly dynamic: boolean;
  readonly base: string;
  readonly ref: string;
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch (err) {
    // Fallback without 'u' for patterns with identity escapes allowed in non-unicode mode.
    try {
      return new RegExp(pattern);
    } catch {
      const message = err instanceof Error ? err.message : String(err);
      throw new SchemaParseError(
        "bad-pattern",
        pattern,
        `pattern ${pattern} cannot be checked: ${message}`,
      );
    }
  }
}

export class LocalSchema {
  private readonly root: JsonValue;
  private readonly staticRefs: WeakMap<object, string>;
  private readonly dynamicRefs: WeakMap<object, string>;
  private readonly patterns: Map<string, RegExp>;

  private constructor(
    root: JsonValue,
    staticRefs: WeakMap<object, string>,
    dynamicRefs: WeakMap<object, string>,
    patterns: Map<string, RegExp>,
  ) {
    this.root = root;
    this.staticRefs = staticRefs;
    this.dynamicRefs = dynamicRefs;
    this.patterns = patterns;
  }

  static parse(text: string): LocalSchema {
    let root: JsonValue;
    try {
      root = parseJsonValue(text);
    } catch (err) {
      const msg = err instanceof JsonSyntaxError ? err.message : String(err);
      throw new SchemaParseError("not-json", msg, `the schema is not JSON (${msg})`);
    }
    return LocalSchema.fromValue(root);
  }

  static fromValue(root: JsonValue): LocalSchema {
    if (typeof root !== "boolean" && !isJsonObject(root)) {
      throw new SchemaParseError("not-a-schema", "", "a schema is a JSON object or true/false");
    }

    const resources = new Map<string, string>([["", ""]]);
    const anchors = new Map<string, string>();
    const pendingRefs: RefEntry[] = [];
    const patterns = new Map<string, RegExp>();
    const walked = new Set<string>();

    const ensurePattern = (p: string) => {
      if (!patterns.has(p)) {
        patterns.set(p, compileRegex(p));
      }
    };

    const walk = (v: JsonValue, loc: string, base: string) => {
      if (!isJsonObject(v)) return;
      if (walked.has(loc)) return;
      walked.add(loc);

      for (const k of ["unevaluatedProperties", "unevaluatedItems"] as const) {
        if (Object.hasOwn(v, k)) {
          throw new SchemaParseError("unsupported", k, `${k} is not supported`);
        }
      }

      let curBase = base;
      if (typeof v.$id === "string") {
        curBase = resolveUri(curBase, v.$id);
        if (!resources.has(curBase)) resources.set(curBase, loc);
      }
      for (const k of ["$anchor", "$dynamicAnchor"] as const) {
        const anchor = v[k];
        if (typeof anchor === "string") {
          const full = `${curBase}#${anchor}`;
          if (!anchors.has(full)) anchors.set(full, loc);
        }
      }
      if (typeof v.$ref === "string") {
        pendingRefs.push({ node: v, dynamic: false, base: curBase, ref: v.$ref });
      }
      if (typeof v.$dynamicRef === "string") {
        pendingRefs.push({ node: v, dynamic: true, base: curBase, ref: v.$dynamicRef });
      }
      if (typeof v.pattern === "string") {
        ensurePattern(v.pattern);
      }
      if (isJsonObject(v.patternProperties)) {
        for (const p of Object.keys(v.patternProperties)) {
          ensurePattern(p);
        }
      }

      const childLoc = (k: string) => `${loc}/${escapePointerToken(k)}`;
      for (const k of ONE_SUBSCHEMA) {
        if (Object.hasOwn(v, k)) walk(v[k]!, childLoc(k), curBase);
      }
      for (const k of LIST_SUBSCHEMAS) {
        const list = v[k];
        if (Array.isArray(list)) {
          for (let i = 0; i < list.length; i++) {
            walk(list[i]!, `${childLoc(k)}/${i}`, curBase);
          }
        }
      }
      if (Object.hasOwn(v, "items")) {
        const items = v.items!;
        if (Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            walk(items[i]!, `${childLoc("items")}/${i}`, curBase);
          }
        } else {
          walk(items, childLoc("items"), curBase);
        }
      }
      for (const k of MAP_SUBSCHEMAS) {
        const map = v[k];
        if (isJsonObject(map)) {
          for (const name of Object.keys(map)) {
            walk(map[name]!, `${childLoc(k)}/${escapePointerToken(name)}`, curBase);
          }
        }
      }
    };

    walk(root, "", "");

    const staticRefs = new WeakMap<object, string>();
    const dynamicRefs = new WeakMap<object, string>();
    let done = 0;
    while (done < pendingRefs.length) {
      const item = pendingRefs[done++]!;
      const uri = resolveUri(item.base, item.ref);
      const resource = resources.get(uri);
      if (resource === undefined) {
        throw new RemoteRefError(uri.length === 0 ? item.ref : uri);
      }
      const hashIdx = item.ref.indexOf("#");
      const rawFrag = hashIdx >= 0 ? item.ref.slice(hashIdx + 1) : "";
      const fragment = percentDecode(rawFrag);
      let target: string;
      if (fragment.length === 0) {
        target = resource;
      } else if (fragment.startsWith("/")) {
        target = `${resource}${fragment}`;
      } else {
        const resolvedAnchor = anchors.get(`${uri}#${fragment}`);
        if (resolvedAnchor === undefined) {
          throw new SchemaParseError(
            "bad-ref",
            item.ref,
            `$ref ${item.ref} points at nothing in this schema`,
          );
        }
        target = resolvedAnchor;
      }
      const resolvedTarget = resolvePointer(root, target);
      if (resolvedTarget === undefined) {
        throw new SchemaParseError(
          "bad-ref",
          item.ref,
          `$ref ${item.ref} points at nothing in this schema`,
        );
      }
      walk(resolvedTarget, target, uri);
      if (item.dynamic) dynamicRefs.set(item.node, target);
      else staticRefs.set(item.node, target);
    }

    return new LocalSchema(root, staticRefs, dynamicRefs, patterns);
  }

  checkValue(value: unknown, entryIndex?: number): ValidationResult {
    const rawFailures: SchemaFailure[] = [];
    this.checkNode(this.root, value, "", 0, rawFailures);
    return finalizeFailures(rawFailures, 1, entryIndex);
  }

  checkJsonSlice(bytes: Uint8Array, entryIndex?: number): ValidationResult {
    const parsed = parseJsonBytes(bytes, MAX_SLICE_BYTES);
    return this.checkValue(parsed, entryIndex);
  }

  checkHarEntries(
    entries: Iterable<HarEntryInput>,
    filter?: Partial<HarValidationFilter>,
  ): ValidationResult {
    const section = filter?.section ?? "response";
    const matcher = buildUrlMatcher(filter?.urlPattern ?? "");
    const collected: SchemaFailure[] = [];
    let checkedEntries = 0;

    for (const entry of entries) {
      if (collected.length >= MAX_FAILURES) break;
      if (!matcher(entry.url)) continue;

      const body = resolveHarBody(entry, section);
      if (!body.hasValue) continue;

      checkedEntries++;
      const entryFailures: SchemaFailure[] = [];
      this.checkNode(this.root, body.value, "", 0, entryFailures);
      const deduped = dedupeFailures(entryFailures, entry.entryIndex);
      for (const f of deduped) {
        if (collected.length >= MAX_FAILURES) break;
        collected.push(f);
      }
    }

    return {
      valid: collected.length === 0,
      failures: collected,
      truncated: collected.length >= MAX_FAILURES,
      checkedEntries,
    };
  }

  private passes(schema: JsonValue, value: unknown, pointer: string, depth: number): boolean {
    const probe: SchemaFailure[] = [];
    this.checkNode(schema, value, pointer, depth, probe);
    return probe.length === 0;
  }

  private checkNode(
    schema: JsonValue,
    value: unknown,
    pointer: string,
    depth: number,
    out: SchemaFailure[],
  ): void {
    if (out.length >= MAX_FAILURES) return;
    if (schema === true) return;
    if (schema === false) {
      out.push({ pointer, keyword: "false", message: "no value is allowed here" });
      return;
    }
    if (!isJsonObject(schema)) return;
    if (depth > MAX_REF_DEPTH) {
      out.push({
        pointer,
        keyword: "$ref",
        message: "the schema refers to itself without end here",
      });
      return;
    }

    const staticTarget = this.staticRefs.get(schema);
    if (staticTarget !== undefined) {
      const sub = resolvePointer(this.root, staticTarget);
      if (sub !== undefined) this.checkNode(sub, value, pointer, depth + 1, out);
    }
    const dynamicTarget = this.dynamicRefs.get(schema);
    if (dynamicTarget !== undefined) {
      const sub = resolvePointer(this.root, dynamicTarget);
      if (sub !== undefined) this.checkNode(sub, value, pointer, depth + 1, out);
    }

    this.checkAny(schema, value, pointer, depth, out);
    if (typeof value === "number") {
      this.checkNumeric(schema, value, pointer, out);
    } else if (typeof value === "string") {
      this.checkString(schema, value, pointer, out);
    } else if (Array.isArray(value)) {
      this.checkArray(schema, value, pointer, depth, out);
    } else if (isPlainObject(value)) {
      this.checkObject(schema, value, pointer, depth, out);
    }
  }

  private checkAny(
    m: Record<string, JsonValue>,
    value: unknown,
    pointer: string,
    depth: number,
    out: SchemaFailure[],
  ): void {
    const typeSpec = m.type;
    if (typeof typeSpec === "string") {
      if (!typeMatches(value, typeSpec)) {
        out.push({
          pointer,
          keyword: "type",
          message: `expected ${typeSpec}, found ${kindName(value)}`,
        });
      }
    } else if (Array.isArray(typeSpec)) {
      const names = typeSpec.filter((t): t is string => typeof t === "string");
      if (!names.some((t) => typeMatches(value, t))) {
        out.push({
          pointer,
          keyword: "type",
          message: `expected ${names.join(" or ")}, found ${kindName(value)}`,
        });
      }
    }

    if (Object.hasOwn(m, "const")) {
      const expected = m.const!;
      if (!jsonEquals(value, expected)) {
        out.push({
          pointer,
          keyword: "const",
          message: `must be ${quoteShort(expected)}`,
        });
      }
    }

    if (Array.isArray(m.enum)) {
      const list = m.enum;
      if (!list.some((item) => jsonEquals(value, item))) {
        out.push({
          pointer,
          keyword: "enum",
          message: `${showInstance(value)} is not one of ${quoteShort(list)}`,
        });
      }
    }

    if (Array.isArray(m.allOf)) {
      for (const s of m.allOf) {
        this.checkNode(s, value, pointer, depth + 1, out);
      }
    }

    if (Array.isArray(m.anyOf)) {
      let first: SchemaFailure[] = [];
      let ok = false;
      for (let i = 0; i < m.anyOf.length; i++) {
        const sub: SchemaFailure[] = [];
        this.checkNode(m.anyOf[i]!, value, pointer, depth + 1, sub);
        if (sub.length === 0) {
          ok = true;
          break;
        }
        if (i === 0) first = sub;
      }
      if (!ok) {
        const firstSame = first.find((f) => f.pointer === pointer);
        const why = firstSame !== undefined ? ` (the first: ${firstSame.message})` : "";
        out.push({
          pointer,
          keyword: "anyOf",
          message: `matches none of the anyOf schemas${why}`,
        });
      }
    }

    if (Array.isArray(m.oneOf)) {
      let matched = 0;
      for (const s of m.oneOf) {
        if (this.passes(s, value, pointer, depth + 1)) matched++;
      }
      if (matched !== 1) {
        out.push({
          pointer,
          keyword: "oneOf",
          message:
            matched === 0
              ? "matches none of the oneOf schemas"
              : `matches ${matched} of the oneOf schemas, not exactly one`,
        });
      }
    }

    if (Object.hasOwn(m, "not") && this.passes(m.not!, value, pointer, depth + 1)) {
      out.push({
        pointer,
        keyword: "not",
        message: "must not match the not schema",
      });
    }

    if (Object.hasOwn(m, "if")) {
      const branch = this.passes(m.if!, value, pointer, depth + 1) ? m.then : m.else;
      if (branch !== undefined) {
        this.checkNode(branch, value, pointer, depth + 1, out);
      }
    }
  }

  private checkNumeric(
    m: Record<string, JsonValue>,
    x: number,
    pointer: string,
    out: SchemaFailure[],
  ): void {
    const lit = String(x);
    if (typeof m.multipleOf === "number" && m.multipleOf > 0) {
      const d = m.multipleOf;
      const q = x / d;
      if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(Math.abs(q), 1.0)) {
        out.push({
          pointer,
          keyword: "multipleOf",
          message: `${lit} is not a multiple of ${d}`,
        });
      }
    }
    if (typeof m.maximum === "number") {
      if (m.exclusiveMaximum === true) {
        if (x >= m.maximum) {
          out.push({
            pointer,
            keyword: "exclusiveMaximum",
            message: `${lit} is not below ${m.maximum}`,
          });
        }
      } else if (x > m.maximum) {
        out.push({
          pointer,
          keyword: "maximum",
          message: `${lit} is above the maximum ${m.maximum}`,
        });
      }
    }
    if (typeof m.exclusiveMaximum === "number" && x >= m.exclusiveMaximum) {
      out.push({
        pointer,
        keyword: "exclusiveMaximum",
        message: `${lit} is not below ${m.exclusiveMaximum}`,
      });
    }
    if (typeof m.minimum === "number") {
      if (m.exclusiveMinimum === true) {
        if (x <= m.minimum) {
          out.push({
            pointer,
            keyword: "exclusiveMinimum",
            message: `${lit} is not above ${m.minimum}`,
          });
        }
      } else if (x < m.minimum) {
        out.push({
          pointer,
          keyword: "minimum",
          message: `${lit} is below the minimum ${m.minimum}`,
        });
      }
    }
    if (typeof m.exclusiveMinimum === "number" && x <= m.exclusiveMinimum) {
      out.push({
        pointer,
        keyword: "exclusiveMinimum",
        message: `${lit} is not above ${m.exclusiveMinimum}`,
      });
    }
  }

  private checkString(
    m: Record<string, JsonValue>,
    s: string,
    pointer: string,
    out: SchemaFailure[],
  ): void {
    const len = codePointCount(s);
    if (typeof m.maxLength === "number" && Number.isInteger(m.maxLength) && m.maxLength >= 0) {
      if (len > m.maxLength) {
        out.push({
          pointer,
          keyword: "maxLength",
          message: `longer than ${plural(m.maxLength, "character", "characters")}`,
        });
      }
    }
    if (typeof m.minLength === "number" && Number.isInteger(m.minLength) && m.minLength >= 0) {
      if (len < m.minLength) {
        out.push({
          pointer,
          keyword: "minLength",
          message: `shorter than ${plural(m.minLength, "character", "characters")}`,
        });
      }
    }
    if (typeof m.pattern === "string") {
      const re = this.patterns.get(m.pattern);
      if (re !== undefined && !re.test(s)) {
        out.push({
          pointer,
          keyword: "pattern",
          message: `does not match ${m.pattern}`,
        });
      }
    }
  }

  private checkArray(
    m: Record<string, JsonValue>,
    items: ReadonlyArray<unknown>,
    pointer: string,
    depth: number,
    out: SchemaFailure[],
  ): void {
    const count = items.length;
    const tuple = Array.isArray(m.prefixItems)
      ? m.prefixItems
      : Array.isArray(m.items)
        ? m.items
        : null;
    const rest =
      m.items !== undefined && !Array.isArray(m.items)
        ? m.items
        : !Array.isArray(m.prefixItems) && Array.isArray(m.items)
          ? m.additionalItems
          : undefined;
    const fixed = tuple === null ? 0 : tuple.length;

    if (typeof m.maxItems === "number" && Number.isInteger(m.maxItems) && m.maxItems >= 0) {
      if (count > m.maxItems) {
        out.push({
          pointer,
          keyword: "maxItems",
          message: `more than ${plural(m.maxItems, "item", "items")}`,
        });
      }
    }
    if (typeof m.minItems === "number" && Number.isInteger(m.minItems) && m.minItems >= 0) {
      if (count < m.minItems) {
        out.push({
          pointer,
          keyword: "minItems",
          message: `fewer than ${plural(m.minItems, "item", "items")}`,
        });
      }
    }
    if (m.uniqueItems === true) {
      const seen = new Map<string, number>();
      for (let i = 0; i < count; i++) {
        const key = canonicalValueKey(items[i]);
        const prev = seen.get(key);
        if (prev !== undefined) {
          out.push({
            pointer,
            keyword: "uniqueItems",
            message: `items ${prev} and ${i} are equal`,
          });
          break;
        }
        seen.set(key, i);
      }
    }
    if (Object.hasOwn(m, "contains")) {
      const s = m.contains!;
      let hits = 0;
      for (let i = 0; i < count; i++) {
        if (this.passes(s, items[i], `${pointer}/${i}`, depth + 1)) hits++;
      }
      const min =
        typeof m.minContains === "number" && Number.isInteger(m.minContains) && m.minContains >= 0
          ? m.minContains
          : 1;
      if (hits < min) {
        out.push({
          pointer,
          keyword: "contains",
          message:
            min === 1
              ? "no item matches contains"
              : `${hits} items match contains, fewer than ${min}`,
        });
      }
      if (
        typeof m.maxContains === "number" &&
        Number.isInteger(m.maxContains) &&
        m.maxContains >= 0 &&
        hits > m.maxContains
      ) {
        out.push({
          pointer,
          keyword: "maxContains",
          message: `${hits} items match contains, more than ${m.maxContains}`,
        });
      }
    }

    for (let i = 0; i < count; i++) {
      const childPointer = `${pointer}/${i}`;
      const positional = tuple !== null && i < tuple.length ? tuple[i] : undefined;
      if (positional !== undefined) {
        this.checkNode(positional, items[i], childPointer, depth + 1, out);
      } else if (i >= fixed && rest !== undefined) {
        this.checkNode(rest, items[i], childPointer, depth + 1, out);
      }
    }
  }

  private checkObject(
    m: Record<string, JsonValue>,
    obj: Record<string, unknown>,
    pointer: string,
    depth: number,
    out: SchemaFailure[],
  ): void {
    const keys = Object.keys(obj);
    const props = isJsonObject(m.properties) ? m.properties : null;
    const patProps = isJsonObject(m.patternProperties) ? m.patternProperties : null;

    for (const key of keys) {
      const childPointer = `${pointer}/${escapePointerToken(key)}`;
      const val = obj[key];
      let matched = false;
      if (props !== null && Object.hasOwn(props, key)) {
        matched = true;
        this.checkNode(props[key]!, val, childPointer, depth + 1, out);
      }
      if (patProps !== null) {
        for (const p of Object.keys(patProps)) {
          const re = this.patterns.get(p);
          if (re !== undefined && re.test(key)) {
            matched = true;
            this.checkNode(patProps[p]!, val, childPointer, depth + 1, out);
          }
        }
      }
      if (!matched && Object.hasOwn(m, "additionalProperties")) {
        const add = m.additionalProperties!;
        if (add === false) {
          out.push({
            pointer: childPointer,
            keyword: "additionalProperties",
            message: `property ${quoteShort(key)} is not allowed`,
          });
        } else {
          this.checkNode(add, val, childPointer, depth + 1, out);
        }
      }
      if (Object.hasOwn(m, "propertyNames")) {
        const why = this.checkPropertyName(m.propertyNames!, key, depth + 1);
        if (why !== null) {
          out.push({
            pointer: childPointer,
            keyword: "propertyNames",
            message: `property name ${quoteShort(key)}: ${why}`,
          });
        }
      }
    }

    if (Array.isArray(m.required)) {
      for (const reqKey of m.required) {
        if (typeof reqKey === "string" && !Object.hasOwn(obj, reqKey)) {
          out.push({
            pointer,
            keyword: "required",
            message: `missing required property ${quoteShort(reqKey)}`,
          });
        }
      }
    }

    const count = keys.length;
    if (
      typeof m.maxProperties === "number" &&
      Number.isInteger(m.maxProperties) &&
      m.maxProperties >= 0 &&
      count > m.maxProperties
    ) {
      out.push({
        pointer,
        keyword: "maxProperties",
        message: `more than ${plural(m.maxProperties, "property", "properties")}`,
      });
    }
    if (
      typeof m.minProperties === "number" &&
      Number.isInteger(m.minProperties) &&
      m.minProperties >= 0 &&
      count < m.minProperties
    ) {
      out.push({
        pointer,
        keyword: "minProperties",
        message: `fewer than ${plural(m.minProperties, "property", "properties")}`,
      });
    }

    const checkRequiredBy = (k: string, need: JsonValue, keyword: string) => {
      if (!Array.isArray(need)) return;
      for (const d of need) {
        if (typeof d === "string" && !Object.hasOwn(obj, d)) {
          out.push({
            pointer,
            keyword,
            message: `${quoteShort(k)} requires ${quoteShort(d)}`,
          });
        }
      }
    };

    if (isJsonObject(m.dependentRequired)) {
      for (const k of Object.keys(m.dependentRequired)) {
        if (Object.hasOwn(obj, k)) {
          checkRequiredBy(k, m.dependentRequired[k]!, "dependentRequired");
        }
      }
    }
    if (isJsonObject(m.dependentSchemas)) {
      for (const k of Object.keys(m.dependentSchemas)) {
        if (Object.hasOwn(obj, k)) {
          this.checkNode(m.dependentSchemas[k]!, obj, pointer, depth + 1, out);
        }
      }
    }
    if (isJsonObject(m.dependencies)) {
      for (const k of Object.keys(m.dependencies)) {
        if (!Object.hasOwn(obj, k)) continue;
        const dep = m.dependencies[k]!;
        if (Array.isArray(dep)) checkRequiredBy(k, dep, "dependencies");
        else this.checkNode(dep, obj, pointer, depth + 1, out);
      }
    }
  }

  private checkPropertyName(schema: JsonValue, key: string, depth: number): string | null {
    if (schema === true) return null;
    if (schema === false) return "no name is allowed";
    if (!isJsonObject(schema)) return null;
    if (depth > MAX_REF_DEPTH) return "the schema refers to itself without end here";

    const staticTarget = this.staticRefs.get(schema);
    if (staticTarget !== undefined) {
      const sub = resolvePointer(this.root, staticTarget);
      if (sub !== undefined) {
        const why = this.checkPropertyName(sub, key, depth + 1);
        if (why !== null) return why;
      }
    }
    const dynamicTarget = this.dynamicRefs.get(schema);
    if (dynamicTarget !== undefined) {
      const sub = resolvePointer(this.root, dynamicTarget);
      if (sub !== undefined) {
        const why = this.checkPropertyName(sub, key, depth + 1);
        if (why !== null) return why;
      }
    }

    if (typeof schema.type === "string") {
      if (schema.type !== "string") return `expected ${schema.type}`;
    } else if (Array.isArray(schema.type)) {
      if (!schema.type.some((t) => t === "string")) return "expected a non-string type";
    }
    if (Object.hasOwn(schema, "const") && schema.const !== key) {
      return `must be ${quoteShort(schema.const!)}`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === key)) {
      return `is not one of ${quoteShort(schema.enum)}`;
    }
    const len = codePointCount(key);
    if (
      typeof schema.maxLength === "number" &&
      Number.isInteger(schema.maxLength) &&
      schema.maxLength >= 0 &&
      len > schema.maxLength
    ) {
      return `longer than ${plural(schema.maxLength, "character", "characters")}`;
    }
    if (
      typeof schema.minLength === "number" &&
      Number.isInteger(schema.minLength) &&
      schema.minLength >= 0 &&
      len < schema.minLength
    ) {
      return `shorter than ${plural(schema.minLength, "character", "characters")}`;
    }
    if (typeof schema.pattern === "string") {
      const re = this.patterns.get(schema.pattern);
      if (re !== undefined && !re.test(key)) return `does not match ${schema.pattern}`;
    }
    if (Array.isArray(schema.allOf)) {
      for (const s of schema.allOf) {
        const why = this.checkPropertyName(s, key, depth + 1);
        if (why !== null) return why;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      if (!schema.anyOf.some((s) => this.checkPropertyName(s, key, depth + 1) === null)) {
        return "matches none of the anyOf schemas";
      }
    }
    if (Array.isArray(schema.oneOf)) {
      let matched = 0;
      for (const s of schema.oneOf) {
        if (this.checkPropertyName(s, key, depth + 1) === null) matched++;
      }
      if (matched !== 1) return `matches ${matched} of the oneOf schemas, not exactly one`;
    }
    if (Object.hasOwn(schema, "not")) {
      if (this.checkPropertyName(schema.not!, key, depth + 1) === null) {
        return "must not match the not schema";
      }
    }
    return null;
  }
}

export interface HarEntryInput {
  readonly entryIndex: number;
  readonly url: string;
  readonly bodyText?: string | null;
  readonly bodyBytes?: Uint8Array | null;
  readonly bodyValue?: unknown;
  readonly encoding?: string | null;
  readonly requestBodyText?: string | null;
  readonly requestBodyBytes?: Uint8Array | null;
  readonly requestBodyValue?: unknown;
}

function decodeBase64Bytes(text: string): Uint8Array | null {
  const raw = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    raw[i] = text.charCodeAt(i) & 0xff;
  }
  const dec = new Base64Decoder();
  const out = new Uint8Array(base64MaxDecoded(raw.length));
  const written = dec.push(raw, 0, raw.length, out, 0);
  if (dec.invalid > 0) return null;
  return out.subarray(0, written);
}

function resolveHarBody(
  entry: HarEntryInput,
  section: "response" | "request",
): { hasValue: true; value: unknown } | { hasValue: false } {
  const direct = section === "response" ? entry.bodyValue : entry.requestBodyValue;
  if (direct !== undefined) return { hasValue: true, value: direct };

  const rawBytes = section === "response" ? entry.bodyBytes : entry.requestBodyBytes;
  if (rawBytes !== null && rawBytes !== undefined) {
    try {
      return { hasValue: true, value: parseJsonBytes(rawBytes, MAX_SLICE_BYTES) };
    } catch {
      return { hasValue: false };
    }
  }

  const rawText = section === "response" ? entry.bodyText : entry.requestBodyText;
  if (rawText === null || rawText === undefined) return { hasValue: false };
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return { hasValue: false };

  if (section === "response" && entry.encoding === "base64") {
    const decoded = decodeBase64Bytes(trimmed);
    if (decoded === null) return { hasValue: false };
    try {
      return { hasValue: true, value: parseJsonBytes(decoded, MAX_SLICE_BYTES) };
    } catch {
      return { hasValue: false };
    }
  }

  try {
    return { hasValue: true, value: parseJsonValue(trimmed) };
  } catch {
    return { hasValue: false };
  }
}

function buildUrlMatcher(pattern: string): (url: string) => boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return () => true;
  if (trimmed.startsWith("/") && trimmed.endsWith("/") && trimmed.length >= 2) {
    try {
      const re = new RegExp(trimmed.slice(1, -1));
      return (url) => re.test(url);
    } catch {
      return (url) => url.includes(trimmed);
    }
  }
  if (trimmed.includes("*")) {
    const escaped = trimmed.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    const re = new RegExp(escaped);
    return (url) => re.test(url);
  }
  return (url) => url.includes(trimmed);
}

function dedupeFailures(raw: ReadonlyArray<SchemaFailure>, entryIndex?: number): SchemaFailure[] {
  const pointerOrder = new Map<string, number>();
  const seen = new Set<string>();
  const out: SchemaFailure[] = [];
  for (const f of raw) {
    if (!pointerOrder.has(f.pointer)) {
      pointerOrder.set(f.pointer, pointerOrder.size);
    }
    const key = `${f.pointer}\0${f.keyword}\0${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      entryIndex === undefined
        ? f
        : { pointer: f.pointer, keyword: f.keyword, message: f.message, entryIndex },
    );
    if (out.length >= MAX_FAILURES) break;
  }
  out.sort((a, b) => {
    const pa = pointerOrder.get(a.pointer) ?? 0;
    const pb = pointerOrder.get(b.pointer) ?? 0;
    if (pa !== pb) return pa - pb;
    if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
  return out;
}

function finalizeFailures(
  raw: ReadonlyArray<SchemaFailure>,
  checkedEntries: number,
  entryIndex?: number,
): ValidationResult {
  const failures = dedupeFailures(raw, entryIndex);
  return {
    valid: failures.length === 0,
    failures,
    truncated: raw.length >= MAX_FAILURES && failures.length >= MAX_FAILURES,
    checkedEntries,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function kindName(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

function typeMatches(v: unknown, name: string): boolean {
  switch (name) {
    case "object":
      return isPlainObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false;
  }
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.hasOwn(b, k) || !jsonEquals(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function canonicalValueKey(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return `n${Object.is(v, -0) ? 0 : v}`;
  if (typeof v === "string") return `s${quoteJsonString(v)}`;
  if (Array.isArray(v)) {
    return `[${v.map((item) => canonicalValueKey(item)).join(",")}]`;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${quoteJsonString(k)}:${canonicalValueKey(v[k])}`).join(",")}}`;
  }
  return String(v);
}

function quoteShort(v: JsonValue): string {
  const s = formatJsonCompact(v);
  const chars = [...s];
  if (chars.length > 60) {
    return `${chars.slice(0, 59).join("")}\u2026`;
  }
  return s;
}

function showInstance(v: unknown): string {
  if (typeof v === "string") return quoteShort(v);
  if (isPlainObject(v)) return "the object";
  if (Array.isArray(v)) return "the array";
  if (v === null) return "null";
  return String(v);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function codePointCount(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

export function parseSchema(text: string): LocalSchema {
  return LocalSchema.parse(text);
}

export function validateValue(
  schema: LocalSchema,
  value: unknown,
  entryIndex?: number,
): ValidationResult {
  return schema.checkValue(value, entryIndex);
}

export function validateJsonSlice(
  schema: LocalSchema,
  bytes: Uint8Array,
  entryIndex?: number,
): ValidationResult {
  return schema.checkJsonSlice(bytes, entryIndex);
}

export function validateHarEntries(
  schema: LocalSchema,
  entries: Iterable<HarEntryInput>,
  filter?: Partial<HarValidationFilter>,
): ValidationResult {
  return schema.checkHarEntries(entries, filter);
}
