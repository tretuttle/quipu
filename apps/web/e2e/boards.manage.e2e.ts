import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { drawBox, openNewBoard } from "./boardsHarness";
import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();

const boardLink = (page: Page, name: string) =>
  page.getByTestId("sidebar-boards-shelf").getByRole("link", { name, exact: true });

const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "Workspace breadcrumb" });

async function renameTo(page: Page, name: string, key: "Enter" | "Escape" = "Enter") {
  const field = page.getByRole("textbox", { name: "Board name" });
  await field.fill(name);
  await field.press(key);
  await field.waitFor({ state: "detached" });
}

async function runFromPalette(page: Page, option: string) {
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByPlaceholder("Search commands and settings...").fill(option.toLowerCase());
  // While the list re-filters it can briefly hold a command twice; each copy runs it.
  await palette
    .getByRole("option", { name: new RegExp(`^${option}`) })
    .first()
    .click();
  await palette.waitFor({ state: "hidden" });
}

/** How many records each board store in the browser's `quipu` database holds. */
function storedCounts(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ boards: number; drawings: number; assets: number }>((resolve, reject) => {
        const request = indexedDB.open("quipu");
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const database = request.result;
          const transaction = database.transaction(["documents", "drawings", "assets"]);
          const all = (store: string) =>
            new Promise<Array<{ kind?: string }>>((done) => {
              const read = transaction.objectStore(store).getAll();
              read.addEventListener("success", () => done(read.result as Array<{ kind?: string }>));
            });
          void Promise.all([all("documents"), all("drawings"), all("assets")]).then(
            ([documents, drawings, assets]) => {
              database.close();
              resolve({
                boards: documents.filter((record) => record.kind === "board").length,
                drawings: drawings.length,
                assets: assets.length,
              });
            },
          );
        });
      }),
  );
}

describe("managing boards", () => {
  it("keeps a saved board out of the Documents list across a reload", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await drawBox(page, canvas, "r", [100, 100], [200, 200]);
      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();
      await page.reload();
      await page.getByRole("application", { name: "Board canvas" }).waitFor();
      const boards = page.getByTestId("sidebar-boards-shelf");
      await boards.getByRole("link", { name: "Board 1" }).waitFor();
      await page.getByTestId("sidebar-documents-empty").getByText("No documents yet").waitFor();
      expect(await page.getByTestId("recent-document").count()).toBe(0);
    });
  });

  it("renames a board from its row menu, F2, a double-click and the palette", async () => {
    await withPage(async (page) => {
      await openNewBoard(page);
      await page.getByRole("button", { name: "Actions for Board 1" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      await renameTo(page, "Plans");
      await boardLink(page, "Plans").waitFor();
      await breadcrumb(page).getByText("Plans").waitFor();

      // F2 on the focused row opens the field; Escape keeps the old name.
      await boardLink(page, "Plans").focus();
      await page.keyboard.press("F2");
      await renameTo(page, "Not this", "Escape");
      await boardLink(page, "Plans").waitFor();
      await expect
        .poll(() => boardLink(page, "Plans").evaluate((n) => n === document.activeElement))
        .toBe(true);

      await boardLink(page, "Plans").dblclick();
      await renameTo(page, "Sketches");
      await boardLink(page, "Sketches").waitFor();

      // From the palette, for the board on screen, even with the sidebar closed.
      await page.keyboard.press(`${MOD}+b`);
      await runFromPalette(page, "Rename board");
      await renameTo(page, "Roadmap");
      await boardLink(page, "Roadmap").waitFor();
      await breadcrumb(page).getByText("Roadmap").waitFor();

      // A right-click on the row opens the same menu.
      await boardLink(page, "Roadmap").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Delete" }).waitFor();
      await page.keyboard.press("Escape");

      await page.reload();
      await boardLink(page, "Roadmap").waitFor();
      expect(await boardLink(page, "Board 1").count()).toBe(0);
    });
  });

  it("deletes a board after confirmation, with its drawing and its images", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await drawBox(page, canvas, "r", [100, 100], [200, 200]);
      const png = await page.evaluate(() => {
        const bitmap = document.createElement("canvas");
        bitmap.width = 30;
        bitmap.height = 20;
        bitmap.getContext("2d")?.fillRect(0, 0, 30, 20);
        return bitmap.toDataURL("image/png").split(",")[1] ?? "";
      });
      // The image tool's picker is covered in boards.e2e.ts; here the image only needs to exist.
      await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
        name: "dot.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
      await page.locator('[data-element-type="image"] image').waitFor();
      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();
      await page.getByRole("button", { name: "New board" }).click();
      await breadcrumb(page).getByText("Board 2").waitFor();
      await page.getByTestId("board-save-status").getByText("Saved").waitFor();
      expect(await storedCounts(page)).toEqual({ boards: 2, drawings: 1, assets: 1 });

      // Cancel keeps it.
      await page.getByRole("button", { name: "Actions for Board 1" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByText("Delete Board 1?").waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
      await boardLink(page, "Board 1").waitFor();

      // Confirm removes it; the board on screen stays.
      await page.getByRole("button", { name: "Actions for Board 1" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await boardLink(page, "Board 1").waitFor({ state: "detached" });
      await breadcrumb(page).getByText("Board 2").waitFor();
      await expect.poll(() => storedCounts(page)).toEqual({ boards: 1, drawings: 0, assets: 0 });

      // Deleting the open board from the palette goes back to the start page.
      await runFromPalette(page, "Delete board");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByTestId("sidebar-boards-empty").getByText("No boards yet").waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/");
      await expect.poll(() => storedCounts(page)).toEqual({ boards: 0, drawings: 0, assets: 0 });

      await page.reload();
      await page.getByTestId("sidebar-boards-empty").getByText("No boards yet").waitFor();
    });
  });
});
