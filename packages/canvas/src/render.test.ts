import { describe, expect, it } from "@effect/vitest";

import { createRenderer, type PathPrimitive } from "./render.ts";
import { rect } from "./testing.ts";
import { monospaceMeasure } from "./text.ts";
import type { Element } from "./elements.ts";

const paths = (primitives: ReadonlyArray<unknown>) =>
  primitives.filter((p): p is PathPrimitive => (p as PathPrimitive).kind === "path");

describe("render", () => {
  it("hand-drawn output is deterministic for a seed and differs across seeds", () => {
    const a = rect(10, 10, 100, 60, { seed: 42, style: { roughness: 1 } });
    const same = { ...a, id: "other" } as Element;
    const different = { ...a, id: "third", seed: 43 } as Element;
    const renderer = createRenderer(monospaceMeasure());
    const first = paths(renderer.render(a).primitives).map((p) => p.d);
    const second = paths(createRenderer(monospaceMeasure()).render(same).primitives).map(
      (p) => p.d,
    );
    const third = paths(renderer.render(different).primitives).map((p) => p.d);
    expect(first).toEqual(second);
    expect(first).not.toEqual(third);
    expect(first.length).toBeGreaterThan(0);
  });

  it("the clean style emits one geometric path, and every paint is a token", () => {
    const renderer = createRenderer(monospaceMeasure());
    const clean = rect(0, 0, 50, 30, { style: { roughness: 0, fill: "soft", stroke: "red" } });
    const rendered = renderer.render(clean);
    const only = paths(rendered.primitives);
    expect(only).toHaveLength(1);
    expect(only[0]?.d).toBe("M0 0h50v30h-50Z");
    expect(only[0]?.stroke).toBe("ink-red");
    expect(only[0]?.fill).toBe("ink-fill-red");
    for (const p of only) {
      expect(p.stroke).not.toMatch(/#|rgb|token/);
      expect(p.fill).not.toMatch(/#|rgb|token/);
    }
  });

  it("an arrow gets an arrowhead at its end only, and a rotated element reports its rotation", () => {
    const renderer = createRenderer(monospaceMeasure());
    const arrow: Element = {
      ...rect(0, 0, 100, 0, { angle: Math.PI / 2, style: { roughness: 0 } }),
      type: "arrow",
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: null,
      endBinding: null,
      startArrowhead: "none",
      endArrowhead: "arrow",
    } as Element;
    const rendered = renderer.render(arrow);
    expect(paths(rendered.primitives)).toHaveLength(2);
    expect(rendered.rotation?.degrees).toBe(90);
  });

  it("caches by version: the same version returns the same object, a new version re-renders", () => {
    const renderer = createRenderer(monospaceMeasure());
    const a = rect(0, 0, 10, 10);
    expect(renderer.render(a)).toBe(renderer.render(a));
    expect(renderer.render({ ...a, version: 1, width: 20 } as Element)).not.toBe(
      renderer.render(a),
    );
  });
});
