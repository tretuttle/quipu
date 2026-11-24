import type { MapNode, MapNodeKind, MapRow } from "../../documents/mapModel";
import { syntaxVariableFor } from "../../syntaxCssVariables";

/**
 * What a row and a node paint with: theme variables only, never a color literal
 * (`quipu/no-raw-svg-paint` enforces it). Values take the syntax table's body
 * entries per JSON type, keys the depth slot, so an Open VSX theme recolors the
 * map exactly as it recolors the source view.
 */
export function rowValuePaint(row: MapRow): string {
  switch (row.kind) {
    case "string":
      return `var(${syntaxVariableFor("string", 0, row.container)})`;
    case "number":
      return `var(${syntaxVariableFor("number", 0, row.container)})`;
    case "true":
    case "false":
    case "null":
      return `var(${syntaxVariableFor("literal", 0, row.container)})`;
    // A container's summary (`{} 4 keys`) is the map's own text, not a token of
    // the file: it takes the hint role, which reads in every palette.
    case "object":
    case "array":
    case "chunk":
      return "var(--map-node-hint)";
    case "group":
      return "var(--info)";
    case "line":
      return "var(--foreground)";
    case "more":
    case "pending":
      return "var(--map-node-hint)";
  }
}

/**
 * A row's key. `lit`: the row shows Find's hit background, so an index takes
 * the text color the palette picks for it.
 */
export function rowKeyPaint(row: MapRow, keyDepth: number, lit: boolean): string {
  if (row.kind === "group") return "var(--foreground)";
  // An array element's index: quieter than a key, still text the user reads.
  if (row.container === "array")
    return lit ? "var(--map-index-key-on-hit)" : "var(--map-index-key)";
  return `var(${syntaxVariableFor("key", keyDepth, "object")})`;
}

/** The header accent: the brace color for objects, the bracket color for arrays, info for groups, the decoded role for a decoded value. */
export function nodeAccentPaint(kind: MapNodeKind): string {
  switch (kind) {
    case "object":
      return `var(${syntaxVariableFor("brace", 0, "object")})`;
    case "array":
    case "chunk":
      return `var(${syntaxVariableFor("bracket", 0, "array")})`;
    case "capture":
    case "host":
    case "page":
      return "var(--info)";
    case "decoded":
      return "var(--map-decoded-accent)";
  }
}

/** A decoded value and everything inside it sit on the decoded surface: they are not bytes of the file. */
export function nodeSurfacePaint(node: Pick<MapNode, "kind" | "decoded">): string {
  if (node.decoded) return "var(--map-decoded-surface)";
  return node.kind === "object" || node.kind === "array" || node.kind === "chunk"
    ? "var(--map-node-surface)"
    : "var(--map-group-surface)";
}

export function nodeStrokePaint(node: Pick<MapNode, "decoded">): string {
  return node.decoded ? "var(--map-decoded-stroke)" : "var(--map-node-stroke)";
}

/**
 * The computed value of a theme variable, for canvas paint (the bitmap
 * overview and the minimap read the same tokens the SVG uses).
 */
export function readThemeColor(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}
