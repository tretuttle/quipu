import { describe, expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";

import { useBrowser } from "./harness";

const withPage = useBrowser();

/**
 * WCAG contrast of the colors a theme cannot change (decoded values on the map,
 * the green and blue drawing ink) against the surfaces each palette paints
 * them on. Read through a probe element, so `color-mix` resolves.
 */
function fixedColorContrast(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const context = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    })!;
    const rgb = (variable: string) => {
      probe.style.color = `var(${variable})`;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return Math.round(((high! + 0.05) / (low! + 0.05)) * 100) / 100;
    };
    const card = rgb("--map-node-surface");
    const canvas = rgb("--canvas-background");
    const result = {
      decodedTextOnCard: ratio(rgb("--map-decoded-accent"), card),
      decodedOutlineOnCard: ratio(rgb("--map-decoded-stroke"), card),
      greenInkOnCanvas: ratio(rgb("--ink-green"), canvas),
      blueInkOnCanvas: ratio(rgb("--ink-blue"), canvas),
    };
    probe.remove();
    return result;
  });
}

describe("colors a theme cannot change", () => {
  it("stay readable on every built-in palette, light and dark", async () => {
    await withPage(
      async (page) => {
        const themes = await page
          .locator("[data-theme-library-card]")
          .getByRole("button", { name: /^Use .* theme/ })
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")!));
        expect(themes).toHaveLength(7);
        const failures: string[] = [];
        for (const mode of ["light", "dark"] as const) {
          await page.getByRole("button", { name: `Use ${mode} mode` }).click();
          for (const theme of themes) {
            await page.getByRole("button", { name: theme }).click();
            const contrast = await fixedColorContrast(page);
            // Decoded badge text is text: 4.5:1. Its outline and ink strokes are
            // graphics: 3:1 (WCAG 1.4.11).
            const minimums = {
              decodedTextOnCard: 4.5,
              decodedOutlineOnCard: 3,
              greenInkOnCanvas: 3,
              blueInkOnCanvas: 3,
            } as const;
            for (const [key, minimum] of Object.entries(minimums)) {
              const value = contrast[key as keyof typeof minimums];
              if (value < minimum) failures.push(`${mode} ${theme}: ${key} ${value} < ${minimum}`);
            }
          }
        }
        expect(failures).toEqual([]);
      },
      { path: "/settings/appearance" },
    );
  }, 120_000);
});
