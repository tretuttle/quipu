/**
 * A plain reader of JSON text for tests to compare the engine against.
 *
 * `JSON.parse` cannot be that reference. In V8 (Node 24.21, Chromium 148 and
 * Electron 44 alike), after a few hundred parses it can return the wrong name
 * for a one-character member name written as an escape: `{"": 0, "\u0001": 0}`
 * comes back with a key `"\"`. A test that trusts it then reports a lost key the
 * engine never lost. This reader follows the JSON grammar and nothing else.
 * Members are own properties (a `__proto__` key included), and a repeated key
 * keeps its first place with the last value, as `JSON.parse` does.
 */
export function readJson(input: Uint8Array | string): unknown {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  let at = 0;

  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at ${at}`);
  };
  const space = () => {
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      at++;
    }
  };
  const string = (): string => {
    at++; // the opening quote
    let out = "";
    for (;;) {
      if (at >= text.length) fail("unterminated string");
      const c = text[at] as string;
      if (c === '"') {
        at++;
        return out;
      }
      if (c.charCodeAt(0) < 0x20) fail("control character in a string");
      if (c !== "\\") {
        out += c;
        at++;
        continue;
      }
      const e = text[at + 1];
      at += 2;
      switch (e) {
        case '"':
        case "\\":
        case "/":
          out += e;
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
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          at += 4;
          break;
        }
        default:
          fail("bad escape");
      }
    }
  };
  /** A scalar at `at`: a string, a literal or a number. */
  const scalar = (): unknown => {
    if (text[at] === '"') return string();
    for (const [word, literal] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return literal;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at, at + 400));
    if (number === null) return fail("unexpected character");
    at += number[0].length;
    return Number(number[0]);
  };

  // Iterative, so a document nested 100 k levels deep reads without touching the call stack.
  type Open =
    | { readonly kind: "array"; readonly value: unknown[] }
    | { readonly kind: "object"; readonly value: Record<string, unknown>; key: string };
  const stack: Open[] = [];
  const member = (object: Record<string, unknown>, key: string, child: unknown) =>
    Object.defineProperty(object, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  /** Reads a key and its colon into the open object, or returns false at its closing brace. */
  const nextKey = (open: Extract<Open, { kind: "object" }>) => {
    space();
    if (text[at] !== '"') fail("expected a key");
    open.key = string();
    space();
    if (text[at] !== ":") fail("expected a colon");
    at++;
  };
  const value = (): unknown => {
    for (;;) {
      space();
      let done: unknown;
      let complete = false;
      if (text[at] === "{") {
        at++;
        space();
        if (text[at] === "}") {
          at++;
          done = {};
          complete = true;
        } else {
          const open: Open = { kind: "object", value: {}, key: "" };
          nextKey(open);
          stack.push(open);
          continue;
        }
      } else if (text[at] === "[") {
        at++;
        space();
        if (text[at] === "]") {
          at++;
          done = [];
          complete = true;
        } else {
          stack.push({ kind: "array", value: [] });
          continue;
        }
      } else {
        done = scalar();
        complete = true;
      }
      // A value is complete: hand it to the containers it closes, innermost first.
      while (complete) {
        const open = stack[stack.length - 1];
        if (open === undefined) return done;
        if (open.kind === "array") open.value.push(done);
        else member(open.value, open.key, done);
        space();
        if (text[at] === ",") {
          at++;
          if (open.kind === "object") nextKey(open);
          complete = false;
        } else if (text[at] === (open.kind === "array" ? "]" : "}")) {
          at++;
          stack.pop();
          done = open.value;
        } else {
          fail(`expected a comma or a closing ${open.kind === "array" ? "bracket" : "brace"}`);
        }
      }
    }
  };

  const result = value();
  space();
  if (at !== text.length) fail("text after the value");
  return result;
}
