import { describe, expect, it } from "@effect/vitest";

import { parsePath, PathSyntaxError } from "./pathParse.ts";

const failure = (text: string) => {
  try {
    parsePath(text);
  } catch (error) {
    if (error instanceof PathSyntaxError) return { message: error.message, at: error.at };
    throw error;
  }
  throw new Error(`${text} parsed`);
};

describe("the path grammar", () => {
  it("reads every form of the subset", () => {
    expect(parsePath("$")).toEqual([]);
    expect(parsePath("$.log.entries[0]['request'][\"url\"]")).toEqual([
      { descendant: false, selectors: [{ kind: "name", name: "log" }] },
      { descendant: false, selectors: [{ kind: "name", name: "entries" }] },
      { descendant: false, selectors: [{ kind: "index", index: 0 }] },
      { descendant: false, selectors: [{ kind: "name", name: "request" }] },
      { descendant: false, selectors: [{ kind: "name", name: "url" }] },
    ]);
    expect(parsePath("$.*[*]..*..[*]")).toEqual([
      { descendant: false, selectors: [{ kind: "wildcard" }] },
      { descendant: false, selectors: [{ kind: "wildcard" }] },
      { descendant: true, selectors: [{ kind: "wildcard" }] },
      { descendant: true, selectors: [{ kind: "wildcard" }] },
    ]);
    expect(parsePath("$..price..['a b']")).toEqual([
      { descendant: true, selectors: [{ kind: "name", name: "price" }] },
      { descendant: true, selectors: [{ kind: "name", name: "a b" }] },
    ]);
  });

  it("reads indexes, negative indexes and slices with every part optional", () => {
    expect(parsePath("$[0][-1][1:3][:2][1:][::2][::-1][:]")[0]).toEqual({
      descendant: false,
      selectors: [{ kind: "index", index: 0 }],
    });
    expect(parsePath("$[1:3]")[0]?.selectors[0]).toEqual({
      kind: "slice",
      start: 1,
      end: 3,
      step: null,
    });
    expect(parsePath("$[:2]")[0]?.selectors[0]).toEqual({
      kind: "slice",
      start: null,
      end: 2,
      step: null,
    });
    expect(parsePath("$[1:]")[0]?.selectors[0]).toEqual({
      kind: "slice",
      start: 1,
      end: null,
      step: null,
    });
    expect(parsePath("$[::2]")[0]?.selectors[0]).toEqual({
      kind: "slice",
      start: null,
      end: null,
      step: 2,
    });
    expect(parsePath("$[::-1]")[0]?.selectors[0]).toEqual({
      kind: "slice",
      start: null,
      end: null,
      step: -1,
    });
    expect(parsePath("$[:]")[0]?.selectors[0]).toEqual({
      kind: "slice",
      start: null,
      end: null,
      step: null,
    });
  });

  it("reads a union and the escapes of a quoted name", () => {
    expect(parsePath("$['a', 'b' ,0, 1:2]")[0]?.selectors).toEqual([
      { kind: "name", name: "a" },
      { kind: "name", name: "b" },
      { kind: "index", index: 0 },
      { kind: "slice", start: 1, end: 2, step: null },
    ]);
    expect(parsePath("$['it\\'s \\\\ \\u00e9 \\n']")[0]?.selectors[0]).toEqual({
      kind: "name",
      name: "it's \\ é \n",
    });
    expect(parsePath('$["say \\"hi\\" \\/"]')[0]?.selectors[0]).toEqual({
      kind: "name",
      name: 'say "hi" /',
    });
  });

  it("reads filter predicates with comparisons, existence, boolean ops, and literals", () => {
    expect(parsePath("$.store.book[?@.isbn]")[2]?.selectors[0]).toEqual({
      kind: "filter",
      expr: {
        kind: "exists",
        path: {
          absolute: false,
          segments: [{ descendant: false, selectors: [{ kind: "name", name: "isbn" }] }],
        },
      },
    });
    expect(parsePath("$.store.book[?@.price < 10 && @.author != 'N']")[2]?.selectors[0]).toEqual({
      kind: "filter",
      expr: {
        kind: "and",
        left: {
          kind: "compare",
          left: {
            kind: "path",
            path: {
              absolute: false,
              segments: [{ descendant: false, selectors: [{ kind: "name", name: "price" }] }],
            },
          },
          op: "<",
          right: { kind: "literal", literal: { kind: "number", value: 10 } },
        },
        right: {
          kind: "compare",
          left: {
            kind: "path",
            path: {
              absolute: false,
              segments: [{ descendant: false, selectors: [{ kind: "name", name: "author" }] }],
            },
          },
          op: "!=",
          right: { kind: "literal", literal: { kind: "string", value: "N" } },
        },
      },
    });
    expect(parsePath("$[?!(@.ok == true || @.tag == null)]")[0]?.selectors[0]).toMatchObject({
      kind: "filter",
      expr: {
        kind: "not",
        expr: { kind: "or" },
      },
    });
  });

  it("says where and why a path is refused", () => {
    expect(failure("log.entries")).toEqual({ message: "a path starts with $", at: 0 });
    expect(failure("$.")).toMatchObject({ message: "expected a name", at: 2 });
    expect(failure("$.1a")).toMatchObject({ at: 2 });
    expect(failure("$[0")).toMatchObject({ message: "the bracket is not closed" });
    // An unfinished bracket says so, not that a number was expected.
    expect(failure("$[")).toMatchObject({ message: "the bracket is not closed", at: 2 });
    expect(failure("$[a]").message).toContain("put an index, a slice");
    expect(failure("$['a")).toMatchObject({ message: "the string is not closed" });
    expect(failure("$[01]")).toMatchObject({ message: "a number has no leading zero" });
    expect(failure("$[-0]")).toMatchObject({ message: "-0 is not a number" });
    expect(failure("$[(@.length-1)]").message).toContain("jq bar");
    expect(failure("$.store[?length(@) > 1]")).toMatchObject({ at: 9 });
    expect(failure("$.store[?length(@) > 1]").message).toContain("length()");
    expect(failure("$.store[?@.price <]").at).toBe(18);
    expect(failure("$[9007199254740993]").message).toBe("the number is too large");
    expect(failure("$.a b")).toMatchObject({ message: 'unexpected "b"', at: 4 });
    expect(failure("$['a\\x']")).toMatchObject({ message: "unknown escape" });
    expect(failure("$['\\ud83']")).toMatchObject({ message: "\\u needs four hex digits" });
  });
});
