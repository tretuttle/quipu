import type { Point } from "@quipu/canvas/geometry";
import { edgePath, type EdgeGutters } from "@quipu/canvas/mapEdges";
import type { ImagePreview, NodeRef } from "@quipu/contracts/engine";
import { memo, useEffect, useId, useState } from "react";

import {
  MAP_HEADER_HEIGHT,
  MAP_NODE_PADDING,
  MAP_PREVIEW_HEIGHT,
  MAP_ROW_HEIGHT,
  textColumns,
  type MapNode,
  type MapPreview,
  type MapRow,
} from "../../documents/mapModel";
import {
  nodeAccentPaint,
  nodeStrokePaint,
  nodeSurfacePaint,
  rowKeyPaint,
  rowValuePaint,
} from "./mapPaint";
import type { MapNodeMarks, MapRowMark } from "./mapSearch";

const FONT_SIZE = 12;
const TEXT_BASELINE = 14;
/** The chevron column before a row's key, in world units. */
export const MAP_CHEVRON_WIDTH = 14;
/** A title at the "titles" level of detail is this many pixels tall on screen, whatever the zoom. */
const TITLE_SCREEN_SIZE = 12;
/** What a node or row without a search hit fades to, as in the tree and source views. */
export const MAP_DIM_OPACITY = 0.45;

/** The pixel a row's key starts at. */
const keyX = MAP_NODE_PADDING + MAP_CHEVRON_WIDTH;

function chevronPath(x: number, y: number, open: boolean): string {
  // A 6 px triangle pointing right, or down when the row is open.
  return open ? `M${x} ${y + 7}l6 0l-3 5z` : `M${x + 1} ${y + 5}l5 3l-5 3z`;
}

export interface MapNodeViewProps {
  readonly node: MapNode;
  readonly position: Point;
  /** "full" mounts the rows; "titles" only the title, at a readable size; "marks" the box alone. */
  readonly detail: "full" | "titles" | "marks";
  /** The camera's zoom, which sizes a title at the "titles" level. */
  readonly zoom: number;
  /** One character's width in world units, as the model sized the node with. */
  readonly charWidth: number;
  /** The rows to mount, as [first, end); the others are culled. */
  readonly rowRange: readonly [number, number];
  readonly focused: boolean;
  readonly selected: boolean;
  /** The row of this node that holds the shared selection, or null. */
  readonly selectedRow: number | null;
  /** The node an arrow end would bind to right now. */
  readonly bindingTarget: boolean;
  /** How the active search marks the node and its rows; null while nothing is searched. */
  readonly marks: MapNodeMarks | null;
  /** Reads a decoded image's bytes, for a preview card. */
  readonly loadPreview: (ref: NodeRef) => Promise<ImagePreview>;
}

/**
 * One node of the map: a box with a header (name and type summary) and one
 * row per child, key and value painted from the syntax table. The node is a
 * tree item with roving focus; its rows are plain text, hit through geometry
 * by the view (which is why nothing here listens to pointer events).
 */
