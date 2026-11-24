/**
 * The drawing element schema. One JSON-serializable record per element,
 * Excalidraw-shaped (MIT): geometry, a stored `seed` so hand-drawn strokes do
 * not change between paints, a fractional `index` for z-order, `isDeleted`
 * tombstones so undo and bindings keep resolving, `groupIds` deepest first,
 * and `frameId` for frame membership. Colors are theme-token names, never hex.
 */
import * as Schema from "effect/Schema";

import { isValidIndexKey } from "./fractionalIndex.ts";

/** Bumped when a persisted element can no longer be read by the previous shape. */
export const ELEMENT_SCHEMA_VERSION = 1;

/** The ink roles a theme resolves to colors. */
const INK_TOKENS = ["default", "muted", "red", "blue", "green", "amber", "violet"] as const;
export const InkToken = Schema.Literals(INK_TOKENS);
export type InkToken = typeof InkToken.Type;

const FILL_STYLES = ["none", "soft", "solid"] as const;
export const FillStyle = Schema.Literals(FILL_STYLES);
export type FillStyle = typeof FillStyle.Type;

const STROKE_STYLES = ["solid", "dashed", "dotted"] as const;
export const StrokeStyle = Schema.Literals(STROKE_STYLES);
export type StrokeStyle = typeof StrokeStyle.Type;

const STROKE_WIDTHS = [1, 2, 4] as const;
export const StrokeWidth = Schema.Literals(STROKE_WIDTHS);
export type StrokeWidth = typeof StrokeWidth.Type;

/** 0 is the clean style; 1 and 2 are hand-drawn (rough.js roughness). */
const ROUGHNESS_LEVELS = [0, 1, 2] as const;
export const Roughness = Schema.Literals(ROUGHNESS_LEVELS);
export type Roughness = typeof Roughness.Type;

const FONT_FAMILIES = ["sans", "mono", "hand"] as const;
export const FontFamily = Schema.Literals(FONT_FAMILIES);
export type FontFamily = typeof FontFamily.Type;

const TEXT_ALIGNS = ["left", "center", "right"] as const;
export const TextAlign = Schema.Literals(TEXT_ALIGNS);
export type TextAlign = typeof TextAlign.Type;

const ARROWHEADS = ["none", "arrow", "bar", "dot"] as const;
export const Arrowhead = Schema.Literals(ARROWHEADS);
export type Arrowhead = typeof Arrowhead.Type;

export const FiniteNumber = Schema.Number.check(Schema.isFinite());
const Opacity = FiniteNumber.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const IndexKey = Schema.String.check(
  Schema.makeFilter(isValidIndexKey, { expected: "a fractional index key" }),
);
/** Non-zero so rough.js never falls through to Math.random (its seed-0 path). */
const Seed = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }));
export const ElementId = Schema.String.check(Schema.isMinLength(1));
export type ElementId = typeof ElementId.Type;

/** Every element's look. Stored as tokens; the renderer resolves them. */
export const ElementStyle = Schema.Struct({
  stroke: InkToken,
  fill: FillStyle,
  strokeWidth: StrokeWidth,
  strokeStyle: StrokeStyle,
  roughness: Roughness,
  opacity: Opacity,
});
export type ElementStyle = typeof ElementStyle.Type;

export const DEFAULT_STYLE: ElementStyle = {
  stroke: "default",
  fill: "none",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 1,
};

const BaseFields = {
  id: ElementId,
  x: FiniteNumber,
  y: FiniteNumber,
  width: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
  height: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Radians, clockwise on screen, about the box center. */
  angle: FiniteNumber,
  index: IndexKey,
  seed: Seed,
  /** Incremented on every change; a cheap "did it change" for caches. */
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  isDeleted: Schema.Boolean,
  locked: Schema.Boolean,
  /** Deepest group first, like Excalidraw. */
  groupIds: Schema.Array(ElementId),
  frameId: Schema.NullOr(ElementId),
  style: ElementStyle,
} as const;

export const Point2 = Schema.Tuple([FiniteNumber, FiniteNumber]);
export type Point2 = typeof Point2.Type;

/**
 * Where a line end attaches: a stable target id (a drawing element or a map
 * node) plus a normalized anchor in the target's box, so the end follows
 * the target through moves, resizes and re-layouts.
 */
