// Named exemption to no-whole-document-materialization: JSON.parse is the reference parser for
// these differential and round-trip tests, and every input is a sample of a few KiB.
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { convert } from "./convert.ts";
import { FormatSyntaxError, FormatTooLargeError, UnrepresentableError } from "./errors.ts";
import { createLocalFormatPool } from "./localPool.ts";
import { TEXT_FORMAT_LIMIT } from "./textDocument.ts";
import { convertText } from "./testing/convertRun.ts";

const failure = async (run: () => Promise<unknown>) => {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UnrepresentableError);
  return error as UnrepresentableError;
};

/** TOML integers past 2^53 read as bigint; JSON has only doubles. */
const plainNumbers = (v: unknown): unknown => {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(plainNumbers);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainNumbers(x)]));
  }
  return v;
};

const norm = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
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

describe("JSON to XML and back", () => {
  const json =
    '{"catalog":{"@id":"c-1","book":[{"@id":"1","title":"A & B"},{"@id":"2","title":"<C>"}],"note":"x","empty":""}}';

  it("writes elements, attributes and escaped text", async () => {
    const xml = await convertText("json", "xml", json);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><catalog id="c-1"><book id="1"><title>A &amp; B</title></book>' +
        '<book id="2"><title>&lt;C&gt;</title></book><note>x</note><empty/></catalog>',
    );
  });

  it("reads it back as the same document", async () => {
    const xml = await convertText("json", "xml", json);
    const back = JSON.parse(await convertText("xml", "json", xml)) as unknown;
    expect(back).toEqual({
      catalog: {
        "@id": "c-1",
        book: [
          { "@id": "1", title: "A & B" },
          { "@id": "2", title: "<C>" },
        ],
        note: "x",
        empty: "",
      },
    });
  });

  it("groups a run of siblings into an array and keeps attributes beside text", async () => {
    const back = JSON.parse(
      await convertText(
        "xml",
        "json",
        '<?xml version="1.0"?>\n<r a="1">\n  <i>1</i>\n  <i>2</i>\n  <j x="y">t</j>\n  <k/>\n</r>\n',
      ),
    ) as unknown;
    expect(back).toEqual({
      r: { "@a": "1", i: ["1", "2"], j: { "@x": "y", "#text": "t" }, k: "" },
    });
  });

  it("names the node XML cannot hold", async () => {
    const nul = await failure(() => convertText("json", "xml", '{"a":{"b":[{"c":1},{"c":null}]}}'));
    expect(nul.reason).toBe("null-value");
    expect(nul.pointer).toBe("/a/b/1/c");
    const two = await failure(() => convertText("json", "xml", '{"a":1,"b":2}'));
    expect(two.reason).toBe("multiple-roots");
    expect(two.pointer).toBe("/b");
    const nested = await failure(() => convertText("json", "xml", '{"a":[[1]]}'));
    expect(nested.reason).toBe("array-in-array");
    expect(nested.pointer).toBe("/a/0");
    const name = await failure(() => convertText("json", "xml", '{"a":{"b c":1}}'));
    expect(name.reason).toBe("invalid-name");
    const empty = await failure(() => convertText("json", "xml", '{"a":{"b":[]}}'));
    expect(empty.reason).toBe("empty-array");
    expect(empty.pointer).toBe("/a/b");
    const late = await failure(() => convertText("json", "xml", '{"a":{"b":1,"@c":"x"}}'));
    expect(late.reason).toBe("attribute-after-content");
  });

  it("names the XML that is not an object", async () => {
    const mixed = await failure(() => convertText("xml", "json", "<a>text<b/>more</a>"));
    expect(mixed.reason).toBe("mixed-content");
    expect(mixed.pointer).toBe("/a");
    const again = await failure(() => convertText("xml", "json", "<a><b/><c/><b/></a>"));
    expect(again.reason).toBe("duplicate-key");
    expect(again.pointer).toBe("/a/b");
  });

  const Name = Schema.String.check(Schema.isPattern(/^[a-z]{1,3}$/));
  // Text that survives XML: no control characters, no lone surrogates.
  const Text = Schema.String.check(Schema.isPattern(/^(?:[^\p{Cc}\p{Cs}]|[\t\n\r])*$/u));
  const Tree: Schema.Codec<unknown> = Schema.suspend(() =>
    Schema.Union([
      Text,
      Schema.Record(
        Name,
        Schema.Union([Text, Schema.Array(Text).check(Schema.isMinLength(2)), Tree]),
      ).check(Schema.isMinProperties(1)),
    ]),
  );

  it.effect.prop(
    "JSON to XML to JSON is the identity on documents XML can say",
    [Arbitrary.schema(Name), Arbitrary.schema(Tree)],
    ([rootName, tree]) =>
      Effect.promise(async () => {
        const doc = { [rootName]: tree };
        const text = JSON.stringify(doc);
        const xml = await convertText("json", "xml", text, { regionBytes: 7 });
        expect(JSON.parse(await convertText("xml", "json", xml)) as unknown).toEqual(norm(doc));
      }),
    { arbitrary: { runs: 120 } },
  );
});

