import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };
const isMac = MOD === "Meta";

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

/**
 * Opens the palette on `query`. While the list re-filters it can hold a row twice for a moment, so
 * the tests read the first row that matches.
 */
async function openPalette(page: Page, query: string): Promise<Locator> {
  await page.keyboard.press(`${MOD}+k`);
  const dialog = palette(page);
  await dialog.getByPlaceholder("Search commands and settings...").fill(query);
  return dialog;
}

async function closePalette(page: Page) {
  await page.keyboard.press("Escape");
  await palette(page).waitFor({ state: "hidden" });
}

/** Pastes a small JSON document whose one key names it, and waits for the tree to show it. */
async function openNamed(page: Page, key: string) {
  await pasteText(page, JSON.stringify({ [key]: true }));
  await treeKey(page, key).waitFor();
}

const treeKey = (page: Page, key: string) =>
  page.getByRole("tree", { name: "Document tree" }).locator("[data-tree-key]", { hasText: key });

const noDocument = (page: Page) => page.getByRole("heading", { name: "No document open" });

/** Presses Back, the app's own command, and waits for what it should show. */
async function back(page: Page, shows: Locator) {
  await page.keyboard.press(`${MOD}+[`);
  await shows.waitFor();
}

describe("go back and forward", () => {
  it("walks the documents and pages opened here, and never leaves the app", async () => {
    await withPage(async (page) => {
      const start = page.url();
      // Nothing to go back to yet: the command is off and the key does nothing.
      const dialog = await openPalette(page, "go back");
      await dialog.getByText("Nothing to go back to.").waitFor();
      expect(await dialog.getByRole("option", { name: /Go back/ }).count()).toBe(0);
      await closePalette(page);
      await page.keyboard.press(`${MOD}+[`);
      await noDocument(page).waitFor();
      expect(page.url()).toBe(start);

      await openNamed(page, "alpha");
      await openNamed(page, "beta");
      await back(page, treeKey(page, "alpha"));
      await page.keyboard.press(`${MOD}+]`);
      await treeKey(page, "beta").waitFor();

      await (
        await openPalette(page, "keyboard shortcuts")
      )
        .getByRole("option", { name: /Show keyboard shortcuts/ })
        .click();
      await palette(page).waitFor({ state: "hidden" });
      await page.waitForURL(/\/settings\/keybindings$/);
      // The browser's own Back button walks the same entries.
      await page.goBack();
      await treeKey(page, "beta").waitFor();

      await back(page, treeKey(page, "alpha"));
      await back(page, noDocument(page));
      // The first entry: Back stays in the app.
      await page.keyboard.press(`${MOD}+[`);
      await noDocument(page).waitFor();
      expect(page.url()).toBe(start);
      const again = await openPalette(page, "go back");
      await again.getByText("Nothing to go back to.").waitFor();
    }, inTree);
  });

  it("shows a document opened from a board's page", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "New board", exact: true }).click();
      await page.getByRole("application", { name: "Board canvas" }).waitFor();
      await page.getByTestId("sidebar-boards-shelf").getByRole("link").first().waitFor();
      await openNamed(page, "gamma");
      expect(new URL(page.url()).pathname).toBe("/");
      await back(page, page.getByRole("application", { name: "Board canvas" }));
    }, inTree);
  });
});

