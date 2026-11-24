/**
 * Turns elements into paint primitives: SVG path data plus token names. The
 * shell maps tokens to theme variables, so no color literal exists on this
 * side. Hand-drawn shapes come from rough.js (MIT) seeded with the element's
 * stored seed; the clean style skips rough and emits the geometric primitive.
 * Drawables are cached by element version, so a pan or zoom rebuilds nothing.
 */
import rough from "roughjs";
import type { Drawable, Options as RoughOptions } from "roughjs/bin/core.js";
import type { RoughGenerator } from "roughjs/bin/generator.js";
import { getStroke } from "perfect-freehand";

import { diamondVertices, roundTo, type Point } from "./geometry.ts";
import { elementBox, FRAME_LABEL_FONT_SIZE, frameLabelBox, freehandSize } from "./hitTest.ts";
import { layoutText, type MeasureText, LINE_HEIGHT } from "./text.ts";
import type { Element, FontFamily, InkToken, LinearElement } from "./elements.ts";

// rough.js publishes a CommonJS main and an ESM module that both hand back the
// API object as the default export. NodeNext types the CJS default import as
// the module namespace while Bundler types it as the API, so the cast names
// the one method this module uses, which both runtimes provide.
interface RoughApi {
  readonly generator: (config?: { options?: RoughOptions }) => RoughGenerator;
}
const roughApi = rough as unknown as RoughApi;

/** Role names the shell resolves through the theme. */
export type PaintToken =
  | `ink-${InkToken}`
  | `ink-fill-${InkToken}`
  | "note-surface"
  | "note-foreground"
  | "frame-stroke"
  | "frame-fill"
  | "frame-label"
  | "none";

export interface PathPrimitive {
  readonly kind: "path";
  /** Stable within the element's render, for list keys. */
  readonly key: string;
  readonly d: string;
  readonly stroke: PaintToken;
  readonly fill: PaintToken;
  readonly strokeWidth: number;
  readonly dash: ReadonlyArray<number> | null;
  /** Hachure fills are drawn as strokes at a thin width. */
  readonly role: "outline" | "fill" | "sketch";
}

export interface TextPrimitive {
  readonly kind: "text";
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily: FontFamily;
  readonly align: "left" | "center" | "right";
  readonly fill: PaintToken;
}

export interface ImagePrimitive {
  readonly kind: "image";
  readonly key: string;
  readonly fileId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type RenderPrimitive = PathPrimitive | TextPrimitive | ImagePrimitive;
type Unkeyed<T> = T extends unknown ? Omit<T, "key"> : never;

export interface RenderedElement {
  readonly id: string;
  readonly version: number;
  /** `rotate(angle, cx, cy)` inputs in degrees and world units. */
  readonly rotation: { readonly degrees: number; readonly cx: number; readonly cy: number } | null;
  readonly opacity: number;
  readonly primitives: ReadonlyArray<RenderPrimitive>;
}

function dashFor(style: Element["style"]): ReadonlyArray<number> | null {
  switch (style.strokeStyle) {
    case "dashed":
      return [style.strokeWidth * 4, style.strokeWidth * 3];
    case "dotted":
      return [style.strokeWidth, style.strokeWidth * 2];
    default:
      return null;
  }
}

function fmt(value: number): string {
  return String(roundTo(value, 2));
}

function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}Z`;
}

function ellipsePath(x: number, y: number, w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  return `M${fmt(cx - rx)} ${fmt(cy)}a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(rx * 2)} 0a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(-rx * 2)} 0Z`;
}

function polygonPath(points: ReadonlyArray<Point>, close: boolean): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${fmt(first.x)} ${fmt(first.y)}`;
  for (const p of rest) d += `L${fmt(p.x)} ${fmt(p.y)}`;
  return close ? `${d}Z` : d;
}

/** Arrowhead geometry at `tip`, pointing away from `from`. */
function arrowheadPath(
  tip: Point,
  from: Point,
  kind: "arrow" | "bar" | "dot",
  size: number,
): string {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const left = angle + Math.PI * 0.8;
  const right = angle - Math.PI * 0.8;
  switch (kind) {
    case "arrow": {
      const a = { x: tip.x + Math.cos(left) * size, y: tip.y + Math.sin(left) * size };
      const b = { x: tip.x + Math.cos(right) * size, y: tip.y + Math.sin(right) * size };
      return `M${fmt(a.x)} ${fmt(a.y)}L${fmt(tip.x)} ${fmt(tip.y)}L${fmt(b.x)} ${fmt(b.y)}`;
    }
    case "bar": {
      const perpendicular = angle + Math.PI / 2;
      const a = {
        x: tip.x + Math.cos(perpendicular) * size * 0.6,
        y: tip.y + Math.sin(perpendicular) * size * 0.6,
      };
      const b = {
        x: tip.x - Math.cos(perpendicular) * size * 0.6,
        y: tip.y - Math.sin(perpendicular) * size * 0.6,
      };
      return `M${fmt(a.x)} ${fmt(a.y)}L${fmt(b.x)} ${fmt(b.y)}`;
    }
    case "dot": {
      const r = size * 0.35;
      return ellipsePath(tip.x - r, tip.y - r, r * 2, r * 2);
    }
  }
}

