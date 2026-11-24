// JSON.parse is the independent reference for what is valid JSON (tests are exempt
// from no-whole-document-materialization); every input is a few KiB.
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost } from "./document.ts";
import { indexDocument } from "./indexDocument.ts";
import { createLocalPool } from "./localPool.ts";
import { SegmentedTape } from "./segmentedTape.ts";

const utf8 = new TextEncoder();

/** What the index reports for `text`, cut into regions of `regionBytes`. */
const problemOf = async (text: string, regionBytes: number) => {
  const bytes = utf8.encode(text);
  const pool = createLocalPool(3);
  try {
    await pool.broadcast({
      type: "open",
      sourceId: 1,
      spec: { kind: "blob", blob: new Blob([bytes]) },
    });
    const stats = await indexDocument(pool, 1, bytes.length, {
      target: new SegmentedTape(),
      regionBytes,
    });
    return stats.problem;
  } finally {
    await pool.terminate();
  }
};

const parses = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** A small seeded generator, so a failing case replays from its seed. */
const prng = (seed: number) => {
  let state = seed >>> 0 || 1;
  return (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
};

/** `value` as JSON with whitespace between tokens, chosen by `pick`. */
const spaced = (value: unknown, pick: (n: number) => number): string => {
  const gap = () => [" ", "", "\n  ", "\t", ""][pick(5)] as string;
  const write = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map((item) => gap() + write(item) + gap()).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const members = Object.entries(v).map(
        ([k, item]) => `${gap()}${JSON.stringify(k)}${gap()}:${gap()}${write(item)}${gap()}`,
      );
      return `{${members.join(",")}}`;
    }
    return JSON.stringify(v);
  };
  return gap() + write(value) + gap();
};

/** Structural damage a hand edit or a cut file leaves: no control characters or non-ASCII. */
const DAMAGE = ['"', ",", ":", "{", "}", "[", "]", "\\", "a", "1", "-", ".", "e", "t", "n", " "];
const corrupt = (text: string, pick: (n: number) => number) => {
  const at = pick(text.length + 1);
  const edit = pick(3);
  const piece = DAMAGE[pick(DAMAGE.length)] as string;
  if (edit === 0) return text.slice(0, at) + text.slice(at + 1);
  if (edit === 1) return text.slice(0, at) + piece + text.slice(at);
  return text.slice(0, at) + piece + text.slice(at + 1);
};

// JSON.stringify escapes control characters, so no raw one reaches a string here (those are not checked).
const Value = Schema.Json;
const wellFormed = (v: unknown): unknown =>
  typeof v === "string"
    ? v.toWellFormed()
    : Array.isArray(v)
      ? v.map(wellFormed)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x)]))
        : v;

describe("the index says whether a document is JSON", () => {
  it.effect.prop(
    "finds nothing wrong with any valid document, wherever regions are cut",
    [Arbitrary.schema(Value), Arbitrary.schema(Schema.Int)],
    ([raw, seed]) =>
      Effect.promise(async () => {
        const pick = prng(seed);
        const text = spaced(wellFormed(raw), pick);
        if (text.trim().length === 0) return;
        expect(await problemOf(text, 1 + pick(40))).toBeNull();
        expect(await problemOf(JSON.stringify(wellFormed(raw), null, 2), 1 << 20)).toBeNull();
      }),
    { arbitrary: { runs: 150 } },
  );

  it.effect(
    "accepts a string whose last escape is cut by a region boundary just before its closing quote",
    () =>
      Effect.promise(async () => {
        // Two-byte regions put a boundary between the backslashes of `"\\"` (a shrunk counterexample).
        const text = '{"":1,"":5,"":null,"":"","":"\\\\","\\\\":null,"":""}';
        expect(parses(text)).toBe(true);
        for (let regionBytes = 1; regionBytes <= 8; regionBytes++) {
          expect(await problemOf(text, regionBytes), `regions of ${regionBytes}`).toBeNull();
        }
      }),
  );

  it.effect(
    "accepts a key ending in an escaped backslash at every small region size (a shrunk counterexample)",
    () =>
      Effect.promise(async () => {
        const raw = {
          "1a": { "a+dgR": 2.823221803522528e205, "": [], "GE%\\": true, "rm}H": ["F9 9"] },
          "": {},
        };
        const pick = prng(-35);
        const text = corrupt(spaced(wellFormed(raw), pick), pick);
        expect(parses(text)).toBe(true);
        for (let regionBytes = 1; regionBytes <= 40; regionBytes++) {
          expect(await problemOf(text, regionBytes), `regions of ${regionBytes}`).toBeNull();
        }
      }),
  );

  it.effect.prop(
    "flags a damaged document exactly when JSON.parse refuses it",
    [Arbitrary.schema(Value), Arbitrary.schema(Schema.Int)],
    ([raw, seed]) =>
      Effect.promise(async () => {
        const pick = prng(seed);
        const text = corrupt(spaced(wellFormed(raw), pick), pick);
        // A document that is now blank or one bare scalar is not opened as JSON at all.
        if (!/^\s*[[{]/.test(text)) return;
        const found = await problemOf(text, 1 << 20);
        expect(found !== null, `${JSON.stringify(text)} → ${JSON.stringify(found)}`).toBe(
          !parses(text),
        );
        // Cut into small regions the check sees less context, but never invents a problem.
        if (parses(text)) expect(await problemOf(text, 1 + pick(40))).toBeNull();
      }),
    { arbitrary: { runs: 400 } },
  );

  it("names the first problem in each kind of broken file", async () => {
    const cases: ReadonlyArray<readonly [string, string, number]> = [
      ['{"a":1,}', "trailing-comma", 7],
      ["[1,2,]", "trailing-comma", 5],
      ['{"a" 1}', "unexpected", 5],
      ['{"a":1]', "close-mismatch", 6],
      ['{"a":1} x', "trailing-data", 8],
      ['{"a":tru}', "literal", 5],
      ['{"a":01}', "number", 5],
      ['{"a":"\\q"}', "escape", 6],
      ['{"a":[1,2', "end", 9],
      ['{"a":"open', "unterminated", 5],
      ["[1 2]", "unexpected", 3],
      ['{"a":1}}', "trailing-data", 7],
    ];
    for (const [text, code, offset] of cases) {
      expect(await problemOf(text, 1 << 20), text).toEqual({ code, offset });
    }
    // A byte order mark is not a problem.
    expect(await problemOf('﻿{"a":1}', 1 << 20)).toBeNull();
  });

  it("reports where a broken file breaks, with its line and column, through the engine", async () => {
    const host = new EngineHost({
      workers: 2,
      crossOriginIsolated: true,
      createPool: createLocalPool,
    });
    const text = '{\n  "name": "broken",\n  "items": [1, 2, 3,\n    "missing": }\n';
    const info = await host.handle({ _tag: "open", source: new Blob([text]), name: "broken.json" });
    expect(await host.handle({ _tag: "problem", documentId: info.documentId })).toEqual({
      offset: text.indexOf(": }"),
      line: 4,
      column: 14,
      message: "Not valid JSON: unexpected `:` at line 4, column 14",
      readsAsJsonc: false,
    });
    const fine = await host.handle({
      _tag: "open",
      source: new Blob(['{"a":[1]}']),
      name: "a.json",
    });
    expect(await host.handle({ _tag: "problem", documentId: fine.documentId })).toBeNull();
  });
});
