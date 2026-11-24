import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const counter = (page: Page) => page.locator("[data-search-count]");

const ORDERS = JSON.stringify({
  meta: { embedded: JSON.stringify({ kind: "inner", note: "knot" }) },
  orders: [
    { id: 1, contact: { email: "a@example.com" }, note: "knot one" },
    { id: 2, contact: { email: "b@example.com" }, note: "knot two" },
    { id: 3, contact: { email: "c@example.com" }, note: "knot three" },
  ],
});

describe("where search starts", () => {
  it("starts at the first hit, or after a node the user selected and says so", async () => {
    await withPage(async (page) => {
      await pasteText(page, ORDERS);
      await row(page, /^orders/).waitFor();
      // Nothing selected by hand: the first of the four hits.
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Find in document").fill("knot");
      await counter(page).getByText("1 of 4").waitFor();
      expect(await page.locator("[data-search-from]").count()).toBe(0);
      await page.keyboard.press("Escape");

      // A node picked in the tree: the next search starts after it, and the counter says why.
      await row(page, /^orders/)
        .locator("[data-tree-toggle]")
        .click();
      await row(page, /^1\b/).click();
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Find in document").fill("knot t");
      await counter(page).getByText("1 of 2").waitFor();
      await page.getByLabel("Find in document").fill("knot");
      await counter(page).getByText("3 of 4").waitFor();
      // Said beside the count, and at more length in its tooltip.
      expect(await page.locator("[data-search-from]").textContent()).toBe(
        "after the selected value",
      );
      await counter(page).hover();
      await page.getByText("Started at the first match after the selected value").waitFor();
    }, inTree);
  });
});

describe("path queries", () => {
  it("shows each result's path, and says a path does not look inside a string's JSON", async () => {
    await withPage(async (page) => {
      await pasteText(page, ORDERS);
      await row(page, /^orders/).waitFor();
      await page.keyboard.press(`${MOD}+Shift+f`);
      const input = page.getByLabel("Path query");
      await input.fill("$..email");
      await input.press("Enter");
      await page.locator("[data-path-count]", { hasText: "3 results" }).waitFor();
      expect(await page.locator("[data-path-result-path]").allTextContents()).toEqual([
        "$.orders[0].contact.email",
        "$.orders[1].contact.email",
        "$.orders[2].contact.email",
      ]);

      await input.fill("$.meta.embedded.kind");
      await input.press("Enter");
      await page.locator("[data-path-count]", { hasText: "No results" }).waitFor();
      await page
        .locator("[data-path-note]")
        .getByText(/does not look inside JSON/)
        .waitFor();

      await input.fill("$[");
      await input.press("Enter");
      await page
        .getByRole("alert")
        .getByText("Not a valid path: the bracket is not closed.")
        .waitFor();
    }, inTree);
  });
});

describe("path results in the tree", () => {
  it("fit their pane, and reveal a result with room around it", async () => {
    const items = Array.from({ length: 300 }, (_, id) => ({ id, name: `item ${id}` }));
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ items }));
      await row(page, /^items/).waitFor();
      await page.keyboard.press(`${MOD}+Shift+f`);
      const input = page.getByLabel("Path query");
      await input.fill("$.items[250].name");
      await input.press("Enter");
      await page.locator("[data-path-count]", { hasText: "1 result" }).waitFor();
      // One result, one row of height: no tall empty pane under it.
      const pane = await page
        .getByRole("listbox", { name: "Path results" })
        .evaluate((el) => el.getBoundingClientRect().height);
      expect(pane).toBeLessThanOrEqual(30);

      await page.locator("[data-path-result]").click();
      const target = row(page, /^name.*item 250/);
      await target.waitFor();
      const place = await target.evaluate((el) => {
        const scroller = el.closest("[data-tree-view]")?.firstElementChild as HTMLElement;
        const box = scroller.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        return { above: rect.top - box.top, below: box.bottom - rect.bottom };
      });
      // Not left on an edge: at least a row of room on both sides.
      expect(place.above).toBeGreaterThanOrEqual(28);
      expect(place.below).toBeGreaterThanOrEqual(28);
    }, inTree);
  });
});

