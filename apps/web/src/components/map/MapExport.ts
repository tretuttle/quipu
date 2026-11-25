/**
 * Map image export (SVG and PNG) for the visible viewport or the whole map.
 * Both outputs clamp the longest side to {@link MAX_MAP_EXPORT_SIDE} (8192 px)
 * and resolve theme tokens so exported files render identically outside the app.
 */
import { visibleWorldBox, type Camera, type Viewport } from "@quipu/canvas/camera";
import { boxesIntersect, expandBox, type Box, type Point } from "@quipu/canvas/geometry";
import { edgeGuttersFor, edgePath, type EdgeGutters } from "@quipu/canvas/mapEdges";

import {
  MAP_HEADER_HEIGHT,
  MAP_NODE_PADDING,
  MAP_ROW_HEIGHT,
  textColumns,
  type MapNode,
  type MapRow,
  type MapSnapshot,
} from "../../documents/mapModel";
import { syntaxVariableFor } from "../../syntaxCssVariables";
import { getStandardThemeColors } from "../../themePalette";
import { readThemeColor } from "./mapPaint";
import { MAP_CHEVRON_WIDTH, MAP_DIM_OPACITY, mapRowTextX } from "./MapNodes";
import type { MapSearchMarks } from "./mapSearch";

export const MAX_MAP_EXPORT_SIDE = 8192;
const DEFAULT_WHOLE_PADDING = 32;
const FONT_SIZE = 12;
const TEXT_BASELINE = 14;
const MONO_FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

export type MapExportScope = "visible" | "whole";

export interface MapExportOptions {
  readonly snapshot: MapSnapshot;
  readonly scope: MapExportScope;
  readonly camera?: Camera;
  readonly viewport?: Viewport;
  readonly marks?: MapSearchMarks | null;
  readonly scale?: number;
  readonly padding?: number;
  readonly resolveColor?: (cssVariable: string) => string;
}

