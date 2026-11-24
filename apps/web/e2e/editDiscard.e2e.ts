// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

const SAMPLE = { name: "alpha", count: 1 };

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-edit-discard-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const valueOf = (page: Page, key: string) =>
  tree(page)
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) })
    .locator("[data-tree-value]");
const recent = (page: Page, name = "Pasted text") =>
  page.getByTestId("recent-document").getByRole("button", { name: new RegExp(`^${name}`) });
const restored = (page: Page) => page.getByText(/^Restored \d+ unsaved edits?$/);
const dialog = (page: Page) => page.locator("[data-unsaved-changes-dialog]");

async function editCount(page: Page, text: string) {
  await valueOf(page, "count").dblclick();
  const input = tree(page).getByLabel("Value");
  await input.fill(text);
  await input.press("Enter");
  await valueOf(page, "count")
    .filter({ hasText: new RegExp(`^${text}$`) })
    .waitFor();
}

/** Opens the pasted sample again from the recents, answering the unsaved-changes question with `answer`. */
async function reopenAnswering(page: Page, answer: "Discard" | null) {
  await recent(page).click();
  if (answer !== null) await dialog(page).getByRole("button", { name: answer }).click();
  await tree(page).waitFor();
}

async function reloadAndReopen(page: Page, name?: string) {
  page.once("dialog", (prompt) => void prompt.accept());
  await page.reload();
  await page.locator("[data-app-sidebar]").waitFor();
  await recent(page, name).click();
  await tree(page).waitFor();
}

/** A file of the private file system, opened through a stubbed open dialog: Save writes it in place. */
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
  await tree(page).waitFor();
}

