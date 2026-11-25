import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import type { Locator, Page } from "playwright-core";

import { MOD, useBrowser } from "./harness";
import { OPEN_VSX_HOSTS, stubOpenVsx } from "./openVsxFixtures";

const withPage = useBrowser();

/** Turns the theme editor's advanced colors on, whichever state the draft opened in. */
async function showAdvancedColors(editor: Locator): Promise<void> {
  const advanced = editor.getByRole("switch", { name: "Use advanced theme colors" });
  if ((await advanced.getAttribute("aria-checked")) !== "true") await advanced.click();
}

const CORD_SUNRISE_PATH = NodePath.join(
  import.meta.dirname,
  "../src/testFixtures/t3-cord-sunrise.theme.json",
);
const APPEARANCE = { path: "/settings/appearance" };
// The tests that search for or install a theme reach Open VSX, answered from fixtures.
const THEME_SEARCH = { ...APPEARANCE, externalHosts: OPEN_VSX_HOSTS };

/** What the user sees of a palette: the sidebar and page surfaces, as painted. */
async function paintedSurfaces(page: Page): Promise<string> {
  return page.evaluate(() => {
    const paint = (selector: string) => {
      const element = document.querySelector(selector);
      return element === null ? "missing" : getComputedStyle(element).backgroundColor;
    };
    return [paint("[data-app-sidebar]"), paint('[data-slot="sidebar-inset"]')].join(" | ");
  });
}

async function chooseThemeFile(page: Page, filePath: string): Promise<void> {
  await page.getByRole("button", { name: "Add theme" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a theme" });
  await dialog.waitFor();
  await dialog.locator('input[type="file"]').setInputFiles(filePath);
  await dialog.getByRole("button", { name: "Add theme" }).click();
}

describe("palettes", () => {
  it("repaints the app when a built-in palette is picked, and keeps it after a reload", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      const painted = new Map<string, string>();
      // A new install starts on the Quipu palette.
      painted.set("Quipu", await paintedSurfaces(page));

      let previous = painted.get("Quipu")!;
      for (const label of [
        "Graphite",
        "Orchid",
        "Grove",
        "Ocean",
        "Ember",
        "High Contrast",
        "Iris",
      ]) {
        await page.getByRole("button", { name: new RegExp(`^Use ${label} theme`) }).click();
        await page.waitForFunction((from) => {
          const paint = (selector: string) => {
            const element = document.querySelector(selector);
            return element === null ? "missing" : getComputedStyle(element).backgroundColor;
          };
          return (
            [paint("[data-app-sidebar]"), paint('[data-slot="sidebar-inset"]')].join(" | ") !== from
          );
        }, previous);
        previous = await paintedSurfaces(page);
        painted.set(label, previous);
      }

      expect(new Set(painted.values()).size).toBe(painted.size);

      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      expect(await paintedSurfaces(page)).toBe(painted.get("Iris"));
    }, APPEARANCE);
  });

  it("switches the whole app between light and dark", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      const light = await paintedSurfaces(page);
      await page.getByRole("button", { name: "Use dark mode" }).click();
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      expect(await paintedSurfaces(page)).not.toBe(light);
    }, APPEARANCE);
  });
});

