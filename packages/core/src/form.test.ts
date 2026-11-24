import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { decodeUtf8 } from "./boundedSlice.ts";
import { formToJson, parseForm } from "./form.ts";
import { formBody } from "./testing/decoderSamples.ts";

const utf8 = new TextEncoder();
const pairs = Arbitrary.schema(
  Schema.Array(Schema.Tuple([Schema.String, Schema.String])).check(Schema.isMaxLength(12)),
).pipe(
  Arbitrary.map((list) =>
    list.map(([name, value]) => [name.toWellFormed(), value.toWellFormed()] as const),
  ),
);

describe("URL-encoded form bodies", () => {
  it.prop(
    "decode to the names and values that were encoded",
    [pairs],
    ([input]) => {
      const named = input.filter(([name]) => name !== "");
      const { fields, total } = parseForm(utf8.encode(formBody(named)));
      expect(fields.map((f) => [f.name, f.value])).toEqual(named.map(([k, v]) => [k, v]));
      expect(total).toBe(named.length);
    },
    { arbitrary: { runs: 300 } },
  );

  it.prop(
    "become a JSON object with the same members, in order",
    [pairs],
    ([input]) => {
      const seen = new Set<string>();
      const unique = input.filter(([name]) => name !== "" && !seen.has(name) && seen.add(name));
      const object = JSON.parse(decodeUtf8(formToJson(utf8.encode(formBody(unique))))) as Record<
        string,
        string
      >;
      expect(Object.keys(object).length).toBe(unique.length);
      for (const [name, value] of unique) expect(object[name]).toBe(value);
    },
    { arbitrary: { runs: 200 } },
  );

  it("keeps repeated names as repeated members", () => {
    const json = decodeUtf8(formToJson(utf8.encode("tag=a&tag=b&tag=c")));
    expect(json).toBe('{"tag":"a","tag":"b","tag":"c"}');
  });

  it("leaves a stray percent sign alone, as a browser does", () => {
    const { fields } = parseForm(utf8.encode("a=100%&b=%zz&c=%41"));
    expect(fields).toEqual([
      { name: "a", value: "100%" },
      { name: "b", value: "%zz" },
      { name: "c", value: "A" },
    ]);
  });

  it("caps the fields it lists and still counts them all", () => {
    const body = Array.from({ length: 500 }, (_, i) => `k${i}=${i}`).join("&");
    const { fields, total } = parseForm(utf8.encode(body), 50);
    expect(fields.length).toBe(50);
    expect(total).toBe(500);
  });
});
