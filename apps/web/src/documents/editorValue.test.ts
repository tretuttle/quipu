import { describe, expect, it } from "vite-plus/test";

import { editorText, editorValue } from "./editorValue.ts";

describe("what the value editor writes", () => {
  it.each([
    ["42", "42", "number"],
    ["-1.5e3", "-1.5e3", "number"],
    ["true", "true", "boolean"],
    ["null", "null", "null"],
    [`"text"`, `"text"`, "string"],
    [`{"a":1}`, `{"a":1}`, "object"],
    ["[1, 2]", "[1, 2]", "array"],
    ["  7  ", "7", "number"],
  ])("%s is that JSON value", (typed, json, type) => {
    expect(editorValue(typed)).toEqual({ valid: true, json, type });
  });

  it.each([
    ["hello", `"hello"`],
    ["", `""`],
    ["1 2", `"1 2"`],
    ["12 apples", `"12 apples"`],
    [" padded ", `" padded "`],
    ['say "hi"', `"say \\"hi\\""`],
    ["Infinity", `"Infinity"`],
    ["'single quoted'", `"'single quoted'"`],
  ])("%j, which does not try to be JSON, is a string", (typed, json) => {
    expect(editorValue(typed)).toEqual({ valid: true, json, type: "string" });
  });

  it.each([
    ["[1,2", "Not valid JSON: expected ',' or ']' after array element at line 1, column 5."],
    ["{a: 1}", "Not valid JSON: expected property name or '}' at line 1, column 2."],
    [`{"a":}`, "Not valid JSON: unexpected token '}'."],
    [`"unclosed`, "Not valid JSON: unterminated string at line 1, column 10."],
    ["[", "Not valid JSON: it ends before the value is complete."],
    ["007", "007 is not a JSON number."],
    ["1.2.3", "1.2.3 is not a JSON number."],
    ["-.5", "-.5 is not a JSON number."],
  ])(
    "%j starts like JSON and is not: it is refused, with the reason, and can be kept as text",
    (typed, problem) => {
      expect(editorValue(typed)).toEqual({ valid: false, problem, asText: JSON.stringify(typed) });
    },
  );

  it("names the problem without repeating a long text", () => {
    const typed = `{"a": }${" ".repeat(10_000)}`;
    const value = editorValue(typed);
    expect(value.valid).toBe(false);
    if (!value.valid) expect(value.problem.length).toBeLessThan(80);
  });

  it("starts a string from its content, quoted only when the content would read as something else", () => {
    // Every start, typed back unchanged, writes the string it came from.
    const contents = [
      "hello",
      "",
      "42",
      "true",
      "null",
      `"quoted"`,
      "[1]",
      " x ",
      "{a:1}",
      "[1,2",
      "007",
    ];
    for (const content of contents) {
      const start = editorText("string", content);
      expect(editorValue(start), content).toEqual({
        valid: true,
        json: JSON.stringify(content),
        type: "string",
      });
    }
    expect(editorText("string", "hello")).toBe("hello");
    expect(editorText("string", "42")).toBe(`"42"`);
    expect(editorText("string", "[1,2")).toBe(`"[1,2"`);
    expect(editorText("number", "42")).toBe("42");
    expect(editorText("object", `{"a": 1}`)).toBe(`{"a": 1}`);
  });
});
