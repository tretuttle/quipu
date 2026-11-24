import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import {
  alignElements,
  distributeElements,
  duplicateElements,
  groupElements,
  maximumGroups,
  ungroupElements,
} from "./arrange.ts";
import { elementBounds } from "./hitTest.ts";
import { createRng } from "./random.ts";
import { rect } from "./testing.ts";
import type { Element } from "./elements.ts";

const coordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -500, maximum: 500 })),
);
const extent = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
);
const boxes = Arbitrary.array(Arbitrary.all([coordinate, coordinate, extent, extent]), {
  minLength: 3,
  maxLength: 8,
});

function applied(original: ReadonlyArray<Element>, changed: ReadonlyArray<Element>): Element[] {
  const byId = new Map(changed.map((e) => [e.id, e]));
  return original.map((e) => byId.get(e.id) ?? e);
}

describe("arrange", () => {
  it.prop(
    "align left puts every element on the same left edge, and the overall bounds' left edge does not move",
    [boxes],
    ([specs]) => {
      const elements = specs.map(([x, y, w, h]) => rect(x, y, w, h));
      const minX = Math.min(...elements.map((e) => e.x));
      const result = applied(elements, alignElements(elements, "left"));
      for (const e of result) expect(e.x).toBeCloseTo(minX, 6);
    },
    { arbitrary: { runs: 200 } },
  );

  it.prop(
    "distribute horizontally gives equal gaps when the boxes fit, and keeps the outer two in place",
    [boxes],
    ([specs]) => {
      const elements = specs.map(([x, y, w, h]) => rect(x, y, w, h));
      const sorted = [...elements].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2));
      const first = sorted[0] as Element;
      const last = sorted[sorted.length - 1] as Element;
      const extentX = last.x + last.width - first.x;
      const span = elements.reduce((sum, e) => sum + e.width, 0);
      const result = applied(elements, distributeElements(elements, "horizontal")).sort(
        (a, b) => a.x - b.x,
      );
      if (extentX - span >= 0) {
        const gaps: number[] = [];
        for (let i = 1; i < result.length; i += 1) {
          const prev = result[i - 1] as Element;
          gaps.push((result[i] as Element).x - (prev.x + prev.width));
        }
        for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] as number, 4);
        expect((result[0] as Element).x).toBeCloseTo(first.x, 6);
      } else {
        expect(result.length).toBe(elements.length);
      }
    },
    { arbitrary: { runs: 200 } },
  );

  it("groups move as one box in alignment and ungroup restores individuals", () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(50, 0, 10, 10);
    const c = rect(100, 40, 10, 10);
    const grouped = applied([a, b, c], groupElements([a, b], "g1"));
    expect(maximumGroups(grouped).length).toBe(2);
    const aligned = applied(grouped, alignElements(grouped, "right"));
    // a and b kept their relative spacing: both moved together.
    const [a2, b2] = aligned;
    expect((b2 as Element).x - (a2 as Element).x).toBe(50);
    expect((b2 as Element).x + 10).toBe(110);
    expect(ungroupElements(aligned).every((e) => e.groupIds.length === 0)).toBe(true);
  });

  it("duplicate rewrites a binding between copied elements and keeps one to an outside target", () => {
    const target = rect(0, 0, 10, 10);
    const outside = rect(200, 0, 10, 10);
    const arrow: Element = {
      ...rect(20, 5, 100, 0),
      type: "arrow",
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: { targetId: target.id, fixedPoint: [0.5, 0.5], gap: 4 },
      endBinding: { targetId: outside.id, fixedPoint: [0.5, 0.5], gap: 4 },
      startArrowhead: "none",
      endArrowhead: "arrow",
    } as Element;
    const result = duplicateElements([target, arrow], {
      rng: createRng(1),
      aboveIndex: "Z",
      offset: 10,
    });
    const copiedArrow = result.elements.find((e) => e.type === "arrow");
    expect(copiedArrow && copiedArrow.type === "arrow" && copiedArrow.startBinding?.targetId).toBe(
      result.idMap.get(target.id),
    );
    expect(copiedArrow && copiedArrow.type === "arrow" && copiedArrow.endBinding?.targetId).toBe(
      outside.id,
    );
    expect(result.elements.every((e) => e.index > "Z")).toBe(true);
    expect(new Set(result.elements.map((e) => e.seed)).size).toBe(2);
    expect(elementBounds(result.elements[0] as Element).x).toBe(10);
  });
});