describe("history and the recent list", () => {
  it("keeps the list's order while going back and forward, and skips a removed document", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quipu-recents-"));
    try {
      await withPage(async (page) => {
        const names = ["a.json", "b.json", "c.json"];
        for (const name of names) {
          const path = NodePath.join(directory, name);
          await NodeFSP.writeFile(path, JSON.stringify({ [name.replace(".json", "-key")]: true }));
          await dropFile(page, path);
          await treeKey(page, name.replace(".json", "-key")).waitFor();
        }
        const rows = page.getByTestId("recent-document");
        const order = async () =>
          (await rows.locator("[data-recent-name]").allTextContents()).map((text) => text.trim());
        await expect.poll(order).toEqual(["c.json", "b.json", "a.json"]);

        await back(page, treeKey(page, "b-key"));
        await back(page, treeKey(page, "a-key"));
        await page.keyboard.press(`${MOD}+]`);
        await treeKey(page, "b-key").waitFor();
        expect(await order()).toEqual(["c.json", "b.json", "a.json"]);

        // Removed from the list, b.json is out of the history as well.
        await page.keyboard.press(`${MOD}+]`);
        await treeKey(page, "c-key").waitFor();
        await page.getByRole("button", { name: "Remove b.json from recent documents" }).click();
        await expect.poll(order).toEqual(["c.json", "a.json"]);
        await back(page, treeKey(page, "a-key"));
        await page.goForward();
        await treeKey(page, "c-key").waitFor();
        await page.goBack();
        await treeKey(page, "a-key").waitFor();
        expect(await order()).toEqual(["c.json", "a.json"]);
      }, inTree);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("closing a document", () => {
  it("closes from the header, its keybinding and the palette, and keeps it in recents", async () => {
    await withPage(async (page) => {
      const recents = page.getByTestId("recent-document");
      await openNamed(page, "alpha");
      await recents.first().waitFor();
      await page.getByRole("button", { name: "Close document" }).click();
      await noDocument(page).waitFor();
      expect(await recents.count()).toBe(1);

      await recents.first().getByRole("button").first().click();
      await treeKey(page, "alpha").waitFor();
      await page.keyboard.press(`${MOD}+Alt+w`);
      await noDocument(page).waitFor();

      await recents.first().getByRole("button").first().click();
      await treeKey(page, "alpha").waitFor();
      const dialog = await openPalette(page, "close document");
      await dialog
        .getByRole("option", { name: /Close document/ })
        .first()
        .getByText(isMac ? "⌥⌘W" : "Ctrl+Alt+W")
        .waitFor();
      await dialog
        .getByRole("option", { name: /Close document/ })
        .first()
        .click();
      await noDocument(page).waitFor();
    }, inTree);
  });

  it("closes the open document when it is removed from recents", async () => {
    await withPage(async (page) => {
      await openNamed(page, "alpha");
      const remove = page.getByRole("button", { name: "Remove Pasted text from recent documents" });
      await remove.hover();
      await page.getByText("Close and remove from recent documents").waitFor();
      await remove.click();
      await noDocument(page).waitFor();
      await page.getByText("No documents yet").waitFor();
      // Nothing is on screen that the sidebar does not list.
      expect(await page.locator("[data-document-workspace]").count()).toBe(0);
    }, inTree);
  });
});

describe("the command palette", () => {
  it("names the shortcut of every bound command, whether or not it can run now", async () => {
    await withPage(async (page) => {
      await openNamed(page, "alpha");
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        ["Find in document", "Ctrl+F", "⌘F"],
        ["Next match", "Ctrl+G", "⌘G"],
        ["Path query", "Ctrl+Shift+F", "⇧⌘F"],
        ["jq filter", "Ctrl+Alt+J", "⌥⌘J"],
        ["Decode selected value", "Ctrl+D", "⌘D"],
        ["Expand all in tree", "Ctrl+Shift+→", "⇧⌘→"],
        ["Show source view", "Ctrl+Alt+3", "⌥⌘3"],
        ["Show keyboard shortcuts", "Shift+?", "⇧?"],
      ];
      for (const [title, linux, mac] of cases) {
        const dialog = await openPalette(page, title);
        await dialog
          .locator("[data-slot=command-item], [data-disabled-command]")
          .filter({ hasText: title })
          .getByText(isMac ? mac : linux, { exact: true })
          .first()
          .waitFor();
        await closePalette(page);
      }
      // Next match waits for a search, and says so.
      await (
        await openPalette(page, "next match")
      )
        .locator("[data-disabled-command]")
        .filter({ hasText: "Next match" })
        .getByText("Find something first.")
        .first()
        .waitFor();
    }, inTree);
  });

  it("offers no document command with no document open, and queues nothing for the next one", async () => {
    await withPage(async (page) => {
      for (const title of ["Find in document", "Decode selected value", "Expand all in tree"]) {
        const dialog = await openPalette(page, title);
        await dialog.getByText("No matching commands or settings.").waitFor();
        await closePalette(page);
      }
      await page.keyboard.press(`${MOD}+f`);
      await openNamed(page, "alpha");
      expect(await page.getByLabel("Find in document").count()).toBe(0);
    }, inTree);
  });

  it("finds a command by the name the Keybindings page gives it, group included", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ alpha: { beta: 1 } }));
      await page.getByRole("treeitem").first().waitFor();
      for (const [query, title] of [
        ["Map: Collapse all on map", "Collapse all on map"],
        ["Canvas zoom to fit", "Zoom to fit"],
        ["draw rectangle", "Rectangle tool"],
        ["Search: Find in document", "Find in document"],
      ] as const) {
        const dialog = await openPalette(page, query);
        await dialog
          .getByRole("option", { name: new RegExp(`^${title}`) })
          .first()
          .waitFor();
        await closePalette(page);
      }
      await page.goto(new URL("/settings/keybindings", page.url()).href);
      for (const title of ["Collapse all on map", "Zoom to fit", "Rectangle tool"]) {
        await page.getByText(title, { exact: true }).first().waitFor();
      }
    });
  });
});

describe("keyboard shortcuts", () => {
  it("opens Settings → Keybindings on ?, but not while typing", async () => {
    await withPage(async (page) => {
      const dialog = await openPalette(page, "");
      await dialog.getByPlaceholder("Search commands and settings...").press("Shift+?");
      expect(new URL(page.url()).pathname).toBe("/");
      await closePalette(page);
      await page.keyboard.press("Shift+?");
      await page.waitForURL(/\/settings\/keybindings$/);
      await page.getByRole("heading", { name: "General", exact: true }).waitFor();
    });
  });
});

