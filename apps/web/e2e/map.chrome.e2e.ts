import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { pasteText, useBrowser } from "./harness";
import { map, mapNode as node } from "./mapHarness";

const withPage = useBrowser();

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("The element has no box.");
  return rect;
}

const zoomText = (page: Page) => page.getByTestId("map-zoom").textContent();

/** Where `locator`'s center is, from the map canvas's center. */
async function fromCanvasCenter(page: Page, locator: Locator) {
  const [at, canvas] = await Promise.all([box(locator), box(page.getByLabel("Map canvas"))]);
  return {
    x: at.x + at.width / 2 - (canvas.x + canvas.width / 2),
    y: at.y + at.height / 2 - (canvas.y + canvas.height / 2),
  };
}

describe("the map's chrome", () => {
  it("turns each zoom button off at its limit", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ a: 1 }));
      await node(page, /^root/).waitFor();
      const zoomIn = page.getByRole("button", { name: "Zoom in" });
      const zoomOut = page.getByRole("button", { name: "Zoom out" });
      expect(await zoomIn.isDisabled()).toBe(false);
      for (let i = 0; i < 100 && !(await zoomIn.isDisabled()); i += 1) await zoomIn.click();
      expect(await zoomIn.isDisabled()).toBe(true);
      expect(await zoomText(page)).toBe("800%");
      expect(await zoomOut.isDisabled()).toBe(false);
      for (let i = 0; i < 100 && !(await zoomOut.isDisabled()); i += 1) await zoomOut.click();
      expect(await zoomOut.isDisabled()).toBe(true);
      expect(await zoomText(page)).toBe("25%");
      expect(await zoomIn.isDisabled()).toBe(false);
    });
  });

  it("shows no minimap for a map of one card, however far in", async () => {
    await withPage(async (page) => {
      const keys = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key${i}`, i]));
      await pasteText(page, JSON.stringify(keys));
      await node(page, /^root \{\} 300 keys$/).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 10 } });
      for (let i = 0; i < 12; i += 1) await page.keyboard.press("=");
      await expect.poll(() => zoomText(page)).not.toBe("100%");
      expect(await page.getByRole("img", { name: "Minimap" }).count()).toBe(0);
    });
  });

  it("keeps the map framed when the window is resized, and the middle where it was once moved", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ name: "quipu", knots: 3 }));
      const root = node(page, /^root \{\} 2 keys$/);
      await root.waitFor();
      const canvas = page.getByLabel("Map canvas");
      // Framed at first: the card in the middle, left to right.
      await expect
        .poll(async () => Math.abs((await fromCanvasCenter(page, root)).x))
        .toBeLessThan(2);

      // Narrower: framed again, in the middle of the narrower canvas.
      const before = await box(canvas);
      await page.setViewportSize({ width: 900, height: 640 });
      await expect.poll(async () => (await box(canvas)).width).toBeLessThan(before.width);
      await expect
        .poll(async () => Math.abs((await fromCanvasCenter(page, root)).x))
        .toBeLessThan(2);

      // Moved by hand, a resize keeps the point at the middle of the view where it was.
      const host = await box(canvas);
      await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(host.x + host.width / 2 - 120, host.y + host.height / 2 - 60, {
        steps: 4,
      });
      await page.mouse.up({ button: "middle" });
      const moved = await fromCanvasCenter(page, root);
      expect(Math.abs(moved.x)).toBeGreaterThan(60);
      await page.setViewportSize({ width: 1200, height: 760 });
      await expect.poll(async () => (await box(canvas)).width).toBeGreaterThan(host.width);
      await expect
        .poll(async () => {
          const after = await fromCanvasCenter(page, root);
          return Math.abs(after.x - moved.x) < 2 && Math.abs(after.y - moved.y) < 2;
        })
        .toBe(true);
    });
  });

  it("shows its node count in the status bar, clear of the cards", async () => {
    await withPage(async (page) => {
      const keys = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, i]));
      await pasteText(page, JSON.stringify(keys));
      await node(page, /^root \{\} 60 keys$/).waitFor();
      const status = page.getByTestId("map-status");
      await status.getByText("1 node").waitFor();
      const [at, canvas] = await Promise.all([box(status), box(page.getByLabel("Map canvas"))]);
      expect(at.y).toBeGreaterThanOrEqual(canvas.y + canvas.height);
    });
  });

  it("draws edges that leave one card together as one line, not a heavy bar", async () => {
    await withPage(async (page) => {
      // 90 children wrap into columns, and their edges run down one trunk, as a capture's hosts do.
      const keys = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`k${i}`, { v: i }]));
      await pasteText(page, JSON.stringify(keys));
      const root = node(page, /^root \{\} 90 keys$/);
      await root.waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 400 } });
      await page.keyboard.press("Control+Shift+ArrowRight");
      await page.getByTestId("map-status").getByText("91 nodes").waitFor();
      await expect.poll(() => map(page).locator("[data-map-edge]").count()).toBeGreaterThan(10);
      // The gap between the root card and its children, where their edges share a trunk.
      const at = await box(root);
      const child = await box(node(page, /^k0 \{\} 1 key$/));
      const shot = await page.screenshot({
        clip: {
          x: at.x + at.width + 2,
          y: at.y,
          width: child.x - (at.x + at.width) - 4,
          height: Math.min(at.height, 400),
        },
      });
      const { strongest, edge } = await page.evaluate(async (png) => {
        const paint = document.createElement("canvas").getContext("2d", {
          willReadFrequently: true,
        })!;
        const probe = document.createElement("div");
        document.body.append(probe);
        // A color as it shows painted once over the canvas background.
        const computed = (variable: string) => {
          probe.style.color = `var(${variable})`;
          return getComputedStyle(probe).color;
        };
        const rgb = (variable: string) => {
          paint.fillStyle = computed("--background");
          paint.fillRect(0, 0, 1, 1);
          paint.fillStyle = computed(variable);
          paint.fillRect(0, 0, 1, 1);
          return Array.from(paint.getImageData(0, 0, 1, 1).data.subarray(0, 3));
        };
        const background = rgb("--background");
        const edgeColor = rgb("--map-edge");
        probe.remove();
        const distance = (color: ArrayLike<number>) =>
          Math.hypot(
            color[0]! - background[0]!,
            color[1]! - background[1]!,
            color[2]! - background[2]!,
          );
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        paint.canvas.width = image.width;
        paint.canvas.height = image.height;
        paint.drawImage(image, 0, 0);
        const data = paint.getImageData(0, 0, image.width, image.height).data;
        let strongest = 0;
        for (let i = 0; i < data.length; i += 4) {
          strongest = Math.max(strongest, distance(data.subarray(i, i + 3)));
        }
        return { strongest, edge: distance(edgeColor) };
      }, shot.toString("base64"));
      // The trunk is there, and nowhere stronger than one edge alone.
      expect(strongest).toBeLessThanOrEqual(edge + 3);
      expect(strongest).toBeGreaterThan(edge * 0.8);
    });
  });
});
