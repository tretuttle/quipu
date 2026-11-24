import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { MOD, pasteText, useBrowser } from "./harness";
import { map, mapNode } from "./mapHarness";

const withPage = useBrowser();

const SAMPLE = { requestId: "req_7f3a9c2e51d4", status: "paid", total: 42 };
const rootNode = (page: Page) => mapNode(page, /^root \{\} 3 keys/);

/** Opens the sample, then selects part of its first line with the mouse, as a user copying an id. */
async function openSampleAndSelectText(page: Page): Promise<string> {
  await pasteText(page, JSON.stringify(SAMPLE, null, 2));
  await rootNode(page).waitFor();
  await page.getByLabel("Document view").getByRole("button", { name: "Source" }).click();
  const line = page.locator("[data-source-view] [data-row-code]", { hasText: "requestId" }).first();
  await line.waitFor();
  const box = await line.boundingBox();
  if (!box) throw new Error("The source line has no box.");
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const selected = await page.evaluate(() => String(getSelection()));
  expect(selected).toContain("requestId");
  return selected;
}

/** A middle-button drag from the middle of `area`: the canvases' pan gesture. */
async function middleDrag(
  page: Page,
  area: { x: number; y: number; width: number; height: number },
) {
  const [cx, cy] = [area.x + area.width / 2, area.y + area.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(cx - 120, cy + 60, { steps: 4 });
  await page.mouse.up({ button: "middle" });
}

describe("middle-click paste", () => {
  it("a middle drag pans the map and a board, and never opens the selection as a document", async () => {
    await withPage(async (page) => {
      await openSampleAndSelectText(page);
      await page.getByLabel("Document view").getByRole("button", { name: "Map" }).click();
      await rootNode(page).waitFor();
      const canvas = await page.getByLabel("Map canvas", { exact: true }).boundingBox();
      if (!canvas) throw new Error("The map has no box.");
      const before = await rootNode(page).boundingBox();
      await middleDrag(page, canvas);

      // The map panned with the drag, and it is still the same document.
      const moved = async () => {
        const after = await rootNode(page).boundingBox();
        return Math.hypot(
          (after?.x ?? 0) - (before?.x ?? 0) + 120,
          (after?.y ?? 0) - (before?.y ?? 0) - 60,
        );
      };
      await expect.poll(moved).toBeLessThan(2);
      expect(await page.getByTestId("recent-document").count()).toBe(1);

      // On a board: the middle drag pans it, and the board stays.
      await page.getByRole("button", { name: "New board" }).click();
      const board = page.getByRole("application", { name: "Board canvas" });
      await board.waitFor();
      const boardUrl = page.url();
      const area = await board.boundingBox();
      if (!area) throw new Error("The board has no box.");
      await middleDrag(page, area);
      await board.waitFor();
      expect(page.url()).toBe(boardUrl);
      expect(await page.getByTestId("recent-document").count()).toBe(1);
      expect(await map(page).count()).toBe(0);
    });
  });

  it("Ctrl+V still opens pasted text, and a middle click in a field still pastes into it", async () => {
    await withPage(async (page, context) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate((text) => navigator.clipboard.writeText(text), JSON.stringify(SAMPLE));
      await page.locator("body").click({ position: { x: 700, y: 400 } });
      await page.keyboard.press(`${MOD}+v`);
      await rootNode(page).waitFor();
      await page.getByTestId("recent-document").getByText("Pasted text").waitFor();

      // The primary selection pastes into the field the middle button is released over.
      const selected = await openSampleAndSelectText(page);
      await page.keyboard.press(`${MOD}+k`);
      const field = page
        .getByRole("dialog", { name: "Command palette" })
        .getByPlaceholder("Search commands and settings...");
      await field.waitFor();
      const documents = await page.getByTestId("recent-document").count();
      await field.click({ button: "middle" });
      await expect.poll(() => field.inputValue()).toBe(selected);
      expect(await page.getByTestId("recent-document").count()).toBe(documents);
    });
  });
});