describe("sizes", () => {
  it("are decimal: 13,400 bytes read 13.4 kB in the sidebar and the status bar", async () => {
    await withPage(async (page) => {
      const text = JSON.stringify({ pad: "x".repeat(13_400 - 10) });
      expect(new TextEncoder().encode(text).length).toBe(13_400);
      await pasteText(page, text);
      await page.getByTestId("recent-document").getByText("13.4 kB").waitFor();
      await page.locator("[data-document-workspace]").getByText("13.4 kB").waitFor();
    }, inTree);
  });
});

describe("the open document's size", () => {
  it("follows its edits in the sidebar, as in the status bar", async () => {
    await withPage(async (page) => {
      const pretty = JSON.stringify({ alpha: { beta: [1, 2, 3] } }, null, 2);
      const minified = JSON.stringify({ alpha: { beta: [1, 2, 3] } });
      await pasteText(page, pretty);
      await treeKey(page, "alpha").waitFor();
      const row = page.getByTestId("recent-document");
      await row.getByText(`${pretty.length} B`).waitFor();
      await (
        await openPalette(page, "minify document")
      )
        .getByRole("option", { name: /^Minify document/ })
        .first()
        .click();
      await page.locator("[data-document-workspace]").getByText(`${minified.length} B`).waitFor();
      await row.getByText(`${minified.length} B`).waitFor();
    }, inTree);
  });
});

