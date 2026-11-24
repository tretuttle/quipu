// The map's layout worker: receives the open nodes' sizes and anchors, lays
// them out (packages/canvas mapLayout) and posts the positions back, so a
// 50 000-node layout never runs on the UI thread. Each request is one message;
// the reply carries the same id.
import { layoutMapTree, type MapLayoutNode } from "@quipu/canvas/mapLayout";

export interface MapLayoutRequest {
  readonly id: number;
  readonly ids: ReadonlyArray<string>;
  /** Parent index per node, or -1 for a root. */
  readonly parents: Int32Array;
  readonly widths: Float64Array;
  readonly heights: Float64Array;
  readonly anchors: Float64Array;
}

export interface MapLayoutReply {
  readonly id: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly bounds: { x: number; y: number; width: number; height: number } | null;
}

self.addEventListener("message", (event: MessageEvent<MapLayoutRequest>) => {
  const { id, ids, parents, widths, heights, anchors } = event.data;
  const nodes: MapLayoutNode[] = ids.map((nodeId, i) => ({
    id: nodeId,
    parentId: parents[i] === -1 ? null : (ids[parents[i] as number] as string),
    width: widths[i] as number,
    height: heights[i] as number,
    anchor: anchors[i] as number,
  }));
  const layout = layoutMapTree(nodes);
  const xs = new Float64Array(ids.length);
  const ys = new Float64Array(ids.length);
  ids.forEach((nodeId, i) => {
    const point = layout.positions.get(nodeId);
    xs[i] = point?.x ?? 0;
    ys[i] = point?.y ?? 0;
  });
  const reply: MapLayoutReply = { id, xs, ys, bounds: layout.bounds };
  self.postMessage(reply, { transfer: [xs.buffer, ys.buffer] });
});
