// JSON.parse is the reference parser for the blanked bytes (the exemption to
// no-whole-document-materialization is for tests); every input is a few KiB.
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { JsoncBlanker } from "./jsoncBlank.ts";

const utf8 = new TextEncoder();
const SPACE = 0x20;

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

const COMMENT_TEXT = ['a "quoted" word', "x, y, }", "] , {", "ünïcødé ✓", "/ * nested-ish", ""];

/** `value` as JSONC: comments and whitespace between tokens, and trailing commas, chosen by `pick`. */
const toJsonc = (value: unknown, pick: (n: number) => number): string => {
  const gap = () => {
    switch (pick(6)) {
      case 0:
        return ` // ${COMMENT_TEXT[pick(COMMENT_TEXT.length)]}\n`;
      case 1:
        return ` /* ${COMMENT_TEXT[pick(COMMENT_TEXT.length)]}\n */ `;
      case 2:
        return "\n  ";
      default:
        return "";
    }
  };
  const write = (v: unknown): string => {
    if (Array.isArray(v)) {
      const items = v.map((item) => gap() + write(item) + gap());
      const trailing = items.length > 0 && pick(2) === 0 ? `,${gap()}` : "";
      return `[${items.join(",")}${trailing}]`;
    }
    if (v !== null && typeof v === "object") {
      const members = Object.entries(v).map(
        ([k, item]) => `${gap()}${JSON.stringify(k)}${gap()}:${gap()}${write(item)}${gap()}`,
      );
      const trailing = members.length > 0 && pick(2) === 0 ? `,${gap()}` : "";
      return `{${members.join(",")}${trailing}}`;
    }
    return JSON.stringify(v);
  };
  return gap() + write(value) + gap();
};

/** Runs the blanker over `bytes` cut into chunks of lengths chosen by `pick`. */
const blank = (bytes: Uint8Array, pick: (n: number) => number) => {
  const out: number[] = [];
  const blanker = new JsoncBlanker((chunk) => out.push(...chunk));
  for (let at = 0; at < bytes.length;) {
    const end = Math.min(bytes.length, at + 1 + pick(9));
    blanker.push(bytes.subarray(at, end));
    at = end;
  }
  blanker.end();
  return Uint8Array.from(out);
};

const norm = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe("blanking JSONC", () => {
  it.prop(
    "any value written as JSONC blanks to the same value, every byte in place",
    [Arbitrary.schema(Schema.Json), Arbitrary.schema(Schema.Int)],
    ([value, seed]) => {
      const pick = prng(seed);
      const input = utf8.encode(toJsonc(value, pick));
      const output = blank(input, pick);
      expect(output.length).toBe(input.length);
      for (let i = 0; i < input.length; i++) {
        if (output[i] !== input[i]) expect(output[i]).toBe(SPACE);
      }
      expect(JSON.parse(new TextDecoder().decode(output)) as unknown).toEqual(norm(value));
    },
    { arbitrary: { runs: 200 } },
  );

  it("keeps line breaks inside comments and commas inside strings", () => {
    const input = '{"a,]": 1, /* one\ntwo */ "b": [1,// x\n],}';
    const output = new TextDecoder().decode(blank(utf8.encode(input), () => 0));
    const blanks = (n: number) => " ".repeat(n);
    expect(output).toBe(
      `{"a,]": 1, ${blanks(6)}\n${blanks(6)} "b": [1${blanks(1)}${blanks(4)}\n]${blanks(1)}}`,
    );
  });
});