export const Binding = Schema.Struct({
  targetId: ElementId,
  /** 0..1 inside the target's current box. */
  fixedPoint: Schema.Tuple([
    FiniteNumber.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    FiniteNumber.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ]),
  /** Stand-off from the target's outline, world units. */
  gap: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type Binding = typeof Binding.Type;

export const RectangleElement = Schema.Struct({ ...BaseFields, type: Schema.Literal("rectangle") });
export const EllipseElement = Schema.Struct({ ...BaseFields, type: Schema.Literal("ellipse") });
export const DiamondElement = Schema.Struct({ ...BaseFields, type: Schema.Literal("diamond") });

const LinearFields = {
  ...BaseFields,
  /** Relative to `x`/`y`. The first point is always [0, 0]. */
  points: Schema.Array(Point2).check(Schema.isMinLength(2)),
  startBinding: Schema.NullOr(Binding),
  endBinding: Schema.NullOr(Binding),
} as const;

export const LineElement = Schema.Struct({ ...LinearFields, type: Schema.Literal("line") });
export const ArrowElement = Schema.Struct({
  ...LinearFields,
  type: Schema.Literal("arrow"),
  startArrowhead: Arrowhead,
  endArrowhead: Arrowhead,
});

export const FreehandElement = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("freehand"),
  /** Input samples relative to `x`/`y`: [x, y, pressure 0..1]. The outline is derived. */
  points: Schema.Array(Schema.Tuple([FiniteNumber, FiniteNumber, FiniteNumber])).check(
    Schema.isMinLength(1),
  ),
  /** True when the device reported a flat 0.5 pressure and the stroke should fake it from velocity. */
  simulatePressure: Schema.Boolean,
});

const TextFields = {
  text: Schema.String,
  fontSize: FiniteNumber.check(Schema.isGreaterThan(0)),
  fontFamily: FontFamily,
  textAlign: TextAlign,
} as const;

export const TextElement = Schema.Struct({
  ...BaseFields,
  ...TextFields,
  type: Schema.Literal("text"),
});

/**
 * Where a note sits on a map node: the node's id and the note's top-left
 * relative to the node's box, so the note rides along when the layout moves
 * the node.
 */
export const NoteAttachment = Schema.Struct({
  targetId: ElementId,
  offset: Point2,
});
export type NoteAttachment = typeof NoteAttachment.Type;

/** A sticky note: a filled square with its text inside. */
export const NoteElement = Schema.Struct({
  ...BaseFields,
  ...TextFields,
  type: Schema.Literal("note"),
  /** The map node the note was dropped on; absent or null when it floats free. */
  attachment: Schema.optionalKey(Schema.NullOr(NoteAttachment)),
});

export const FrameElement = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("frame"),
  name: Schema.String,
});

export const ImageElement = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("image"),
  /** The asset id (content hash) in the per-document file store. */
  fileId: Schema.String.check(Schema.isMinLength(1)),
});

export const Element = Schema.Union([
  RectangleElement,
  EllipseElement,
  DiamondElement,
  LineElement,
  ArrowElement,
  FreehandElement,
  TextElement,
  NoteElement,
  FrameElement,
  ImageElement,
]);
export type Element = typeof Element.Type;

export type RectangleElement = typeof RectangleElement.Type;
export type EllipseElement = typeof EllipseElement.Type;
export type DiamondElement = typeof DiamondElement.Type;
export type LineElement = typeof LineElement.Type;
export type ArrowElement = typeof ArrowElement.Type;
export type FreehandElement = typeof FreehandElement.Type;
export type TextElement = typeof TextElement.Type;
export type NoteElement = typeof NoteElement.Type;
export type FrameElement = typeof FrameElement.Type;
export type ImageElement = typeof ImageElement.Type;
export type LinearElement = LineElement | ArrowElement;
export type BoxElement =
  | RectangleElement
  | EllipseElement
  | DiamondElement
  | NoteElement
  | FrameElement
  | ImageElement
  | TextElement;

export function isLinearElement(element: Element): element is LinearElement {
  return element.type === "line" || element.type === "arrow";
}

export function isTextBearing(element: Element): element is TextElement | NoteElement {
  return element.type === "text" || element.type === "note";
}

/** Elements that can be a binding target: anything with a box outline. */
export function isBindable(element: Element): boolean {
  return (
    element.type === "rectangle" ||
    element.type === "ellipse" ||
    element.type === "diamond" ||
    element.type === "note" ||
    element.type === "frame" ||
    element.type === "image" ||
    element.type === "text"
  );
}
