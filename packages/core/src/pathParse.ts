/**
 * The JSONPath subset the path bar speaks, after RFC 9535:
 *
 *     $            the root
 *     .key         member shorthand: letters, digits, `_` and `-`, not starting with a digit
 *     .*  [*]      every child
 *     ['key']      a member, single or double quoted, with JSON escapes
 *     [n]  [-n]    an element, counted from the end when negative
 *     [a:b:c]      a slice: start, end (exclusive) and step, each optional
 *     ..key ..*    the same, over the node and all its descendants
 *     [a, b]       a union of the selectors above
 *     [?(expr)]    filter predicates (`&&`, `||`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `@`, `$`, literals)
 *
 * Function extensions and bare script expressions `[(...)]` are refused with a clear message.
 * The parser is pure: it takes text and returns a tree.
 */

export interface FilterPath {
  readonly absolute: boolean;
  readonly segments: PathExpression;
}

export type FilterLiteral =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string };

export type FilterOperand =
  | { readonly kind: "literal"; readonly literal: FilterLiteral }
  | { readonly kind: "path"; readonly path: FilterPath };

export type FilterCmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type FilterExpr =
  | { readonly kind: "or"; readonly left: FilterExpr; readonly right: FilterExpr }
  | { readonly kind: "and"; readonly left: FilterExpr; readonly right: FilterExpr }
  | { readonly kind: "not"; readonly expr: FilterExpr }
  | { readonly kind: "exists"; readonly path: FilterPath }
  | {
      readonly kind: "compare";
      readonly left: FilterOperand;
      readonly op: FilterCmpOp;
      readonly right: FilterOperand;
    };

export type Selector =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "wildcard" }
  | {
      readonly kind: "slice";
      readonly start: number | null;
      readonly end: number | null;
      readonly step: number | null;
    }
  | { readonly kind: "filter"; readonly expr: FilterExpr };

export interface Segment {
  /** `..`: apply the selectors to the node and all its descendants. */
  readonly descendant: boolean;
  readonly selectors: ReadonlyArray<Selector>;
}

export type PathExpression = ReadonlyArray<Segment>;

export class PathSyntaxError extends Error {
  readonly at: number;
  constructor(detail: string, at: number) {
    super(detail);
    this.name = "PathSyntaxError";
    this.at = at;
  }
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isNameStart = (c: string | undefined) =>
  c !== undefined &&
  ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c >= "\u0080");
const isNameChar = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === "-";

/** The largest integer a path may hold, so index arithmetic stays exact. */
const MAX_INDEX = 2 ** 53 - 1;

