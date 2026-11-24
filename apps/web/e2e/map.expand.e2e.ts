// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { map, mapNode as node } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-expand-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** Runs a command from the palette by its title. */
async function run(page: Page, title: string) {
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill(title);
  // An option's name is its title, then its shortcut, if it has one.
  await palette.getByRole("option", { name: new RegExp(`^${title}`) }).click();
  await palette.waitFor({ state: "detached" });
}

const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
const cards = (page: Page) => map(page).getByRole("treeitem").count();

describe("expanding and collapsing the map", () => {
  it("opens the whole map from anywhere, or only what is under the current node", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({ a: { a1: { x: 1 }, a2: { y: 2 } }, b: { b1: { z: 3 } } }),
      );
      const root = node(page, /^root \{\} 2 keys$/);
      await root.waitFor();
      await root.click({ position: { x: 40, y: 12 } });
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focused(page)).toMatch(/^a \{\}/);
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focused(page)).toMatch(/^b \{\}/);

      // With `b` current, the whole map opens, `a`'s side too.
      await run(page, "Expand all on map");
      await node(page, /^a1 \{\}/).waitFor();
      await node(page, /^a2 \{\}/).waitFor();
      await node(page, /^b1 \{\}/).waitFor();
      expect(await cards(page)).toBe(6);
      await run(page, "Collapse all on map");
      await expect.poll(() => cards(page)).toBe(1);

      // Under the selection: only `b`'s side opens, and closes again with `b` still there.
      await root.click({ position: { x: 40, y: 12 } });
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focused(page)).toMatch(/^a \{\}/);
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focused(page)).toMatch(/^b \{\}/);
      await run(page, "Expand all under selection");
      await node(page, /^b1 \{\}/).waitFor();
      expect(await node(page, /^a1 \{\}/).count()).toBe(0);
      expect(await cards(page)).toBe(4);
      await run(page, "Collapse all under selection");
      await node(page, /^b1 \{\}/).waitFor({ state: "detached" });
      expect(await node(page, /^b \{\}/).count()).toBe(1);
      expect(await cards(page)).toBe(3);
    });
  });

  it("opens every host and page of a capture from a host, and says so", async () => {
    await withPage(async (page) => {
      const entries = [0, 1, 2].map((h) => ({
        pageref: `page_${h}`,
        request: { method: "GET", url: `https://host-${h}.example/r`, headers: [] },
        response: { status: 200, content: { mimeType: "text/plain", text: "ok" } },
      }));
      const file = NodePath.join(scratch, "hosts.har");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          log: {
            version: "1.2",
            pages: [0, 1, 2].map((h) => ({ id: `page_${h}`, title: `Page ${h}` })),
            entries,
          },
        }),
      );
      await dropFile(page, file);
      const capture = node(page, /^Capture 3 requests, 3 hosts$/);
      await capture.waitFor();
      await capture.click({ position: { x: 40, y: 12 } });
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focused(page)).toMatch(/^host-0\.example/);

      await run(page, "Expand all on map");
      for (const h of [0, 1, 2]) await node(page, new RegExp(`^Page ${h} 1 request$`)).waitFor();
      await page
        .getByTestId("map-notice")
        .getByText("Opened every host and page. Open a request to see its data.")
        .waitFor();
      await run(page, "Collapse all on map");
      await expect.poll(() => cards(page)).toBe(1);

      await capture.click({ position: { x: 40, y: 12 } });
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focused(page)).toMatch(/^host-0\.example/);
      await run(page, "Expand all under selection");
      await node(page, /^Page 0 1 request$/).waitFor();
      expect(await node(page, /^Page [12] /).count()).toBe(0);
      await page
        .getByTestId("map-notice")
        .getByText(
          "Opened everything under host-0.example down to its requests. Open a request to see its data.",
        )
        .waitFor();
    });
  });
});
