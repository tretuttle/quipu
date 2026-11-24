import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import {
  boxContainsPoint,
  boxFromCorners,
  distanceToEllipseOutline,
  distanceToSegment,
  type Box,
  type Point,
  pointInPolygon,
  rotatePoint,
  rotatedBoxBounds,
  rotatedBoxCorners,
  unionBoxes,
} from "./geometry.ts";

const coordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
);
const point = Arbitrary.all([coordinate, coordinate]).pipe(Arbitrary.map(([x, y]) => ({ x, y })));
const angle = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -Math.PI * 2, maximum: Math.PI * 2 })),
);
const options = { arbitrary: { runs: 300 } };

const worldCoordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -1e9, maximum: 1e9 })),
);
/** A semi-axis as a power of ten, so aspect ratios reach a million to one. */
const semiAxisExponent = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 5 })),
);
const axisFraction = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -2, maximum: 2 })),
);

/**
 * The nearest-point distance by sampling the outline densely in world
 * coordinates, then resampling around every sampled local minimum until the
 * window is far below float resolution. Independent of the solver under test.
 */
function sampledEllipseDistance(box: Box, p: Point): number {
  const a = box.width / 2;
  const b = box.height / 2;
  const cx = box.x + a;
  const cy = box.y + b;
  const at = (theta: number) =>
    Math.hypot(cx + a * Math.cos(theta) - p.x, cy + b * Math.sin(theta) - p.y);
  const samples = 2048;
  const step = (Math.PI * 2) / samples;
  const values = Array.from({ length: samples }, (_, i) => at(i * step));
  let best = Math.min(...values);
  for (let i = 0; i < samples; i += 1) {
    const value = values[i] as number;
    const previous = values[(i + samples - 1) % samples] as number;
    const next = values[(i + 1) % samples] as number;
    // Strict on one side, so a plateau of equal rounded values refines once.
    if (value >= previous || value > next) continue;
    let center = i * step;
    let half = step;
    let local = value;
    for (let round = 0; round < 18; round += 1) {
      let bestTheta = center;
      for (let k = -16; k <= 16; k += 1) {
        const theta = center + (half * k) / 16;
        const d = at(theta);
        if (d < local) {
          local = d;
          bestTheta = theta;
        }
      }
      center = bestTheta;
      half /= 8;
    }
    best = Math.min(best, local);
  }
  return best;
}

function expectNearestEllipseDistance(box: Box, p: Point) {
  const expected = sampledEllipseDistance(box, p);
  const scale = Math.max(box.width, box.height, expected);
  expect(Math.abs(distanceToEllipseOutline(box, p) - expected)).toBeLessThanOrEqual(
    1e-6 + scale * 1e-9,
  );
}

describe("geometry", () => {
  it.prop(
    "a box from two corners has non-negative extents and contains both corners",
    [point, point],
    ([a, b]) => {
      const box = boxFromCorners(a, b);
      expect(box.width).toBeGreaterThanOrEqual(0);
      expect(box.height).toBeGreaterThanOrEqual(0);
      expect(boxContainsPoint(box, a, 1e-9)).toBe(true);
      expect(boxContainsPoint(box, b, 1e-9)).toBe(true);
    },
    options,
  );

  it.prop(
    "rotating by an angle and back returns the point",
    [point, point, angle],
    ([p, center, a]) => {
      const back = rotatePoint(rotatePoint(p, center, a), center, -a);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    },
    options,
  );

  it.prop(
    "rotated bounds contain every rotated corner",
    [point, point, angle],
    ([a, b, theta]) => {
      const box = boxFromCorners(a, b);
      const bounds = rotatedBoxBounds(box, theta);
      for (const corner of rotatedBoxCorners(box, theta)) {
        expect(boxContainsPoint(bounds, corner, 1e-6)).toBe(true);
      }
    },
    options,
  );

  it.prop(
    "the distance to a segment is never more than the distance to either end",
    [point, point, point],
    ([p, a, b]) => {
      const d = distanceToSegment(p, a, b);
      expect(d).toBeLessThanOrEqual(Math.hypot(p.x - a.x, p.y - a.y) + 1e-9);
      expect(d).toBeLessThanOrEqual(Math.hypot(p.x - b.x, p.y - b.y) + 1e-9);
    },
    options,
  );

  it.prop(
    "a box's center is inside its polygon and a far point is not",
    [point, point],
    ([a, b]) => {
      const box = boxFromCorners(a, b);
      // A box thinner than float resolution has no interior to test.
      if (box.width < 1e-6 || box.height < 1e-6) return;
      const polygon = rotatedBoxCorners(box, 0);
      expect(pointInPolygon({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, polygon)).toBe(
        true,
      );
      expect(pointInPolygon({ x: box.x + box.width + 5, y: box.y + box.height / 2 }, polygon)).toBe(
        false,
      );
    },
    options,
  );

  it.prop(
    "the distance to an ellipse outline is the nearest distance a dense sampling finds",
    [
      worldCoordinate,
      worldCoordinate,
      semiAxisExponent,
      semiAxisExponent,
      axisFraction,
      axisFraction,
    ],
    ([x, y, ea, eb, u, v]) => {
      const a = 10 ** ea;
      const b = 10 ** eb;
      const box = { x, y, width: a * 2, height: b * 2 };
      expectNearestEllipseDistance(box, { x: x + a + u * a, y: y + b + v * b });
    },
    options,
  );

  it("the center of a thin ellipse is its half-height from the outline, not its half-width", () => {
    const box = { x: 0, y: 0, width: 300, height: 40 };
    expect(distanceToEllipseOutline(box, { x: 150, y: 20 })).toBeCloseTo(20, 9);
    expectNearestEllipseDistance(box, { x: 150, y: 20 });
    expectNearestEllipseDistance(box, { x: 2, y: 2 });
    expectNearestEllipseDistance(
      { x: 1e6, y: -1e6, width: 2, height: 2000 },
      { x: 1000000.2, y: -998200 },
    );
  });

  it("unions boxes and returns null for none", () => {
    expect(unionBoxes([])).toBeNull();
    expect(
      unionBoxes([
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 5, y: 5, width: 2, height: 2 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 7, height: 7 });
  });
});
