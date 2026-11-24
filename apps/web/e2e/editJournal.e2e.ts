import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

const SAMPLE = { name: "alpha", count: 1, list: [3, 2, 1] };

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const valueOf = (page: Page, key: string) =>
  page
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) })
    .locator("[data-tree-value]");
const recent = (page: Page) =>
  page.getByTestId("recent-document").getByRole("button", { name: /^Pasted text/ });
const restored = (page: Page) => page.getByText(/^Restored \d+ unsaved edits?$/);

async function editCount(page: Page, text: string) {
  await valueOf(page, "count").dblclick();
  const input = tree(page).getByLabel("Value");
  await input.fill(text);
  await input.press("Enter");
  await valueOf(page, "count")
    .filter({ hasText: new RegExp(`^${text}$`) })
    .waitFor();
}

/** Closes the tab the way a reload does (the browser's own unload question is accepted) and opens the file again. */
async function reloadAndReopen(page: Page) {
  page.once("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await page.locator("[data-app-sidebar]").waitFor();
  await recent(page).click();
  await tree(page).waitFor();
}

describe("unsaved edits survive a closed tab", () => {
  it("are restored when the file opens again, and Discard opens the file as it was", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      await tree(page).waitFor();
      // The recents list keeps a copy of pasted text, which is what reopens it after a reload.
      await recent(page).waitFor();
      await editCount(page, "42");
      await editCount(page, "43");

      await reloadAndReopen(page);
      await restored(page).waitFor();
      expect(await restored(page).textContent()).toBe("Restored 2 unsaved edits");
      await valueOf(page, "count").filter({ hasText: /^43$/ }).waitFor();
      await page.locator("[data-unsaved-dot]").first().waitFor();
      // The restored edits are history: undo walks back through them.
      await page.getByRole("button", { name: "Undo edit" }).click();
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();

      await page.getByRole("button", { name: "Discard" }).click();
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      await page.locator("[data-unsaved-dot]").first().waitFor({ state: "detached" });

      // Discarded means gone: the next open has nothing to restore.
      await reloadAndReopen(page);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await restored(page).count()).toBe(0);
      expect(await page.locator("[data-unsaved-dot]").count()).toBe(0);
    }, inTree);
  });

  it("are kept with Keep, and stay until they are discarded", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      await tree(page).waitFor();
      await recent(page).waitFor();
      await editCount(page, "5");

      await reloadAndReopen(page);
      await restored(page).waitFor();
      await page.getByRole("button", { name: "Keep" }).click();
      await restored(page).waitFor({ state: "detached" });
      await valueOf(page, "count").filter({ hasText: /^5$/ }).waitFor();

      await reloadAndReopen(page);
      await restored(page).waitFor();
      await valueOf(page, "count").filter({ hasText: /^5$/ }).waitFor();
    }, inTree);
  });
});
