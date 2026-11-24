import type { Flow } from "../flows.ts";
import { SAMPLE_DOCUMENT } from "./sample.ts";

/**
 * Editing in the Tree: a value, a key, a sort undone, and the Export dialog
 * with YAML picked.
 */
export const edit: Flow = {
  id: "edit",
  title: "Edit a document in the Tree and export it as YAML",
  run: async ({ page, click, doubleClick, moveTo, paste, press, type, wait }) => {
    const tree = page.getByRole("tree", { name: "Document tree" });
    const row = (key: string) =>
      tree
        .getByRole("treeitem")
        .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) });
    /** The first of `location`'s keys the tree shows, once it is `key`. */
    const firstLocationKey = (key: string) =>
      tree
        .locator("[data-tree-key]")
        .filter({ hasText: /^(lat|lon|elevation_m)$/ })
        .first()
        .filter({ hasText: new RegExp(`^${key}$`) });

    await moveTo({ x: 700, y: 520 }, 600);
    const root = page
      .getByRole("tree", { name: "Document map" })
      .getByRole("treeitem", { name: /^root / });
    await paste(SAMPLE_DOCUMENT, root);
    await wait(700);

    await click(page.getByLabel("Document view").getByRole("button", { name: "Tree" }), 700);
    await row("status").waitFor();
    await wait(500);
    await click(row("location").locator("[data-tree-toggle]"), 600);
    await row("lat").waitFor();
    await wait(500);

    await doubleClick(row("status").locator("[data-tree-value]"), 650);
    await tree.getByLabel("Value").waitFor();
    await press("Control+a");
    await type("maintenance", 60);
    await press("Enter");
    await row("status").getByText('"maintenance"').waitFor();
    await wait(600);

    await doubleClick(row("station").locator("[data-tree-key]"), 650);
    await tree.getByLabel("Key").waitFor();
    await press("Control+a");
    await type("name", 80);
    await press("Enter");
    await row("name").waitFor();
    await wait(600);

    await click(row("location").locator("[data-tree-key]"), 600);
    await click(page.getByRole("button", { name: "Transform" }), 650);
    await click(page.getByRole("menuitem", { name: "Sort keys A to Z" }), 500);
    await page.getByRole("menuitem", { name: "Sort keys A to Z" }).waitFor({ state: "hidden" });
    await firstLocationKey("elevation_m").waitFor();
    await wait(900);
    await click(page.getByRole("button", { name: "Undo edit" }), 650);
    await page.getByRole("button", { name: "Redo edit", disabled: false }).waitFor();
    await wait(900);

    await click(page.getByRole("button", { name: "Export", exact: true }), 700);
    const dialog = page.getByRole("dialog", { name: /^Export / });
    await dialog.waitFor();
    await wait(400);
    await click(dialog.getByRole("combobox", { name: "Format" }), 600);
    await click(page.getByRole("option", { name: "YAML", exact: true }), 500);
    await dialog.getByRole("combobox", { name: "Format" }).getByText("YAML").waitFor();
    await wait(1500);
  },
};
