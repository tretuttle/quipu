import { describe, expect, it } from "vite-plus/test";

import { drawBox, openNewBoard, runFromPalette } from "./boardsHarness";
import { MOD, pasteText, useBrowser } from "./harness";
import { mapNode as node } from "./mapHarness";

const withPage = useBrowser();

const ORDER = JSON.stringify({
  order: { id: 1042, placed: "2026-03-01T09:30:00Z", total: 61.5 },
  customer: { name: "Sample Customer", city: "Springfield" },
  payload: JSON.stringify({
    items: [{ sku: "A-1", quantity: 2 }],
    note: "a json value long enough",
  }),
});

const SETTINGS_PAGES = ["general", "appearance", "keybindings", "storage", "open-source-licenses"];

// Every test in this project fails when its page reaches a host other than its own (see `useBrowser`).
// These walk the product's main paths and read the list themselves, and the last one proves the check
// catches a request that does leave.
describe("requests stay on the page's own origin", () => {
  it("while a document is opened, decoded, searched, queried, edited and exported", async () => {
    await withPage(async (page, _context, network) => {
      await pasteText(page, ORDER);
      await node(page, /^root \{\} 3 keys$/).waitFor();

      await runFromPalette(
        page,
        "Decode all values in selection",
        /Decode all values in selection/,
      );
      await node(page, /^payload JSON/).waitFor();

      await page.keyboard.press(`${MOD}+f`);
      const find = page.getByLabel("Find in document");
      await find.fill("Springfield");
      await find.press("Enter");
      await page.getByText("1 of 1", { exact: true }).waitFor();

      const views = page.getByLabel("Document view");
      await views.getByRole("button", { name: "Tree" }).click();
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await views.getByRole("button", { name: "Source" }).click();
      await page.locator("[data-source-view]").waitFor();

      // jq runs in a WebAssembly worker the app serves itself.
      await runFromPalette(page, "jq filter", /jq filter/);
      const jq = page.getByLabel("jq filter");
      // Find left its hit selected; the filter is for the whole document.
      await page
        .getByRole("group", { name: "Run jq on" })
        .getByRole("button", { name: "Document" })
        .click();
      await jq.fill(".order.id");
      await jq.press("Enter");
      await page.locator("[data-jq-output]").getByText("1042").first().waitFor();

      await runFromPalette(page, "Minify document", /Minify document/);
      await page.locator("[data-unsaved-dot]").first().waitFor();

      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Export / });
      await dialog.getByRole("combobox", { name: "Format" }).click();
      await page.getByRole("option", { name: "YAML", exact: true }).waitFor();

      expect(network.external()).toEqual([]);
    });
  });

  it("while a board is drawn", async () => {
    await withPage(async (page, _context, network) => {
      const canvas = await openNewBoard(page);
      await drawBox(page, canvas, "r", [80, 120], [260, 240]);
      await drawBox(page, canvas, "o", [320, 120], [480, 240]);
      await page.locator('[data-element-type="ellipse"]').waitFor();
      await page.getByTestId("board-save-status").getByText("Saved").waitFor();
      expect(network.external()).toEqual([]);
    });
  });

  it.each(SETTINGS_PAGES)("on the %s settings page", async (name) => {
    await withPage(
      async (page, _context, network) => {
        await page.getByRole("heading").first().waitFor();
        // Fonts, icons and the license list have all loaded once the network is quiet.
        await page.waitForLoadState("networkidle");
        expect(network.external()).toEqual([]);
      },
      { path: `/settings/${name}` },
    );
  });

  it("is checked: a page that reaches another host fails its test", async () => {
    const leaves = withPage(async (page, context) => {
      // Refused before it leaves the machine; the page still asked for it.
      await context.route("https://elsewhere.invalid/**", (route) => route.abort());
      await page.evaluate(() => fetch("https://elsewhere.invalid/ping").catch(() => null));
    });
    await expect(leaves).rejects.toThrow(/outside its own origin[^]*elsewhere\.invalid/);
  });
});
