import { describe, expect, it } from "vite-plus/test";

import { drawBox, openNewBoard } from "./boardsHarness";
import { pasteText, useBrowser } from "./harness";

const withPage = useBrowser();

describe("saving a board", () => {
  it("says Saving until the change is written, and Saved means a reload keeps it", async () => {
    await withPage(async (page) => {
      // The page's timers run on a clock the test moves, so the save waits
      // until the test lets it run, however busy the machine is.
      await page.clock.install();
      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      const canvas = await openNewBoard(page);
      const status = page.getByTestId("board-save-status");
      await page.clock.pauseAt(Date.now() + 60_000);

      await drawBox(page, canvas, "r", [100, 100], [200, 200]);
      await page.locator('[data-element-type="rectangle"]').waitFor();
      expect(await status.textContent()).toBe("Saving…");

      await page.clock.runFor(1_000);
      await status.getByText("Saved", { exact: true }).waitFor();
      await page.clock.resume();
      await page.reload();
      await page.locator('[data-element-type="rectangle"]').waitFor();
    });
  });

  it("names the drawings on a document's map: Saving drawings, then Drawings saved", async () => {
    await withPage(async (page) => {
      await page.clock.install();
      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      await pasteText(page, JSON.stringify({ alpha: 1 }));
      const canvas = page.getByLabel("Map canvas", { exact: true });
      await page
        .getByRole("tree", { name: "Document map" })
        .getByRole("treeitem")
        .first()
        .waitFor();
      const status = page.getByTestId("map-save-status");
      // A map without drawings has nothing to save, and says nothing.
      expect(await status.count()).toBe(0);
      await page.clock.pauseAt(Date.now() + 60_000);

      const box = await canvas.boundingBox();
      if (!box) throw new Error("The map has no box.");
      await canvas.focus();
      await page.keyboard.press("r");
      await page.mouse.move(box.x + box.width - 260, box.y + 120);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 220, box.y + 150);
      await page.mouse.move(box.x + box.width - 180, box.y + 180);
      await page.mouse.up();
      await page.locator('[data-element-type="rectangle"]').waitFor();
      expect(await status.textContent()).toBe("Saving drawings…");

      await page.clock.runFor(1_000);
      await status.getByText("Drawings saved", { exact: true }).waitFor();
    });
  });
});
