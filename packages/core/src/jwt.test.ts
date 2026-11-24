import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { decodeUtf8 } from "./boundedSlice.ts";
import { decodeJwt, decodeJwtHeader, jwtAlgorithm, MAX_JWT_BYTES } from "./jwt.ts";
import { jwt, SAMPLE_JWT, toBase64Url } from "./testing/decoderSamples.ts";

const utf8 = new TextEncoder();
const claims = Arbitrary.schema(
  Schema.Record(
    Schema.String.check(Schema.isMinLength(1)),
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
  ),
).pipe(Arbitrary.map((record) => ({ ...record })));

describe("decodeJwt", () => {
  it("decodes the header and payload and carries the signature unverified", () => {
    const token = decodeJwt(utf8.encode(SAMPLE_JWT));
    expect(token).not.toBeNull();
    expect(decodeUtf8(token!.header)).toBe('{"alg":"HS256","typ":"JWT"}');
    expect(JSON.parse(decodeUtf8(token!.payload))).toMatchObject({
      name: "Ada Lovelace",
      iat: 1516239022,
    });
    expect(token!.signatureBytes).toBe(32);
    expect(token!.signature).toBe(SAMPLE_JWT.split(".")[2]);
    expect(jwtAlgorithm(token!.header)).toBe("HS256");
  });

  it.prop(
    "returns exactly the JSON that was encoded, for any claims",
    [claims, claims],
    ([header, payload]) => {
      const text = jwt(header, payload);
      const token = decodeJwt(utf8.encode(text));
      expect(token).not.toBeNull();
      expect(decodeUtf8(token!.header)).toBe(JSON.stringify(header));
      expect(decodeUtf8(token!.payload)).toBe(JSON.stringify(payload));
    },
    { arbitrary: { runs: 200 } },
  );

  it("accepts a Bearer prefix and an empty signature (alg none)", () => {
    expect(decodeJwt(utf8.encode(`Bearer ${SAMPLE_JWT}`))).not.toBeNull();
    const none = `${toBase64Url(utf8.encode('{"alg":"none"}'))}.${toBase64Url(utf8.encode('{"a":1}'))}.`;
    const token = decodeJwt(utf8.encode(none));
    expect(token?.signatureBytes).toBe(0);
    expect(jwtAlgorithm(token!.header)).toBe("none");
  });

  it("refuses what only looks like a token", () => {
    const notJson = `${toBase64Url(utf8.encode("hello there"))}.${toBase64Url(utf8.encode("{}"))}.c2ln`;
    const cases = [
      "not.a.token at all",
      "a.b",
      "a.b.c.d",
      notJson,
      "eyJ.eyJ.",
      `${SAMPLE_JWT}x*`,
      "x".repeat(MAX_JWT_BYTES + 1),
    ];
    for (const text of cases) expect(decodeJwt(utf8.encode(text)), text.slice(0, 40)).toBeNull();
  });

  it("reads the header of a token cut mid-payload", () => {
    const cut = utf8.encode(SAMPLE_JWT.slice(0, SAMPLE_JWT.indexOf(".") + 9));
    expect(decodeUtf8(decodeJwtHeader(cut)!)).toBe('{"alg":"HS256","typ":"JWT"}');
    expect(decodeJwtHeader(utf8.encode("eyJhbGciOiJIUzI1NiJ9"))).toBeNull();
  });
});
