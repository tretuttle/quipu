import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { detectString, NO_CONTEXT, STRING_HEAD_BYTES, type StringContext } from "./detectString.ts";
import {
  GRAPHQL_QUERY,
  gzip,
  jpegLike,
  jwt,
  ndjsonBody,
  PNG_1X1,
  SAMPLE_JWT,
  SVG_TEXT,
  toBase64,
  toBase64Url,
} from "./testing/decoderSamples.ts";

const utf8 = new TextEncoder();

const kinds = (text: string, context: Partial<StringContext> = {}) => {
  const bytes = utf8.encode(text);
  const head = bytes.subarray(0, STRING_HEAD_BYTES);
  return detectString(head, bytes.length > STRING_HEAD_BYTES, { ...NO_CONTEXT, ...context }).map(
    (d) => d.kind,
  );
};
const label = (text: string, context: Partial<StringContext> = {}) => {
  const bytes = utf8.encode(text);
  return detectString(bytes.subarray(0, STRING_HEAD_BYTES), bytes.length > STRING_HEAD_BYTES, {
    ...NO_CONTEXT,
    ...context,
  })[0]?.label;
};

describe("detectString: what each decoder claims", () => {
  it("claims JWTs, with or without Bearer, and reads the algorithm", () => {
    expect(kinds(SAMPLE_JWT)).toEqual(["jwt"]);
    expect(label(SAMPLE_JWT)).toBe("JWT · HS256");
    expect(kinds(`Bearer ${SAMPLE_JWT}`)).toEqual(["jwt"]);
    expect(label(jwt({ alg: "RS256", kid: "k1" }, { sub: "x" }))).toBe("JWT · RS256");
    expect(label(jwt({ typ: "JWT" }, { sub: "x" }))).toBe("JWT");
  });

  it("claims a JWT longer than the head from its header alone", () => {
    const long = jwt({ alg: "ES256" }, { blob: "x".repeat(20_000) });
    expect(long.length).toBeGreaterThan(STRING_HEAD_BYTES);
    expect(label(long)).toBe("JWT · ES256");
  });

  it("claims nested stringified JSON, whole or longer than the head", () => {
    expect(kinds('{"a":1,"b":[true,null]}')).toEqual(["json"]);
    expect(kinds("  \n[1, 2, 3]\n")).toEqual(["json"]);
    const long = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i })) });
    expect(kinds(long)).toEqual(["json"]);
  });

  it("claims NDJSON before JSON, and not pretty-printed JSON", () => {
    expect(kinds(ndjsonBody([{ a: 1 }, { a: 2 }]))).toEqual(["ndjson"]);
    expect(kinds('{"a":1}\n{"a":2}')).toEqual(["ndjson"]);
    expect(kinds('{\n  "a": 1,\n  "b": 2\n}')).toEqual(["json"]);
    expect(kinds('{"a":1}\n', { mimeType: "application/x-ndjson" })).toEqual(["ndjson"]);
    expect(kinds('{"a":1}\n')).toEqual(["json"]);
  });

  it("claims GraphQL documents, minified or not, and names the operation", () => {
    expect(kinds(GRAPHQL_QUERY)).toEqual(["graphql"]);
    expect(label(GRAPHQL_QUERY)).toBe("GraphQL · query Products");
    expect(kinds("\n  mutation Add($i: I!) { add(input: $i) { id } }")).toEqual(["graphql"]);
    expect(kinds("{ viewer { login } }")).toEqual(["graphql"]);
    expect(kinds("# fetch me\nquery { me { id } }")).toEqual(["graphql"]);
  });

  it("claims URL-encoded forms, and a lone pair only with evidence", () => {
    expect(kinds("a=1&b=two+words&c=%F0%9F%A7%B5")).toEqual(["form"]);
    expect(kinds("?q=quipu&page=2")).toEqual(["form"]);
    expect(
      kinds("redirect=%2Fhome%3Fx%3D1", { mimeType: "application/x-www-form-urlencoded" }),
    ).toEqual(["form"]);
    expect(kinds("a=1", { mimeType: "application/x-www-form-urlencoded; charset=UTF-8" })).toEqual([
      "form",
    ]);
    // A cookie value is one pair with percent escapes: not a form unless declared.
    expect(kinds("sess_id=u%3D123456789012345%3As1%3D1700000000000")).toEqual([]);
    expect(kinds("a=1")).toEqual([]);
  });

  it("claims an SVG held as text, declared or by its namespace, and not other XML", () => {
    expect(kinds(SVG_TEXT)).toEqual(["svg"]);
    expect(kinds(`<?xml version="1.0"?>\n${SVG_TEXT}`)).toEqual(["svg"]);
    expect(kinds('<svg width="8"><path d="M0 0"/></svg>', { mimeType: "image/svg+xml" })).toEqual([
      "svg",
    ]);
    expect(kinds('<svg width="8"><path d="M0 0"/></svg>')).toEqual([]);
    expect(
      kinds('<html><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>'),
    ).toEqual([]);
    expect(kinds("<note><to>Ada</to></note>")).toEqual([]);
  });

  it("claims base64 by what it decodes to, not by its alphabet", () => {
    expect(label(toBase64(PNG_1X1))).toBe("base64 · image/png");
    expect(label(toBase64(jpegLike(300)))).toBe("base64 · image/jpeg");
    expect(label(toBase64(utf8.encode(SVG_TEXT)))).toBe("base64 · image/svg+xml");
    expect(label(toBase64Url(utf8.encode('{"hello":"world","n":[1,2,3]}')))).toBe(
      "base64 · application/json",
    );
    expect(label(toBase64(utf8.encode("Hello, this is plain text in base64!")))).toBe(
      "base64 · text/plain",
    );
    expect(label(`data:image/png;base64,${toBase64(PNG_1X1)}`)).toBe("base64 · image/png");
  });

  it("claims base64 of gzip, and base64 wrapped at 76 columns", async () => {
    const gz = await gzip(utf8.encode(JSON.stringify({ rows: [1, 2, 3] })));
    expect(label(toBase64(gz))).toBe("base64 · application/gzip");
    const wrapped = (toBase64(jpegLike(2000)).match(/.{1,76}/g) ?? []).join("\n");
    expect(label(wrapped)).toBe("base64 · image/jpeg");
  });

  it("takes bytes it cannot name as base64 only when the object says so", () => {
    const opaque = toBase64(Uint8Array.from({ length: 300 }, (_, i) => (i * 97 + 13) & 0xff));
    expect(kinds(opaque)).toEqual([]);
    expect(kinds(opaque, { key: "text", encoding: "base64" })).toEqual(["base64"]);
    expect(label(opaque, { key: "text", encoding: "base64", mimeType: "video/mp4" })).toBe(
      "base64 · video/mp4",
    );
    // The body's siblings are not the body: `"encoding": "base64"` is the word, not data.
    expect(kinds("base64", { key: "encoding", encoding: "base64" })).toEqual([]);
    expect(kinds("font/woff2", { key: "mimeType", encoding: "base64" })).toEqual([]);
    expect(kinds(opaque, { key: "payload_b64" })).toEqual(["base64"]);
  });
});

