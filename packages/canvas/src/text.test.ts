import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { layoutText, monospaceMeasure, textHeight } from "./text.ts";

const words = Arbitrary.array(Arbitrary.schema(Schema.String.check(Schema.isMaxLength(12))), {
  maxLength: 30,
}).pipe(Arbitrary.map((parts) => parts.join(" ")));
const maxWidth = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 20, maximum: 400 })),
);
const measure = monospaceMeasure(0.6);
const font = { family: "sans" as const, size: 20 };

describe("text layout", () => {
  it.prop(
    "no wrapped line is wider than the box, and the words survive in order",
    [words, maxWidth],
    ([text, width]) => {
      const layout = layoutText(text, font, measure, width);
      // A single character wider than the box is unavoidable; everything else fits.
      const widest = Math.max(0, ...[...text].map((char) => measure(char, font)));
      for (const line of layout.lines) {
        expect(measure(line, font)).toBeLessThanOrEqual(Math.max(width, widest) + 1e-9);
      }
      expect(layout.lines.join(" ").replaceAll(/\s+/g, "")).toBe(text.replaceAll(/\s+/g, ""));
      expect(layout.height).toBe(textHeight(layout.lines.length, font.size));
    },
    { arbitrary: { runs: 300 } },
  );

  it("keeps blank lines and does not wrap without a width", () => {
    const layout = layoutText("a\n\nb c d e f", font, measure, null);
    expect(layout.lines).toEqual(["a", "", "b c d e f"]);
    expect(layout.height).toBe(textHeight(3, 20));
  });
});