export interface MapExportGeometry {
  readonly rect: Box;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

interface PositionedNode {
  readonly node: MapNode;
  readonly position: Point;
}

interface ExportPalette {
  readonly background: string;
  readonly foreground: string;
  readonly nodeSurface: string;
  readonly groupSurface: string;
  readonly decodedSurface: string;
  readonly nodeStroke: string;
  readonly decodedStroke: string;
  readonly nodeHint: string;
  readonly edge: string;
  readonly info: string;
  readonly decodedAccent: string;
  readonly indexKey: string;
  readonly indexKeyOnHit: string;
  readonly searchHit: string;
  readonly searchStroke: string;
  readonly varColor: (cssVar: string) => string;
}

const xmlEscape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const defaultColorResolver = (cssVar: string): string => {
  if (typeof document !== "undefined") {
    const resolved = readThemeColor(cssVar);
    if (resolved !== "") return resolved;
  }
  const fallback = getStandardThemeColors("light");
  switch (cssVar) {
    case "--background":
      return fallback.canvas;
    case "--foreground":
      return fallback.text;
    case "--map-node-surface":
      return fallback.surface;
    case "--map-group-surface":
      return fallback.secondary;
    case "--map-decoded-surface":
      return fallback.accentSurface;
    case "--map-node-stroke":
    case "--map-edge":
      return fallback.border;
    case "--map-decoded-stroke":
    case "--map-decoded-accent":
    case "--info":
      return fallback.accent;
    case "--map-node-hint":
    case "--map-index-key":
      return fallback.textMuted;
    case "--map-index-key-on-hit":
      return fallback.searchMatchForeground;
    case "--map-search-hit":
      return fallback.searchMatchBackground;
    case "--map-search-stroke":
      return fallback.searchMatchActiveBackground;
    default:
      return fallback.text;
  }
};

const resolvePalette = (resolveColor: (cssVar: string) => string): ExportPalette => {
  const get = (cssVar: string) => resolveColor(cssVar) || defaultColorResolver(cssVar);
  const cache = new Map<string, string>();
  const varColor = (cssVar: string): string => {
    const cached = cache.get(cssVar);
    if (cached !== undefined) return cached;
    const value = get(cssVar);
    cache.set(cssVar, value);
    return value;
  };
  return {
    background: varColor("--background"),
    foreground: varColor("--foreground"),
    nodeSurface: varColor("--map-node-surface"),
    groupSurface: varColor("--map-group-surface"),
    decodedSurface: varColor("--map-decoded-surface"),
    nodeStroke: varColor("--map-node-stroke"),
    decodedStroke: varColor("--map-decoded-stroke"),
    nodeHint: varColor("--map-node-hint"),
    edge: varColor("--map-edge"),
    info: varColor("--info"),
    decodedAccent: varColor("--map-decoded-accent"),
    indexKey: varColor("--map-index-key"),
    indexKeyOnHit: varColor("--map-index-key-on-hit"),
    searchHit: varColor("--map-search-hit"),
    searchStroke: varColor("--map-search-stroke"),
    varColor,
  };
};

const accentColor = (node: MapNode, palette: ExportPalette): string => {
  switch (node.kind) {
    case "object":
      return palette.varColor(syntaxVariableFor("brace", 0, "object"));
    case "array":
    case "chunk":
      return palette.varColor(syntaxVariableFor("bracket", 0, "array"));
    case "capture":
    case "host":
    case "page":
      return palette.info;
    case "decoded":
      return palette.decodedAccent;
  }
};

const surfaceColor = (node: MapNode, palette: ExportPalette): string => {
  if (node.decoded) return palette.decodedSurface;
  return node.kind === "object" || node.kind === "array" || node.kind === "chunk"
    ? palette.nodeSurface
    : palette.groupSurface;
};

const rowKeyColor = (
  row: MapRow,
  keyDepth: number,
  lit: boolean,
  palette: ExportPalette,
): string => {
  if (row.kind === "group") return palette.foreground;
  if (row.container === "array") return lit ? palette.indexKeyOnHit : palette.indexKey;
  return palette.varColor(syntaxVariableFor("key", keyDepth, "object"));
};

const rowValueColor = (row: MapRow, palette: ExportPalette): string => {
  switch (row.kind) {
    case "string":
      return palette.varColor(syntaxVariableFor("string", 0, row.container));
    case "number":
      return palette.varColor(syntaxVariableFor("number", 0, row.container));
    case "true":
    case "false":
    case "null":
      return palette.varColor(syntaxVariableFor("literal", 0, row.container));
    case "group":
      return palette.info;
    case "line":
      return palette.foreground;
    case "object":
    case "array":
    case "chunk":
    case "more":
    case "pending":
      return palette.nodeHint;
  }
};

/** Computes the exported world rectangle and pixel dimensions capped at 8192 px per side. */
export function computeMapExportGeometry(options: MapExportOptions): MapExportGeometry {
  const { snapshot, scope } = options;
  let rect: Box;
  let rawScale: number;

  if (scope === "visible") {
    if (!options.camera || !options.viewport) {
      throw new Error("Visible-area export requires both camera and viewport.");
    }
    rect = visibleWorldBox(options.camera, options.viewport);
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    rawScale = options.scale ?? options.camera.k * ratio;
  } else {
    if (snapshot.bounds === null || snapshot.nodes.length === 0) {
      throw new Error("The map has no laid-out nodes to export.");
    }
    const padding = options.padding ?? DEFAULT_WHOLE_PADDING;
    rect = expandBox(snapshot.bounds, padding);
    rawScale = options.scale ?? 1;
  }

  const safeWidth = Math.max(1, rect.width);
  const safeHeight = Math.max(1, rect.height);
  const positiveScale = Math.max(0.01, rawScale);
  const longestPx = Math.max(safeWidth * positiveScale, safeHeight * positiveScale, 1);
  const scale =
    longestPx > MAX_MAP_EXPORT_SIDE
      ? positiveScale * (MAX_MAP_EXPORT_SIDE / longestPx)
      : positiveScale;

  return {
    rect,
    scale,
    width: Math.max(1, Math.min(MAX_MAP_EXPORT_SIDE, Math.round(safeWidth * scale))),
    height: Math.max(1, Math.min(MAX_MAP_EXPORT_SIDE, Math.round(safeHeight * scale))),
  };
}

const collectNodesInRect = (snapshot: MapSnapshot, rect: Box): PositionedNode[] => {
  const list: PositionedNode[] = [];
  for (const node of snapshot.nodes) {
    const position = snapshot.positions.get(node.id);
    if (!position) continue;
    const box: Box = { x: position.x, y: position.y, width: node.width, height: node.height };
    if (boxesIntersect(box, rect)) list.push({ node, position });
  }
  list.sort((a, b) => a.node.level - b.node.level);
  return list;
};

const collectEdgeGutters = (snapshot: MapSnapshot): Map<string, EdgeGutters> => {
  const gutters = new Map<string, EdgeGutters>();
  for (const [parentId, childIds] of snapshot.childrenOf) {
    const parent = snapshot.byId.get(parentId);
    const at = snapshot.positions.get(parentId);
    if (!parent || !at || childIds.length < 2) continue;
    const children: Box[] = [];
    for (const id of childIds) {
      const child = snapshot.byId.get(id);
      const childAt = snapshot.positions.get(id);
      if (child && childAt) {
        children.push({ ...childAt, width: child.width, height: child.height });
      }
    }
    const routed = edgeGuttersFor({ ...at, width: parent.width, height: parent.height }, children);
    if (routed !== null) gutters.set(parentId, routed);
  }
  return gutters;
};

const rowKeyX = MAP_NODE_PADDING + MAP_CHEVRON_WIDTH;

const chevronSvgPath = (x: number, y: number, open: boolean): string =>
  open ? `M${x} ${y + 7}l6 0l-3 5z` : `M${x + 1} ${y + 5}l5 3l-5 3z`;

/** Renders the map region to a self-contained SVG string with resolved theme colors. */
function renderMapSvg(options: MapExportOptions): {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
} {
  const geometry = computeMapExportGeometry(options);
  const { rect, width, height } = geometry;
  const palette = resolvePalette(options.resolveColor ?? defaultColorResolver);
  const { snapshot, marks } = options;
  const nodes = collectNodesInRect(snapshot, rect);
  const gutters = collectEdgeGutters(snapshot);
  const charWidth = snapshot.charWidth;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}">`,
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${xmlEscape(palette.background)}"/>`,
  ];

  for (const { node, position } of nodes) {
    if (node.parentId === null) continue;
    const parent = snapshot.byId.get(node.parentId);
    const parentAt = snapshot.positions.get(node.parentId);
    if (!parent || !parentAt) continue;
    const d = edgePath(
      { x: parentAt.x + parent.width, y: parentAt.y + node.anchor + MAP_ROW_HEIGHT / 2 },
      { x: position.x, y: position.y + MAP_HEADER_HEIGHT / 2 },
      gutters.get(node.parentId) ?? null,
    );
    parts.push(
      `<path d="${d}" fill="none" stroke="${xmlEscape(palette.edge)}" stroke-width="1.25" stroke-linejoin="round"/>`,
    );
  }

  for (const { node, position } of nodes) {
    const nodeMarks = marks?.get(node.id) ?? null;
    const stroke = nodeMarks?.lit
      ? palette.searchStroke
      : node.decoded
        ? palette.decodedStroke
        : palette.nodeStroke;
    const opacityAttr = nodeMarks?.dim ? ` opacity="${MAP_DIM_OPACITY}"` : "";

    parts.push(`<g transform="translate(${position.x} ${position.y})">`);
    parts.push(
      `<rect width="${node.width}" height="${node.height}" rx="6" fill="${xmlEscape(surfaceColor(node, palette))}"/>`,
    );
    parts.push(`<g${opacityAttr}>`);
    parts.push(
      `<rect width="${node.width}" height="${node.height}" rx="6" fill="none" stroke="${xmlEscape(stroke)}" stroke-width="1"/>`,
    );
    parts.push(
      `<rect x="0" y="4" width="3" height="${MAP_HEADER_HEIGHT - 8}" rx="1.5" fill="${xmlEscape(accentColor(node, palette))}"/>`,
    );
    parts.push(
      `<text x="${MAP_NODE_PADDING}" y="${TEXT_BASELINE + 4}" font-family="${xmlEscape(MONO_FONT_STACK)}" font-size="${FONT_SIZE}" font-weight="600" fill="${xmlEscape(palette.foreground)}">${xmlEscape(node.title)}<tspan dx="${charWidth}" font-weight="400" fill="${xmlEscape(palette.nodeHint)}">${xmlEscape(node.subtitle)}</tspan></text>`,
    );

    for (let index = 0; index < node.rows.length; index++) {
      const row = node.rows[index] as MapRow;
      const top = MAP_HEADER_HEIGHT + index * MAP_ROW_HEIGHT;
      const rowMark = nodeMarks?.rows[index] ?? (nodeMarks?.dim ? "dim" : undefined);
      const rowOpacity = rowMark === "dim" ? ` opacity="${MAP_DIM_OPACITY}"` : "";
      parts.push(`<g${rowOpacity}>`);
      if (rowMark === "hit") {
        parts.push(
          `<rect x="2" y="${top}" width="${node.width - 4}" height="${MAP_ROW_HEIGHT}" rx="3" fill="${xmlEscape(palette.searchHit)}"/>`,
        );
      }
      if (row.expandable) {
        parts.push(
          `<path d="${chevronSvgPath(MAP_NODE_PADDING, top, row.expanded)}" fill="${xmlEscape(palette.nodeHint)}"/>`,
        );
      }
      const keyFill = rowKeyColor(row, node.keyDepth, rowMark === "hit", palette);
      const sep =
        row.key && row.value ? `<tspan fill="${xmlEscape(palette.nodeHint)}">: </tspan>` : "";
      parts.push(
        `<text x="${rowKeyX}" y="${top + TEXT_BASELINE}" font-family="${xmlEscape(MONO_FONT_STACK)}" font-size="${FONT_SIZE}" fill="${xmlEscape(keyFill)}">${xmlEscape(row.key)}${sep}</text>`,
      );
      if (row.value) {
        const valueX = mapRowTextX(row, "value", charWidth);
        parts.push(
          `<text x="${valueX}" y="${top + TEXT_BASELINE}" font-family="${xmlEscape(MONO_FONT_STACK)}" font-size="${FONT_SIZE}" fill="${xmlEscape(rowValueColor(row, palette))}">${xmlEscape(row.value)}</text>`,
        );
      }
      parts.push("</g>");
    }
    parts.push("</g></g>");
  }

  parts.push("</svg>");
  return { svg: parts.join(""), width, height };
}

