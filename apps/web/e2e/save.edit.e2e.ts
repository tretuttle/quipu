// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
// Saving what the user edited: the bytes written are read back from the origin's private file
// system, where a stubbed open dialog put the file and from where the document was opened.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-save-edit-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const SAMPLE = { name: "quipu", count: 1, tags: ["a", "b"] };
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const valueOf = (page: Page, key: string) =>
  page
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) })
    .locator("[data-tree-value]");
const unsavedDot = (page: Page) => page.locator("[data-unsaved-dot]");

async function editValueInTree(page: Page, key: string, text: string) {
  await valueOf(page, key).dblclick();
  const input = tree(page).getByLabel("Value");
  await input.fill(text);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  // A string shows in quotes.
  await valueOf(page, key)
    .filter({ hasText: new RegExp(`^"?${text}"?$`) })
    .waitFor();
}

/** Writes `contents` to the private file system and opens it through a stubbed open dialog. */
async function openThroughPicker(page: Page, name: string, contents: string) {
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

const readPrivateFile = (page: Page, name: string) =>
  page.evaluate(async (fileName) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(fileName)).getFile()).text();
  }, name);

async function stubSavePicker(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options: { suggestedName: string }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      },
    });
  });
}

describe("saving edits", () => {
  it("writes the edited bytes in place with Mod+S, and the unsaved dot goes", async () => {
    await withPage(async (page) => {
      await openThroughPicker(page, "edit.json", pretty(SAMPLE));
      await valueOf(page, "count").waitFor();
      await editValueInTree(page, "count", "42");
      await unsavedDot(page).first().waitFor();
      await page.keyboard.press(`${MOD}+s`);
      await page.getByText("Saved edit.json", { exact: true }).first().waitFor();
      expect(await readPrivateFile(page, "edit.json")).toBe(pretty({ ...SAMPLE, count: 42 }));
      await unsavedDot(page).first().waitFor({ state: "detached" });
      // The document is the saved file now: it shows the saved value, with nothing to save.
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
    }, inTree);
  });

  it("keeps the history after a save in place: Undo brings the edit back as unsaved", async () => {
    await withPage(async (page) => {
      await openThroughPicker(page, "undo.json", pretty(SAMPLE));
      await valueOf(page, "count").waitFor();
      await editValueInTree(page, "count", "42");
      await page.keyboard.press(`${MOD}+s`);
      await page.getByText("Saved undo.json", { exact: true }).first().waitFor();
      await unsavedDot(page).first().waitFor({ state: "detached" });
      expect(await readPrivateFile(page, "undo.json")).toBe(pretty({ ...SAMPLE, count: 42 }));
      // Undo, from the tree as a user does it: the saved edit comes back off, and is unsaved.
      await valueOf(page, "count").click();
      await page.keyboard.press(`${MOD}+z`);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      await unsavedDot(page).first().waitFor();
      // Saving again writes the undone bytes over the file the first save wrote.
      await page.keyboard.press(`${MOD}+s`);
      await page.getByText("Saved undo.json", { exact: true }).nth(1).waitFor();
      expect(await readPrivateFile(page, "undo.json")).toBe(pretty(SAMPLE));
      await unsavedDot(page).first().waitFor({ state: "detached" });
    }, inTree);
  });

  it("saves from the unsaved-changes question, then opens the other file", async () => {
    await withPage(async (page) => {
      await openThroughPicker(page, "first.json", pretty(SAMPLE));
      await valueOf(page, "count").waitFor();
      await editValueInTree(page, "name", "khipu");
      await pasteText(page, pretty({ other: true }));
      const dialog = page.locator("[data-unsaved-changes-dialog]");
      await dialog.getByText("Save changes to first.json?").waitFor();
      await dialog.getByRole("button", { name: "Save" }).click();
      await valueOf(page, "other").waitFor();
      expect(await readPrivateFile(page, "first.json")).toBe(pretty({ ...SAMPLE, name: "khipu" }));
      expect(await unsavedDot(page).count()).toBe(0);
    }, inTree);
  });

  it("leaves the document unsaved after an export", async () => {
    await withPage(async (page) => {
      await stubSavePicker(page);
      await openThroughPicker(page, "kept.json", pretty(SAMPLE));
      await valueOf(page, "count").waitFor();
      await editValueInTree(page, "count", "7");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Export / });
      await dialog.getByRole("combobox", { name: "Format" }).click();
      await page.getByRole("option", { name: "YAML", exact: true }).click();
      await dialog.getByRole("button", { name: "Export…" }).click();
      await page.getByText("Exported kept.yaml", { exact: true }).first().waitFor();
      // The export holds the edit; the file and the dot do not change.
      expect(await readPrivateFile(page, "kept.yaml")).toContain("count: 7");
      expect(await readPrivateFile(page, "kept.json")).toBe(pretty(SAMPLE));
      await unsavedDot(page).first().waitFor();
    }, inTree);
  });
});

describe("formats read through a conversion", () => {
  it.each([
    ["service.yaml", "service: quipu\nreplicas: 3\n", "replicas", "YAML"],
    ["people.csv", "name,size\nquipu,2\nkhipu,3\n", "size", "CSV"],
  ] as const)("offers no editing for %s, and says why", (name, contents, key, label) =>
    withPage(async (page) => {
      await NodeFS.promises.writeFile(NodePath.join(scratch, name), contents);
      await dropFile(page, NodePath.join(scratch, name));
      await tree(page).getByRole("treeitem").first().focus();
      await page.keyboard.press(`${MOD}+Shift+ArrowRight`);
      await valueOf(page, key).first().waitFor();
      expect(await page.getByRole("button", { name: "Transform" }).count()).toBe(0);
      // Read-only is said once, by the header's format chip; not again in the status bar.
      await page
        .locator("[data-document-format-badge]")
        .filter({ hasText: `${label} · Read-only` })
        .waitFor();
      expect(await page.getByText(/read-only/i).count()).toBe(1);
      // A double click edits nothing, and F2 says why.
      await valueOf(page, key).first().dblclick();
      expect(await tree(page).getByLabel("Value").count()).toBe(0);
      await valueOf(page, key).first().click();
      await page.keyboard.press("F2");
      await page
        .getByText(`${label} opens read-only. Export converts it to another format.`)
        .first()
        .waitFor();
    }, inTree),
  );
});
