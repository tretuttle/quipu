import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { click, drag, openNewBoard, useCleanStyle } from "./boardsHarness";
import { useBrowser } from "./harness";

const withPage = useBrowser();

/** True once the bundled hand font has a loaded face in the page. */
function handFontLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    [...document.fonts].some(
      (face) => face.family.replace(/"/g, "") === "Kalam" && face.status === "loaded",
    ),
  );
}

/** The font Chromium drew the first match of `selector` with, as the platform reports it. */
async function renderedFamily(page: Page, selector: string): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const used = fonts.toSorted((a, b) => b.glyphCount - a.glyphCount)[0];
    return used?.familyName ?? "";
  } finally {
    await cdp.detach();
  }
}

/**
 * WCAG contrast of a text node's fill against the board background, with both
 * colors resolved to sRGB by painting them on a canvas.
 */
function contrastWithCanvas(text: Locator): Promise<number> {
  return text.evaluate((node) => {
    const probe = document.createElement("div");
    probe.style.color = "var(--canvas-background)";
    document.body.append(probe);
    const background = getComputedStyle(probe).color;
    probe.remove();
    const pixel = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    });
    if (!pixel) throw new Error("No 2D canvas.");
    const rgba = (css: string) => {
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = css;
      pixel.fillRect(0, 0, 1, 1);
      return [...pixel.getImageData(0, 0, 1, 1).data].map((channel) => channel / 255);
    };
    const [br = 0, bg = 0, bb = 0] = rgba(background);
    const [fr = 0, fg = 0, fb = 0, fa = 1] = rgba(getComputedStyle(node).fill);
    const over = (f: number, b: number) => f * fa + b * (1 - fa);
    const luminance = (r: number, g: number, b: number) => {
      const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const text = luminance(over(fr, br), over(fg, bg), over(fb, bb));
    const back = luminance(br, bg, bb);
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
  });
}

describe("board text and labels", () => {
  it("loads the hand font only for a board with handwritten text", async () => {
    await withPage(async (page) => {
      expect(await handFontLoaded(page)).toBe(false);
      const canvas = await openNewBoard(page);
      await page.keyboard.press("t");
      await click(page, canvas, [200, 200]);
      await page.getByRole("textbox", { name: "Text" }).fill("hello board");
      await page.keyboard.press("Escape");
      const text = page.locator('[data-element-type="text"] text').first();
      await text.getByText("hello board").waitFor();
      await expect.poll(() => handFontLoaded(page)).toBe(true);
      expect(await renderedFamily(page, '[data-element-type="text"] text')).toBe("Kalam");

      // A sticky note uses it too.
      await page.keyboard.press("n");
      await click(page, canvas, [400, 300]);
      await page.getByRole("textbox", { name: "Sticky note text" }).fill("remember");
      await page.keyboard.press("Escape");
      const note = page.locator('[data-element-type="note"] text').first();
      await note.getByText("remember").waitFor();
      expect(await renderedFamily(page, '[data-element-type="note"] text')).toBe("Kalam");
    });
  });

  it("writes Clean text in the interface font", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await useCleanStyle(page, canvas);
      await page.keyboard.press("t");
      await click(page, canvas, [200, 200]);
      await page.getByRole("textbox", { name: "Text" }).fill("plain words");
      await page.keyboard.press("Escape");
      const text = page.locator('[data-element-type="text"] text').first();
      await text.getByText("plain words").waitFor();
      expect(await renderedFamily(page, '[data-element-type="text"] text')).not.toBe("Kalam");
      // The interface's own font stack.
      expect(await text.evaluate((node) => getComputedStyle(node).fontFamily)).toBe(
        await page.evaluate(() => getComputedStyle(document.body).fontFamily),
      );
    });
  });

  it("draws a frame's name with readable contrast in light and dark", async () => {
    await withPage(async (page) => {
      await page.emulateMedia({ colorScheme: "light" });
      const canvas = await openNewBoard(page);
      await page.keyboard.press("f");
      await drag(page, canvas, [100, 120], [400, 320]);
      const label = page.locator('[data-element-type="frame"] text').getByText("Frame");
      await label.waitFor();
      expect(await contrastWithCanvas(label)).toBeGreaterThanOrEqual(4.5);
      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();

      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      const darkLabel = page.locator('[data-element-type="frame"] text').getByText("Frame");
      await darkLabel.waitFor();
      expect(await contrastWithCanvas(darkLabel)).toBeGreaterThanOrEqual(4.5);
    });
  });
  it("lists the hand font and its license among the open-source notices", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: "Search open-source licenses" }).click();
        await page.getByPlaceholder("Search licenses").fill("kalam");
        await page.getByText("@fontsource/kalam", { exact: true }).waitFor();
        await page
          .getByText(/^OFL-1\.1 · /)
          .first()
          .waitFor();
        await page
          .getByRole("link", { name: "View project source for @fontsource/kalam" })
          .waitFor();
      },
      { path: "/settings/open-source-licenses" },
    );
  });
});
