import { describe, expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";

import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();

/** The sidebar's right edge, in viewport pixels: at or left of 0 once it has collapsed. */
async function sidebarRightEdge(page: Page): Promise<number> {
  const box = await page.getByRole("navigation", { name: "Documents" }).boundingBox();
  if (box === null) throw new Error("The sidebar has no box.");
  return box.x + box.width;
}

describe("command palette", () => {
  it("opens with its keybinding, and Toggle sidebar hides the sidebar", async () => {
    await withPage(async (page) => {
      expect(await sidebarRightEdge(page)).toBeGreaterThan(100);

      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.waitFor();
      await palette.getByPlaceholder("Search commands and settings...").fill("toggle sidebar");
      await palette.getByRole("option", { name: /Toggle sidebar/ }).click();

      await palette.waitFor({ state: "hidden" });
      await page.waitForFunction(() => {
        const nav = document.querySelector('[role="navigation"][aria-label="Documents"]');
        return nav !== null && nav.getBoundingClientRect().right <= 0;
      });
    });
  });

  it("lists the shell's commands and closes on Escape", async () => {
    await withPage(async (page) => {
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      // The list is virtualized, so each command is found through the search box.
      const search = palette.getByPlaceholder("Search commands and settings...");
      for (const title of [
        "Show all commands",
        "Show keyboard shortcuts",
        "Toggle sidebar",
        "Toggle right panel",
        "Show Inspector panel",
        "Show Source panel",
        "Open file…",
        "New board",
        "Change theme",
        "Toggle theme editor",
        "Open general settings",
        "Open appearance settings",
        "Open storage settings",
        "About Quipu",
      ]) {
        await search.fill(title);
        await palette.getByRole("option", { name: new RegExp(title) }).waitFor();
      }
      await search.fill("");
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
    });
  });

  it("opens About, a section of General, from the palette", async () => {
    await withPage(async (page) => {
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      // The list is virtualized and Settings sits below the document and canvas groups.
      await page.keyboard.type("About");
      await palette.getByRole("option", { name: /About Quipu/ }).click();
      await page.getByRole("heading", { name: "About", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Confirmations" }).waitFor();
    });
  });

  it("runs a submenu command and backs out with Backspace", async () => {
    await withPage(async (page) => {
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      const search = palette.getByPlaceholder("Search commands and settings...");
      await search.fill("change appearance");
      await palette.getByRole("option", { name: /Change appearance/ }).click();
      await palette.getByRole("option", { name: /^Dark/ }).waitFor();
      await page.keyboard.press("Backspace");
      await palette.getByRole("option", { name: /Toggle sidebar/ }).waitFor();
      await search.fill("change appearance");
      await palette.getByRole("option", { name: /Change appearance/ }).click();
      await palette.getByRole("option", { name: /^Dark/ }).click();

      await palette.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    });
  });
});

const DEFAULT_SIDEBAR_CHORD = /Ctrl\+B|⌘B/;
const REBOUND_SIDEBAR_CHORD = /Ctrl\+Shift\+Y|⇧⌘Y/;

/** The pill that shows a row's shortcut; clicking it starts recording a new one. */
function shortcutButton(page: Page, label: string, chord?: RegExp) {
  return page.getByRole("button", {
    name: chord
      ? new RegExp(`^Edit shortcut for ${label}: (${chord.source})`)
      : new RegExp(`^Edit shortcut for ${label}:`),
  });
}

async function rebindSidebarToggle(page: Page) {
  await shortcutButton(page, "Toggle sidebar").click();
  await page.keyboard.press(`${MOD}+Shift+y`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await shortcutButton(page, "Toggle sidebar", REBOUND_SIDEBAR_CHORD).waitFor();
}

describe("keybindings", () => {
  it("makes a rebound command work after a reload, and retires its old key", async () => {
    await withPage(
      async (page) => {
        await rebindSidebarToggle(page);
        await page.getByText("Custom").first().waitFor();

        await page.reload();
        await page.getByRole("navigation", { name: "Settings", exact: true }).waitFor();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("navigation", { name: "Documents" }).waitFor();

        // The old chord no longer toggles.
        await page.keyboard.press(`${MOD}+b`);
        expect(await sidebarRightEdge(page)).toBeGreaterThan(100);

        await page.keyboard.press(`${MOD}+Shift+y`);
        await page.waitForFunction(() => {
          const nav = document.querySelector('[role="navigation"][aria-label="Documents"]');
          return nav !== null && nav.getBoundingClientRect().right <= 0;
        });
      },
      { path: "/settings/keybindings" },
    );
  });

  it("restores a default from the row's actions menu", async () => {
    await withPage(
      async (page) => {
        await rebindSidebarToggle(page);
        await page.getByRole("button", { name: "Actions for Toggle sidebar" }).click();
        await page.getByRole("menuitem", { name: "Reset to default" }).click();
        await shortcutButton(page, "Toggle sidebar", DEFAULT_SIDEBAR_CHORD).waitFor();
        await page.getByText("Custom").waitFor({ state: "hidden" });
      },
      { path: "/settings/keybindings" },
    );
  });

  it("builds a when condition, saves it, and keeps it across a reload", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: "Edit when clause for Toggle sidebar" }).click();
        const expression = page.getByRole("textbox", { name: "When expression" });
        await expression.waitFor();
        expect(await expression.inputValue()).toBe("");

        await page.getByRole("button", { name: "Condition" }).first().click();
        expect(await expression.inputValue()).toBe("editableFocus");

        await page.getByRole("button", { name: "Negate editableFocus" }).click();
        expect(await expression.inputValue()).toBe("!editableFocus");

        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const saved = page.getByRole("button", {
          name: "Edit when clause for Toggle sidebar: Anywhere except text fields",
        });
        await saved.waitFor();

        await page.reload();
        await saved.waitFor();
      },
      { path: "/settings/keybindings" },
    );
  });

  it("flags a condition Quipu does not know, and refuses to save a broken expression", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: "Edit when clause for Toggle sidebar" }).click();
        const expression = page.getByRole("textbox", { name: "When expression" });
        await expression.fill("somethingElse");
        await page.getByLabel("Unknown condition: somethingElse").first().waitFor();

        await expression.fill("a &&");
        await page.getByText("Use variables with !, &&, ||, and parentheses.").waitFor();
        await page.keyboard.press("Escape");
        expect(await page.getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(
          true,
        );
      },
      { path: "/settings/keybindings" },
    );
  });

  it("adds a second binding to a command beside its default", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: "Add keybinding" }).click();
        await page.locator('[data-slot="select-trigger"]').filter({ hasText: "Command" }).click();
        await page.getByRole("option", { name: "Toggle sidebar" }).click();
        await page.getByRole("textbox", { name: "Keybinding for Toggle sidebar" }).click();
        await page.keyboard.press(`${MOD}+Shift+y`);
        await page.getByRole("button", { name: "Save", exact: true }).click();

        // Both the default and the new chord are listed for the command.
        await shortcutButton(page, "Toggle sidebar", DEFAULT_SIDEBAR_CHORD).waitFor();
        await shortcutButton(page, "Toggle sidebar", REBOUND_SIDEBAR_CHORD).waitFor();
      },
      { path: "/settings/keybindings" },
    );
  });

  it("offers Open keybindings.json only where there is a file", async () => {
    await withPage(
      async (page) => {
        // A browser keeps keybindings in local storage, so there is no file to open.
        await page.getByRole("button", { name: "Add keybinding" }).waitFor();
        expect(await page.getByRole("button", { name: "Open keybindings.json" }).count()).toBe(0);
      },
      { path: "/settings/keybindings" },
    );
  });

  it("says when a search finds nothing", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("searchbox", { name: "Search keybindings" }).fill("zzzz");
        await page.getByText("No keybindings match your search.").waitFor();
      },
      { path: "/settings/keybindings" },
    );
  });
});