describe("theme files", () => {
  it("adds a card for an imported theme file and exports the same bytes T3 Code wrote", async () => {
    await withPage(async (page) => {
      const original = NodeFS.readFileSync(CORD_SUNRISE_PATH);

      await chooseThemeFile(page, CORD_SUNRISE_PATH);
      const card = page.locator('[data-theme-library-card="cord-sunrise"]');
      await card.waitFor();
      await card.getByRole("button", { name: "Use Cord Sunrise theme" }).waitFor();

      const downloadPromise = page.waitForEvent("download");
      await card.getByRole("button", { name: "Export Cord Sunrise" }).click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe("cord-sunrise.json");
      const path = await download.path();
      expect(NodeFS.readFileSync(path).equals(original)).toBe(true);
    }, APPEARANCE);
  });

  it("rejects a file that is not a theme and says why", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Add theme" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a theme" });
      await dialog.waitFor();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "not-a-theme.json",
        mimeType: "application/json",
        buffer: Buffer.from('{"hello":"world"}'),
      });
      await dialog.getByRole("button", { name: "Add theme" }).click();
      const alert = dialog.getByRole("alert").first();
      await alert.waitFor();
      expect(await alert.textContent()).toContain(
        "This theme file uses an unsupported version. Expected 1.",
      );
      expect(await page.locator("[data-theme-library-card]").count()).toBe(8);
    }, APPEARANCE);
  });

  it("duplicates a theme card into the editor and removes a custom theme card", async () => {
    await withPage(async (page) => {
      await chooseThemeFile(page, CORD_SUNRISE_PATH);
      const card = page.locator('[data-theme-library-card="cord-sunrise"]');
      await card.waitFor();

      await card.getByRole("button", { name: "Duplicate Cord Sunrise" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await editor.waitFor();
      expect(await editor.getByPlaceholder("e.g. Aurora").inputValue()).toBe("Cord Sunrise copy");
      await editor.getByRole("button", { name: "Create theme" }).click();

      const copyCard = page.locator('[data-theme-library-card="cord-sunrise-copy"]');
      await copyCard.waitFor();
      await editor.waitFor({ state: "detached" });

      await copyCard.getByRole("button", { name: "Remove Cord Sunrise copy" }).click();
      const confirmDialog = page.getByRole("alertdialog", { name: "Remove “Cord Sunrise copy”?" });
      await confirmDialog.waitFor();
      await confirmDialog.getByRole("button", { name: "Remove theme" }).click();
      await copyCard.waitFor({ state: "detached" });
    }, APPEARANCE);
  });
});

describe("theme editor", () => {
  it("picks the palette role of the element that is clicked", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await editor.waitFor();
      await showAdvancedColors(editor);
      await editor.getByRole("button", { name: "Inspect app colors" }).click();
      await editor.getByText("Select an element").waitFor();

      // The sidebar's own surface, away from its controls.
      await page.locator("[data-app-sidebar]").click({ position: { x: 20, y: 500 } });

      await editor.getByText(/^Sidebar background · \d+ uses?$/).waitFor();
      await editor.getByRole("button", { name: "Inspect app colors" }).waitFor();
    }, APPEARANCE);
  });

  it("narrows the color list with the filter", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await showAdvancedColors(editor);
      await editor.getByText("Foundation", { exact: true }).waitFor();

      await editor.getByRole("textbox", { name: "Filter colors" }).fill("sidebar");

      await editor.getByText("Sidebar background").waitFor();
      expect(await editor.getByText("Surface", { exact: true }).count()).toBe(0);
    }, APPEARANCE);
  });

  it("reopens a saved theme with the colors that were saved", async () => {
    await withPage(async (page) => {
      await chooseThemeFile(page, CORD_SUNRISE_PATH);
      const card = page.locator('[data-theme-library-card="cord-sunrise"]');
      await card.waitFor();

      await card.getByRole("button", { name: "Edit Cord Sunrise" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await editor.getByRole("switch", { name: "Use advanced theme colors" }).click();
      const background = editor.getByRole("textbox", { name: "Background hex value", exact: true });
      await background.fill("#102a43");
      await background.press("Enter");
      await editor.getByRole("button", { name: "Save changes" }).click();
      await editor.waitFor({ state: "detached" });

      await card.getByRole("button", { name: "Edit Cord Sunrise" }).click();
      await editor.getByRole("switch", { name: "Use advanced theme colors" }).click();
      expect(
        await editor
          .getByRole("textbox", { name: "Background hex value", exact: true })
          .inputValue(),
      ).toBe("#102a43");
    }, APPEARANCE);
  });

  it("saves a created theme as a card and applies it", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await editor.getByPlaceholder("e.g. Aurora").fill("Harbor");
      await editor.getByRole("button", { name: "Create theme" }).click();

      const card = page.locator("[data-theme-library-card]", { hasText: "Harbor" });
      await card.waitFor();
      await editor.waitFor({ state: "detached" });
      await card
        .getByRole("button", { name: /^Use Harbor/, pressed: true })
        .first()
        .waitFor();
      await card.getByRole("button", { name: "Edit Harbor" }).waitFor();
    }, APPEARANCE);
  });
});

