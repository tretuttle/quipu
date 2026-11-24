// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, useBrowser } from "./harness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-invalid-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(name: string, contents: string): string {
  const file = NodePath.join(scratch, name);
  NodeFS.writeFileSync(file, contents);
  return file;
}

/** A broken document: a key where a list item belongs, and nothing closed. */
const BROKEN = '{\n  "name": "broken",\n  "items": [1, 2, 3,\n    "missing": }\n';
const MESSAGE = "Not valid JSON: unexpected `:` at line 4, column 14";

const notice = (page: Page) => page.locator("[data-document-problem]");
const badge = (page: Page) => page.locator("[data-document-format-badge]");

describe("a document that is not valid JSON", () => {
  it("says so on the map, with the line and column, and the header says so too", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("broken.json", BROKEN));
      await notice(page).getByText(MESSAGE).waitFor();
      await badge(page).filter({ hasText: "JSON · Not valid" }).waitFor();
      await page.getByRole("tree", { name: "Document map" }).waitFor();
    });
  });

  it("keeps saying so in the tree, and shows the spot in the source", async () => {
    await withPage(
      async (page) => {
        await dropFile(page, writeFixture("broken.json", BROKEN));
        await page.getByRole("tree", { name: "Document tree" }).waitFor();
        await notice(page).getByText(MESSAGE).waitFor();
        await notice(page).getByRole("button", { name: "Show in source" }).click();
        const marked = page.getByLabel("Document text").locator("[data-problem]");
        await marked.waitFor();
        expect(await marked.textContent()).toBe(":");
        // The notice stays while the document is open.
        await notice(page).getByText(MESSAGE).waitFor();
      },
      { storage: { "quipu:document-view": "tree" } },
    );
  });

  it("keeps a .json file with a trailing comma as JSON, says so, and offers JSONC", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("data.json", '{\n  "a": 1,\n  "b": [1, 2,],\n}\n'));
      await notice(page)
        .getByText(
          "Not valid JSON: a comma before the end of a list or object at line 3, column 14",
        )
        .waitFor();
      await badge(page).filter({ hasText: "JSON · Not valid" }).waitFor();
      await notice(page).getByRole("button", { name: "Open as JSONC" }).click();
      await badge(page).filter({ hasText: "JSONC · Read-only" }).waitFor();
      expect(await notice(page).count()).toBe(0);
    });
  });

  it("shows nothing past the first problem instead of invented keys", async () => {
    await withPage(
      async (page) => {
        await dropFile(page, writeFixture("quotes.json", "{'single': 'quotes', unquoted: true}"));
        await notice(page)
          .getByText(/^Not valid JSON: unexpected `'` at line 1, column 2/)
          .waitFor();
        const tree = page.getByRole("tree", { name: "Document tree" });
        await tree.getByRole("treeitem", { name: /^root : \{\} 0 keys/ }).waitFor();
        expect(await tree.getByRole("treeitem").count()).toBe(1);
      },
      { storage: { "quipu:document-view": "tree" } },
    );
  });

  it("names JSONC as JSONC, and says nothing about a valid file", async () => {
    await withPage(async (page) => {
      await dropFile(
        page,
        writeFixture("settings.jsonc", '{\n  // fine\n  "a": [1,],\n  "b" 2\n}\n'),
      );
      await notice(page).getByText("Not valid JSONC: unexpected `2` at line 4, column 7").waitFor();
      await dropFile(page, writeFixture("fine.json", '{"a":[1,2,3]}'));
      await badge(page)
        .filter({ hasText: /^JSON$/ })
        .waitFor();
      expect(await notice(page).count()).toBe(0);
    });
  });
});
