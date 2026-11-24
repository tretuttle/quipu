import { describe, expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";

import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();

const KEYBINDINGS = { path: "/settings/keybindings" };

function shortcutButton(page: Page, label: string, chord?: RegExp) {
  return page.getByRole("button", {
    name: new RegExp(`^Edit shortcut for ${label}: ${chord ? `(${chord.source})` : ""}`),
  });
}

describe("keybindings list", () => {
  it("writes keys the way the platform does", async () => {
    await withPage(async (page) => {
      await shortcutButton(page, "Toggle sidebar").waitFor();
      const keys = await page.locator('[data-slot="kbd"]').allTextContents();
      expect(keys.filter((key) => /^[a-z]{2,}$/.test(key))).toEqual([]);
      for (const key of ["←", "F3", "Backspace", "Enter", "Page Up"]) expect(keys).toContain(key);
    }, KEYBINDINGS);
  });

  it("says in words where each binding works", async () => {
    await withPage(async (page) => {
      await shortcutButton(page, "Toggle sidebar").waitFor();
      const conditions = await page.locator("[data-keybinding-when]").allTextContents();
      expect(conditions.filter((text) => /[!&|()]|[a-z][A-Z]/.test(text))).toEqual([]);
      expect(conditions).toContain("Anywhere except text fields");
      expect(conditions).toContain(
        "On the map or a board, with a drawing selected, not while typing",
      );
      // A board has no map nodes: no board shortcut speaks of them.
      expect(conditions).toContain("On a map node, with no drawing selected, not while typing");
      expect(conditions.filter((text) => /on the map or a board.*map node/i.test(text))).toEqual(
        [],
      );
      // Not a warning: the browser note is a line of text.
      await page
        .getByText("The browser may claim some shortcuts first. The desktop app receives them all.")
        .waitFor();
      expect(await page.getByRole("button", { name: /browser may claim/ }).count()).toBe(0);
    }, KEYBINDINGS);
  });
});

describe("browser shortcut note", () => {
  it("sits in its card with the same space above and below it", async () => {
    await withPage(async (page) => {
      const note = page.locator("[data-browser-shortcut-note]");
      await note.waitFor();
      const space = await note.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const card = element.parentElement!.getBoundingClientRect();
        const next = element.nextElementSibling!.getBoundingClientRect();
        return { above: text.top - card.top, below: next.top - text.bottom };
      });
      expect(space.above).toBeGreaterThanOrEqual(12);
      expect(Math.abs(space.below - space.above)).toBeLessThanOrEqual(2);
    }, KEYBINDINGS);
  });
});

describe("shortcut recorder", () => {
  const REBOUND = /Ctrl\+Shift\+Y|⇧⌘Y/;
  const DEFAULT = /Ctrl\+B|⌘B/;

  it("saves the recorded shortcut on Enter", async () => {
    await withPage(async (page) => {
      await shortcutButton(page, "Toggle sidebar").click();
      await page.keyboard.press(`${MOD}+Shift+y`);
      await page.keyboard.press("Enter");
      await shortcutButton(page, "Toggle sidebar", REBOUND).waitFor();
    }, KEYBINDINGS);
  });

  it("cancels on Escape and keeps the old shortcut", async () => {
    await withPage(async (page) => {
      await shortcutButton(page, "Toggle sidebar").click();
      await page.keyboard.press(`${MOD}+Shift+u`);
      await page.keyboard.press("Escape");
      await shortcutButton(page, "Toggle sidebar", DEFAULT).waitFor();
      expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
    }, KEYBINDINGS);
  });

  it("binds Enter itself through its own button", async () => {
    await withPage(async (page) => {
      await shortcutButton(page, "Toggle sidebar").click();
      await page
        .getByRole("button", { name: "Use Enter as the shortcut for Toggle sidebar" })
        .click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await shortcutButton(page, "Toggle sidebar", /Enter|Return/).waitFor();
    }, KEYBINDINGS);
  });
});

describe("restoring defaults", () => {
  it("puts the theme and color scheme back with the other settings", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: "Use dark mode" }).click();
        await page.getByRole("button", { name: /^Use Grove theme/ }).click();
        await page.waitForFunction(() => document.documentElement.dataset.themeId === "grove");

        await page.getByRole("button", { name: "General", exact: true }).click();
        const restore = page.getByRole("button", { name: "Restore default settings" });
        await restore.click();

        await page.waitForFunction(() => document.documentElement.dataset.themeId === "quipu");
        expect(await restore.isDisabled()).toBe(true);
      },
      { path: "/settings/appearance" },
    );
  });
});
