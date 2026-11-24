import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { FIRST_INDEX_KEY, isValidIndexKey, keyBetween, keysBetween } from "./fractionalIndex.ts";

const options = { arbitrary: { runs: 300 } };
/** Which gap to insert into, as a fraction of the current list. */
const positions = Arbitrary.array(
  Arbitrary.schema(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  {
    minLength: 1,
    maxLength: 60,
  },
);

describe("fractional index keys", () => {
  it("starts from the first key and stays valid", () => {
    expect(keyBetween(null, null)).toBe(FIRST_INDEX_KEY);
    expect(isValidIndexKey(FIRST_INDEX_KEY)).toBe(true);
    expect(isValidIndexKey("")).toBe(false);
    expect(isValidIndexKey("a0")).toBe(false);
  });

  it.prop(
    "inserting at any position keeps the list strictly sorted and every key valid",
    [positions],
    ([fractions]) => {
      const keys: string[] = [FIRST_INDEX_KEY];
      for (const fraction of fractions) {
        const gap = Math.min(keys.length, Math.floor(fraction * (keys.length + 1)));
        const below = gap === 0 ? null : (keys[gap - 1] as string);
        const above = gap === keys.length ? null : (keys[gap] as string);
        const key = keyBetween(below, above);
        expect(isValidIndexKey(key)).toBe(true);
        if (below !== null) expect(key > below).toBe(true);
        if (above !== null) expect(key < above).toBe(true);
        keys.splice(gap, 0, key);
      }
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
      expect(new Set(keys).size).toBe(keys.length);
    },
    options,
  );

  it("hands out several ascending keys between two bounds", () => {
    const keys = keysBetween("V", "W", 5);
    for (let i = 1; i < keys.length; i += 1) expect(keys[i]! > keys[i - 1]!).toBe(true);
    expect(keys[0]! > "V").toBe(true);
    expect(keys[keys.length - 1]! < "W").toBe(true);
  });

  it("refuses an inverted range", () => {
    expect(() => keyBetween("W", "V")).toThrow();
  });
});
