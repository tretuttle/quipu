import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { formatBytes } from "./formatBytes";

const SCALE = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 } as const;

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1_000, "1.00 kB"],
    [13_400, "13.4 kB"],
    [999_499, "999 kB"],
    [999_500, "1.00 MB"],
    [52_803_133, "52.8 MB"],
    [2_147_596_427, "2.15 GB"],
  ])("shows %d bytes as %s", (bytes, shown) => {
    expect(formatBytes(bytes)).toBe(shown);
  });

  it.prop(
    "names a decimal unit and three significant digits within rounding of the size",
    [Arbitrary.schema(Schema.Int)],
    ([raw]) => {
      const bytes = Math.abs(raw) % 5e14;
      const match = /^(\d+(?:\.\d+)?) (B|kB|MB|GB|TB)$/.exec(formatBytes(bytes));
      expect(match).not.toBeNull();
      const [, number = "", unit = "B"] = match ?? [];
      const shown = Number(number);
      expect(shown).toBeLessThan(1000);
      if (unit !== "B") expect(number.replace(".", "").replace(/^0+/, "")).toHaveLength(3);
      // The shown number is the size rounded to its last digit.
      const step = 10 ** -(number.split(".")[1]?.length ?? 0);
      expect(Math.abs(bytes / SCALE[unit as keyof typeof SCALE] - shown)).toBeLessThanOrEqual(
        step / 2 + 1e-9,
      );
    },
    { arbitrary: { runs: 500 } },
  );
});
