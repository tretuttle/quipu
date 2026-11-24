import type { PaintToken } from "@quipu/canvas/render";
import type { FontFamily } from "@quipu/canvas/elements";

/** A paint token becomes a theme variable; the SVG never sees a color literal. */
export function paintFor(token: PaintToken): string {
  return token === "none" ? "none" : `var(--${token})`;
}

export function fontFamilyFor(family: FontFamily): string {
  switch (family) {
    case "mono":
      return "var(--font-mono)";
    case "hand":
      return "var(--font-hand)";
    default:
      return "var(--font-sans)";
  }
}

let context: CanvasRenderingContext2D | null | undefined;

/**
 * Measures text on one offscreen canvas, by advance width, the way
 * Excalidraw's `CanvasTextMetricsProvider` does. Falls back to a fixed
 * width per character where canvas is unavailable (jsdom).
 */
export function measureBoardText(text: string, font: { family: FontFamily; size: number }): number {
  if (context === undefined) {
    context =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (context === null || context === undefined) return text.length * font.size * 0.6;
  const family = getComputedStyle(document.documentElement).getPropertyValue(
    font.family === "mono" ? "--font-mono" : font.family === "hand" ? "--font-hand" : "--font-sans",
  );
  context.font = `${font.size}px ${family.trim() || "sans-serif"}`;
  return context.measureText(text.length === 0 ? " " : text).width;
}
