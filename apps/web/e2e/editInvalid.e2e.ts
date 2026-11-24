// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-edit-invalid-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** A broken document: a key where a list item belongs, and nothing closed. */
const BROKEN = '{\n  "name": "broken",\n  "items": [1, 2, 3,\n    "missing": }\n';

const notice = (page: Page) => page.locator("[data-document-problem]");

describe("editing a document that is not valid JSON", () => {
  it("says the check was made when the file opened, and how to make it again", async () => {
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "broken.json");
      NodeFS.writeFileSync(file, BROKEN);
      await dropFile(page, file);
      await notice(page)
        .getByText("The Tree and Map views show the file up to this point.")
        .waitFor();
      await notice(page).getByRole("button", { name: "Show in source" }).waitFor();

      const name = page
        .locator('[role="treeitem"]')
        .filter({ has: page.locator("[data-tree-key]", { hasText: /^name$/ }) })
        .locator("[data-tree-value]");
      await name.dblclick();
      const input = page.getByRole("tree", { name: "Document tree" }).getByLabel("Value");
      await input.fill("fixed");
      await input.press("Enter");
      await input.waitFor({ state: "detached" });

      await notice(page)
        .getByText(
          "Found when the file was opened; edits are not checked again. Save, then open the file again to check it.",
        )
        .waitFor();
      // The file's offset no longer says where the problem is in the edited document.
      expect(await notice(page).getByRole("button", { name: "Show in source" }).count()).toBe(0);
    }, inTree);
  });
});