describe("storage", () => {
  it("keeps every setting under quipu: keys", async () => {
    await withPage(async (page) => {
      const dialog = await openPalette(page, "change appearance");
      await dialog
        .getByRole("option", { name: /Change appearance/ })
        .first()
        .click();
      await dialog.getByRole("option", { name: /^Dark/ }).first().click();
      await page.waitForFunction(
        () => localStorage.getItem("quipu:theme-appearance-mode") === "dark",
      );
      const keys = await page.evaluate(() => Object.keys(localStorage));
      expect(keys.filter((key) => !key.startsWith("quipu:"))).toEqual([]);
    });
  });
});

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${locator.toString()} has no box.`);
  return box;
}

/** The header's pieces and the map's drawing toolbar: none overlaps another or leaves the page. */
async function expectNothingOverlaps(page: Page, width: number) {
  // A sheet over the page hides the page from the accessibility tree, not from the screen.
  const button = (name: string | RegExp) =>
    page.getByRole("button", { name, exact: true, includeHidden: true }).first();
  const pieces = {
    name: page.locator("[data-breadcrumb-name]"),
    close: button("Close document"),
    format: page.locator("[data-document-format-badge]"),
    save: button("Save"),
    export: button("Export"),
    undo: button("Undo edit"),
    transform: button("Transform"),
    views: page.locator('[aria-label="Document view"]'),
    panelToggle: button("Toggle right panel"),
    toolbar: page.getByTestId("board-toolbar"),
  };
  const content = await boxOf(page.locator("[data-content-area]"));
  const boxes = await Promise.all(
    Object.entries(pieces).map(async ([name, locator]) => [name, await boxOf(locator)] as const),
  );
  for (const [name, box] of boxes) {
    expect(box.x, `${name} at ${width} px`).toBeGreaterThanOrEqual(content.x - 0.5);
    expect(box.x + box.width, `${name} at ${width} px`).toBeLessThanOrEqual(
      content.x + content.width + 0.5,
    );
  }
  // The file name is the last thing to give way: it stays readable at every width.
  const name = boxes.find(([piece]) => piece === "name")?.[1];
  expect(name?.width ?? 0, `the name's width at ${width} px`).toBeGreaterThanOrEqual(80);
  for (const [index, [name, box]] of boxes.entries()) {
    for (const [other, otherBox] of boxes.slice(index + 1)) {
      expect(intersects(box, otherBox), `${name} and ${other} at ${width} px`).toBe(false);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

describe("narrow windows", () => {
  it("keep the header and toolbar whole from 1280 down to 640 px with the right panel open", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quipu-narrow-"));
    const path = NodePath.join(
      directory,
      "a-capture-with-a-rather-long-name-that-has-to-be-cut-short.json",
    );
    await NodeFSP.writeFile(path, JSON.stringify({ nested: [1, 2, 3] }));
    try {
      await withPage(async (page) => {
        await narrowWindows(page, path);
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

/** Opens a long-named document on the map, opens the right panel, and narrows the window. */
async function narrowWindows(page: Page, path: string) {
  await dropFile(page, path);
  await page.getByTestId("board-toolbar").waitFor();
  await page.keyboard.press(`${MOD}+Alt+b`);
  const panel = page.locator("[data-right-panel][data-state=open]");
  await panel.waitFor();
  for (const width of [1280, 1100, 800, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("tab", { name: "Inspector", includeHidden: true }).waitFor();
    // Beside the page while the page keeps room for its header, a sheet over it after that.
    // The panel changes place after the page reports its new width, so wait for it to settle.
    const isInline = () => panel.evaluate((element) => element.tagName === "ASIDE");
    await expect
      .poll(isInline, { message: `the panel's place at ${width} px` })
      .toBe(width === 1280);
    const inline = await isInline();
    // Below 900 px the sidebar opens over the page on demand instead of taking its width. It
    // changes place after the window does, like the panel: wait for the page's edge to settle.
    const leftEdge = async () => (await boxOf(page.locator("[data-content-area]"))).x;
    const edge = expect.poll(leftEdge, { message: `the page's left edge at ${width} px` });
    if (width < 900) await edge.toBeLessThan(1);
    else await edge.toBeGreaterThan(100);
    const content = await boxOf(page.locator("[data-content-area]"));
    if (inline) {
      expect(intersects(await boxOf(panel), content)).toBe(false);
    } else {
      // The sheet starts under the header, so the header's controls stay in sight and in reach,
      // and it has its own way out.
      const header = await boxOf(page.locator("[data-content-area] header"));
      expect((await boxOf(panel)).y, `the sheet's top at ${width} px`).toBeGreaterThanOrEqual(
        header.y + header.height - 0.5,
      );
      const toggle = page.getByRole("button", { name: "Toggle right panel", includeHidden: true });
      const hit = await toggle.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top !== null && element.contains(top);
      });
      expect(hit, `the panel toggle is on top at ${width} px`).toBe(true);
      await panel.getByRole("button", { name: "Close right panel" }).waitFor();
    }
    await expectNothingOverlaps(page, width);
  }
  // On a narrow window the sheet closes with its button, and with Escape.
  await panel.getByRole("button", { name: "Close right panel" }).click();
  await panel.waitFor({ state: "hidden" });
  await page.keyboard.press(`${MOD}+Alt+b`);
  await panel.waitFor();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  // The header's own toggle, in reach above the sheet, closes it rather than opening it again.
  await page.keyboard.press(`${MOD}+Alt+b`);
  await panel.waitFor();
  // Focus stays in the sheet, so the header is out of the accessibility tree, not out of reach.
  await page.getByRole("button", { name: "Toggle right panel", includeHidden: true }).click();
  await panel.waitFor({ state: "hidden" });
  expect(await panel.count()).toBe(0);
  await expectNothingOverlaps(page, 640);
  // The cut-short name is whole in its tooltip.
  await page.locator("[data-breadcrumb-name]").hover();
  await page
    .locator('[data-slot="tooltip-popup"]')
    .getByText("a-capture-with-a-rather-long-name-that-has-to-be-cut-short.json")
    .waitFor();
}

describe("the header's file actions", () => {
  it("name Save and Export where there is room, and keep their icons and tooltips where there is not", async () => {
    await withPage(async (page) => {
      await openNamed(page, "alpha");
      const save = page.getByRole("button", { name: "Save", exact: true });
      const exportButton = page.getByRole("button", { name: "Export", exact: true });
      await save.getByText("Save", { exact: true }).waitFor();
      await exportButton.getByText("Export", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Transform" }).getByText("Transform").waitFor();

      await page.setViewportSize({ width: 800, height: 800 });
      await save.getByText("Save", { exact: true }).waitFor({ state: "hidden" });
      await exportButton.hover();
      await page
        .locator('[data-slot="tooltip-popup"]')
        .getByText(/^Export…/)
        .waitFor();
    }, inTree);
  });
});

describe("dropping a file", () => {
  it("centers the drop card on the page, not the window", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "quipu-drop-"));
    const path = NodePath.join(directory, "dropped.json");
    await NodeFSP.writeFile(path, "{}");
    try {
      await withPage(async (page) => {
        const cdp = await page.context().newCDPSession(page);
        const data = { items: [], files: [path], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver"] as const) {
          await cdp.send("Input.dispatchDragEvent", { type, x: 640, y: 400, data });
        }
        const card = await boxOf(page.locator("[data-drop-card]"));
        const content = await boxOf(page.locator("[data-content-area]"));
        const centre = (box: Box) => box.x + box.width / 2;
        expect(Math.abs(centre(card) - centre(content))).toBeLessThan(1);
        // It sits clear of the sidebar, beside which the window's center would put it.
        const sidebar = await boxOf(page.getByRole("navigation", { name: "Documents" }));
        expect(card.x).toBeGreaterThan(sidebar.x + sidebar.width);
        await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: 640, y: 400, data });
        await cdp.detach();
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
