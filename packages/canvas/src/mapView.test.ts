import { describe, expect, it } from "@effect/vitest";

import {
  cameraShowing,
  MAP_COMFORTABLE_ZOOM,
  MAP_INSETS,
  MAP_READABLE_ZOOM,
  overviewCamera,
  readableFitCamera,
  usableArea,
} from "./mapView.ts";

const viewport = { width: 1280, height: 800 };
const screenBox = (
  box: { x: number; y: number; width: number; height: number },
  camera: {
    x: number;
    y: number;
    k: number;
  },
) => ({
  x: box.x * camera.k + camera.x,
  y: box.y * camera.k + camera.y,
  width: box.width * camera.k,
  height: box.height * camera.k,
});
const inside = (
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-6;

describe("where the map puts its camera", () => {
  it("fits a small map whole, inside the area the chrome leaves free", () => {
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    const camera = readableFitCamera(bounds, bounds, viewport, 0.01);
    expect(camera.k).toBe(1);
    expect(inside(screenBox(bounds, camera), usableArea(viewport))).toBe(true);
  });

  it("never fits a large map to a zoom without text: the root shows readable at the top left", () => {
    const bounds = { x: 0, y: 0, width: 600, height: 60_000 };
    const root = { x: 0, y: 0, width: 400, height: 2000 };
    expect(overviewCamera(bounds, viewport, 0.001).k).toBeLessThan(MAP_COMFORTABLE_ZOOM);
    const camera = readableFitCamera(bounds, root, viewport, 0.001);
    expect(camera.k).toBe(MAP_READABLE_ZOOM);
    const shown = screenBox(root, camera);
    const area = usableArea(viewport);
    // The root's top left corner is just inside the usable area, under the toolbar.
    expect(shown.x).toBeGreaterThanOrEqual(area.x);
    expect(shown.y).toBeGreaterThanOrEqual(area.y);
    expect(shown.x).toBeLessThan(area.x + 40);
    expect(shown.y).toBeLessThan(area.y + 40);
  });

  it("anchors a map that would only fit at a tiring zoom, as a tall capture node does", () => {
    // Fits whole at about 56 %: drawn, but 7 px text. The frame anchors at full size instead.
    const bounds = { x: 0, y: 0, width: 900, height: 800 };
    const root = { x: 0, y: 0, width: 420, height: 800 };
    const overview = overviewCamera(bounds, viewport, 0.001);
    expect(overview.k).toBeGreaterThan(0.5);
    expect(overview.k).toBeLessThan(MAP_COMFORTABLE_ZOOM);
    expect(readableFitCamera(bounds, root, viewport, 0.001).k).toBe(MAP_READABLE_ZOOM);
    // A map that fits at 80 % or more is shown whole.
    const small = { x: 0, y: 0, width: 600, height: 400 };
    expect(readableFitCamera(small, small, viewport, 0.001)).toEqual(
      overviewCamera(small, viewport, 0.001),
    );
  });

  it("brings a box into the usable area, clear of the toolbar and the minimap", () => {
    const camera = { x: 0, y: 0, k: 1 };
    // Under the toolbar, and in the bottom right under the minimap.
    for (const box of [
      { x: 600, y: 10, width: 200, height: 40 },
      { x: 1150, y: 700, width: 100, height: 40 },
    ]) {
      const next = cameraShowing(camera, viewport, box);
      expect(inside(screenBox(box, next), usableArea(viewport))).toBe(true);
    }
    // Already inside: the camera does not move.
    const visible = { x: 400, y: 300, width: 100, height: 40 };
    expect(cameraShowing(camera, viewport, visible)).toBe(camera);
  });

  it("frames a map larger than fits at the floor from its top left, under the toolbar", () => {
    const bounds = { x: 0, y: 0, width: 4000, height: 90_000 };
    const camera = overviewCamera(bounds, viewport, 0.12);
    expect(camera.k).toBe(0.12);
    const area = usableArea(viewport);
    expect(camera.y).toBeGreaterThanOrEqual(area.y);
    expect(camera.x).toBeGreaterThanOrEqual(area.x);
  });

  it("keeps half the viewport usable when the chrome would cover more", () => {
    const area = usableArea({ width: 300, height: 200 }, MAP_INSETS);
    expect(area.width).toBeGreaterThanOrEqual(150);
    expect(area.height).toBeGreaterThanOrEqual(100);
  });
});
