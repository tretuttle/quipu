import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import {
  fitCameraToBox,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToWorld,
  visibleWorldBox,
  wheelZoomFactor,
  worldToScreen,
  zoomCameraTo,
  zoomFloorFor,
  type Camera,
} from "./camera.ts";
import { boxContainsBox } from "./geometry.ts";

const coordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -5000, maximum: 5000 })),
);
const zoom = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: MIN_ZOOM, maximum: MAX_ZOOM })),
);
const camera = Arbitrary.all([coordinate, coordinate, zoom]).pipe(
  Arbitrary.map(([x, y, k]): Camera => ({ x, y, k })),
);
const point = Arbitrary.all([coordinate, coordinate]).pipe(Arbitrary.map(([x, y]) => ({ x, y })));
const requestedZoom = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 0.001, maximum: 100 })),
);
const size = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 20000 })),
);
const options = { arbitrary: { runs: 300 } };

describe("camera", () => {
  it.prop(
    "screen to world to screen is the identity",
    [camera, point],
    ([cam, p]) => {
      const back = worldToScreen(cam, screenToWorld(cam, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    },
    options,
  );

  it.prop(
    "zooming about a cursor keeps the world under the cursor fixed and clamps the zoom",
    [camera, point, requestedZoom],
    ([cam, cursor, k]) => {
      const before = screenToWorld(cam, cursor);
      const next = zoomCameraTo(cam, k, cursor);
      const after = screenToWorld(next, cursor);
      expect(after.x).toBeCloseTo(before.x, 3);
      expect(after.y).toBeCloseTo(before.y, 3);
      expect(next.k).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(next.k).toBeLessThanOrEqual(MAX_ZOOM);
    },
    options,
  );

  it.prop(
    "fit shows the whole box and never zooms past 1 by default",
    [coordinate, coordinate, size, size],
    ([x, y, width, height]) => {
      const viewport = { width: 1280, height: 800 };
      const box = { x, y, width, height };
      const fitted = fitCameraToBox(box, viewport);
      expect(fitted.k).toBeLessThanOrEqual(1);
      expect(fitted.k).toBeGreaterThanOrEqual(MIN_ZOOM);
      const visible = visibleWorldBox(fitted, viewport);
      // Content wider than the viewport at MIN_ZOOM cannot fit; everything else must.
      if (width <= viewport.width / MIN_ZOOM - 96 && height <= viewport.height / MIN_ZOOM - 96) {
        expect(boxContainsBox(visible, box)).toBe(true);
      }
    },
    options,
  );

  it("wheel zoom is bounded and direction follows the sign", () => {
    expect(wheelZoomFactor(100, 1)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, 1)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100000, 1)).toBeGreaterThan(0.4);
  });

  it.prop(
    "with the floor the content asks for, fit always shows the whole box",
    [coordinate, coordinate, size, size],
    ([x, y, width, height]) => {
      const viewport = { width: 1280, height: 800 };
      const box = { x, y, width, height };
      const floor = zoomFloorFor(box, viewport);
      expect(floor).toBeLessThanOrEqual(MIN_ZOOM);
      const fitted = fitCameraToBox(box, viewport, { minZoom: floor });
      expect(boxContainsBox(visibleWorldBox(fitted, viewport), box)).toBe(true);
      // The floor only drops when MIN_ZOOM cannot show the box.
      if (width <= viewport.width / MIN_ZOOM - 96 && height <= viewport.height / MIN_ZOOM - 96) {
        expect(floor).toBe(MIN_ZOOM);
      } else {
        expect(floor).toBeLessThan(MIN_ZOOM);
      }
      // Zooming out below the floor stops at it; the floor never rises above MIN_ZOOM.
      expect(zoomCameraTo(fitted, 0, { x: 0, y: 0 }, floor).k).toBeCloseTo(floor, 6);
      expect(zoomCameraTo(fitted, 0, { x: 0, y: 0 }, 5).k).toBe(MIN_ZOOM);
    },
    options,
  );
});