describe("the find bar's look", () => {
  it("types in the interface font, like the rest of the bar", async () => {
    await withPage(async (page) => {
      await pasteText(page, ORDERS);
      await row(page, /^orders/).waitFor();
      await page.keyboard.press(`${MOD}+f`);
      const find = page.getByLabel("Find in document");
      await find.waitFor();
      const fonts = await page.evaluate(() => ({
        input: getComputedStyle(
          document.querySelector<HTMLElement>('[aria-label="Find in document"]')!,
        ).fontFamily,
        bar: getComputedStyle(document.querySelector<HTMLElement>('[role="search"]')!).fontFamily,
      }));
      expect(fonts.input).toBe(fonts.bar);
      expect(fonts.input).not.toMatch(/mono/i);
    }, inTree);
  });
});

describe("jq", () => {
  it("shows jq's errors without its prefixes, the caret under the place", async () => {
    await withPage(async (page) => {
      await pasteText(page, ORDERS);
      await row(page, /^orders/).waitFor();
      await page.keyboard.press(`${MOD}+Alt+j`);
      const program = page.getByLabel("jq filter");
      await program.fill(".meta.embedded | .data");
      await program.press("Enter");
      const error = page.locator("[data-jq-error]");
      await error.waitFor();
      expect(await error.textContent()).toBe('Cannot index string with string ("data")');

      await program.fill(".data[");
      await program.press("Enter");
      await error.getByText(/Syntax error/).waitFor();
      const lines = ((await error.textContent()) ?? "").split("\n");
      expect(lines[0]).toBe("Syntax error, unexpected end of file (line 1, column 6):");
      expect(lines[1]).toBe(".data[");
      // The caret sits under column 6, in a block that keeps the lines as they are.
      expect(lines[2]).toBe("     ^");
      expect(await error.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre");
      expect(await page.getByText(/jq: |\/dev\/stdin/).count()).toBe(0);
    }, inTree);
  });

  it("runs on the whole document, or on the selected value when the user picks it", async () => {
    await withPage(async (page) => {
      await pasteText(page, ORDERS);
      await row(page, /^orders/).waitFor();
      await page.keyboard.press(`${MOD}+Alt+j`);
      const program = page.getByLabel("jq filter");
      const scope = page.getByRole("group", { name: "Run jq on" });
      const output = page.locator("[data-jq-output]");
      // Nothing selected: the whole document, and the selection cannot be picked.
      await page
        .locator("[data-jq-scope]")
        .getByText(/whole document/)
        .waitFor();
      expect(await scope.getByRole("button", { name: "Selected value" }).isDisabled()).toBe(true);
      await program.fill("keys");
      await program.press("Enter");
      await output.getByText(/"orders"/).waitFor();

      // A node selected in the tree: jq runs there, and Document runs it on everything again.
      await row(page, /^orders/).click();
      await page
        .locator("[data-jq-scope]")
        .getByText(/selected value/)
        .waitFor();
      await program.fill("length");
      await program.press("Enter");
      await output.getByText(/^\s*3\s*$/).waitFor();
      await scope.getByRole("button", { name: "Document" }).click();
      await page
        .locator("[data-jq-scope]")
        .getByText(/whole document/)
        .waitFor();
      await program.press("Enter");
      await output.getByText(/^\s*2\s*$/).waitFor();
    }, inTree);
  });
});

describe("the bar on a text document", () => {
  it("offers only Find, and the path and jq chords do nothing", async () => {
    await withPage(async (page) => {
      await pasteText(page, "just some words, not json\nsecond line");
      await page.getByLabel("Document text").getByText("second line").waitFor();
      // Neither chord applies to plain text, so neither may open or switch the bar.
      await page.keyboard.press(`${MOD}+Shift+f`);
      await page.keyboard.press(`${MOD}+Alt+j`);
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Find in document").waitFor();
      // One kind of query: no tab row, and the bar still closes.
      expect(await page.getByRole("tablist", { name: "Query kind" }).count()).toBe(0);
      expect(await page.getByLabel("jq filter").count()).toBe(0);
      await page.getByRole("button", { name: "Close query bar" }).click();
      await page.getByLabel("Find in document").waitFor({ state: "detached" });
    }, inTree);
  });
});