export const MapNodeView = memo(function MapNodeView({
  node,
  position,
  detail,
  rowRange,
  focused,
  selected,
  selectedRow,
  bindingTarget,
  marks,
  loadPreview,
  zoom,
  charWidth,
}: MapNodeViewProps) {
  const [first, end] = rowRange;
  const label = `${node.title} ${node.subtitle}`.trim();
  // Text never paints past the node's box, whatever the font does.
  const clipId = useId();
  return (
    <g
      aria-expanded={node.expandable ? node.expanded : undefined}
      aria-label={label}
      aria-level={node.level}
      aria-posinset={node.position}
      aria-selected={selected}
      aria-setsize={node.setSize}
      className="outline-none"
      data-hit={marks?.lit ? "" : undefined}
      data-map-decoded={node.decoded ? "" : undefined}
      data-map-kind={node.kind}
      data-map-node={node.id}
      data-map-dim={marks?.dim ? "" : undefined}
      role="treeitem"
      tabIndex={focused ? 0 : -1}
      transform={`translate(${position.x} ${position.y})`}
    >
      {/* The card is opaque at every level of detail, dimmed or not: no edge shows through it. */}
      <rect
        width={node.width}
        height={node.height}
        rx={6}
        fill={selected ? "var(--map-selection-fill)" : nodeSurfacePaint(node)}
        data-map-card=""
      />
      <g opacity={marks?.dim ? MAP_DIM_OPACITY : undefined}>
        <rect
          width={node.width}
          height={node.height}
          rx={6}
          fill="none"
          stroke={
            selected || bindingTarget
              ? "var(--map-selection)"
              : marks?.lit
                ? "var(--map-search-stroke)"
                : nodeStrokePaint(node)
          }
          strokeWidth={1}
          strokeDasharray={bindingTarget && !selected ? "4 3" : undefined}
          vectorEffect="non-scaling-stroke"
        />
        <clipPath id={clipId}>
          <rect width={node.width} height={node.height} rx={6} />
        </clipPath>
        <rect
          x={0}
          y={4}
          width={3}
          height={MAP_HEADER_HEIGHT - 8}
          rx={1.5}
          fill={nodeAccentPaint(node.kind)}
        />
        {detail === "titles" ? (
          <MapNodeTitle
            node={node}
            zoom={zoom}
            charWidth={charWidth}
            clipPath={`url(#${clipId})`}
          />
        ) : null}
        {detail === "full" ? (
          <g clipPath={`url(#${clipId})`}>
            <text
              x={MAP_NODE_PADDING}
              y={TEXT_BASELINE + 4}
              fontSize={FONT_SIZE}
              fontFamily="var(--font-mono)"
              fontWeight={600}
              fill="var(--foreground)"
            >
              {node.title}
              <tspan dx={charWidth} fontWeight={400} fill="var(--map-node-hint)">
                {node.subtitle}
              </tspan>
            </text>
            <line
              x1={0}
              x2={node.width}
              y1={MAP_HEADER_HEIGHT - 0.5}
              y2={MAP_HEADER_HEIGHT - 0.5}
              stroke="var(--map-node-stroke)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {node.preview !== null ? (
              <MapPreviewImage
                preview={node.preview}
                y={MAP_HEADER_HEIGHT + node.rows.length * MAP_ROW_HEIGHT + MAP_NODE_PADDING / 2}
                width={node.width}
                loadPreview={loadPreview}
              />
            ) : null}
            {node.rows.slice(first, end).map((row, offset) => (
              <MapRowView
                key={row.treeId ?? row.childId ?? `${row.kind}:${row.key}:${first + offset}`}
                row={row}
                index={first + offset}
                keyDepth={node.keyDepth}
                selected={selectedRow === first + offset}
                width={node.width}
                charWidth={charWidth}
                // A dimmed node is faded whole; its rows are not faded again.
                mark={marks === null || marks.dim ? null : (marks.rows[first + offset] ?? null)}
              />
            ))}
          </g>
        ) : null}
      </g>
      {focused ? (
        <rect
          x={1}
          y={1}
          width={node.width - 2}
          height={node.height - 2}
          rx={5}
          fill="none"
          stroke="var(--map-focus)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          data-map-focus-ring=""
        />
      ) : null}
    </g>
  );
});

/**
 * A node's title when its rows are too small to read: drawn at a fixed size on
 * screen, shortened to the node's width, so the map stays labeled zoomed out.
 */
function MapNodeTitle({
  node,
  zoom,
  charWidth,
  clipPath,
}: {
  readonly node: MapNode;
  readonly zoom: number;
  readonly charWidth: number;
  readonly clipPath: string;
}) {
  // World units that make the title TITLE_SCREEN_SIZE pixels tall, within the node's own height.
  const size = Math.min(TITLE_SCREEN_SIZE / Math.max(zoom, 0.01), node.height - 4);
  const scale = size / FONT_SIZE;
  const room = Math.max(1, Math.floor((node.width - MAP_NODE_PADDING * 2) / (charWidth * scale)));
  const text = fitColumns(node.title, room);
  return (
    <text
      clipPath={clipPath}
      data-map-title=""
      x={MAP_NODE_PADDING}
      y={Math.min(node.height - 4, size + 4)}
      fontSize={size}
      fontFamily="var(--font-mono)"
      fontWeight={600}
      fill="var(--foreground)"
    >
      {text}
    </text>
  );
}

/** Where a row's key, or its value, starts inside its node: where an editor for it opens. */
export const mapRowTextX = (row: MapRow, part: "key" | "value", charWidth: number) =>
  part === "key" || !row.key ? keyX : keyX + (textColumns(row.key) + 2) * charWidth;