describe("discarded and saved edits", () => {
  it("opens a file again after a download save, an undo and Discard, and keeps opening it", async () => {
    await withPage(async (page) => {
      // The download path: a browser with no save dialog.
      await page.evaluate(() => {
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: undefined,
        });
      });
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      await tree(page).waitFor();
      await recent(page).waitFor();
      await editCount(page, "42");
      await Promise.all([page.waitForEvent("download"), page.keyboard.press(`${MOD}+s`)]);
      await page.keyboard.press(`${MOD}+z`);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();

      await reopenAnswering(page, "Discard");
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await page.getByText(/Could not open/).count()).toBe(0);
      expect(await restored(page).count()).toBe(0);

      await reloadAndReopen(page);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await page.getByText(/Could not open/).count()).toBe(0);
      expect(await restored(page).count()).toBe(0);
    }, inTree);
  });

  it("brings back edits made before a download save when the original is opened again", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: undefined,
        });
      });
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      await tree(page).waitFor();
      await recent(page).waitFor();
      await editCount(page, "42");
      await Promise.all([page.waitForEvent("download"), page.keyboard.press(`${MOD}+s`)]);
      // The file the document came from is unchanged: its edits are still unsaved there.
      await reloadAndReopen(page);
      await restored(page).waitFor();
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
    }, inTree);
  });

  it("offers back only the edits made after a save in place when the saved file opens again", async () => {
    await withPage(async (page) => {
      await openThroughPicker(page, "kept.json", JSON.stringify(SAMPLE, null, 2));
      await recent(page, "kept.json").waitFor();
      await editCount(page, "42");
      await page.keyboard.press(`${MOD}+s`);
      await page.getByText("Saved kept.json").first().waitFor();
      await editCount(page, "43");

      await reloadAndReopen(page, "kept.json");
      await restored(page).waitFor();
      expect(await restored(page).textContent()).toBe("Restored 1 unsaved edit");
      await valueOf(page, "count").filter({ hasText: /^43$/ }).waitFor();
      // Undo goes back to the file as saved, not to the file before the save.
      await page.getByRole("button", { name: "Undo edit" }).click();
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
    }, inTree);
  });

  it("drops the edits when the unsaved-changes question is answered Discard", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      await tree(page).waitFor();
      await recent(page).waitFor();
      await editCount(page, "42");
      // Replacing the document asks; Discard drops the edits for good.
      await reopenAnswering(page, "Discard");
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await restored(page).count()).toBe(0);
      await reloadAndReopen(page);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await restored(page).count()).toBe(0);

      // Closing the document asks too.
      await editCount(page, "7");
      await page.getByRole("button", { name: "Close document" }).click();
      await dialog(page).getByRole("button", { name: "Discard" }).click();
      await recent(page).click();
      await tree(page).waitFor();
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await restored(page).count()).toBe(0);
    }, inTree);
  });

  it("opens a dropped file after a download save, a restore, Discard and a reload, every time", async () => {
    const file = NodePath.join(scratch, "order.json");
    NodeFS.writeFileSync(file, JSON.stringify(SAMPLE, null, 2));
    const failures: string[] = [];
    for (let round = 1; round <= 30; round++) {
      await withPage(async (page) => {
        await page.evaluate(() => {
          Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            value: undefined,
          });
        });
        await dropFile(page, file);
        await page.getByLabel("Document view").getByRole("button", { name: "Tree" }).click();
        await tree(page).waitFor();
        await recent(page, "order.json").waitFor();
        await editCount(page, "42");
        await Promise.all([page.waitForEvent("download"), page.keyboard.press(`${MOD}+s`)]);
        await reloadAndReopen(page, "order.json");
        await restored(page).waitFor();
        await page.getByRole("button", { name: "Discard" }).click();
        await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
        await page.locator("[data-unsaved-dot]").first().waitFor({ state: "detached" });

        // The reload opens the document again by itself; a click on it in the recents while that
        // open is under way opens it a second time, as a quick user does.
        page.once("dialog", (prompt) => void prompt.accept());
        await page.reload();
        await page.getByText("Opening order.json…").waitFor();
        await recent(page, "order.json").click();
        const failed = page.getByText(/^Could not open/);
        await tree(page).or(failed).first().waitFor();
        if ((await failed.count()) > 0) {
          failures.push(`round ${round}: ${await page.locator("body").innerText()}`);
          return;
        }
        await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
        expect(await restored(page).count()).toBe(0);
      }, inTree);
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("a recent document that cannot be opened as it was", () => {
  const sample = () => {
    const file = NodePath.join(scratch, `sample-${Math.random().toString(36).slice(2)}.json`);
    NodeFS.writeFileSync(file, JSON.stringify(SAMPLE, null, 2));
    return { file, name: NodePath.basename(file) };
  };
  const removeButton = (page: Page) =>
    page.getByRole("button", { name: "Remove from recent documents" });

  it("waits for the journal the page before it still holds, and then restores its edits", async () => {
    await withPage(async (page) => {
      const { file, name } = sample();
      await dropFile(page, file);
      await page.getByLabel("Document view").getByRole("button", { name: "Tree" }).click();
      await recent(page, name).waitFor();
      await editCount(page, "42");
      // A second page opens the same file while the first still has it open: what a reload
      // does while the browser is still taking the page it replaced down.
      const next = await page.context().newPage();
      await next.goto(page.url());
      await next.locator("[data-app-sidebar]").waitFor();
      await recent(next, name).click();
      await next.getByText(`Opening ${name}…`).waitFor();
      await page.close();
      await restored(next).waitFor();
      await valueOf(next, "count").filter({ hasText: /^42$/ }).waitFor();
      expect(await next.getByText(/^Could not open/).count()).toBe(0);
    }, inTree);
  });

  it("opens without its journal when another tab keeps it, and says so", async () => {
    await withPage(async (page) => {
      const { file, name } = sample();
      await dropFile(page, file);
      await recent(page, name).waitFor();
      const other = await page.context().newPage();
      await other.goto(page.url());
      await other.locator("[data-app-sidebar]").waitFor();
      await recent(other, name).click();
      await other
        .getByText(`${name} is open in another tab or window`)
        .waitFor({ timeout: 20_000 });
      await tree(other).waitFor();
      expect(await other.getByText(/^Could not open/).count()).toBe(0);
    }, inTree);
  });

  it("says a recent whose stored copy is gone can't be found, and takes it off the list", async () => {
    await withPage(async (page) => {
      // Pasted text has no file to go back to: the recent is the copy kept of it.
      const name = "Pasted text";
      await pasteText(page, JSON.stringify(SAMPLE));
      await recent(page, name).waitFor();
      await page.getByRole("button", { name: "Close document" }).click();
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry("quipu-recent-copies", { recursive: true });
      });
      await recent(page, name).click();
      await page.getByText(`${name} can't be found`).waitFor();
      await page.getByRole("button", { name: "Choose the file" }).waitFor();
      await removeButton(page).click();
      await recent(page, name).waitFor({ state: "detached" });
    }, inTree);
  });

  it("says a recent whose file was deleted can't be found, and takes it off the list", async () => {
    await withPage(async (page) => {
      await openThroughPicker(page, "gone.json", JSON.stringify(SAMPLE));
      await recent(page, "gone.json").waitFor();
      await page.getByRole("button", { name: "Close document" }).click();
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry("gone.json");
      });
      await recent(page, "gone.json").click();
      await page.getByText("gone.json can't be found").waitFor();
      await removeButton(page).click();
      await recent(page, "gone.json").waitFor({ state: "detached" });
    }, inTree);
  });

  it("offers to open the file again or remove it when its stored bytes cannot be read", async () => {
    await withPage(async (page) => {
      const name = "Pasted text";
      await pasteText(page, JSON.stringify(SAMPLE));
      await recent(page, name).waitFor();
      await page.getByRole("button", { name: "Close document" }).click();
      // The stored copy goes away after the File is read from it: the bytes behind it are gone.
      await page.evaluate(() => {
        const read = FileSystemFileHandle.prototype.getFile;
        FileSystemFileHandle.prototype.getFile = async function (this: FileSystemFileHandle) {
          const snapshot = await read.call(this);
          const root = await navigator.storage.getDirectory();
          const copies = await root.getDirectoryHandle("quipu-recent-copies");
          await copies.removeEntry(this.name);
          return snapshot;
        };
      });
      await recent(page, name).click();
      const failed = page.getByRole("alert").filter({ hasText: `Could not open ${name}` });
      await failed.waitFor();
      await failed.getByRole("button", { name: "Open file…" }).waitFor();
      await failed.getByRole("button", { name: "Remove from recent documents" }).click();
      await recent(page, name).waitFor({ state: "detached" });
      await failed.waitFor({ state: "detached" });
    }, inTree);
  });
});