describe("settings", () => {
  it("renders every page", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Confirmations" }).waitFor();

      await page.getByRole("button", { name: "Keybindings" }).click();
      await page.getByRole("heading", { name: "General", exact: true }).waitFor();
      await page.getByText("Toggle sidebar", { exact: true }).first().waitFor();

      await page.getByRole("button", { name: "Storage" }).click();
      await page.getByRole("heading", { name: "Storage" }).first().waitFor();
      await page.getByText("Settings and layout").waitFor();

      // About is a section of General, not a page of its own.
      await page.getByRole("button", { name: "General" }).click();
      await page.getByRole("heading", { name: "About", exact: true }).waitFor();
      await page.getByText(/Inca record made of/).waitFor();
      expect(await page.getByRole("button", { name: "About", exact: true }).count()).toBe(0);

      await page.getByRole("link", { name: /View notices/ }).click();
      await page.getByRole("heading", { name: "Third-party notices" }).waitFor();

      await page.getByRole("button", { name: "General" }).click();
      await page.getByRole("heading", { name: "Confirmations" }).waitFor();
    });
  });

  it("leaves with Escape", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Confirmations" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("navigation", { name: "Documents" }).waitFor();
    });
  });

  it("keeps a changed setting across a reload", async () => {
    await withPage(
      async (page) => {
        const toggle = page.getByRole("switch", { name: "Confirm before clearing stored data" });
        await toggle.waitFor();
        expect(await toggle.getAttribute("aria-checked")).toBe("true");
        await toggle.click();
        await page.getByRole("button", { name: "Restore default settings" }).waitFor();

        await page.reload();
        const reloaded = page.getByRole("switch", { name: "Confirm before clearing stored data" });
        await reloaded.waitFor();
        expect(await reloaded.getAttribute("aria-checked")).toBe("false");
      },
      { path: "/settings/general" },
    );
  });

  it("finds a setting from the settings search", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("combobox", { name: "Search settings" }).fill("khipu");
        await page.getByRole("option", { name: /About the name Quipu/ }).click();
        const name = page.locator("#about-name");
        await name.waitFor();
        await page.waitForFunction(() => {
          const top = document.getElementById("about-name")?.getBoundingClientRect().top ?? -1;
          return top >= 0 && top < window.innerHeight;
        });
      },
      { path: "/settings/general" },
    );
  });
});

