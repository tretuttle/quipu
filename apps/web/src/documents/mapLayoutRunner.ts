import type { MapLayout, MapLayoutNode } from "@quipu/canvas/mapLayout";

import type { MapLayoutReply, MapLayoutRequest } from "./mapLayout.worker.ts";
import type { MapLayoutRunner } from "./mapModel.ts";

/** Runs the map layout in its worker; one runner per open map. */
export function createWorkerLayoutRunner(): MapLayoutRunner {
  const worker = new Worker(new URL("./mapLayout.worker.ts", import.meta.url), {
    type: "module",
  });
  let nextId = 1;
  const pending = new Map<
    number,
    { ids: ReadonlyArray<string>; resolve: (layout: MapLayout) => void }
  >();
  worker.addEventListener("error", (event) => {
    // A worker that cannot start would leave every layout pending; say so instead.
    console.error("[map] the layout worker failed", event.message);
  });
  worker.addEventListener("message", (event: MessageEvent<MapLayoutReply>) => {
    const reply = event.data;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    const positions = new Map<string, { x: number; y: number }>();
    entry.ids.forEach((id, i) => {
      positions.set(id, { x: reply.xs[i] as number, y: reply.ys[i] as number });
    });
    entry.resolve({ positions, bounds: reply.bounds });
  });
  return {
    layout: (nodes: ReadonlyArray<MapLayoutNode>) => {
      const ids = nodes.map((node) => node.id);
      const index = new Map(ids.map((id, i) => [id, i] as const));
      const parents = new Int32Array(nodes.length);
      const widths = new Float64Array(nodes.length);
      const heights = new Float64Array(nodes.length);
      const anchors = new Float64Array(nodes.length);
      nodes.forEach((node, i) => {
        parents[i] = node.parentId === null ? -1 : (index.get(node.parentId) ?? -1);
        widths[i] = node.width;
        heights[i] = node.height;
        anchors[i] = node.anchor;
      });
      const id = nextId++;
      const request: MapLayoutRequest = { id, ids, parents, widths, heights, anchors };
      return new Promise<MapLayout>((resolve) => {
        pending.set(id, { ids, resolve });
        worker.postMessage(request, {
          transfer: [parents.buffer, widths.buffer, heights.buffer, anchors.buffer],
        });
      });
    },
    dispose: () => {
      worker.terminate();
      pending.clear();
    },
  };
}