describe("YAML, TOML, NDJSON and CSV sources", () => {
  it("YAML to JSON follows the yaml package, anchors expanded", async () => {
    const text = "a: &x {k: 1}\nb: *x\nc: [1, two, 3.5, null, true]\n";
    const json = JSON.parse(await convertText("yaml", "json", text)) as unknown;
    expect(json).toEqual({ a: { k: 1 }, b: { k: 1 }, c: [1, "two", 3.5, null, true] });
    expect(json).toEqual(parseYaml(text));
  });

  it("YAML values JSON cannot hold are errors with a pointer", async () => {
    const e = await failure(() => convertText("yaml", "json", "a:\n  b: [1, .nan]\n"));
    expect(e.reason).toBe("non-finite-number");
    expect(e.pointer).toBe("/a/b/1");
  });

  it("TOML to JSON writes dates as text", async () => {
    const text = 'title = "x"\n[a]\nd = 1979-05-27T07:32:00Z\nl = [1, 2]\n';
    expect(JSON.parse(await convertText("toml", "json", text))).toEqual({
      title: "x",
      a: { d: "1979-05-27T07:32:00.000Z", l: [1, 2] },
    });
  });

  it("TOML and YAML syntax errors carry the byte offset of the bad token", async () => {
    // Line 2, UTF-16 column 14 is the stray `x`; the quoted text before it is 6 bytes wider in UTF-8.
    const toml = await convertText("toml", "json", 'a = 1\nname = "é😀" x\n').catch(
      (e: unknown) => e,
    );
    expect(toml).toBeInstanceOf(FormatSyntaxError);
    expect((toml as FormatSyntaxError).offset).toBe(22);
    const yaml = await convertText("yaml", "json", "a: é😀\nb: c: d\n").catch((e: unknown) => e);
    expect(yaml).toBeInstanceOf(FormatSyntaxError);
    expect((yaml as FormatSyntaxError).offset).toBe(13);
  });

  it("NDJSON and JSON arrays convert both ways", async () => {
    const lines = '{"a":1}\n\n{"a":[1,2]}\n"s"\n';
    expect(await convertText("ndjson", "json", lines)).toBe('[{"a":1},{"a":[1,2]},"s"]');
    expect(
      await convertText("json", "ndjson", '[{"a":1},{"a":[1,2]},"s"]', { regionBytes: 3 }),
    ).toBe('{"a":1}\n{"a":[1,2]}\n"s"\n');
  });

  it("CSV to JSON is strings keyed by the header", async () => {
    expect(
      JSON.parse(
        await convertText("csv", "json", 'id,name\r\n1,"Ana ""A"""\r\n\r\n2,Bo,extra\r\n'),
      ),
    ).toEqual([
      { id: "1", name: 'Ana "A"' },
      { id: "2", name: "Bo", _2: "extra" },
    ]);
    const dup = await failure(() => convertText("csv", "json", "a,a\n1,2\n"));
    expect(dup.reason).toBe("duplicate-key");
  });

  it("CSV to YAML streams through the same stages", async () => {
    expect(parseYaml(await convertText("csv", "yaml", "a,b\n1,x y\n2,\n"))).toEqual([
      { a: "1", b: "x y" },
      { a: "2", b: "" },
    ]);
  });

  it.effect.prop(
    "string tables survive CSV to JSON to CSV",
    [
      Arbitrary.schema(
        Schema.Array(Schema.Array(Schema.String).check(Schema.isBetweenLength(2, 2))).check(
          Schema.isBetweenLength(1, 6),
        ),
      ),
    ],
    ([raw]) =>
      Effect.promise(async () => {
        const rows = raw.map((r) => r.map((c) => c.toWellFormed().replaceAll("\0", "")));
        const csv = stringifyCsv([["h1", "h2"], ...rows]);
        const json = await convertText("csv", "json", csv);
        const back = await convertText("json", "csv", json, { regionBytes: 5 });
        expect(parseCsv(back, { columns: true })).toEqual(
          parseCsv(csv, { columns: true, skip_empty_lines: true }),
        );
      }),
    { arbitrary: { runs: 100 } },
  );

  it.effect.prop(
    "JSON survives YAML",
    [Arbitrary.schema(Schema.Json)],
    ([raw]) =>
      Effect.promise(async () => {
        const value = wellFormed(raw);
        const yaml = await convertText("json", "yaml", JSON.stringify(value), { regionBytes: 11 });
        expect(JSON.parse(await convertText("yaml", "json", yaml)) as unknown).toEqual(norm(value));
      }),
    { arbitrary: { runs: 100 } },
  );

  it.effect.prop(
    "TOML documents survive JSON",
    [
      Arbitrary.schema(
        Schema.Record(
          Schema.String.check(Schema.isMinLength(1)),
          Schema.Union([Schema.String, Schema.Boolean, Schema.Finite, Schema.Array(Schema.String)]),
        ),
      ),
    ],
    ([raw]) =>
      Effect.promise(async () => {
        const value = wellFormed(raw);
        const toml = await convertText("json", "toml", JSON.stringify(value));
        expect(norm(plainNumbers(parseToml(toml, { integersAsBigInt: "asNeeded" })))).toEqual(
          norm(value),
        );
        expect(JSON.parse(await convertText("toml", "json", toml)) as unknown).toEqual(norm(value));
      }),
    { arbitrary: { runs: 100 } },
  );
});

