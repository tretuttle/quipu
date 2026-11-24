// Named exemption to no-whole-document-materialization: JSON.parse is the reference parser for
// these differential and round-trip tests, and every input is a sample of a few KiB.
import { describe, expect, it } from "@effect/vitest";
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { FormatSyntaxError } from "./errors.ts";
import { textValueAt } from "./testing/textValue.ts";
import { indexToml } from "./tomlTape.ts";
import { indexYaml } from "./yamlTape.ts";

const encoder = new TextEncoder();
const enc = (s: string) => encoder.encode(s);
/** Lone surrogates have no UTF-8 form, so no text file holds them. */
const wellFormed = (v: unknown): unknown => {
  if (typeof v === "string") return v.toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, k.toWellFormed(), {
        value: wellFormed(x),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return v;
};
const norm = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe("YAML on the tape", () => {
  const text = [
    "# lead comment",
    "name: quipu 🧵",
    "empty:",
    "list:",
    "  - 1",
    "  - [a, 'b c', {x: 1}]",
    "  - |",
    "    block text",
    "    more",
    "anchors:",
    "  base: &b {k: v, n: 2}",
    "  copy: *b",
    "'quoted key': \"é\\n\"",
    "? [complex, key]",
    ": value",
    "",
  ].join("\n");

  it("has the document the yaml package reads, with byte ranges into the file", () => {
    const bytes = enc(text);
    const index = indexYaml(bytes);
    const expected = parseYaml(text, { mapAsMap: false }) as Record<string, unknown>;
    expect(norm(textValueAt("yaml", bytes, index))).toEqual(norm(expected));
    // The root's first member is `name`, and its value token covers its own bytes in the file.
    const tape = index.tape;
    const nameValue = 1;
    expect(decodeUtf8(bytes.subarray(tape.start(nameValue), tape.end(nameValue)))).toBe("quipu 🧵");
    expect(tape.end(nameValue) - tape.start(nameValue)).toBe(encoder.encode("quipu 🧵").length);
  });

  it("reads several documents as an array", () => {
    const bytes = enc("a: 1\n---\n- x\n---\n");
    const index = indexYaml(bytes);
    expect(index.documents).toBe(3);
    expect(norm(textValueAt("yaml", bytes, index))).toEqual([{ a: 1 }, ["x"], null]);
  });

  it("refuses broken YAML with the byte offset", () => {
    const bytes = enc("é: [1, 2\nb: : :\n");
    expect(() => indexYaml(bytes)).toThrow(FormatSyntaxError);
  });

  it.prop(
    "round trips what yaml.stringify writes",
    [Arbitrary.schema(Schema.Json)],
    ([raw]) => {
      const value = wellFormed(raw);
      const bytes = enc(stringifyYaml(value));
      const index = indexYaml(bytes);
      expect(norm(textValueAt("yaml", bytes, index))).toEqual(norm(value));
    },
    { arbitrary: { runs: 150 } },
  );
});

describe("TOML on the tape", () => {
  const text = [
    "# config",
    'title = "T\\u00e9st"',
    "[owner]",
    'name = "Tom"',
    "dob = 1979-05-27T07:32:00-08:00",
    "[database]",
    "ports = [ 8000, 8001,",
    "  8002 ]",
    'data = [ ["delta", "phi"], [3.14] ]',
    "[servers.alpha]",
    'ip = "10.0.0.1"',
    '[servers."beta x"]',
    "ip = '10.0.0.2'",
    "a.b.c = { d = 1, e = [true, false] }",
    "[[products]]",
    'name = "Hammer"',
    "[[products]]",
    'name = "Nail"',
    "ml = '''",
    "two",
    "lines'''",
    "",
  ].join("\n");

  it("has the document smol-toml reads", async () => {
    const { parse } = await import("smol-toml");
    const bytes = enc(text);
    const index = indexToml(bytes);
    expect(norm(textValueAt("toml", bytes, index))).toEqual(norm(parse(text)));
  });

  it("refuses broken TOML", () => {
    expect(() => indexToml(enc("a = \nb = 1"))).toThrow(FormatSyntaxError);
  });

  it.prop(
    "round trips what smol-toml writes",
    [
      Arbitrary.schema(
        Schema.Record(
          Schema.String.check(Schema.isMinLength(1)),
          Schema.Union([Schema.String, Schema.Boolean, Schema.Finite, Schema.Array(Schema.String)]),
        ),
      ),
    ],
    ([raw]) => {
      const value = wellFormed(raw) as Record<string, unknown>;
      const bytes = enc(stringifyToml(value));
      const index = indexToml(bytes);
      expect(norm(textValueAt("toml", bytes, index))).toEqual(norm(value));
    },
    { arbitrary: { runs: 150 } },
  );
});
