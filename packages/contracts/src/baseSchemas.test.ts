import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  PortSchema,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const at = "2026-10-05T00:00:00.000Z";
const Shape = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Number, at: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Number }),
]);
/** How a reader decodes persisted JSON: the JSON codec over the runtime schema. */
const fromWire = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never) as (value: unknown) => S["Type"];

describe("ForwardCompatibleArray", () => {
  it("decodes elements through their own codec and drops ones it cannot read", () => {
    const decoded = fromWire(ForwardCompatibleArray(Shape))([
      { kind: "circle", radius: 1, at },
      { kind: "triangle" },
      { kind: "square", side: "wide" },
    ]);
    expect(decoded).toHaveLength(1);
    expect(DateTime.isDateTime((decoded[0] as { at: unknown }).at)).toBe(true);
  });

  it("applies decoding defaults instead of failing", () => {
    const WithDefault = Schema.Struct({
      name: Schema.String,
      count: Schema.optionalKey(Schema.Number).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(7)),
      ),
    });
    expect(Schema.decodeSync(ForwardCompatibleArray(WithDefault))([{ name: "a" }])).toEqual([
      { name: "a", count: 7 },
    ]);
  });

  const Named = ForwardCompatibleArray(Schema.Struct({ name: TrimmedNonEmptyString }));

  it("drops an element it cannot encode instead of failing the array", () => {
    const wire = JSON.parse(
      JSON.stringify(
        Schema.encodeUnknownSync(Schema.toCodecJson(Named))([
          { name: "a" },
          { name: " " },
          { name: "b" },
        ]),
      ),
    );
    expect(wire).toEqual([{ name: "a" }, { name: "b" }]);
    expect(fromWire(Named)(wire)).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("does not accept holes as a decoded value", () => {
    expect(Schema.is(Named)([undefined])).toBe(false);
    const sparse: Array<{ name: string }> = [{ name: "a" }];
    sparse.length = 2;
    expect(Schema.is(Named)(sparse)).toBe(false);
    expect(Schema.is(Named)([{ name: "a" }])).toBe(true);
  });
});

describe("trimmed non-empty strings", () => {
  // Schema-derived strings are rarely padded, so pad them with every kind of
  // whitespace `trim()` removes, and include whitespace-only values.
  const whitespace = Arbitrary.schema(
    Schema.Literals([" ", "\t", "\n", "\r\n", "\v", "\f", " ", " ", "　", "﻿"]),
  );
  const padding = Arbitrary.array(whitespace, { maxLength: 4 }).pipe(
    Arbitrary.map((parts) => parts.join("")),
  );
  const paddedString = Arbitrary.all([padding, Arbitrary.schema(Schema.String), padding]).pipe(
    Arbitrary.map(([before, value, after]) => before + value + after),
  );
  const options = { arbitrary: { runs: 500 } };

  const make = TrimmedNonEmptyString.makeOption;
  const encode = Schema.encodeUnknownExit(TrimmedNonEmptyString);
  const decode = Schema.decodeExit(TrimmedNonEmptyString);

  it.prop(
    "whatever make accepts encodes to something that decodes back",
    [paddedString],
    ([input]) => {
      const made = make(input);
      if (made._tag === "None") {
        expect(input.trim()).toBe("");
        return;
      }
      const encoded = encode(made.value);
      expect(encoded).toStrictEqual(Exit.succeed(input.trim()));
      expect(decode(input.trim())).toStrictEqual(Exit.succeed(input.trim()));
    },
    options,
  );

  it.prop(
    "decoding then encoding is stable",
    [paddedString],
    ([input]) => {
      const decoded = decode(input);
      if (Exit.isFailure(decoded)) {
        expect(input.trim()).toBe("");
        expect(Exit.isFailure(encode(input))).toBe(true);
        return;
      }
      expect(decoded.value).toBe(input.trim());
      expect(encode(decoded.value)).toStrictEqual(Exit.succeed(decoded.value));
    },
    options,
  );

  it.prop(
    "generated values round-trip",
    [TrimmedNonEmptyString],
    ([value]) => {
      const encoded = encode(value);
      expect(Exit.isSuccess(encoded)).toBe(true);
      if (Exit.isSuccess(encoded))
        expect(decode(encoded.value)).toStrictEqual(Exit.succeed(value.trim()));
    },
    options,
  );

  it("rejects whitespace-only values everywhere", () => {
    const isTrimmedNonEmpty = Schema.is(TrimmedNonEmptyString);
    for (const value of [" ", "\t\n", " 　"]) {
      expect(() => TrimmedNonEmptyString.make(value)).toThrow();
      expect(isTrimmedNonEmpty(value)).toBe(false);
      expect(Exit.isFailure(encode(value))).toBe(true);
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });

  it("trims without rejecting blank input on the plain variant", () => {
    const decodeTrimmed = Schema.decodeSync(TrimmedString);
    expect(decodeTrimmed("  a  ")).toBe("a");
    expect(decodeTrimmed("   ")).toBe("");
  });
});

describe("PortSchema", () => {
  const decodePort = Schema.decodeUnknownExit(PortSchema);

  it("accepts the whole TCP range and nothing beside it", () => {
    expect(decodePort(1)).toStrictEqual(Exit.succeed(1));
    expect(decodePort(65535)).toStrictEqual(Exit.succeed(65535));
    expect(Exit.isFailure(decodePort(0))).toBe(true);
    expect(Exit.isFailure(decodePort(65536))).toBe(true);
    expect(Exit.isFailure(decodePort(80.5))).toBe(true);
    expect(Exit.isFailure(decodePort("80"))).toBe(true);
  });
});