describe("Add a theme", () => {
  it("searches Open VSX, offers four popular picks and sorts, and installs the recorded extension", async () => {
    await withPage(async (page, context) => {
      const recording = await stubOpenVsx(context);
      await page.getByRole("button", { name: "Add theme" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a theme" });
      await dialog.waitFor();

      for (const pick of ["Dracula", "Catppuccin", "Nord", "Tokyo Night"]) {
        await dialog.getByRole("button", { name: pick, exact: true }).waitFor();
      }

      await dialog.getByRole("button", { name: "Dracula", exact: true }).click();
      await dialog.getByRole("searchbox", { name: "Search Open VSX themes" }).press("Enter");
      await dialog.getByRole("heading", { name: "Dracula Theme Official" }).waitFor();

      await dialog.getByRole("combobox", { name: "Sort themes" }).click();
      await page.getByRole("option", { name: "Newest" }).click();
      await dialog.getByRole("heading", { name: "Dracula Theme Official" }).waitFor();
      expect(recording.searches.map((search) => search.get("sortBy"))).toEqual([
        "downloadCount",
        "timestamp",
      ]);

      await dialog.getByRole("button", { name: "Install Dracula Theme Official" }).click();
      await page.locator("[data-theme-library-card]", { hasText: "Dracula" }).first().waitFor();
      await page
        .getByRole("button", { name: /^Use .*Dracula Theme/ })
        .first()
        .waitFor();

      const hosts = new Set(recording.externalRequests.map((request) => request.host));
      expect(hosts.size).toBeGreaterThan(0);
      for (const host of hosts) expect(OPEN_VSX_HOSTS).toContain(host);
    }, THEME_SEARCH);
  });

  it("talks to no outside host until the dialog is used", async () => {
    await withPage(async (page, context) => {
      const recording = await stubOpenVsx(context);
      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      await page.getByRole("button", { name: "Add theme" }).click();
      await page.getByRole("dialog", { name: "Add a theme" }).waitFor();

      expect(recording.externalRequests).toEqual([]);
    }, APPEARANCE);
  });
});

describe("motion", () => {
  it("sets the duration panels animate with from the slider", async () => {
    await withPage(async (page) => {
      const slider = page.getByRole("slider", { name: "Panel animation duration" });
      await slider.focus();
      await page.keyboard.press("End");
      await page.getByText("400 ms").waitFor();

      await page.waitForFunction(() => {
        const gap = document.querySelector('[data-slot="sidebar-gap"]');
        return gap !== null && getComputedStyle(gap).transitionDuration === "0.4s";
      });

      for (let step = 0; step < 8; step += 1) await page.keyboard.press("ArrowLeft");
      await page.getByText("200 ms").waitFor();
      await page.waitForFunction(() => {
        const gap = document.querySelector('[data-slot="sidebar-gap"]');
        return gap !== null && getComputedStyle(gap).transitionDuration === "0.2s";
      });
    }, APPEARANCE);
  });
});

describe("typography", () => {
  it("resizes the interface and code previews with the size controls", async () => {
    await withPage(async (page) => {
      const interfacePreview = page.getByRole("group", { name: "Interface font preview" });
      const sampleSize = () =>
        interfacePreview
          .getByText("Settings and panels")
          .evaluate((element) => getComputedStyle(element).fontSize);
      const before = await sampleSize();

      await page.getByRole("combobox", { name: "Interface font size" }).click();
      await page.getByRole("option", { name: "20 px" }).click();
      await page.waitForFunction((previous) => {
        const element = [...document.querySelectorAll("p")].find(
          (candidate) => candidate.textContent === "Settings and panels",
        );
        return element !== undefined && getComputedStyle(element).fontSize !== previous;
      }, before);
      expect(parseFloat(await sampleSize())).toBeGreaterThan(parseFloat(before));

      const codePreview = page.getByRole("group", { name: "Code font preview" });
      const codeSize = () => codePreview.evaluate((element) => getComputedStyle(element).fontSize);
      await codePreview.waitFor();
      const codeBefore = await codeSize();
      await page.getByRole("combobox", { name: "Code font size" }).click();
      await page.getByRole("option", { name: "18 px" }).click();
      await page.waitForFunction((previous) => {
        const preview = document.querySelector('[role="group"][aria-label="Code font preview"]');
        return preview !== null && getComputedStyle(preview).fontSize !== previous;
      }, codeBefore);
      expect(parseFloat(await codeSize())).toBeGreaterThan(parseFloat(codeBefore));
    }, APPEARANCE);
  });

  it("applies a font family typed into the interface font row to the app and its preview", async () => {
    await withPage(async (page) => {
      const family = page.getByRole("textbox", { name: "Interface font family" });
      await family.fill("serif");
      await family.press("Enter");
      await page.waitForFunction(() =>
        getComputedStyle(document.body).fontFamily.startsWith("serif"),
      );
      const previewFamily = await page
        .getByRole("group", { name: "Interface font preview" })
        .getByText("Settings and panels")
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(previewFamily.startsWith("serif")).toBe(true);

      await page.reload();
      await page.getByRole("textbox", { name: "Interface font family" }).waitFor();
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(
        /^serif/,
      );
    }, APPEARANCE);
  });
});

describe("contrast and glass", () => {
  it("moves the contrast and glass opacity sliders and shows the value", async () => {
    await withPage(async (page) => {
      const contrast = page.getByRole("slider", { name: "Contrast" });
      await contrast.focus();
      await page.keyboard.press("End");
      await page.getByText("200%").waitFor();
      await page.waitForFunction(
        () =>
          document.documentElement.style.getPropertyValue("--appearance-contrast-boost") === "100%",
      );

      const glass = page.getByRole("slider", { name: "Glass opacity" });
      await glass.focus();
      await page.keyboard.press("End");
      await page.getByText("100%").first().waitFor();
      await page.waitForFunction(
        () => document.documentElement.style.getPropertyValue("--glass-opacity") === "100%",
      );
    }, APPEARANCE);
  });
});

describe("palette commands and chords", () => {
  it("opens the theme list from its chord and applies the pick", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      const before = await paintedSurfaces(page);

      await page.keyboard.press(`${MOD}+Alt+a`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("option", { name: /^Ember/ }).click();
      await palette.waitFor({ state: "hidden" });

      await page.getByRole("button", { name: /^Use Ember theme/ }).waitFor();
      expect(await paintedSurfaces(page)).not.toBe(before);
    }, APPEARANCE);
  });

  it("cycles the appearance with its chord and names the result", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      await page.keyboard.press(`${MOD}+Alt+Shift+a`);
      await page.getByText("Appearance: Dark").waitFor();
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    }, APPEARANCE);
  });

  it("toggles the theme editor from its chord and from the palette", async () => {
    await withPage(async (page) => {
      await page.keyboard.press(`${MOD}+Alt+Shift+t`);
      await page.locator("[data-theme-editor-panel]").waitFor();
      await page.keyboard.press(`${MOD}+Alt+Shift+t`);
      await page.locator("[data-theme-editor-panel]").waitFor({ state: "detached" });

      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      // The list is virtualized and Appearance sits below the document and canvas groups.
      await palette.getByRole("combobox").fill("customize");
      await palette.getByRole("option", { name: /Toggle theme editor/ }).click();
      await page.locator("[data-theme-editor-panel]").waitFor();
    }, APPEARANCE);
  });
});
