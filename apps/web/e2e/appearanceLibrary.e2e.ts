import { describe, expect, it } from "vite-plus/test";
import type { Locator, Page } from "playwright-core";

import { MOD, pasteText, useBrowser } from "./harness";
import { OPEN_VSX_HOSTS, stubOpenVsx } from "./openVsxFixtures";

const withPage = useBrowser();

/** Turns the theme editor's advanced colors on, whichever state the draft opened in. */
async function showAdvancedColors(editor: Locator): Promise<void> {
  const advanced = editor.getByRole("switch", { name: "Use advanced theme colors" });
  if ((await advanced.getAttribute("aria-checked")) !== "true") await advanced.click();
}

const APPEARANCE = { path: "/settings/appearance" };
// The tests that search for or install a theme reach Open VSX, answered from fixtures.
const THEME_SEARCH = { ...APPEARANCE, externalHosts: OPEN_VSX_HOSTS };

function themeId(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.themeId ?? null);
}

function isDark(page: Page) {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

function toastTitled(page: Page, title: string) {
  return page.locator('[data-slot="toast-title"]', { hasText: title });
}

describe("built-in palettes", () => {
  it("dresses a new install in the Graphite look, following the system", async () => {
    await withPage(async (page) => {
      expect(await themeId(page)).toBeNull();
      const graphite = page.locator('[data-theme-library-card="default"]');
      await graphite
        .getByRole("button", { name: "Use Graphite for light mode", pressed: true })
        .waitFor();
      await graphite
        .getByRole("button", { name: "Use Graphite for dark mode", pressed: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Follow the system appearance", pressed: true })
        .waitFor();
    }, APPEARANCE);
  });

  it("names every palette for its look, and no other product", async () => {
    await withPage(async (page) => {
      const titles = await page
        .locator("[data-theme-library-card]")
        .getByRole("button", { name: /^Use .* theme/ })
        .allTextContents();
      expect(titles).toEqual([
        "Graphite",
        "Orchid",
        "Grove",
        "Ocean",
        "Ember",
        "Iris",
        "Quipu",
        "High Contrast",
      ]);
      expect(await page.locator("body").innerText()).not.toMatch(/\bT3\b/);
    }, APPEARANCE);
  });

  it("starts on a palette chosen earlier", async () => {
    await withPage(
      async (page) => {
        expect(await themeId(page)).toBe("orchid");
        await page
          .locator('[data-theme-library-card="orchid"]')
          .getByRole("button", { name: "Use Orchid for light mode", pressed: true })
          .waitFor();
      },
      {
        ...APPEARANCE,
        storage: { "quipu:theme": "orchid", "quipu:theme-appearance-mode": "light" },
      },
    );
  });

  it("says what the add-theme dialog accepts in plain words", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Add theme" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a theme" });
      await dialog
        .getByText("Drop a theme file (.json). Quipu, VS Code and T3 Code theme files work.")
        .waitFor();
      // The compatibility sentence is the only place T3 Code is named.
      expect((await dialog.innerText()).match(/T3/g)).toHaveLength(1);
    }, APPEARANCE);
  });

  it("lists no terminal colors in the theme editor", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await showAdvancedColors(editor);
      await editor.getByText("Sidebar background").waitFor();
      expect(await editor.innerText()).not.toMatch(/terminal/i);
      await editor.getByRole("textbox", { name: "Filter colors" }).fill("terminal");
      await editor.getByText("No matches.").waitFor();
    }, APPEARANCE);
  });
});

/** Page controls and theme cards the open editor covers, at the current scroll position. */
function controlsUnderEditor(page: Page) {
  return page.evaluate(() => {
    const editor = document.querySelector("[data-theme-editor-panel]")!.getBoundingClientRect();
    const page = document.querySelector('[data-slot="sidebar-inset"]')!;
    const targets = page.querySelectorAll(
      "button, input, [role=slider], [role=combobox], [data-theme-library-card]",
    );
    return [...targets].flatMap((target) => {
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return [];
      const overlaps =
        box.left < editor.right &&
        box.right > editor.left &&
        box.top < editor.bottom &&
        box.bottom > editor.top;
      return overlaps
        ? [target.getAttribute("aria-label") ?? target.textContent?.trim().slice(0, 40) ?? ""]
        : [];
    });
  });
}

