import type { Box } from "@quipu/canvas/geometry";
import type { TraceOccurrence } from "@quipu/contracts/deepSearch";
import type { ByteRange } from "@quipu/contracts/engine";
import { useMemo } from "react";

import type { MapSnapshot } from "../../documents/mapModel";
import { nodeId } from "../../documents/treeModel";

export interface TraceArcSegment {
  readonly key: string;
  readonly path: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

const centerOf = (box: Box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const resolveVisibleMapNodeId = (
  occurrence: TraceOccurrence,
  snapshot: MapSnapshot,
): string | null => {
  if (occurrence.ref !== null) {
    const tid = nodeId(occurrence.ref);
    const direct = snapshot.locations.get(tid);
    if (direct !== undefined && snapshot.positions.has(direct.nodeId)) {
      return direct.nodeId;
    }
  }
  // Walk HAR entry or capture fallback when collapsed in Map.
  if (occurrence.entryIndex !== null) {
    const capture = snapshot.nodes.find((node) => node.kind === "capture");
    if (capture && snapshot.positions.has(capture.id)) return capture.id;
  }
  const root = snapshot.nodes[0];
  return root && snapshot.positions.has(root.id) ? root.id : null;
};

const boxForNode = (snapshot: MapSnapshot, id: string): Box | null => {
  const node = snapshot.byId.get(id);
  const pos = snapshot.positions.get(id);
  if (!node || !pos) return null;
  return { x: pos.x, y: pos.y, width: node.width, height: node.height };
};

/**
 * Computes transient quadratic Bezier SVG arcs between the origin occurrence
 * and every distinct visible target node on the Map. Never modifies persisted drawings.
 */
export const computeTraceArcs = (
  originRange: ByteRange | null,
  occurrences: ReadonlyArray<TraceOccurrence>,
  snapshot: MapSnapshot,
): ReadonlyArray<TraceArcSegment> => {
  if (occurrences.length === 0) return [];
  const originOcc =
    (originRange !== null
      ? occurrences.find(
          (occ) => occ.range.start <= originRange.start && occ.range.end >= originRange.end,
        )
      : undefined) ?? occurrences[0]!;
  const fromNodeId = resolveVisibleMapNodeId(originOcc, snapshot);
  if (fromNodeId === null) return [];
  const fromBox = boxForNode(snapshot, fromNodeId);
  if (fromBox === null) return [];
  const p1 = centerOf(fromBox);

  const segments: TraceArcSegment[] = [];
  const seenTargets = new Set<string>([fromNodeId]);

  for (const occ of occurrences) {
    const toNodeId = resolveVisibleMapNodeId(occ, snapshot);
    if (toNodeId === null || seenTargets.has(toNodeId)) continue;
    const toBox = boxForNode(snapshot, toNodeId);
    if (toBox === null) continue;
    seenTargets.add(toNodeId);

    const p2 = centerOf(toBox);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    const lift = Math.min(90, Math.max(24, dist * 0.18));
    const cx = mx - (dy / (dist || 1)) * lift * 0.35;
    const cy = my - lift;

    segments.push({
      key: `${fromNodeId}->${toNodeId}`,
      path: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`,
      fromNodeId,
      toNodeId,
    });
  }
  return segments;
};

/**
 * Transient, unsaved SVG arc overlay rendered in Map world coordinates for an
 * active exact-value trace.
 */
export function TraceArcs({
  snapshot,
  occurrences,
  originRange,
}: {
  readonly snapshot: MapSnapshot;
  readonly occurrences: ReadonlyArray<TraceOccurrence>;
  readonly originRange: ByteRange | null;
}) {
  const arcs = useMemo(
    () => computeTraceArcs(originRange, occurrences, snapshot),
    [originRange, occurrences, snapshot],
  );
  if (arcs.length === 0) return null;
  return (
    <g data-trace-arcs="" aria-hidden="true" pointerEvents="none">
      {arcs.map((arc) => (
        <path
          key={arc.key}
          d={arc.path}
          fill="none"
          stroke="var(--map-search-stroke, currentColor)"
          strokeWidth={2}
          strokeDasharray="6 4"
          opacity={0.85}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}
