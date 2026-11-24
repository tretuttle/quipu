/**
 * Text layout for text and note elements. Measurement is injected: the shell
 * passes a function backed by one offscreen canvas context, so this package
 * never touches the DOM and a test can pass a fixed-width font.
 */
import type { FontFamily } from "./elements.ts";

export type MeasureText = (text: string, font: TextFont) => number;

export interface TextFont {
  readonly family: FontFamily;
  /** World units; the renderer scales with the camera. */
  readonly size: number;
}

export const LINE_HEIGHT = 1.25;

export interface TextLayout {
  readonly lines: ReadonlyArray<string>;
  readonly width: number;
  readonly height: number;
}

/** Height of `lineCount` lines at `fontSize`, the way Excalidraw sizes text boxes. */
export function textHeight(lineCount: number, fontSize: number): number {
  return Math.max(1, lineCount) * fontSize * LINE_HEIGHT;
}

/**
 * Wraps at word boundaries to `maxWidth` (null for no wrapping), breaking a
 * single word that is wider than the box. An empty line measures as a space so
 * blank lines keep their height.
 */
export function layoutText(
  text: string,
  font: TextFont,
  measure: MeasureText,
  maxWidth: number | null,
): TextLayout {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (maxWidth === null || measure(paragraph, font) <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (measure(candidate, font) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.length > 0) lines.push(line);
      // A single word wider than the box: break it by characters.
      let chunk = "";
      for (const char of word) {
        if (measure(chunk + char, font) <= maxWidth || chunk.length === 0) {
          chunk += char;
        } else {
          lines.push(chunk);
          chunk = char;
        }
      }
      line = chunk;
    }
    lines.push(line);
  }
  const width = Math.max(0, ...lines.map((line) => measure(line.length === 0 ? " " : line, font)));
  return { lines, width, height: textHeight(lines.length, font.size) };
}

/** A measurer with every character `unit` wide at size 1: for tests and fallbacks. */
export function monospaceMeasure(unit = 0.6): MeasureText {
  return (text, font) => text.length * unit * font.size;
}
