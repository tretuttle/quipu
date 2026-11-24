import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readJson } from "./readJson.ts";

const Key = Schema.Array(
  Schema.Literals(["", "\u0000", "\u0001", "\u001f", "\n", '"', "\\", "/", " ", "é", "😀", "a"]),
).check(Schema.isMaxLength(3));
const Value: Schema.Codec<unknown> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.String,
  Schema.Struct({ list: Schema.Array(Schema.suspend(() => Value)).check(Schema.isMaxLength(4)) }),
  Schema.Struct({
    members: Schema.Array(Schema.Tuple([Key, Schema.suspend(() => Value)])).check(
      Schema.isMaxLength(4),
    ),
  }),
]);
/** The generated shape as a JSON value: members become own properties, whatever their names. */
const build = (raw: unknown): unknown => {
  // `-0` is written as `0`.
  if (typeof raw === "number") return raw === 0 ? 0 : raw;
  if (raw === null || typeof raw !== "object") return raw;
  if ("list" in raw) return (raw as { list: unknown[] }).list.map(build);
  const out: Record<string, unknown> = {};
  for (const [key, value] of (raw as { members: [string[], unknown][] }).members) {
    Object.defineProperty(out, key.join(""), {
      value: build(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
};
const keysOf = (value: unknown, out: string[] = []): string[] => {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keysOf(child, out);
    }
  }
  return out;
};

describe("the reference JSON reader", () => {
  it.live.prop(
    "reads back what JSON.stringify writes, member names and their order included",
    [Arbitrary.schema(Value), Arbitrary.schema(Schema.Boolean)],
    ([raw, pretty]) =>
      Effect.sync(() => {
        const value = build(raw);
        const text = JSON.stringify(value, null, pretty ? 2 : undefined);
        const read = readJson(text);
        expect(read).toEqual(value);
        expect(keysOf(read)).toEqual(keysOf(value));
      }),
    { arbitrary: { runs: 2000 } },
  );

  it("reads the one-character escaped names V8's JSON.parse was seen to return as a backslash", () => {
    expect(Object.keys(readJson('{"": 0, "\\u0001": 0}') as object)).toEqual(["", "\u0001"]);
    expect(Object.keys(readJson('{"":{},"\\\\/":true}') as object)).toEqual(["", "\\/"]);
    expect(Object.keys(readJson('{"":"","\\u0000":null,"\\u000f":false}') as object)).toEqual([
      "",
      "\u0000",
      "\u000f",
    ]);
  });

  it("keeps a repeated key in its first place with its last value, and __proto__ as a member", () => {
    const read = readJson('{"a":1,"b":2,"a":3,"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(Object.keys(read)).toEqual(["a", "b", "__proto__"]);
    expect(read.a).toBe(3);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(read, "__proto__")?.value).toEqual({ x: 1 });
  });

  it.each(['{"a":1,}', "[1,]", "{'a':1}", "01", '"a\u0001"', '"\\x"', "1 2", "", "tru"])(
    "refuses %j",
    (text) => {
      expect(() => readJson(text)).toThrow(SyntaxError);
    },
  );
});