describe("theme editor placement", () => {
  for (const width of [1600, 1280]) {
    it(`leaves every control and theme card uncovered at ${width} px`, async () => {
      await withPage(async (page) => {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("button", { name: "Create theme" }).click();
        await page.locator("[data-theme-editor-panel]").waitFor();
        expect(await controlsUnderEditor(page)).toEqual([]);

        await page
          .locator("[data-settings-page-scroll]")
          .evaluate((scroller) => scroller.scrollTo(0, scroller.scrollHeight));
        expect(await controlsUnderEditor(page)).toEqual([]);
      }, APPEARANCE);
    });
  }

  it("covers a narrow window whole, with its close button in reach", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 900, height: 800 });
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await editor.waitFor();
      const box = (await editor.boundingBox())!;
      expect(box.x).toBeLessThanOrEqual(8);
      expect(box.x + box.width).toBeGreaterThanOrEqual(892);
      await editor.getByRole("button", { name: /close/i }).first().click();
      await editor.waitFor({ state: "detached" });
    }, APPEARANCE);
  });

  it("gives the page its width back when the editor closes", async () => {
    await withPage(async (page) => {
      const inset = page.locator('[data-slot="sidebar-inset"]');
      const full = (await inset.boundingBox())!.width;
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await editor.waitFor();
      expect((await inset.boundingBox())!.width).toBeLessThan(full);
      await editor.getByRole("button", { name: "Cancel" }).click();
      await editor.waitFor({ state: "detached" });
      expect((await inset.boundingBox())!.width).toBe(full);
    }, APPEARANCE);
  });
});

describe("theme editor roles", () => {
  it("offers only colors Quipu paints, named for what they paint", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Create theme" }).click();
      const editor = page.locator("[data-theme-editor-panel]");
      await showAdvancedColors(editor);
      await editor.getByText("Sidebar background").waitFor();
      const text = await editor.innerText();
      for (const label of [
        "Map cards and panels",
        "Text and map edges",
        "Buttons, selection and drawing ink",
        "Search hits",
        "Current hit",
        "Source view",
      ]) {
        expect(text).toContain(label);
      }
      expect(text).not.toMatch(/message|terminal|toolbar|raised surface|update/i);
    }, APPEARANCE);
  });

  it("paints tree search hits with the theme's search colors", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: /^Use Grove theme/ }).click();
        await page.waitForFunction(() => document.documentElement.dataset.themeId === "grove");
        await page.goto(new URL("/", page.url()).href);
        await page.locator("[data-app-sidebar]").waitFor();
        await pasteText(page, JSON.stringify({ alpha: "find me", beta: "find me too" }, null, 2));
        await page.getByRole("tree", { name: "Document tree" }).waitFor();
        await page.keyboard.press(`${MOD}+f`);
        const find = page.getByLabel("Find in document");
        await find.fill("find me");
        await find.press("Enter");
        await page.locator("[data-search-mark]").first().waitFor();

        const paints = await page.evaluate(() => {
          const resolve = (variable: string) => {
            const probe = document.createElement("div");
            probe.style.backgroundColor = `var(${variable})`;
            document.body.append(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
          };
          const marks = [...document.querySelectorAll("[data-search-mark]")].map(
            (mark) => getComputedStyle(mark).backgroundColor,
          );
          return {
            marks,
            hit: resolve("--app-theme-search-match-background"),
            current: resolve("--app-theme-search-match-active-background"),
          };
        });
        expect(paints.marks).toContain(paints.current);
        expect(paints.marks).toContain(paints.hit);
      },
      { ...APPEARANCE, storage: { "quipu:document-view": "tree" } },
    );
  });
});

describe("font previews", () => {
  it("shows a JSON sample in the code font, colored like the source view", async () => {
    await withPage(async (page) => {
      const preview = page.getByRole("group", { name: "Code font preview" });
      await preview.waitFor();
      expect(await preview.innerText()).toContain('"name": "quipu"');
      const paints = await preview.evaluate((element) => {
        const key = [...element.querySelectorAll("span")].find(
          (span) => span.textContent === "name",
        );
        const probe = document.createElement("span");
        probe.style.color = "var(--syntax-key-1)";
        document.body.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return {
          family: getComputedStyle(element).fontFamily,
          key: key ? getComputedStyle(key).color : null,
          expected,
        };
      });
      expect(paints.key).toBe(paints.expected);
      expect(paints.family.length).toBeGreaterThan(0);
    }, APPEARANCE);
  });
});

describe("color scheme miniatures", () => {
  it("draw Quipu's sidebar and map in the active palette", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      await page.getByRole("button", { name: /^Use Ocean theme/ }).click();
      await page.waitForFunction(() => document.documentElement.dataset.themeId === "ocean");
      const light = page
        .getByRole("button", { name: "Use light mode" })
        .locator("[data-theme-wireframe] svg");
      const drawing = await light.evaluate((svg) => {
        const root = getComputedStyle(document.documentElement);
        const role = (name: string) => root.getPropertyValue(`--app-theme-${name}`).trim();
        const fills = new Set(
          [...svg.querySelectorAll("[fill]")].map((node) => node.getAttribute("fill")),
        );
        return {
          edges: svg.querySelectorAll("path").length,
          cards: svg.querySelectorAll('rect[rx="3"][stroke]').length,
          paintsCanvas: fills.has(role("canvas")),
          paintsSidebar: fills.has(role("sidebar")),
          paintsCards: fills.has(role("surface")),
        };
      });
      expect(drawing).toEqual({
        edges: 2,
        cards: 3,
        paintsCanvas: true,
        paintsSidebar: true,
        paintsCards: true,
      });
    }, APPEARANCE);
  });
});

