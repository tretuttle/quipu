import { cn } from "../../lib/utils";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

type MapCardRow = Readonly<{ key: number; value: number; kind: "string" | "number" }>;

/** One node of the miniature map: a header line, then key and value lines. */
function MiniMapCard({
  colors,
  x,
  y,
  width,
  rows,
  selected = false,
}: {
  colors: ThemeCardPreviewColors;
  x: number;
  y: number;
  width: number;
  rows: ReadonlyArray<MapCardRow>;
  selected?: boolean;
}) {
  const height = 12 + rows.length * 9 + 3;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={3}
        fill={colors.surface}
        stroke={selected ? colors.messageAction : colors.border}
        strokeWidth={selected ? 1.5 : 1}
      />
      <rect x={x + 5} y={y + 4.5} width={width * 0.4} height={3} rx={1.5} fill={colors.text} />
      {rows.map((row, index) => {
        const rowY = y + 14 + index * 9;
        return (
          <g key={`${String(index)}-${String(row.key)}`}>
            <rect x={x + 5} y={rowY} width={row.key} height={3} rx={1.5} fill={colors.syntaxKey} />
            <rect
              x={x + 8 + row.key}
              y={rowY}
              width={row.value}
              height={3}
              rx={1.5}
              fill={row.kind === "number" ? colors.syntaxNumber : colors.syntaxString}
            />
          </g>
        );
      })}
    </g>
  );
}

/**
 * Quipu in a theme's colors: the sidebar with a selected document, the header
 * with its view toggle, and a map of three cards joined by edges, their key and
 * value lines in the theme's syntax colors.
 */
function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  return (
    <svg
      className="absolute inset-0 size-full"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 240 140"
      style={
        clip === undefined
          ? undefined
          : {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
      }
    >
      <rect width={240} height={140} fill={colors.canvas} />

      {/* Sidebar: the app name, then documents with one selected. */}
      <rect width={54} height={140} fill={colors.sidebar} />
      <rect x={54} width={1} height={140} fill={colors.border} />
      <rect x={8} y={9} width={22} height={4} rx={2} fill={colors.text} />
      {[0, 1, 2, 3].map((row) => (
        <g key={row}>
          {row === 1 ? (
            <rect
              x={5}
              y={24 + row * 11}
              width={44}
              height={9}
              rx={2.5}
              fill={colors.accentSurface}
            />
          ) : null}
          <rect
            x={9}
            y={27 + row * 11}
            width={[30, 24, 34, 20][row]}
            height={3}
            rx={1.5}
            fill={row === 1 ? colors.text : colors.mutedForeground}
          />
        </g>
      ))}

      {/* Header: the document name and the Map, Tree, Source toggle. */}
      <rect x={55} y={20} width={185} height={1} fill={colors.border} />
      <rect x={64} y={8.5} width={38} height={3} rx={1.5} fill={colors.mutedForeground} />
      <rect x={170} y={4.5} width={62} height={11} rx={3} fill={colors.accentSurface} />
      <rect
        x={171}
        y={5.5}
        width={20}
        height={9}
        rx={2.5}
        fill={colors.surface}
        stroke={colors.border}
        strokeWidth={0.75}
      />
      {[0, 1, 2].map((segment) => (
        <rect
          key={segment}
          x={176 + segment * 20}
          y={8.5}
          width={10}
          height={3}
          rx={1.5}
          fill={segment === 0 ? colors.text : colors.mutedForeground}
        />
      ))}

      {/* The map: a root card and two children, joined by edges. */}
      <g fill="none" stroke={colors.text} strokeOpacity={0.3} strokeWidth={1}>
        <path d="M128 62 C 140 62, 138 46, 150 46" />
        <path d="M128 62 C 140 62, 138 100, 150 100" />
      </g>
      <MiniMapCard
        colors={colors}
        x={66}
        y={40}
        width={62}
        rows={[
          { key: 14, value: 22, kind: "string" },
          { key: 18, value: 12, kind: "number" },
          { key: 12, value: 26, kind: "string" },
        ]}
      />
      <MiniMapCard
        colors={colors}
        x={150}
        y={31}
        width={64}
        rows={[
          { key: 16, value: 20, kind: "string" },
          { key: 12, value: 10, kind: "number" },
        ]}
        selected
      />
      <MiniMapCard
        colors={colors}
        x={150}
        y={85}
        width={64}
        rows={[
          { key: 12, value: 24, kind: "string" },
          { key: 18, value: 14, kind: "string" },
        ]}
      />
    </svg>
  );
}

export function ThemeWireframe({
  className,
  panes,
}: {
  /** Sizing (height) for the frame; the drawing scales to fill it. */
  className?: string;
  panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
      data-theme-wireframe=""
    >
      {panes.map((pane) => (
        <ThemeWireframePane clip={pane.clip} colors={pane.colors} key={pane.clip ?? "pane"} />
      ))}
    </span>
  );
}