/** `text` cut to `room` columns, with an ellipsis when it was cut. */
function fitColumns(text: string, room: number): string {
  if (textColumns(text) <= room) return text;
  let kept = "";
  for (const character of text) {
    if (textColumns(kept + character) > room - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

function MapRowView({
  row,
  index,
  keyDepth,
  selected,
  width,
  mark,
  charWidth,
}: {
  readonly row: MapRow;
  readonly index: number;
  readonly keyDepth: number;
  readonly selected: boolean;
  readonly width: number;
  readonly mark: MapRowMark;
  readonly charWidth: number;
}) {
  const top = MAP_HEADER_HEIGHT + index * MAP_ROW_HEIGHT;
  const valueX = row.key ? keyX + (textColumns(row.key) + 2) * charWidth : keyX;
  return (
    <g
      data-hit={mark === "hit" ? "" : undefined}
      data-map-more={row.kind === "more" ? "" : undefined}
      data-map-row={index}
      data-map-row-id={row.treeId ?? row.childId ?? undefined}
      opacity={mark === "dim" ? MAP_DIM_OPACITY : undefined}
    >
      {mark === "hit" ? (
        <rect
          x={2}
          y={top}
          width={width - 4}
          height={MAP_ROW_HEIGHT}
          rx={3}
          fill="var(--map-search-hit)"
          data-map-search-hit=""
        />
      ) : null}
      {selected ? (
        <rect
          x={2}
          y={top}
          width={width - 4}
          height={MAP_ROW_HEIGHT}
          rx={3}
          fill="var(--map-selection-fill)"
        />
      ) : null}
      {row.expandable ? (
        <path
          d={chevronPath(MAP_NODE_PADDING, top, row.expanded)}
          fill="var(--map-node-hint)"
          data-map-toggle=""
        />
      ) : null}
      <text
        x={keyX}
        y={top + TEXT_BASELINE}
        fontSize={FONT_SIZE}
        fontFamily="var(--font-mono)"
        // A selected row paints its own background over Find's.
        fill={rowKeyPaint(row, keyDepth, mark === "hit" && !selected)}
      >
        {row.key}
        {row.key && row.value ? <tspan fill="var(--map-node-hint)">{": "}</tspan> : null}
      </text>
      {row.value ? (
        <text
          x={valueX}
          y={top + TEXT_BASELINE}
          fontSize={FONT_SIZE}
          fontFamily="var(--font-mono)"
          fill={rowValuePaint(row)}
        >
          {row.value}
        </text>
      ) : null}
      {row.badge !== null ? (
        <g data-decode-badge="">
          <rect
            x={valueX + (textColumns(row.value) + 1) * charWidth}
            y={top + 3}
            // The badge's text is drawn two sizes smaller than the row's.
            width={((textColumns(row.badge) * (FONT_SIZE - 2)) / FONT_SIZE) * charWidth + charWidth}
            height={MAP_ROW_HEIGHT - 6}
            rx={4}
            fill="none"
            stroke="var(--map-decoded-stroke)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={valueX + (textColumns(row.value) + 1.5) * charWidth}
            y={top + TEXT_BASELINE - 1}
            fontSize={FONT_SIZE - 2}
            fontFamily="var(--font-mono)"
            fill="var(--map-decoded-accent)"
          >
            {row.badge}
          </text>
        </g>
      ) : null}
    </g>
  );
}

type PreviewLoad =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly url: string }
  | { readonly phase: "failed"; readonly message: string };

/**
 * A decoded image under a preview card's rows, drawn from a Blob URL as an SVG
 * `<image>` (as the Inspector draws an `<img>`), so an SVG value cannot run anything.
 */
function MapPreviewImage({
  preview,
  y,
  width,
  loadPreview,
}: {
  readonly preview: MapPreview;
  readonly y: number;
  readonly width: number;
  readonly loadPreview: (ref: NodeRef) => Promise<ImagePreview>;
}) {
  const [load, setLoad] = useState<PreviewLoad>({ phase: "loading" });
  const { ref } = preview;
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    loadPreview(ref).then(
      (image) => {
        url = URL.createObjectURL(image.blob);
        if (live) setLoad({ phase: "ready", url });
        else URL.revokeObjectURL(url);
      },
      (error: unknown) => {
        if (live) {
          setLoad({
            phase: "failed",
            message: error instanceof Error ? error.message : "The image could not be read.",
          });
        }
      },
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [loadPreview, ref]);
  if (load.phase !== "ready") {
    return (
      <text
        x={MAP_NODE_PADDING}
        y={y + TEXT_BASELINE}
        fontSize={FONT_SIZE}
        fontFamily="var(--font-mono)"
        fill="var(--muted-foreground)"
      >
        {load.phase === "loading" ? "Loading image…" : load.message}
      </text>
    );
  }
  return (
    <image
      aria-label={`Decoded image, ${preview.mime}`}
      data-map-preview=""
      href={load.url}
      x={MAP_NODE_PADDING}
      y={y}
      width={width - MAP_NODE_PADDING * 2}
      height={MAP_PREVIEW_HEIGHT}
      preserveAspectRatio="xMidYMid meet"
    />
  );
}

/** The link from a parent's row to the child node it opened. */
export const MapEdge = memo(function MapEdge({
  from,
  to,
  gutters,
}: {
  readonly from: Point;
  readonly to: Point;
  /** A wrapped parent's trunk and bus, which its edges run along; null for a curve. */
  readonly gutters: EdgeGutters | null;
}) {
  return (
    <path
      d={edgePath(from, to, gutters)}
      strokeLinejoin="round"
      fill="none"
      stroke="var(--map-edge)"
      strokeWidth={1.25}
      vectorEffect="non-scaling-stroke"
      data-map-edge=""
    />
  );
});
