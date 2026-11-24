import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { boxContainsPoint, rotatePoint, boxCenter } from "./geometry.ts";
import { elementBounds, elementBox, hitElement, outlinePointToward } from "./hitTest.ts";
import { rect } from "./testing.ts";
import type { Element } from "./elements.ts";

const coordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -300, maximum: 300 })),
);
const extent = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 40, maximum: 300 })),
);
const unit = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 0.9 })),
);
const angle = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -Math.PI, maximum: Math.PI })),
);
const shapeType = Arbitrary.schema(Schema.Literals(["rectangle", "ellipse", "diamond"]));
const options = { arbitrary: { runs: 300 } };

function shape(
  type: "rectangle" | "ellipse" | "diamond",
  x: number,
  y: number,
  w: number,
  h: number,
  theta: number,
  fill: "none" | "solid",
): Element {
  return { ...rect(x, y, w, h, { angle: theta, style: { fill } }), type } as Element;
}

describe("hit testing", () => {
  it.prop(
    "a filled shape's center hits; a point well outside its bounds misses",
    [shapeType, coordinate, coordinate, extent, extent, angle],
    ([type, x, y, w, h, theta]) => {
      const element = shape(type, x, y, w, h, theta, "solid");
      const center = boxCenter(elementBox(element));
      expect(hitElement(element, center, 2)).toBe(true);
      const bounds = elementBounds(element);
      expect(hitElement(element, { x: bounds.x + bounds.width + 50, y: bounds.y - 50 }, 2)).toBe(
        false,
      );
    },
    options,
  );

  it.prop(
    "a point on a rotated rectangle's edge hits whether or not it is filled, and its interior hits only when filled",
    [coordinate, coordinate, extent, extent, angle, unit],
    ([x, y, w, h, theta, t]) => {
      const hollow = shape("rectangle", x, y, w, h, theta, "none");
      const filled = shape("rectangle", x, y, w, h, theta, "solid");
      const box = elementBox(hollow);
      const center = boxCenter(box);
      const edgePoint = rotatePoint({ x: box.x + box.width * t, y: box.y }, center, theta);
      expect(hitElement(hollow, edgePoint, 1)).toBe(true);
      expect(hitElement(filled, edgePoint, 1)).toBe(true);
      const interior = rotatePoint(
        { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 },
        center,
        theta,
      );
      expect(hitElement(hollow, interior, Math.min(w, h) / 4)).toBe(false);
      expect(hitElement(filled, interior, 1)).toBe(true);
    },
    options,
  );

  it.prop(
    "an arrow hits near its stroke and misses the empty corner of its bounding box",
    [coordinate, coordinate, extent, extent],
    ([x, y, w, h]) => {
      const arrow: Element = {
        ...rect(x, y, w, h),
        type: "arrow",
        points: [
          [0, 0],
          [w, h],
        ],
        startBinding: null,
        endBinding: null,
        startArrowhead: "none",
        endArrowhead: "arrow",
      } as Element;
      expect(hitElement(arrow, { x: x + w / 2, y: y + h / 2 }, 2)).toBe(true);
      // The corner opposite the diagonal is inside the box but far from the stroke.
      const corner = { x: x + w, y: y };
      const perpendicular = Math.abs(w * h) / Math.hypot(w, h);
      if (perpendicular > 20) expect(hitElement(arrow, corner, 5)).toBe(false);
    },
    options,
  );

  it.prop(
    "the outline point toward a target lies on the box edge plus the gap",
    [shapeType, coordinate, coordinate, extent, extent, coordinate, coordinate],
    ([type, x, y, w, h, tx, ty]) => {
      const element = shape(type, x, y, w, h, 0, "none");
      const gap = 4;
      const box = elementBox(element);
      const center = boxCenter(box);
      const toward = { x: tx, y: ty };
      if (toward.x === center.x && toward.y === center.y) return;
      const p = outlinePointToward(element, toward, gap);
      expect(
        boxContainsPoint(
          {
            x: box.x - gap,
            y: box.y - gap,
            width: box.width + gap * 2,
            height: box.height + gap * 2,
          },
          p,
          1e-6,
        ),
      ).toBe(true);
      // Outside the shape itself (a filled twin does not contain it)...
      const filled = shape(type, x, y, w, h, 0, "solid");
      expect(hitElement(filled, p, 0)).toBe(false);
      // ...but within a corner's reach of its outline.
      expect(hitElement(element, p, gap * Math.SQRT2 + 1e-6)).toBe(true);
    },
    options,
  );
});