describe("right panel", () => {
  it("switches between its two tabs and shows each one's empty state", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      await page.getByRole("tab", { name: "Inspector", selected: true }).waitFor();
      await page.getByText("Nothing to inspect").waitFor();

      for (const [tab, message] of [
        ["Source", "No source to show"],
        ["Inspector", "Nothing to inspect"],
      ] as const) {
        await page.getByRole("tab", { name: tab }).click();
        await page.getByRole("tab", { name: tab, selected: true }).waitFor();
        await page.getByText(message).waitFor();
      }
      expect(await page.getByRole("tab").allTextContents()).toEqual(["Inspector", "Source"]);
    });
  });

  it("remembers its tab and open state across a reload", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      await page.getByRole("tab", { name: "Source" }).click();
      await page.reload();
      await page.getByRole("tab", { name: "Source", selected: true }).waitFor();
    });
  });
});

describe("tooltips", () => {
  it("shows a tooltip on hover, and no element carries a native title", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Toggle right panel" }).hover();
      await page
        .locator('[data-slot="tooltip-popup"]')
        .filter({ hasText: "Toggle right panel" })
        .waitFor();

      await page.getByRole("button", { name: "Toggle right panel" }).click();
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("heading", { name: "Confirmations" }).waitFor();
      const titled = await page.evaluate(() =>
        [...document.querySelectorAll("[title]")].map((element) => element.outerHTML.slice(0, 120)),
      );
      expect(titled).toEqual([]);
    });
  });
});

describe("storage", () => {
  it("asks before clearing, and clears nothing when cancelled", async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => window.localStorage.setItem("quipu:probe", "kept"));
        await page.getByRole("button", { name: "Clear caches" }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByText("Clear caches?").waitFor();
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await page.evaluate(() => window.localStorage.getItem("quipu:probe"))).toBe("kept");
      },
      { path: "/settings/storage" },
    );
  });

  it("does not confirm on Enter: it only activates the focused Cancel", async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => window.localStorage.setItem("quipu:probe", "kept"));
        await page.getByRole("button", { name: "Clear settings and layout" }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByText("Clear settings and layout?").waitFor();

        // The dialog has no Enter handler: Enter presses the focused button, and
        // Cancel is the first one, so it closes the dialog without confirming.
        await dialog.getByRole("button", { name: "Cancel" }).waitFor();
        await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "hidden" });
        expect(await page.evaluate(() => window.localStorage.getItem("quipu:probe"))).toBe("kept");
      },
      { path: "/settings/storage" },
    );
  });

  it("clears Quipu's saved settings after confirmation", async () => {
    await withPage(
      async (page) => {
        await page.evaluate(() => window.localStorage.setItem("quipu:probe", "gone"));
        await page.getByRole("button", { name: "Clear settings and layout" }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByText("Clear settings and layout?").waitFor();
        await dialog.getByRole("button", { name: "Clear", exact: true }).click();
        await page.waitForFunction(() => window.localStorage.getItem("quipu:probe") === null);
      },
      { path: "/settings/storage" },
    );
  });
});

describe("sidebar", () => {
  it("shows the empty states for documents and boards, and collapses a shelf", async () => {
    await withPage(async (page) => {
      await page.getByText("No documents yet").waitFor();
      await page.getByText("No boards yet").waitFor();

      // Collapsed by keyboard as by mouse, an empty shelf keeps its plain name.
      await page.getByRole("button", { name: "Boards", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByText("No boards yet").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Boards", exact: true, expanded: false }).waitFor();
      await page.getByRole("button", { name: "Documents", exact: true }).click();
      await page.getByText("No documents yet").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Documents", exact: true, expanded: false }).waitFor();
    });
  });

  it("offers a bordered add action in each empty shelf", async () => {
    await withPage(async (page) => {
      // Documents: the palette, which lists Open file… and the recents.
      await page.getByRole("button", { name: "Open document", exact: true }).click();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.waitFor();
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
      // Boards: a new board, which the shelf then lists.
      await page.getByRole("button", { name: "New board", exact: true }).click();
      await page.getByRole("application", { name: "Board canvas" }).waitFor();
      await page
        .getByTestId("sidebar-boards-shelf")
        .getByRole("link", { name: "Board 1" })
        .waitFor();
    });
  });

  it("keeps its width across a reload but not whether it is open", async () => {
    await withPage(async (page) => {
      const rail = page.getByRole("button", { name: "Resize Sidebar" });
      const box = await rail.boundingBox();
      if (box === null) throw new Error("The rail has no box.");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      const widened = await sidebarRightEdge(page);
      expect(widened).toBeGreaterThan(300);

      await page.keyboard.press(`${MOD}+b`);
      await page.reload();
      await page.getByRole("navigation", { name: "Documents" }).waitFor();
      // Open again after the reload, at the width the drag left.
      expect(Math.abs((await sidebarRightEdge(page)) - widened)).toBeLessThan(2);
    });
  });
});
