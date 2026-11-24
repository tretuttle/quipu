import type { Page } from "playwright-core";

/** A map role's contrast in the palette on screen: borders and hints against what they sit on. */
export interface MapContrast {
  readonly palette: string;
  /** Unselected node border against the canvas, and against the node's own surface. */
  readonly borderOnCanvas: number;
  readonly borderOnNode: number;
  /** Secondary text (`{} 4 keys`, `: `, chevrons) against the node's surface. */
  readonly hintOnNode: number;
  /**
   * An array index (`0:`) against each background its row can show: a plain
   * row, a selected one, one inside a decoded value, one lit by Find, and the
   * current hit (lit and selected, so the selection is drawn over the hit).
   */
  readonly indexOn: {
    readonly row: number;
    readonly selectedRow: number;
    readonly decodedRow: number;
    readonly litRow: number;
    readonly currentHit: number;
  };
}

/**
 * Reads the map's paint roles as the palette computes them (through a probe
 * element, so `color-mix` resolves) and returns WCAG contrast ratios.
 */
export function mapContrast(page: Page, palette: string): Promise<MapContrast> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const canvas = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    })!;
    /** The color seen where each variable's paint is laid over the previous one, bottom first. */
    const over = (...variables: string[]) => {
      canvas.clearRect(0, 0, 1, 1);
      for (const variable of variables) {
        // An unset variable would fall back to the inherited color and measure nothing.
        if (getComputedStyle(probe).getPropertyValue(variable).trim() === "") {
          throw new Error(`${variable} is not set`);
        }
        probe.style.color = `var(${variable})`;
        canvas.fillStyle = getComputedStyle(probe).color;
        canvas.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const rgb = (variable: string) => over(variable);
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const canvasColor = rgb("--background");
    const node = rgb("--map-node-surface");
    const border = rgb("--map-node-stroke");
    const hint = rgb("--map-node-hint");
    /** The index paint's contrast on a row whose background is `layers`, bottom first. */
    const index = (paint: string, ...layers: string[]) =>
      ratio(over(...layers, paint), over(...layers));
    const indexOn = {
      row: index("--map-index-key", "--map-node-surface"),
      selectedRow: index("--map-index-key", "--map-node-surface", "--map-selection-fill"),
      decodedRow: index("--map-index-key", "--map-decoded-surface"),
      litRow: index("--map-index-key-on-hit", "--map-node-surface", "--map-search-hit"),
      currentHit: index(
        "--map-index-key",
        "--map-node-surface",
        "--map-search-hit",
        "--map-selection-fill",
      ),
    };
    probe.remove();
    return {
      palette: name,
      borderOnCanvas: ratio(border, canvasColor),
      borderOnNode: ratio(border, node),
      hintOnNode: ratio(hint, node),
      indexOn,
    };
  }, palette);
}
