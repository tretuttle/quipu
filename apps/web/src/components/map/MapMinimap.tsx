import type { Camera, Viewport } from "@quipu/canvas/camera";
import { visibleWorldBox } from "@quipu/canvas/camera";
import { boxContainsBox, type Box, type Point } from "@quipu/canvas/geometry";
import { useEffect, useRef } from "react";

import type { MapSnapshot } from "../../documents/mapModel";
import { readThemeColor } from "./mapPaint";

const WIDTH = 192;
const HEIGHT = 128;
const PADDING = 6;

interface Scale {
  readonly k: number;
  readonly x: number;
  readonly y: number;
}

function scaleFor(bounds: Box | null): Scale {
  if (bounds === null || bounds.width === 0 || bounds.height === 0) return { k: 1, x: 0, y: 0 };
  const k = Math.min((WIDTH - PADDING * 2) / bounds.width, (HEIGHT - PADDING * 2) / bounds.height);
  return {
    k,
    x: PADDING + (WIDTH - PADDING * 2 - bounds.width * k) / 2 - bounds.x * k,
    y: PADDING + (HEIGHT - PADDING * 2 - bounds.height * k) / 2 - bounds.y * k,
  };
}

/**
 * The minimap: one canvas of node marks, redrawn when the layout commits, and a
 * second canvas with the viewport rectangle, redrawn when the camera moves.
 * Clicking it centers the camera there. Canvas rather than a DOM node per
 * element keeps it cheap on a large map. It hides while the whole map is on
 * screen: then it would only repeat the view. Nodes are outlined over a light
 * fill, so one big node reads as a card and not as a solid block.
 */
export function MapMinimap({
  snapshot,
  camera,
  viewport,
  onJump,
}: {
  readonly snapshot: MapSnapshot;
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly onJump: (world: Point) => void;
}) {
  const marksRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const scale = scaleFor(snapshot.bounds);
  const bounds = snapshot.bounds;
  // Nothing to show where the whole map is on screen, or where it is one card.
  const hidden =
    bounds === null ||
    snapshot.nodes.length < 2 ||
    boxContainsBox(visibleWorldBox(camera, viewport), bounds);

  useEffect(() => {
    const canvas = marksRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = WIDTH * ratio;
    canvas.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = readThemeColor("--map-minimap-node");
    context.strokeStyle = readThemeColor("--map-minimap-node-stroke");
    context.lineWidth = 1;
    for (const node of snapshot.nodes) {
      const at = snapshot.positions.get(node.id);
      if (!at) continue;
      const x = scale.x + at.x * scale.k;
      const y = scale.y + at.y * scale.k;
      const width = Math.max(1, node.width * scale.k);
      const height = Math.max(1, node.height * scale.k);
      context.fillRect(x, y, width, height);
      if (width >= 4 && height >= 4) context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    }
    // `hidden`: shown again, the minimap is a new canvas that needs its marks.
  }, [snapshot, scale.k, scale.x, scale.y, hidden]);

  useEffect(() => {
    const canvas = frameRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = WIDTH * ratio;
    canvas.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, WIDTH, HEIGHT);
    const visible = visibleWorldBox(camera, viewport);
    context.strokeStyle = readThemeColor("--map-minimap-viewport");
    context.lineWidth = 1.5;
    context.strokeRect(
      scale.x + visible.x * scale.k,
      scale.y + visible.y * scale.k,
      visible.width * scale.k,
      visible.height * scale.k,
    );
  }, [camera, viewport, scale.k, scale.x, scale.y, hidden]);

  if (hidden) return null;
  return (
    <div
      aria-label="Minimap"
      className="surface-glass pointer-events-auto absolute right-3 bottom-14 overflow-hidden rounded-lg border border-border/60 shadow-sm"
      data-board-chrome=""
      data-testid="map-minimap"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        onJump({ x: (x - scale.x) / scale.k, y: (y - scale.y) / scale.k });
      }}
      role="img"
      style={{ width: WIDTH, height: HEIGHT }}
    >
      <canvas
        ref={marksRef}
        className="absolute inset-0"
        style={{ width: WIDTH, height: HEIGHT }}
      />
      <canvas
        ref={frameRef}
        className="absolute inset-0"
        style={{ width: WIDTH, height: HEIGHT }}
      />
    </div>
  );
}