describe("light and dark swatches", () => {
  it("says where a dark pick went while the scheme is light, and offers to show it", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      await page
        .locator('[data-theme-library-card="grove"]')
        .getByRole("button", { name: "Use Grove for dark mode" })
        .click();

      await toastTitled(page, "Grove is now your dark theme").waitFor();
      expect(await isDark(page)).toBe(false);

      await page.getByRole("button", { name: "Switch to Dark" }).click();
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains("dark") &&
          document.documentElement.dataset.themeId === "grove",
      );
    }, APPEARANCE);
  });

  it("applies a pick for the showing appearance without a note", async () => {
    await withPage(async (page) => {
      await page.getByRole("button", { name: "Use light mode" }).click();
      await page
        .locator('[data-theme-library-card="ocean"]')
        .getByRole("button", { name: "Use Ocean for light mode" })
        .click();
      await page.waitForFunction(() => document.documentElement.dataset.themeId === "ocean");
      expect(await toastTitled(page, "Ocean is now").count()).toBe(0);
    }, APPEARANCE);
  });
});

describe("Open VSX themes", () => {
  it("costs one search while typing, checks only cards on screen, and shows their icons", async () => {
    await withPage(async (page, context) => {
      const recording = await stubOpenVsx(context);
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.getByRole("button", { name: "Add theme" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a theme" });
      await dialog
        .getByRole("searchbox", { name: "Search Open VSX themes" })
        .pressSequentially("dracula", { delay: 40 });

      const card = dialog.locator("article", {
        has: page.getByRole("heading", { name: "Dracula Theme Official" }),
      });
      await card.getByRole("button", { name: "Install Dracula Theme Official" }).waitFor();
      const icon = card.locator("img[data-theme-extension-icon]");
      await icon.waitFor();
      await icon.evaluate(
        (image: HTMLImageElement) =>
          image.complete ||
          new Promise((resolve) => image.addEventListener("load", resolve, { once: true })),
      );
      expect(await icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);

      const cards = await dialog.locator("article").count();
      const paths = recording.externalRequests.map((request) => new URL(request.url).pathname);
      expect(recording.searches.map((search) => search.get("query"))).toEqual(["dracula"]);
      expect(paths.filter((path) => path.endsWith(".vsix"))).toEqual([]);
      const details = paths.filter((path) => /^\/api\/(?!-\/)[^/]+\/[^/]+$/.test(path));
      expect(details.length).toBeGreaterThan(0);
      expect(details.length).toBeLessThan(cards);
      // What the cross-origin isolation policy reports for an image it blocks.
      expect(consoleErrors.filter((text) => /BLOCKED_BY_RESPONSE/.test(text))).toEqual([]);
    }, THEME_SEARCH);
  });

  it("names an installed extension's variants and offers to use it", async () => {
    await withPage(async (page, context) => {
      await stubOpenVsx(context);
      await page.getByRole("button", { name: "Use light mode" }).click();
      await page.getByRole("button", { name: "Add theme" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a theme" });
      await dialog.getByRole("button", { name: "Dracula", exact: true }).click();
      await dialog.getByRole("button", { name: "Install Dracula Theme Official" }).click();

      await toastTitled(page, "Dracula Theme Official added").waitFor();
      await page.getByText("Variants: Dracula Theme, Soft. Use it now?").waitFor();
      await page.getByRole("button", { name: "Use it" }).click();
      await toastTitled(page, "Dracula Theme Official is now your dark theme").waitFor();

      const card = page.locator("[data-theme-library-card]", {
        hasText: "Dracula Theme Official",
      });
      await card
        .getByRole("button", { name: "Use Dracula Theme for dark mode, currently active" })
        .waitFor({ state: "attached" });
      await card
        .getByRole("button", { name: "Use Soft for dark mode" })
        .waitFor({ state: "attached" });
      const title = card.getByRole("button", { name: /^Use Dracula Theme Official, / });
      expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await title.innerText()).toBe("Dracula Theme Official");

      // Under the swatch: the variant's own name in full, not the title again.
      const label = card.locator("[data-theme-variant-label]");
      expect(await label.allInnerTexts()).toEqual(["Dracula Theme"]);
      expect(
        await label.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.scrollHeight <= element.clientHeight,
        ),
      ).toBe(true);
      expect(await card.innerText()).not.toMatch(/\+1|…/);
    }, THEME_SEARCH);
  });
});