export interface Renderer {
  /** Primitives for an element; memoized on id + version + style tokens. */
  readonly render: (element: Element) => RenderedElement;
  /** Drops every cached drawable. A theme change does not need it: tokens are stable. */
  readonly clear: () => void;
}

/** A sentinel paint: rough's own default stroke must never reach the output. */
const TOKEN_PLACEHOLDER = "token";

export function createRenderer(measure: MeasureText): Renderer {
  const generator: RoughGenerator = roughApi.generator();
  const cache = new Map<string, RenderedElement>();

  const roughOptions = (element: Element, fill: boolean): RoughOptions => ({
    seed: element.seed,
    roughness: element.style.roughness,
    bowing: 1,
    stroke: TOKEN_PLACEHOLDER,
    strokeWidth: element.style.strokeWidth,
    ...(fill ? { fill: TOKEN_PLACEHOLDER } : {}),
    fillStyle: element.style.fill === "solid" ? "solid" : "hachure",
    fillWeight: element.style.strokeWidth / 2,
    hachureGap: element.style.strokeWidth * 4,
    disableMultiStroke: element.style.strokeStyle !== "solid",
    preserveVertices: true,
  });

  type UnkeyedPath = Omit<PathPrimitive, "key">;
  const fromDrawable = (element: Element, drawable: Drawable): UnkeyedPath[] => {
    const ink = element.style.stroke;
    const dash = dashFor(element.style);
    const out: UnkeyedPath[] = [];
    for (const set of drawable.sets) {
      const d = generator.opsToPath(set);
      if (set.type === "path") {
        out.push({
          kind: "path",
          d,
          stroke: `ink-${ink}`,
          fill: "none",
          strokeWidth: element.style.strokeWidth,
          dash,
          role: "outline",
        });
      } else if (set.type === "fillPath") {
        out.push({
          kind: "path",
          d,
          stroke: "none",
          fill: `ink-fill-${ink}`,
          strokeWidth: 0,
          dash: null,
          role: "fill",
        });
      } else {
        out.push({
          kind: "path",
          d,
          stroke: `ink-fill-${ink}`,
          fill: "none",
          strokeWidth: Math.max(0.5, element.style.strokeWidth / 2),
          dash: null,
          role: "sketch",
        });
      }
    }
    // Fills under outlines, as rough draws them.
    return out.sort((a, b) => (a.role === "outline" ? 1 : 0) - (b.role === "outline" ? 1 : 0));
  };

  const cleanShape = (element: Element, d: string, closed: boolean): UnkeyedPath[] => {
    const ink = element.style.stroke;
    const fill: PaintToken = closed && element.style.fill !== "none" ? `ink-fill-${ink}` : "none";
    return [
      {
        kind: "path",
        d,
        stroke: `ink-${ink}`,
        fill,
        strokeWidth: element.style.strokeWidth,
        dash: dashFor(element.style),
        role: "outline",
      },
    ];
  };

  const linearPrimitives = (element: LinearElement): UnkeyedPath[] => {
    const points = element.points.map(([px, py]) => ({ x: element.x + px, y: element.y + py }));
    const rough = element.style.roughness > 0;
    const closed = element.type === "line" && element.style.fill !== "none" && points.length > 2;
    const out: UnkeyedPath[] = rough
      ? fromDrawable(
          element,
          closed
            ? generator.polygon(
                points.map((p) => [p.x, p.y]),
                roughOptions(element, true),
              )
            : generator.linearPath(
                points.map((p) => [p.x, p.y]),
                roughOptions(element, false),
              ),
        )
      : cleanShape(element, polygonPath(points, closed), closed);
    if (element.type === "arrow") {
      const size = Math.max(8, element.style.strokeWidth * 5);
      const first = points[0];
      const second = points[1];
      const last = points[points.length - 1];
      const beforeLast = points[points.length - 2];
      const head = (tip: Point, from: Point, kind: typeof element.endArrowhead) => {
        if (kind === "none") return;
        out.push({
          kind: "path",
          d: arrowheadPath(tip, from, kind, size),
          stroke: `ink-${element.style.stroke}`,
          fill: kind === "dot" ? `ink-${element.style.stroke}` : "none",
          strokeWidth: element.style.strokeWidth,
          dash: null,
          role: "outline",
        });
      };
      if (first && second) head(first, second, element.startArrowhead);
      if (last && beforeLast) head(last, beforeLast, element.endArrowhead);
    }
    return out;
  };

  const render = (element: Element): RenderedElement => {
    const key = `${element.id}:${element.version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const box = elementBox(element);
    const primitives: Array<Unkeyed<RenderPrimitive>> = [];
    const rough = element.style.roughness > 0;
    switch (element.type) {
      case "rectangle": {
        primitives.push(
          ...(rough
            ? fromDrawable(
                element,
                generator.rectangle(
                  box.x,
                  box.y,
                  box.width,
                  box.height,
                  roughOptions(element, element.style.fill !== "none"),
                ),
              )
            : cleanShape(element, rectPath(box.x, box.y, box.width, box.height), true)),
        );
        break;
      }
      case "ellipse": {
        primitives.push(
          ...(rough
            ? fromDrawable(
                element,
                generator.ellipse(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                  box.width,
                  box.height,
                  roughOptions(element, element.style.fill !== "none"),
                ),
              )
            : cleanShape(element, ellipsePath(box.x, box.y, box.width, box.height), true)),
        );
        break;
      }
      case "diamond": {
        const vertices = diamondVertices(box);
        primitives.push(
          ...(rough
            ? fromDrawable(
                element,
                generator.polygon(
                  vertices.map((p) => [p.x, p.y]),
                  roughOptions(element, element.style.fill !== "none"),
                ),
              )
            : cleanShape(element, polygonPath(vertices, true), true)),
        );
        break;
      }
      case "line":
      case "arrow": {
        primitives.push(...linearPrimitives(element));
        break;
      }
      case "freehand": {
        const outline = getStroke(
          element.points.map(([px, py, pressure]) => [px, py, pressure]),
          {
            size: freehandSize(element.style.strokeWidth),
            thinning: 0.6,
            smoothing: 0.5,
            streamline: 0.5,
            simulatePressure: element.simulatePressure,
            last: true,
          },
        ).map(([ox, oy]) => ({ x: element.x + (ox ?? 0), y: element.y + (oy ?? 0) }));
        primitives.push({
          kind: "path",
          d: polygonPath(outline, true),
          stroke: "none",
          fill: `ink-${element.style.stroke}`,
          strokeWidth: 0,
          dash: null,
          role: "fill",
        });
        break;
      }
      case "text": {
        const layout = layoutText(
          element.text,
          { family: element.fontFamily, size: element.fontSize },
          measure,
          null,
        );
        primitives.push({
          kind: "text",
          lines: layout.lines,
          x: box.x,
          y: box.y,
          width: box.width,
          fontSize: element.fontSize,
          lineHeight: LINE_HEIGHT,
          fontFamily: element.fontFamily,
          align: element.textAlign,
          fill: `ink-${element.style.stroke}`,
        });
        break;
      }
      case "note": {
        primitives.push({
          kind: "path",
          d: rectPath(box.x, box.y, box.width, box.height),
          stroke: "none",
          fill: "note-surface",
          strokeWidth: 0,
          dash: null,
          role: "fill",
        });
        const padding = Math.min(12, box.width / 8);
        const layout = layoutText(
          element.text,
          { family: element.fontFamily, size: element.fontSize },
          measure,
          Math.max(1, box.width - padding * 2),
        );
        primitives.push({
          kind: "text",
          lines: layout.lines,
          x: box.x + padding,
          y: box.y + padding,
          width: box.width - padding * 2,
          fontSize: element.fontSize,
          lineHeight: LINE_HEIGHT,
          fontFamily: element.fontFamily,
          align: element.textAlign,
          fill: "note-foreground",
        });
        break;
      }
      case "frame": {
        primitives.push({
          kind: "path",
          d: rectPath(box.x, box.y, box.width, box.height),
          stroke: "frame-stroke",
          fill: "frame-fill",
          strokeWidth: 1,
          dash: null,
          role: "outline",
        });
        const label = frameLabelBox(element);
        primitives.push({
          kind: "text",
          lines: [element.name],
          x: label.x,
          y: label.y,
          width: label.width,
          fontSize: FRAME_LABEL_FONT_SIZE,
          lineHeight: LINE_HEIGHT,
          fontFamily: "sans",
          align: "left",
          fill: "frame-label",
        });
        break;
      }
      case "image": {
        primitives.push({
          kind: "image",
          fileId: element.fileId,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        });
        break;
      }
    }
    const keyed = primitives.map((primitive, n) => ({
      ...primitive,
      key: `${primitive.kind}${n}`,
    }));
    const rendered: RenderedElement = {
      id: element.id,
      version: element.version,
      rotation:
        element.angle === 0
          ? null
          : {
              degrees: roundTo((element.angle * 180) / Math.PI, 3),
              cx: box.x + box.width / 2,
              cy: box.y + box.height / 2,
            },
      opacity: element.style.opacity,
      primitives: keyed,
    };
    // Keep the cache bounded: one entry per element, replaced on version change.
    for (const existing of cache.keys()) {
      if (existing.startsWith(`${element.id}:`)) cache.delete(existing);
    }
    cache.set(key, rendered);
    return rendered;
  };

  return { render, clear: () => cache.clear() };
}
