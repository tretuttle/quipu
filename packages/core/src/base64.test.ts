import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { Base64Decoder, base64MaxDecoded } from "./base64.ts";
import { toBase64, toBase64Url } from "./testing/decoderSamples.ts";

const utf8 = new TextEncoder();
const bytesArb = Arbitrary.schema(Schema.Uint8Array);

const decodeAll = (text: string, split: ReadonlyArray<number> = []) => {
  const input = utf8.encode(text);
  const decoder = new Base64Decoder();
  const out = new Uint8Array(base64MaxDecoded(input.length));
  let at = 0;
  let written = 0;
  for (const cut of [
    ...split.filter((c) => c > 0 && c < input.length).sort((a, b) => a - b),
    input.length,
  ]) {
    written += decoder.push(input, at, cut, out, written);
    at = cut;
  }
  return { bytes: out.subarray(0, written), decoder };
};

describe("Base64Decoder", () => {
  it.prop(
    "round-trips standard and URL-safe base64, padded or not, whatever the chunking",
    [
      bytesArb,
      Arbitrary.schema(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400 }))),
      ),
    ],
    ([bytes, cuts]) => {
      for (const text of [
        toBase64(bytes),
        toBase64Url(bytes),
        toBase64(bytes).replace(/=+$/, ""),
      ]) {
        const { bytes: decoded, decoder } = decodeAll(text, cuts);
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
        expect(decoder.invalid).toBe(0);
      }
    },
    { arbitrary: { runs: 300 } },
  );

  it.prop(
    "reads the escapes a JSON serializer adds: \\/, \\u002f and line breaks, even split mid-escape",
    [
      bytesArb,
      Arbitrary.schema(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400 }))),
      ),
    ],
    ([bytes, cuts]) => {
      const plain = toBase64(bytes);
      const phpStyle = plain.replace(/\//g, "\\/");
      const unicodeStyle = plain.replace(/\//g, "\\u002f");
      const wrapped = (plain.match(/.{1,76}/g) ?? []).join("\\r\\n");
      for (const text of [phpStyle, unicodeStyle, wrapped]) {
        const { bytes: decoded, decoder } = decodeAll(text, cuts);
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
        expect(decoder.invalid).toBe(0);
      }
    },
    { arbitrary: { runs: 200 } },
  );

  it("counts what is not base64 and what shifts alignment", () => {
    const stray = decodeAll("aGVs*bG8=");
    expect(stray.decoder.invalid).toBe(1);
    const wrapped = decodeAll("aGVs\nbG8=");
    expect(wrapped.decoder.invalid).toBe(0);
    expect(wrapped.decoder.shifted).toBe(1);
    expect(new TextDecoder().decode(wrapped.bytes)).toBe("hello");
  });
});