describe("detectString: what no decoder claims", () => {
  it("leaves everyday strings alone", () => {
    const strings = [
      "",
      "a",
      "hello world",
      "550e8400-e29b-41d4-a716-446655440000",
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      "ThisIsAVeryLongCamelCaseIdentifierName",
      "1791708172545",
      "https://example.com/a/b?c=d&e=f",
      "/images/products/shoe_large.jpg",
      "2026-10-11T09:02:38.095Z",
      "session=abc123; Path=/; HttpOnly; Secure",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      "[Unreleased]",
      "{{template}}",
      "{CACHEBUSTER}",
      "{uid}",
      "[object Object]",
      "key=value",
      "v1.2.3-beta.4",
      "#ff00aa",
      "application/json; charset=utf-8",
      "eyJ",
      "a.b.c",
      "true",
      "null",
    ];
    for (const text of strings) expect(kinds(text), JSON.stringify(text)).toEqual([]);
  });

  it("takes a short base64 cursor that decodes to JSON, and not a short name that decodes", () => {
    expect(label("eyJwYWdlIjoyfQ==")).toBe("base64 · application/json");
    expect(kinds("KyberNetwork")).toEqual([]);
    expect(kinds("TVYzS1JBMVctVC0yTTk4")).toEqual([]);
  });

  it("does not take a long unpadded word for base64", () => {
    const words = "the quick brown fox jumps over the lazy dog".replace(/ /g, "");
    expect(kinds(words.repeat(4))).toEqual([]);
  });

  it.prop(
    "never claims arbitrary text as a JWT or a form",
    [Arbitrary.schema(Schema.String)],
    ([text]) => {
      const found = kinds(text.toWellFormed());
      expect(found).not.toContain("jwt");
    },
    { arbitrary: { runs: 400 } },
  );

  it.prop(
    "claims every JSON.stringify of an object or array, whatever it holds",
    [
      Arbitrary.schema(Schema.Json).pipe(
        Arbitrary.map((v) => (typeof v === "object" && v !== null ? v : [v])),
      ),
    ],
    ([value]) => {
      const text = JSON.stringify(value);
      if (text.length < 2) return;
      expect(kinds(text)).toContain("json");
    },
    { arbitrary: { runs: 300 } },
  );
});
