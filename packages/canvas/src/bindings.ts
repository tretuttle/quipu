/**
 * Arrow and line ends that follow their target. A binding stores the target
 * id and a normalized anchor inside its box; the end point is recomputed from
 * the target's current geometry whenever the target or the arrow changes.
 */
import { boxCenter, rotatePoint, type Point } from "./geometry.ts";
import { elementBox, outlinePointToward } from "./hitTest.ts";
import type { Binding, Element, LinearElement } from "./elements.ts";

/** The default stand-off between an arrow end and its target's outline. */
const DEFAULT_BINDING_GAP = 4;

/** The world point a binding's anchor refers to. */
function bindingAnchorPoint(target: Element, binding: Binding): Point {
  const box = elementBox(target);
  const local = {
    x: box.x + box.width * binding.fixedPoint[0],
    y: box.y + box.height * binding.fixedPoint[1],
  };
  return rotatePoint(local, boxCenter(box), target.angle);
}

/** A binding to the target's center, for an arrow that has not picked a point. */
export function centerBinding(targetId: string, gap = DEFAULT_BINDING_GAP): Binding {
  return { targetId, fixedPoint: [0.5, 0.5], gap };
}

/**
 * Where a bound end lands: on the target's outline, between the anchor and the
 * arrow's other end, `gap` units out. A center anchor therefore meets the
 * outline wherever the arrow approaches from; an edge anchor stays put.
 */
function boundEndPoint(target: Element, binding: Binding, otherEnd: Point): Point {
  const anchor = bindingAnchorPoint(target, binding);
  const [u, v] = binding.fixedPoint;
  const isCenter = Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 0.5) < 1e-6;
  if (!isCenter) return anchor;
  return outlinePointToward(target, otherEnd, binding.gap);
}

/**
 * The linear element with both bound ends moved to their targets. Elements
 * come from `lookup`, which returns null for an unknown or deleted target; a
 * missing target leaves that end where it is but keeps the binding.
 */
export function refreshBoundPoints<E extends LinearElement>(
  element: E,
  lookup: (id: string) => Element | null,
): E {
  const points = element.points.map(([px, py]) => ({ x: element.x + px, y: element.y + py }));
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 2) return element;
  const startTarget = element.startBinding ? lookup(element.startBinding.targetId) : null;
  const endTarget = element.endBinding ? lookup(element.endBinding.targetId) : null;
  if (startTarget === null && endTarget === null) return element;

  const secondFromStart = points[1] ?? last;
  const secondFromEnd = points[points.length - 2] ?? first;
  // Resolve against the other end's current point first, then the other end
  // against the new start, so two center-bound ends meet on both outlines.
  const newStart =
    startTarget && element.startBinding
      ? boundEndPoint(
          startTarget,
          element.startBinding,
          points.length === 2 && endTarget ? boxCenter(elementBox(endTarget)) : secondFromStart,
        )
      : first;
  const newEnd =
    endTarget && element.endBinding
      ? boundEndPoint(endTarget, element.endBinding, points.length === 2 ? newStart : secondFromEnd)
      : last;
  const absolute = points.map((p, i) =>
    i === 0 ? newStart : i === points.length - 1 ? newEnd : p,
  );
  const origin = absolute[0] as Point;
  const relative = absolute.map((p): [number, number] => [p.x - origin.x, p.y - origin.y]);
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const [rx, ry] of relative) {
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return {
    ...element,
    x: origin.x,
    y: origin.y,
    width: maxX - minX,
    height: maxY - minY,
    points: relative,
  };
}