const CMP_OPS: ReadonlyArray<FilterCmpOp> = ["==", "!=", "<=", ">=", "<", ">"];
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export const parsePath = (text: string): PathExpression => {
  let i = 0;
  const fail = (detail: string, at = i): never => {
    throw new PathSyntaxError(detail, at);
  };
  const skipSpace = () => {
    while (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i++;
  };

  const integer = (): number => {
    const start = i;
    if (text[i] === "-") i++;
    if (!isDigit(text[i])) return fail("expected a number", i);
    if (text[i] === "0" && isDigit(text[i + 1])) return fail("a number has no leading zero", i);
    while (isDigit(text[i])) i++;
    const raw = text.slice(start, i);
    if (raw === "-0") return fail("-0 is not a number", start);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_INDEX) {
      return fail("the number is too large", start);
    }
    return value;
  };

  const quoted = (): string => {
    const quote = text[i];
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) return fail("the string is not closed", i);
      if (c === quote) {
        i++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = text[i + 1];
      i += 2;
      switch (e) {
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
        case "/":
        case "\\":
          out += e;
          break;
        case "'":
        case '"':
          if (e !== quote)
            return fail(`\\${e} is only an escape inside ${e === "'" ? "'…'" : '"…"'}`, i - 2);
          out += e;
          break;
        case "u": {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("\\u needs four hex digits", i - 2);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          return fail("unknown escape", i - 2);
      }
    }
  };

  const shorthand = (): Selector => {
    if (text[i] === "*") {
      i++;
      return { kind: "wildcard" };
    }
    if (!isNameStart(text[i])) {
      return fail(
        isDigit(text[i]) ? "a name cannot start with a digit; use ['…']" : "expected a name",
        i,
      );
    }
    const start = i;
    while (isNameChar(text[i])) i++;
    const name = text.slice(start, i);
    if (text[i] === "(") return fail(`function ${name}() is not supported`, start);
    return { kind: "name", name };
  };

  const parseSubSegments = (): PathExpression => {
    const segments: Segment[] = [];
    for (;;) {
      const save = i;
      skipSpace();
      if (text[i] === "." && text[i + 1] === ".") {
        i += 2;
        if (text[i] === "[") segments.push({ descendant: true, selectors: bracket() });
        else segments.push({ descendant: true, selectors: [shorthand()] });
      } else if (text[i] === ".") {
        i++;
        segments.push({ descendant: false, selectors: [shorthand()] });
      } else if (text[i] === "[") {
        segments.push({ descendant: false, selectors: bracket() });
      } else {
        i = save;
        return segments;
      }
    }
  };

  const filterOperand = (): FilterOperand => {
    skipSpace();
    const c = text[i];
    if (c === "@") {
      i++;
      return { kind: "path", path: { absolute: false, segments: parseSubSegments() } };
    }
    if (c === "$") {
      i++;
      return { kind: "path", path: { absolute: true, segments: parseSubSegments() } };
    }
    if (c === "'" || c === '"') {
      return { kind: "literal", literal: { kind: "string", value: quoted() } };
    }
    for (const [word, literal] of [
      ["true", { kind: "boolean", value: true }],
      ["false", { kind: "boolean", value: false }],
      ["null", { kind: "null" }],
    ] as const) {
      if (text.startsWith(word, i) && !isNameChar(text[i + word.length])) {
        i += word.length;
        return { kind: "literal", literal };
      }
    }
    const numMatch = JSON_NUMBER_RE.exec(text.slice(i));
    if (numMatch !== null) {
      const n = Number(numMatch[0]);
      if (Number.isFinite(n)) {
        i += numMatch[0].length;
        return { kind: "literal", literal: { kind: "number", value: n } };
      }
    }
    if (isNameStart(c)) {
      const start = i;
      while (isNameChar(text[i])) i++;
      const name = text.slice(start, i);
      if (text[i] === "(") return fail(`function ${name}() is not supported`, start);
      i = start;
    }
    return fail("expected a value, @ or $", i);
  };

  const filterNot = (): FilterExpr => {
    skipSpace();
    if (text[i] === "!" && text[i + 1] !== "=") {
      i++;
      return { kind: "not", expr: filterNot() };
    }
    if (text[i] === "(") {
      i++;
      const expr = filterOr();
      skipSpace();
      if (text[i] !== ")") return fail("expected )", i);
      i++;
      return expr;
    }
    const leftAt = i;
    const left = filterOperand();
    skipSpace();
    for (const op of CMP_OPS) {
      if (text.startsWith(op, i)) {
        i += op.length;
        return { kind: "compare", left, op, right: filterOperand() };
      }
    }
    if (left.kind === "path") return { kind: "exists", path: left.path };
    return fail("expected a comparison such as ==", leftAt);
  };

  const filterAnd = (): FilterExpr => {
    let left = filterNot();
    for (;;) {
      skipSpace();
      if (!text.startsWith("&&", i)) return left;
      i += 2;
      left = { kind: "and", left, right: filterNot() };
    }
  };

  const filterOr = (): FilterExpr => {
    let left = filterAnd();
    for (;;) {
      skipSpace();
      if (!text.startsWith("||", i)) return left;
      i += 2;
      left = { kind: "or", left, right: filterAnd() };
    }
  };

  const selector = (): Selector => {
    skipSpace();
    const c = text[i];
    if (c === "*") {
      i++;
      return { kind: "wildcard" };
    }
    if (c === "'" || c === '"') return { kind: "name", name: quoted() };
    if (c === "?") {
      i++;
      return { kind: "filter", expr: filterOr() };
    }
    if (c === "@" || c === "(")
      return fail("expressions are not supported here; the jq bar can run them", i);
    if (c === undefined) return fail("the bracket is not closed", i);
    if (c !== ":" && c !== "-" && !isDigit(c)) {
      return fail("inside [ ] put an index, a slice such as 0:5, * or a quoted 'name'", i);
    }
    // An integer, or a slice that may begin with `:`.
    let start: number | null = null;
    if (c !== ":") start = integer();
    skipSpace();
    if (text[i] !== ":") {
      if (start === null) return fail("expected a selector", i);
      return { kind: "index", index: start };
    }
    i++;
    skipSpace();
    let end: number | null = null;
    if (text[i] !== ":" && text[i] !== "]" && text[i] !== ",") end = integer();
    skipSpace();
    let step: number | null = null;
    if (text[i] === ":") {
      i++;
      skipSpace();
      if (text[i] !== "]" && text[i] !== ",") step = integer();
      skipSpace();
    }
    return { kind: "slice", start, end, step };
  };

  const bracket = (): Selector[] => {
    // At the `[`.
    i++;
    const selectors: Selector[] = [selector()];
    for (;;) {
      skipSpace();
      if (text[i] === ",") {
        i++;
        selectors.push(selector());
        continue;
      }
      if (text[i] === "]") {
        i++;
        return selectors;
      }
      return fail(text[i] === undefined ? "the bracket is not closed" : "expected , or ]", i);
    }
  };

  skipSpace();
  if (text[i] !== "$") fail("a path starts with $", i);
  i++;
  const segments: Segment[] = [];
  for (;;) {
    skipSpace();
    if (i >= text.length) return segments;
    if (text[i] === ".") {
      if (text[i + 1] === ".") {
        i += 2;
        if (text[i] === "[") segments.push({ descendant: true, selectors: bracket() });
        else segments.push({ descendant: true, selectors: [shorthand()] });
      } else {
        i++;
        segments.push({ descendant: false, selectors: [shorthand()] });
      }
    } else if (text[i] === "[") {
      segments.push({ descendant: false, selectors: bracket() });
    } else {
      fail(`unexpected "${text[i]}"`, i);
    }
  }
};
