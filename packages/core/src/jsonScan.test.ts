import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { prettyJson, scanJson } from "./jsonScan.ts";
import { readJson } from "./testing/readJson.ts";

const utf8 = new TextEncoder();
const json = Arbitrary.schema(Schema.Json);
const container = json.pipe(
  Arbitrary.map((value) => (typeof value === "object" && value !== null ? value : { value })),
);

describe("scanJson", () => {
  it.prop(
    "calls whatever JSON.stringify writes complete, compact or indented",
    [json],
    ([value]) => {
      // A bare number or literal could still continue, so it is complete once a space follows.
      expect(scanJson(utf8.encode(`${JSON.stringify(value)} `)).status).toBe("complete");
      expect(scanJson(utf8.encode(`${JSON.stringify(value, null, 2)}\n`)).status).toBe("complete");
    },
    { arbitrary: { runs: 300 } },
  );

  it.prop(
    "calls every strict prefix of an object or array a prefix",
    [container],
    ([value]) => {
      const bytes = utf8.encode(JSON.stringify(value));
      for (let cut = 1; cut < bytes.length; cut++) {
        // A cut inside a multi-byte character is still a valid prefix of the bytes.
        expect(scanJson(bytes.subarray(0, cut)).status).toBe("prefix");
      }
    },
    { arbitrary: { runs: 80 } },
  );

  it("rejects what is not JSON, at the byte that breaks it", () => {
    const cases: Array<[string, number]> = [
      ["[Unreleased]", 1],
      ["{{template}}", 1],
      ["[object Object]", 1],
      ['{"a" 1}', 5],
      ['{"a":1,}', 7],
      ["[1,]", 3],
      ['{"a":tru}', 5],
      ['["\\q"]', 1],
      ['["a\nb"]', 1],
      ['{"a":1} {"b":2}', 8],
      ["[01]", 1],
      ["[1.]", 1],
    ];
    for (const [text, at] of cases) {
      const scan = scanJson(utf8.encode(text));
      expect(scan.status, text).toBe("invalid");
      expect(scan.end, text).toBe(at);
    }
  });

  it("reads a value that ends the input as a prefix, since it may go on", () => {
    expect(scanJson(utf8.encode("[1, 2")).status).toBe("prefix");
    expect(scanJson(utf8.encode('{"a":"unterminated')).status).toBe("prefix");
    expect(scanJson(utf8.encode("123")).status).toBe("prefix");
    expect(scanJson(utf8.encode("123 ")).status).toBe("complete");
  });

  it("does not recurse: a 100 000-level array is a prefix, not a stack overflow", () => {
    const scan = scanJson(utf8.encode("[".repeat(100_000)));
    expect(scan.status).toBe("prefix");
  });
});

describe("prettyJson", () => {
  it.prop(
    "re-indents without changing what the text says",
    [json],
    ([value]) => {
      const compact = utf8.encode(JSON.stringify(value));
      const pretty = prettyJson(compact);
      expect(readJson(pretty)).toEqual(readJson(JSON.stringify(value)));
      // Formatting is stable: pretty text pretties to itself.
      expect(Array.from(prettyJson(pretty))).toEqual(Array.from(pretty));
    },
    { arbitrary: { runs: 300 } },
  );

  it("indents two spaces and keeps empty containers on one line", () => {
    const out = new TextDecoder().decode(
      prettyJson(utf8.encode('{"a":[1,{"b":null}],"c":{},"d":[]}')),
    );
    expect(out).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}',
    );
  });

  it("prints a truncated head as far as it goes", () => {
    const out = new TextDecoder().decode(prettyJson(utf8.encode('{"a":[1,2],"b":"cut off her')));
    expect(out).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "cut off her');
  });
});
