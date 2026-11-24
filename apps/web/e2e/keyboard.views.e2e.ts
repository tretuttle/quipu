import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

/** Where the keyboard is: the focused element's role, its row key, and the view it is in. */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      role: active?.getAttribute("role") ?? active?.tagName.toLowerCase() ?? "none",
      key: active?.querySelector("[data-tree-key]")?.textContent ?? "",
      label: active?.getAttribute("aria-label") ?? "",
      inTree:
        active?.closest("[data-tree-view]") !== null &&
        active?.closest("[data-tree-view]") !== undefined,
      inSource:
        active?.closest("[data-source-view]") !== null &&
        active?.closest("[data-source-view]") !== undefined,
    };
  });

/** Waits until the keyboard is on the tree row whose key is `key`. */
const focusOnRow = (page: Page, key: string) =>
  page.waitForFunction((wanted) => {
    const active = document.activeElement as HTMLElement | null;
    return (
      active?.getAttribute("role") === "treeitem" &&
      active.querySelector("[data-tree-key]")?.textContent === wanted
    );
  }, key);

/** A file of the private file system, opened through a stubbed open dialog that answers its handle. */
async function openWithKeyboard(page: Page, name: string, contents: string) {
  await page.evaluate(
    async ({ fileName, text }) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      Object.defineProperty(window, "showOpenFilePicker", {
        configurable: true,
        value: async () => [handle],
      });
    },
    { fileName: name, text: contents },
  );
  await page.keyboard.press(`${MOD}+o`);
}

describe("a keyboard-only session", () => {
  it("keeps the keyboard in the view through open, search, edit, rename, undo, save and export", async () => {
    await withPage(async (page) => {
      const steps: string[] = [];
      const record = async (step: string) =>
        steps.push(`${step}: ${JSON.stringify(await focusOf(page))}`);

      // Open: the document's view takes the keyboard.
      await openWithKeyboard(page, "keys.json", '{"name":"quipu","knots":3,"tags":["a","b"]}');
      await focusOnRow(page, "root");
      await record("open");

      // Navigate.
      await page.keyboard.press("ArrowDown");
      await focusOnRow(page, "name");
      await page.keyboard.press("ArrowDown");
      await focusOnRow(page, "knots");
      await record("navigate");

      // Search, then Escape back to the tree.
      await page.keyboard.press(`${MOD}+f`);
      await page.keyboard.type("quipu");
      await page.locator("[data-search-count]").getByText("1 of 1").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.activeElement?.closest("[data-tree-view]") !== null,
      );
      await record("search");

      // Edit a value inline: Enter commits, and the keyboard is back on the row.
      await page.keyboard.type("k");
      await focusOnRow(page, "knots");
      await page.keyboard.press("F2");
      await page.getByRole("textbox", { name: "Value" }).waitFor();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("4");
      await page.keyboard.press("Enter");
      await page.getByRole("treeitem", { name: /^knots.*4/ }).waitFor();
      await focusOnRow(page, "knots");
      await record("edit");

      // Rename the key: the keyboard is back on the renamed row.
      await page.keyboard.press("Shift+F2");
      await page.getByRole("textbox", { name: "Key" }).waitFor();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("count");
      await page.keyboard.press("Enter");
      await focusOnRow(page, "count");
      await record("rename");

      // Undo: the keyboard stays in the tree.
      await page.keyboard.press(`${MOD}+z`);
      await page.getByRole("treeitem", { name: /^knots/ }).waitFor();
      await page.waitForFunction(
        () => document.activeElement?.closest("[data-tree-view]") !== null,
      );
      await record("undo");

      // Save in place: the document reopens from the file, and the keyboard comes back to the
      // row it was on, not into the Find box that was open before.
      await page.keyboard.press(`${MOD}+s`);
      await page.getByText("Saved keys.json").first().waitFor();
      await focusOnRow(page, "knots");
      await record("save");
      expect((await focusOf(page)).label).not.toBe("Find in document");

      // Export from the command palette, then Escape: the keyboard comes back to the view.
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.waitFor();
      await page.keyboard.type("Export");
      // Enter runs the highlighted command, once the palette has highlighted it.
      await palette.locator('[role="option"][data-highlighted]', { hasText: "Export…" }).waitFor();
      await page.keyboard.press("Enter");
      const exporting = page.getByRole("dialog", { name: /^Export / });
      await exporting.waitFor();
      await page.keyboard.press("Escape");
      await exporting.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.closest("[data-tree-view]") !== null,
      );
      await focusOnRow(page, "knots");
      await record("export");
      console.log(steps.join("\n"));
      // The arrows still work after the whole session.
      await page.keyboard.press("Home");
      await focusOnRow(page, "root");
    }, inTree);
  });

  it("gives the keyboard back to the Source view after an edit made there", async () => {
    await withPage(
      async (page) => {
        await openWithKeyboard(page, "source.json", '{\n  "count": 3\n}\n');
        const text = page.getByLabel("Document text");
        await text.waitFor();
        await page.waitForFunction(
          () => document.activeElement?.closest("[data-source-view]") !== null,
        );
        // A double-click on a value edits it in place.
        await text.locator("[data-row-code] span", { hasText: /^3$/ }).dblclick();
        const editor = page.getByRole("textbox", { name: "Value" });
        await editor.waitFor();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type("5");
        await page.keyboard.press("Enter");
        await editor.waitFor({ state: "detached" });
        await text.locator("[data-row-code] span", { hasText: /^5$/ }).waitFor();
        await page.waitForFunction(
          () => document.activeElement?.closest("[data-source-view]") !== null,
        );
        expect((await focusOf(page)).inSource).toBe(true);
      },
      { storage: { "quipu:document-view": "source" } },
    );
  });
});
