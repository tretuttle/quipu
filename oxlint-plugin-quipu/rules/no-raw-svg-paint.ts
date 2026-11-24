import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

/*
 * SVG and canvas paint comes from theme tokens. @shadcn/lint reads class names only, so a
 * `fill="#fff"`, a `style={{ stroke: "red" }}` or `ctx.fillStyle = "#000"` gets past it.
 *
 * Limits. The rule is syntactic.
 * - A string literal, a template without substitutions, and the branches of `?:`, `&&`, `||`
 *   and `??` are checked. Any other expression (an identifier, a call, a template with
 *   substitutions) is allowed; the rule cannot see what it holds.
 * - Style keys are checked on an object written inline in a `style` attribute, and on
 *   `el.style.<key> = literal`. An object built elsewhere and passed in is not seen.
 * - A value is a color literal when it is a hex color, a color function with no var() inside,
 *   or a CSS named color. `none`, `currentColor`, `transparent`, `inherit`, `url(#id)`,
 *   `var(--token)` and words that are not CSS colors (`primary`) pass.
 */

const PAINT_ATTRIBUTES = new Set(["fill", "stroke", "stopColor", "stop-color", "color"]);
const PAINT_STYLE_KEYS = new Set(["fill", "stroke", "stopColor", "color"]);
const CANVAS_PAINT_PROPERTIES = new Set(["fillStyle", "strokeStyle"]);

const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/u;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u;
const VAR_WITH_FALLBACK = /^var\(\s*--[^,)]+,\s*(.+)\)$/u;

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet " +
    "brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan " +
    "darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta " +
    "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue " +
    "darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey " +
    "dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray " +
    "green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush " +
    "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray " +
    "lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
    "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen " +
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna " +
    "silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle " +
    "tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

function isColorLiteral(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (HEX_COLOR.test(value)) return true;
  if (COLOR_FUNCTION.test(value)) return !value.includes("var(");
  const fallback = VAR_WITH_FALLBACK.exec(value);
  if (fallback?.[1] !== undefined) return isColorLiteral(fallback[1]);
  return NAMED_COLORS.has(value);
}

/** The color literals a value can produce, with the node to report each on. */
function* colorLiterals(node: unknown): Generator<{ node: ESTree.Node; text: string }> {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return;
  const value = expression.value;
  switch (value.type) {
    case "Literal":
      if (typeof value.value === "string" && isColorLiteral(value.value)) {
        yield { node: value, text: value.value };
      }
      return;
    case "TemplateLiteral": {
      const [only] = value.quasis;
      if (
        value.expressions.length === 0 &&
        only?.value.cooked &&
        isColorLiteral(only.value.cooked)
      ) {
        yield { node: value, text: only.value.cooked };
      }
      return;
    }
    case "JSXExpressionContainer":
      yield* colorLiterals(value.expression);
      return;
    case "ConditionalExpression":
      yield* colorLiterals(value.consequent);
      yield* colorLiterals(value.alternate);
      return;
    case "LogicalExpression":
      yield* colorLiterals(value.left);
      yield* colorLiterals(value.right);
      return;
  }
}

/** Object literals a `style` value can produce. */
function* styleObjects(node: unknown): Generator<ESTree.ObjectExpression> {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return;
  const value = expression.value;
  switch (value.type) {
    case "ObjectExpression":
      yield value;
      return;
    case "JSXExpressionContainer":
      yield* styleObjects(value.expression);
      return;
    case "ConditionalExpression":
      yield* styleObjects(value.consequent);
      yield* styleObjects(value.alternate);
      return;
    case "LogicalExpression":
      yield* styleObjects(value.left);
      yield* styleObjects(value.right);
      return;
  }
}

const MESSAGE =
  "Paint comes from theme tokens, never a color literal. Use currentColor, a var(--token), a Tailwind token class, or a value read from the theme.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow color literals in SVG fill/stroke/stopColor/color attributes and style keys, and in canvas fillStyle/strokeStyle assignments.",
    },
  },
  create(context) {
    const reportAll = (value: unknown, where: string) => {
      for (const { node, text } of colorLiterals(value)) {
        context.report({ node, message: `${where} is the color literal ${text}. ${MESSAGE}` });
      }
    };

    return {
      JSXAttribute(node) {
        if (node.value === null || node.value === undefined) return;
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (name === undefined) return;

        if (PAINT_ATTRIBUTES.has(name)) {
          reportAll(node.value, `The ${name} attribute`);
          return;
        }
        if (name !== "style") return;
        for (const object of styleObjects(node.value)) {
          for (const property of object.properties) {
            if (property.type !== "Property") continue;
            const key = getPropertyName(property.key);
            if (Option.isNone(key) || !PAINT_STYLE_KEYS.has(key.value)) continue;
            reportAll(property.value, `The style key ${key.value}`);
          }
        }
      },
      AssignmentExpression(node) {
        const target = unwrapExpression(node.left);
        if (Option.isNone(target) || target.value.type !== "MemberExpression") return;
        const property = getPropertyName(target.value.property);
        if (Option.isNone(property)) return;

        if (CANVAS_PAINT_PROPERTIES.has(property.value)) {
          reportAll(node.right, `The canvas ${property.value}`);
          return;
        }
        if (!PAINT_STYLE_KEYS.has(property.value)) return;
        // el.style.color = "#fff"
        const owner = unwrapExpression(target.value.object);
        if (Option.isNone(owner) || owner.value.type !== "MemberExpression") return;
        const ownerName = getPropertyName(owner.value.property);
        if (Option.isSome(ownerName) && ownerName.value === "style") {
          reportAll(node.right, `The style key ${property.value}`);
        }
      },
    };
  },
});