describe("JSON to TOML", () => {
  const toml = (json: string, options: Parameters<typeof convertText>[3] = {}) =>
    convertText("json", "toml", json, options);

  it("writes root members as lines, a root member's array one element per line, the rest inline", async () => {
    const out = await toml(
      '{"title":"quipu","n":-12,"f":1.5e3,"on":true,"owner":{"name":"Ana","tags":["a",1,{"k":"v"}],"empty":{}},' +
        '"rows":[{"id":1,"p":[1,2]},{"id":2,"p":[]},[3,4]],"none":[]}',
    );
    expect(out).toBe(
      [
        'title = "quipu"',
        "n = -12",
        "f = 1.5e3",
        "on = true",
        'owner = { name = "Ana", tags = ["a", 1, { k = "v" }], empty = {} }',
        "rows = [",
        "  { id = 1, p = [1, 2] },",
        "  { id = 2, p = [] },",
        "  [3, 4],",
        "]",
        "none = []",
        "",
      ].join("\n"),
    );
  });

  it("quotes keys that are not bare and escapes what TOML's basic strings forbid", async () => {
    const value = {
      "a b": "x\u007fy",
      "": '/slash "q" back\\ \n\t\u0001 \u{1F600} é',
      "k-1_": 1,
    };
    const out = await toml(JSON.stringify(value));
    expect(out).toBe(
      [
        String.raw`"a b" = "x\u007Fy"`,
        String.raw`"" = "/slash \"q\" back\\ \n\t\u0001 😀 é"`,
        "k-1_ = 1",
        "",
      ].join("\n"),
    );
    expect(parseToml(out)).toEqual(value);
  });

  it("reads \\/ and surrogate-pair escapes as the characters they are", async () => {
    const out = await toml('{"s":"a\\/b \\ud83d\\ude00"}');
    expect(out).toBe('s = "a/b 😀"\n');
  });

  it("keeps integers past 64 bits digit for digit, as floats", async () => {
    const out = await toml(
      '{"max":9223372036854775807,"min":-9223372036854775808,"over":9223372036854775808,"huge":-123456789012345678901234}',
    );
    expect(out).toBe(
      "max = 9223372036854775807\nmin = -9223372036854775808\nover = 9.223372036854775808e18\nhuge = -1.23456789012345678901234e23\n",
    );
    expect(parseToml(out, { integersAsBigInt: "asNeeded" })).toMatchObject({
      max: 9223372036854775807n,
      min: -9223372036854775808n,
    });
  });

  it("gives the same bytes whatever the region size, strings longer than a region included", async () => {
    const long = "w".repeat(150_000);
    const json = JSON.stringify({
      a: 1,
      s: long,
      list: [{ x: "y z", n: [1, 2, { q: long }] }, "t"],
      deep: { a: { b: { c: [true, false] } } },
    });
    const whole = await toml(json, { regionBytes: 1 << 24 });
    expect(norm(parseToml(whole))).toEqual(norm(JSON.parse(json)));
    for (const regionBytes of [4096, 65_536, 100_000]) {
      expect(await toml(json, { regionBytes }), `regions of ${regionBytes}`).toBe(whole);
    }
  });

  it("converts a string longer than the region overhang that a target holding whole tokens must read past", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const json = JSON.stringify({ a: 1, s: big, t: "tail", rows: [{ k: big }, { k: "z" }] });
    const out = await toml(json, { regionBytes: 1 << 20 });
    expect(out).toBe(
      `a = 1\ns = "${big}"\nt = "tail"\nrows = [\n  { k = "${big}" },\n  { k = "z" },\n]\n`,
    );
  });

  it("names the first node TOML cannot hold, by JSON Pointer", async () => {
    const root = await failure(() => toml("[1,2]"));
    expect(root.reason).toBe("not-a-table");
    expect(root.pointer).toBe("");
    const scalar = await failure(() => toml('"text"'));
    expect(scalar.reason).toBe("not-a-table");
    const nul = await failure(() => toml('{"a":{"b":[1,null]}}', { regionBytes: 5 }));
    expect(nul.reason).toBe("null-value");
    expect(nul.pointer).toBe("/a/b/1");
    const lone = await failure(() => toml('{"a":["ok","bad \\ud800 surrogate"]}'));
    expect(lone.reason).toBe("invalid-input");
    expect(lone.pointer).toBe("/a/1");
  });

  it("names the node when the source was read through a reader, not the input bytes", async () => {
    const yaml = await failure(() => convertText("yaml", "toml", "a:\n  b: [1, null]\n"));
    expect(yaml.reason).toBe("null-value");
    expect(yaml.pointer).toBe("/a/b/1");
    const ndjson = await failure(() => convertText("ndjson", "toml", '{"a":1}\n{"a":2}\n'));
    expect(ndjson.reason).toBe("not-a-table");
    expect(ndjson.pointer).toBe("");
    const xml = await failure(() => convertText("xml", "json", "<a><b/><c/><b/></a>"));
    expect(xml.pointer).toBe("/a/b");
  });

  it("refuses a string larger than the 64 MiB a whole-token target holds, naming it", async () => {
    const big = `{"keep":1,"s":"${"x".repeat(65 * 1024 * 1024)}"}`;
    const error = await failure(() => toml(big));
    expect(error.reason).toBe("token-too-large");
    expect(error.pointer).toBe("/s");
    expect(error.message).toContain("/s");
  });

  it("refuses a YAML or TOML source above the text limit before reading it", async () => {
    const bytes = new TextEncoder().encode("a: 1\n");
    const pool = createLocalFormatPool(1);
    try {
      const error = await convert(
        "yaml",
        "json",
        {
          spec: {
            kind: "memory",
            buffer: bytes.buffer,
            byteOffset: bytes.byteOffset,
            byteLength: bytes.byteLength,
          },
          size: TEXT_FORMAT_LIMIT + 1,
        },
        { pool, sink: { write: () => {} } },
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(FormatTooLargeError);
      expect((error as FormatTooLargeError).message).toBe(
        "This YAML document is 256.0 MiB; YAML documents up to 256 MiB can be converted.",
      );
    } finally {
      await pool.terminate();
    }
  });

  // Documents TOML can say: an object root and no null. Mixed arrays are fine in TOML 1.0.
  const NoNull: Schema.Codec<unknown> = Schema.suspend(() =>
    Schema.Union([
      Schema.String,
      Schema.Boolean,
      Schema.Finite,
      Schema.Array(NoNull).check(Schema.isMaxLength(4)),
      Schema.Record(Schema.String, NoNull).check(Schema.isMaxProperties(4)),
    ]),
  );

  it.effect.prop(
    "any table without null reads back as the same value, in any region size",
    [Arbitrary.schema(Schema.Record(Schema.String, NoNull).check(Schema.isMaxProperties(5)))],
    ([raw]) =>
      Effect.promise(async () => {
        const value = wellFormed(raw);
        const json = JSON.stringify(value);
        const whole = await toml(json, { regionBytes: 1 << 20 });
        expect(norm(plainNumbers(parseToml(whole, { integersAsBigInt: "asNeeded" })))).toEqual(
          norm(value),
        );
        for (const regionBytes of [1, 5, 31]) {
          expect(await toml(json, { regionBytes })).toBe(whole);
        }
      }),
    { arbitrary: { runs: 150 } },
  );
});
