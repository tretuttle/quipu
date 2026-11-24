import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { GRID_SIZE, snapBox } from "./snapping.ts";

const coordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
);

describe("snapping", () => {
  it.prop(
    "grid snapping lands the box's top-left on a grid line",
    [coordinate, coordinate],
    ([x, y]) => {
      const moving = { x, y, width: 30, height: 30 };
      const snap = snapBox(moving, { grid: true, threshold: 8, candidates: [] });
      expect(((moving.x + snap.dx) / GRID_SIZE) % 1).toBeCloseTo(0, 6);
      expect(((moving.y + snap.dy) / GRID_SIZE) % 1).toBeCloseTo(0, 6);
      expect(Math.abs(snap.dx)).toBeLessThanOrEqual(GRID_SIZE / 2);
      expect(snap.guides).toEqual([]);
    },
    { arbitrary: { runs: 200 } },
  );

  it("snaps an edge to a nearby box edge and reports the guide; a far box does nothing", () => {
    const candidate = { x: 100, y: 0, width: 50, height: 50 };
    const near = snapBox(
      { x: 94, y: 200, width: 20, height: 20 },
      { grid: false, threshold: 8, candidates: [candidate] },
    );
    // The box center (104) is closer to the candidate edge at 100 than its own left edge (94) is.
    expect(near.dx).toBe(-4);
    expect(near.guides.map((guide) => guide.axis)).toEqual(["x"]);
    expect(near.guides[0]?.at).toBe(100);
    const far = snapBox(
      { x: 0, y: 200, width: 20, height: 20 },
      { grid: false, threshold: 8, candidates: [candidate] },
    );
    expect(far).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("snaps to the gap two boxes keep between them", () => {
    const left = { x: 0, y: 0, width: 40, height: 40 };
    const right = { x: 60, y: 0, width: 40, height: 40 };
    // After `right` with the same 20 gap would be x = 120; the box sits at 117.
    const snap = snapBox(
      { x: 117, y: 0, width: 40, height: 40 },
      { grid: false, threshold: 8, candidates: [left, right] },
    );
    expect(snap.dx).toBe(3);
  });
});