/** Exports the map as an SVG string and UTF-8 SVG Blob. */
export function exportMapSvg(options: MapExportOptions): {
  readonly svg: string;
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
} {
  const { svg, width, height } = renderMapSvg(options);
  return {
    svg,
    blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    width,
    height,
  };
}

const traceRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
};

const drawEdgeSegment = (
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  gutters: EdgeGutters | null,
) => {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  if (gutters === null) {
    const dx = Math.max(24, (to.x - from.x) * 0.5);
    ctx.bezierCurveTo(from.x + dx, from.y, to.x - dx, to.y, to.x, to.y);
  } else {
    const { trunkX, busY } = gutters;
    ctx.lineTo(trunkX, from.y);
    if (busY !== null) {
      ctx.lineTo(trunkX, busY);
      const busX = Math.max(trunkX, to.x - 16);
      ctx.lineTo(busX, busY);
      ctx.lineTo(busX, to.y);
    } else {
      ctx.lineTo(trunkX, to.y);
    }
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();
};

/** Renders the map region onto a 2D canvas sized within 8192 px per side. */
function renderMapToCanvas(
  options: MapExportOptions,
  targetCanvas?: HTMLCanvasElement,
): HTMLCanvasElement {
  const geometry = computeMapExportGeometry(options);
  const { rect, scale, width, height } = geometry;
  const canvas = targetCanvas ?? document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is unavailable for map export.");

  const palette = resolvePalette(options.resolveColor ?? defaultColorResolver);
  const { snapshot, marks } = options;
  const nodes = collectNodesInRect(snapshot, rect);
  const gutters = collectEdgeGutters(snapshot);
  const charWidth = snapshot.charWidth;

  ctx.save();
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  ctx.scale(scale, scale);
  ctx.translate(-rect.x, -rect.y);

  ctx.strokeStyle = palette.edge;
  ctx.lineWidth = Math.max(1 / scale, 1.25);
  ctx.lineJoin = "round";
  for (const { node, position } of nodes) {
    if (node.parentId === null) continue;
    const parent = snapshot.byId.get(node.parentId);
    const parentAt = snapshot.positions.get(node.parentId);
    if (!parent || !parentAt) continue;
    drawEdgeSegment(
      ctx,
      { x: parentAt.x + parent.width, y: parentAt.y + node.anchor + MAP_ROW_HEIGHT / 2 },
      { x: position.x, y: position.y + MAP_HEADER_HEIGHT / 2 },
      gutters.get(node.parentId) ?? null,
    );
  }

  const drawDetails = scale >= 0.35;
  for (const { node, position } of nodes) {
    const nodeMarks = marks?.get(node.id) ?? null;
    const stroke = nodeMarks?.lit
      ? palette.searchStroke
      : node.decoded
        ? palette.decodedStroke
        : palette.nodeStroke;

    ctx.save();
    ctx.translate(position.x, position.y);
    traceRoundedRect(ctx, 0, 0, node.width, node.height, 6);
    ctx.fillStyle = surfaceColor(node, palette);
    ctx.fill();

    if (nodeMarks?.dim) ctx.globalAlpha = MAP_DIM_OPACITY;
    traceRoundedRect(ctx, 0, 0, node.width, node.height, 6);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1 / scale, 1);
    ctx.stroke();

    ctx.fillStyle = accentColor(node, palette);
    ctx.fillRect(0, 4, 3, MAP_HEADER_HEIGHT - 8);

    if (drawDetails) {
      ctx.save();
      traceRoundedRect(ctx, 0, 0, node.width, node.height, 6);
      ctx.clip();

      ctx.font = `600 ${FONT_SIZE}px ${MONO_FONT_STACK}`;
      ctx.fillStyle = palette.foreground;
      ctx.fillText(node.title, MAP_NODE_PADDING, TEXT_BASELINE + 4);
      if (node.subtitle) {
        const subX = MAP_NODE_PADDING + (textColumns(node.title) + 1) * charWidth;
        ctx.font = `400 ${FONT_SIZE}px ${MONO_FONT_STACK}`;
        ctx.fillStyle = palette.nodeHint;
        ctx.fillText(node.subtitle, subX, TEXT_BASELINE + 4);
      }

      ctx.font = `400 ${FONT_SIZE}px ${MONO_FONT_STACK}`;
      for (let index = 0; index < node.rows.length; index++) {
        const row = node.rows[index] as MapRow;
        const top = MAP_HEADER_HEIGHT + index * MAP_ROW_HEIGHT;
        const rowMark = nodeMarks?.rows[index] ?? (nodeMarks?.dim ? "dim" : undefined);
        ctx.save();
        if (rowMark === "dim") ctx.globalAlpha *= MAP_DIM_OPACITY;
        if (rowMark === "hit") {
          ctx.fillStyle = palette.searchHit;
          ctx.fillRect(2, top, node.width - 4, MAP_ROW_HEIGHT);
        }
        if (row.key) {
          ctx.fillStyle = rowKeyColor(row, node.keyDepth, rowMark === "hit", palette);
          ctx.fillText(row.value ? `${row.key}: ` : row.key, rowKeyX, top + TEXT_BASELINE);
        }
        if (row.value) {
          ctx.fillStyle = rowValueColor(row, palette);
          ctx.fillText(row.value, mapRowTextX(row, "value", charWidth), top + TEXT_BASELINE);
        }
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  ctx.restore();
  return canvas;
}

/** Exports the map as a PNG Blob with dimensions capped at 8192 px per side. */
export async function exportMapPng(
  options: MapExportOptions,
  createCanvas?: () => HTMLCanvasElement,
): Promise<{ readonly blob: Blob; readonly width: number; readonly height: number }> {
  const canvas = renderMapToCanvas(options, createCanvas?.());
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => {
      if (out) resolve(out);
      else reject(new Error("Could not encode map canvas to PNG."));
    }, "image/png");
  });
  return { blob, width: canvas.width, height: canvas.height };
}

/** Triggers a browser download for an exported SVG or PNG Blob. */
export function downloadMapBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
