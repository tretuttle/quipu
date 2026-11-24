// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { expectMedianWithin, sampleRuns } from "./budget";
import { cachedHar, skipWithout } from "./fixtures";
import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();

const HAR_2G = cachedHar("har-2g.har");

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-open-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(name: string, contents: string): string {
  const file = NodePath.join(scratch, name);
  NodeFS.writeFileSync(file, contents);
  return file;
}

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
/** These tests read the outline: open documents in the Tree view (the Map is the default). */
const inTree = { storage: { "quipu:document-view": "tree" } };

describe("opening a document", () => {
  it("shows the keys of pasted JSON", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ name: "quipu", knots: 3, nested: { depth: 2 } }));
      const rows = tree(page);
      await rows.getByRole("treeitem", { name: /name.*"quipu"/ }).waitFor();
      await rows.getByRole("treeitem", { name: /knots.*3/ }).waitFor();
      await rows.getByRole("treeitem", { name: /nested/ }).waitFor();
      await page.getByRole("navigation", { name: "Documents" }).getByText("Pasted text").waitFor();
    }, inTree);
  });

  it("opens a file that is not JSON as text", async () => {
    await withPage(async (page) => {
      await dropFile(
        page,
        writeFixture("notes.txt", "Knots to tie today\nA square knot, then a clove hitch.\n"),
      );
      await page.getByLabel("Document text").getByText("then a clove hitch.").waitFor();
      expect(await tree(page).count()).toBe(0);
    }, inTree);
  });

  it("opens a 100 000-level document without an error", async () => {
    const depth = 100_000;
    const file = writeFixture("json-deep.json", "[".repeat(depth) + "]".repeat(depth));
    await withPage(async (page) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await dropFile(page, file);
      await tree(page)
        .getByRole("treeitem", { name: /root.*\[\] 1 item/ })
        .waitFor();
      await page.getByText("json-deep.json").first().waitFor();
      expect(errors).toEqual([]);
      expect(await page.getByRole("alert").count()).toBe(0);
    }, inTree);
  });

  it("opens through Open file… when the browser has no file picker", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        // Firefox and Safari have no picker; the property lives on the prototype, so shadow it.
        Object.defineProperty(window, "showOpenFilePicker", { value: undefined });
      });
      const file = writeFixture("picked.json", '{"chosen":"by dialog"}');
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.keyboard.press(`${MOD}+o`),
      ]);
      await chooser.setFiles(file);
      await tree(page)
        .getByRole("treeitem", { name: /chosen.*by dialog/ })
        .waitFor();
    }, inTree);
  });

  it("expands and collapses with the keyboard, and chunks a big array", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ list: Array.from({ length: 2500 }, (_, i) => i) }));
      const rows = tree(page);
      const list = rows.getByRole("treeitem", { name: /list/ });
      await list.waitFor();
      await list.focus();
      await page.keyboard.press("ArrowRight");
      await rows.getByRole("treeitem", { name: "[0…999]" }).waitFor();
      await rows.getByRole("treeitem", { name: "[2000…2499]" }).waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await rows.getByRole("treeitem", { name: /^0\b.*0/ }).waitFor();
      await list.focus();
      await page.keyboard.press("ArrowLeft");
      await rows.getByRole("treeitem", { name: "[0…999]" }).waitFor({ state: "detached" });
    }, inTree);
  });

  it("opens the document again after a reload, and from the recent list", async () => {
    await withPage(async (page) => {
      await pasteText(page, '{"remembered":"across reloads"}');
      await tree(page)
        .getByRole("treeitem", { name: /remembered/ })
        .waitFor();
      const recent = page.getByTestId("recent-document");
      await recent.getByText("Pasted text").waitFor();
      // The tab's document comes back by itself, and the recent list opens it too.
      await page.reload();
      await tree(page)
        .getByRole("treeitem", { name: /remembered.*across reloads/ })
        .waitFor();
      await page.getByTestId("recent-document").getByText("Pasted text").click();
      await tree(page)
        .getByRole("treeitem", { name: /remembered.*across reloads/ })
        .waitFor();
    }, inTree);
  });

  it("lists recents in the command palette", async () => {
    await withPage(async (page) => {
      await pasteText(page, '{"a":1}');
      await tree(page).getByRole("treeitem", { name: /a.*1/ }).waitFor();
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("option", { name: /Open file/ }).waitFor();
      await palette.getByRole("option", { name: /Open recent document/ }).click();
      await palette.getByRole("option", { name: /Pasted text/ }).waitFor();
    }, inTree);
  });
});

describe("a 2 GiB HAR", () => {
  it("shows the root's first rows within a second of the drop and expands log → entries", async (context) => {
    skipWithout(context, HAR_2G);
    // Each run drops the file on a fresh page; the first one also walks log → entries.
    const samples = await sampleRuns((run) =>
      withPage(async (page) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const started = Date.now();
        await dropFile(page, HAR_2G.path);
        const log = tree(page).getByRole("treeitem", { name: /^log/ });
        await log.waitFor({ timeout: 10_000 });
        const firstRows = Date.now() - started;
        if (run === 0) {
          await log.locator("[data-tree-toggle]").click();
          const entries = tree(page).getByRole("treeitem", { name: /^entries/ });
          await entries.waitFor();
          await entries.locator("[data-tree-toggle]").click();
          await tree(page)
            .getByRole("treeitem", { name: /\[0…999\]/ })
            .waitFor();
          await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 30_000 });
        }
        expect(errors).toEqual([]);
        return firstRows;
      }, inTree),
    );
    expectMedianWithin("har-2g: drop to first rows", samples, 1000);
  }, 600_000);
});
