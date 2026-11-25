import { describe, expect, it, vi } from "vite-plus/test";

import { MAP_CHAR_WIDTH, type MapNode, type MapSnapshot } from "../../documents/mapModel";
import {
  computeMapExportGeometry,
  exportMapPng,
  exportMapSvg,
  MAX_MAP_EXPORT_SIDE,
} from "./MapExport";

function makeSnapshot(boundsWidth = 480, boundsHeight = 260): MapSnapshot {
  const root: MapNode = {
    id: "0:0",
    kind: "object",
    parentId: null,
    title: "root",
    subtitle: "{} 2 keys",
    rows: [
      {
        key: "name",
        value: '"quipu <v1>"',
        kind: "string",
        container: "object",
        childId: null,
        expandable: false,
        expanded: false,
        treeId: "0:1",
        badge: null,
        decoded: false,
      },
      {
        key: "items",
        value: "[] 1 item",
        kind: "array",
        container: "object",
        childId: "0:2",
        expandable: true,
        expanded: true,
        treeId: "0:2",
        badge: null,
        decoded: false,
      },
    ],
    anchor: 0,
    level: 0,
    position: 1,
    setSize: 1,
    keyDepth: 0,
    treeId: "0:0",
    decoded: false,
    expandable: true,
    expanded: true,
    preview: null,
    width: 240,
    height: 76,
  };
  const child: MapNode = {
    id: "0:2",
    kind: "array",
    parentId: "0:0",
    title: "items",
    subtitle: "[] 1 item",
    rows: [
      {
        key: "0",
        value: "42",
        kind: "number",
        container: "array",
        childId: null,
        expandable: false,
        expanded: false,
        treeId: "0:3",
        badge: null,
        decoded: false,
      },
    ],
    anchor: 48,
    level: 1,
    position: 1,
    setSize: 1,
    keyDepth: 1,
    treeId: "0:2",
    decoded: false,
    expandable: true,
    expanded: true,
    preview: null,
    width: 180,
    height: 56,
  };
  return {
    version: 1,
    nodes: [root, child],
    byId: new Map([
      [root.id, root],
      [child.id, child],
    ]),
    childrenOf: new Map([[root.id, [child.id]]]),
    positions: new Map([
      [root.id, { x: 0, y: 0 }],
      [child.id, { x: 300, y: 80 }],
    ]),
    bounds: { x: 0, y: 0, width: boundsWidth, height: boundsHeight },
    grouping: null,
    laidOutGrouping: null,
    locations: new Map(),
    rowLocations: new Map(),
    charWidth: MAP_CHAR_WIDTH,
  };
}

describe("MapExport", () => {
  it("computes visible and whole-map geometry and caps dimensions at 8192 px per side", () => {
    const snap = makeSnapshot(20_000, 10_000);
    const whole = computeMapExportGeometry({
      snapshot: snap,
      scope: "whole",
      padding: 32,
      scale: 1,
    });
    expect(whole.width).toBe(MAX_MAP_EXPORT_SIDE);
    expect(whole.height).toBeLessThanOrEqual(MAX_MAP_EXPORT_SIDE);
    expect(whole.height).toBeGreaterThan(4000);
    expect(whole.scale).toBeLessThan(1);

    const visible = computeMapExportGeometry({
      snapshot: snap,
      scope: "visible",
      camera: { x: 0, y: 0, k: 2 },
      viewport: { width: 800, height: 600 },
      scale: 2,
    });
    expect(visible.rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(visible.width).toBe(800);
    expect(visible.height).toBe(600);
  });

  it("exports standalone SVG with edges, cards, and XML-escaped text", async () => {
    const snapshot = makeSnapshot();
    const { svg, blob, width, height } = exportMapSvg({
      snapshot,
      scope: "whole",
      resolveColor: () => "#112233",
    });
    expect(width).toBe(544);
    expect(height).toBe(324);
    expect(blob.type).toContain("image/svg+xml");
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="-32 -32 544 324"');
    expect(svg).toContain("&quot;quipu &lt;v1&gt;&quot;");
    expect(svg).toContain('<path d="M');
    expect(await blob.text()).toBe(svg);
  });

  it("exports PNG within 8192 px bounds using Canvas2D", async () => {
    const snapshot = makeSnapshot(16_384, 8_192);
    const fillText = vi.fn();
    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      clip: vi.fn(),
      fillText,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineJoin: "miter",
      font: "",
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx,
      toBlob: (cb: (b: Blob | null) => void, type?: string) =>
        cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: type ?? "image/png" })),
    } as unknown as HTMLCanvasElement;

    const result = await exportMapPng(
      {
        snapshot,
        scope: "whole",
        resolveColor: () => "#ffffff",
      },
      () => fakeCanvas,
    );

    expect(result.width).toBe(MAX_MAP_EXPORT_SIDE);
    expect(result.height).toBeGreaterThan(0);
    expect(result.height).toBeLessThanOrEqual(MAX_MAP_EXPORT_SIDE);
    expect(result.blob.type).toBe("image/png");
    expect(result.blob.size).toBeGreaterThan(0);
    expect(fillText).toHaveBeenCalled();
  });
});
