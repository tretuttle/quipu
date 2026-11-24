import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { pasteText, useBrowser } from "./harness";
import { map, mapNode as node, toggleMapRow } from "./mapHarness";

const withPage = useBrowser();

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("The element has no box.");
  return rect;
}

/** A box in world units, read through the camera transform. */
async function worldBox(page: Page, rect: { x: number; y: number; width: number; height: number }) {
  const [host, camera] = await Promise.all([
    box(page.getByLabel("Map canvas")),
    page.getByTestId("map-camera").getAttribute("transform"),
  ]);
  const match = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(camera ?? "");
  if (!match) throw new Error(`no camera transform: ${camera}`);
  const [tx, ty, k] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return {
    x: (rect.x - host.x - tx) / k,
    y: (rect.y - host.y - ty) / k,
    width: rect.width / k,
    height: rect.height / k,
  };
}

/** The arrowhead's vertex in world units. */
async function tipOf(page: Page) {
  const d = (await page.locator('[data-element-type="arrow"] path').last().getAttribute("d")) ?? "";
  const match = /L([-\d.]+) ([-\d.]+)L/.exec(d);
  if (!match) throw new Error(`no arrowhead in ${d}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** Within a few units of the box's outline, never deep inside it or out in empty space. */
function onOutline(
  tip: { x: number; y: number },
  target: { x: number; y: number; width: number; height: number },
) {
  const dx = Math.max(target.x - tip.x, tip.x - (target.x + target.width), 0);
  const dy = Math.max(target.y - tip.y, tip.y - (target.y + target.height), 0);
  const depth = Math.min(
    tip.x - target.x,
    target.x + target.width - tip.x,
    tip.y - target.y,
    target.y + target.height - tip.y,
  );
  return Math.hypot(dx, dy) <= 8 && depth <= 8;
}

/** The row of the root that names `lower`, in world units: the card's width, one row (20 units) tall. */
async function lowerRow(page: Page) {
  const root = node(page, /^root/);
  const card = await worldBox(page, await box(root.locator("rect").first()));
  const text = await worldBox(
    page,
    await box(
      root
        .locator("[data-map-row]")
        .filter({ hasText: /^lower/ })
        .locator("text")
        .first(),
    ),
  );
  return { x: card.x, y: text.y + text.height / 2 - 10, width: card.width, height: 20 };
}

describe("drawings attached to map nodes", () => {
  it("point at the nearest shown row while their node is closed, and after a reload", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ upper: { a: 1 }, lower: { value: "target" } }));
      await node(page, /^root/).waitFor();
      await toggleMapRow(page, /^lower/);
      const lower = node(page, /^lower \{\} 1 key$/);
      const target = await box(lower);
      // An arrow from empty canvas into the `lower` card.
      await page.getByLabel("Map canvas").click({ position: { x: 30, y: 30 } });
      await page.keyboard.press("a");
      const from = { x: target.x - 160, y: target.y + target.height + 140 };
      const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(
          from.x + ((to.x - from.x) * i) / 8,
          from.y + ((to.y - from.y) * i) / 8,
        );
      }
      await page.mouse.up();
      await page.keyboard.press("v");
      expect(onOutline(await tipOf(page), await worldBox(page, await box(lower)))).toBe(true);

      // Collapsed, the card is gone: the arrow points at the row that names it.
      await toggleMapRow(page, /^lower/);
      await lower.waitFor({ state: "detached" });
      await expect.poll(async () => onOutline(await tipOf(page), await lowerRow(page))).toBe(true);

      // After a reload the map opens with `lower` closed: the arrow still lands on its row.
      await page
        .getByTestId("map-save-status")
        .getByText("Drawings saved", { exact: true })
        .waitFor();
      await page.getByTestId("recent-document").getByText("Pasted text").waitFor();
      await page.reload();
      await page.getByTestId("recent-document").getByText("Pasted text").click();
      await node(page, /^root/).waitFor();
      await page.locator('[data-element-type="arrow"]').waitFor();
      expect(
        await map(page)
          .getByRole("treeitem", { name: /^lower/ })
          .count(),
      ).toBe(0);
      await expect.poll(async () => onOutline(await tipOf(page), await lowerRow(page))).toBe(true);

      // Opened again, the card takes its arrow back.
      await toggleMapRow(page, /^lower/);
      await expect
        .poll(async () => onOutline(await tipOf(page), await worldBox(page, await box(lower))))
        .toBe(true);
    });
  });
});
