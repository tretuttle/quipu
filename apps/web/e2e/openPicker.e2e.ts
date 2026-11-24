import type { Page } from "playwright-core";
import { describe, it } from "vite-plus/test";

import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
/** These tests read the outline: open documents in the Tree view (the Map is the default). */
const inTree = { storage: { "quipu:document-view": "tree" } };

/**
 * Answers the next `showOpenFilePicker` with a real file handle: a file in the
 * origin's private file system, which is a `FileSystemFileHandle` like one the
 * user picks, so `getFile`, `isSameEntry` and `queryPermission` all run for real.
 */
const pickerReturns = (page: Page, name: string, contents: string) =>
  page.evaluate(
    async ([fileName, text]) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      // The picker lives on the prototype; an own property shadows it.
      Object.defineProperty(window, "showOpenFilePicker", {
        configurable: true,
        value: async () => [handle],
      });
    },
    [name, contents],
  );

describe("opening through the File System Access picker", () => {
  it("opens the picked file, remembers its handle and reopens it after a reload", async () => {
    await withPage(async (page) => {
      await pickerReturns(page, "picked.json", '{"pickedBy":"the file picker"}');
      await page.keyboard.press(`${MOD}+o`);
      await tree(page)
        .getByRole("treeitem", { name: /pickedBy.*the file picker/ })
        .waitFor();
      await page.getByTestId("recent-document").getByText("picked.json").waitFor();

      // The recent is the handle, not a copy: a reload reopens the same file from it, and so
      // does the recent list.
      await page.reload();
      await tree(page)
        .getByRole("treeitem", { name: /pickedBy.*the file picker/ })
        .waitFor();
      await page.getByTestId("recent-document").getByText("picked.json").click();
      await tree(page)
        .getByRole("treeitem", { name: /pickedBy.*the file picker/ })
        .waitFor();
    }, inTree);
  });
});
