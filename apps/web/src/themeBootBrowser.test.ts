import { chromium, type Browser, type Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startDevServer } from "./testing/devServer";
import { GROVE_THEME, QUIPU_THEME, getThemeColorsForMode } from "./themePalette";

// A real Chromium paints the real index.html and index.css. The theme colors
// come from the shipped palettes, so a drift in the boot script, the
// stylesheet mapping, or the runtime apply step shows up as a wrong color.

let origin: string;
let server: ViteDevServer;
let browser: Browser;

// The hook bundles the app's dependencies when this file's cache is cold.
beforeAll(async () => {
  ({ server, origin } = await startDevServer("theme-boot", { hmr: false }));
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openWithStorage(
  storage: Readonly<Record<string, string>>,
  colorScheme: "light" | "dark",
  options: { readonly blockApp: boolean },
): Promise<Page> {
  const context = await browser.newContext({ colorScheme });
  const page = await context.newPage();
  await page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
  }, storage);
  if (options.blockApp) {
    // Stop every module request: only the inline script in index.html can
    // paint, which is exactly the no-flash guarantee.
    await page.route(
      (url) => url.pathname.startsWith("/src/") || url.pathname.startsWith("/@"),
      (route) => route.abort(),
    );
  }
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return page;
}

async function paintedColor(page: Page, selector: string, color: string): Promise<string> {
  return page.evaluate(
    ({ selector, color }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`No ${selector} in the page`);
      const probe = document.createElement("div");
      probe.style.backgroundColor = color;
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return `${getComputedStyle(element).backgroundColor}|${expected}`;
    },
    { selector, color },
  );
}

function expectPaints(painted: string): void {
  const [actual, expected] = painted.split("|");
  expect(actual).toBe(expected);
}

describe("the active theme at boot", () => {
  it("paints Quipu's dark half before any app code runs when the system is dark", async () => {
    const page = await openWithStorage(
      { "quipu:theme": "quipu", "quipu:theme-appearance-mode": "system" },
      "dark",
      { blockApp: true },
    );
    const dark = getThemeColorsForMode(QUIPU_THEME, "dark")!;

    expect(await page.evaluate(() => document.documentElement.dataset.themeId)).toBe("quipu");
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    expectPaints(await paintedColor(page, "html", dark.chrome));
    await page.context().close();
  });

  it("paints Grove's light half when the appearance mode is light under a dark system", async () => {
    const page = await openWithStorage(
      { "quipu:theme": "grove", "quipu:theme-appearance-mode": "light" },
      "dark",
      { blockApp: true },
    );
    const light = getThemeColorsForMode(GROVE_THEME, "light")!;

    expect(await page.evaluate(() => document.documentElement.dataset.themeId)).toBe("grove");
    expectPaints(await paintedColor(page, "html", light.chrome));
    await page.context().close();
  });

  // The shell paints its own surfaces (the body keeps index.html's boot
  // background), so the check reads the main column and the sidebar.
  it.each([
    ["quipu", QUIPU_THEME, "dark", { "quipu:theme-appearance-mode": "system" }],
    ["grove", GROVE_THEME, "light", { "quipu:theme-appearance-mode": "light" }],
  ] as const)(
    "paints the %s palette onto the rendered shell",
    async (id, theme, mode, appearance) => {
      const page = await openWithStorage({ "quipu:theme": id, ...appearance }, "dark", {
        blockApp: false,
      });
      await page.waitForSelector('[data-slot="sidebar-inset"]');
      const colors = getThemeColorsForMode(theme, mode)!;

      expectPaints(await paintedColor(page, '[data-slot="sidebar-inset"]', colors.canvas));
      expectPaints(await paintedColor(page, '[data-slot="sidebar-inner"]', colors.sidebar));
      await page.context().close();
    },
  );

  it("paints different colors for different palettes", async () => {
    const painted: string[] = [];
    for (const id of ["quipu", "grove"]) {
      const page = await openWithStorage(
        { "quipu:theme": id, "quipu:theme-appearance-mode": "dark" },
        "dark",
        { blockApp: false },
      );
      await page.waitForSelector('[data-slot="sidebar-inset"]');
      painted.push(
        await page.evaluate(
          () =>
            getComputedStyle(document.querySelector('[data-slot="sidebar-inset"]')!)
              .backgroundColor,
        ),
      );
      await page.context().close();
    }

    expect(painted[0]).not.toBe(painted[1]);
  });
});
