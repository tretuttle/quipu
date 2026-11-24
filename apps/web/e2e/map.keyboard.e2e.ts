// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { map, mapNode as node, toggleMapRow } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-keyboard-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** A capture whose pages are named like every DevTools capture's: `page_1`, `page_2`. */
function capture(prefix: string, hosts: number): string {
  const entries = [];
  for (let h = 0; h < hosts; h += 1) {
    for (let n = 0; n < 3; n += 1) {
      entries.push({
        pageref: "page_1",
        request: { method: "GET", url: `https://${prefix}${h}.example/r/${n}`, headers: [] },
        response: { status: 200, content: { mimeType: "text/plain", text: "ok" } },
      });
    }
  }
  return JSON.stringify({
    log: { version: "1.2", pages: [{ id: "page_1", title: "Home" }], entries },
  });
}

const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

describe("the keyboard on the map", () => {
  it("drills from the capture to a request in a second capture opened in the same session", async () => {
    await withPage(async (page) => {
      const first = NodePath.join(scratch, "first.har");
      const second = NodePath.join(scratch, "second.har");
      NodeFS.writeFileSync(first, capture("one-", 4));
      NodeFS.writeFileSync(second, capture("two-", 5));
      await dropFile(page, first);
      await node(page, /^Capture 12 requests, 4 hosts$/).waitFor();
      await dropFile(page, second);
      const root = node(page, /^Capture 15 requests, 5 hosts$/);
      await root.waitFor();
      await root.focus();
      for (const [step, label] of [
        [1, /^two-0\.example/],
        [2, /^Home 3 requests$/],
        [3, /^GET \/r\/0 \{\}/],
        [4, /^pageref|^request|^response/],
      ] as const) {
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => focused(page), { message: `step ${step}` }).toMatch(label);
      }
      // Right opened only what it landed on: one request card, not every request on the page.
      expect(await node(page, /^GET \/r\/\d \{\}/).count()).toBe(1);
    });
  });

  it("has one current node: the keyboard moves the selection, and decode in selection acts there", async () => {
    await withPage(async (page) => {
      const body = (n: number) => JSON.stringify({ n, note: "a json value long enough" });
      await pasteText(
        page,
        JSON.stringify({ a: { a1: body(1), a2: body(2) }, b: { b1: body(3), b2: body(4) } }),
      );
      await node(page, /^root \{\} 2 keys$/).waitFor();
      await toggleMapRow(page, /^a:/);
      await toggleMapRow(page, /^b:/);
      const a = node(page, /^a \{\} 2 keys$/);
      const b = node(page, /^b \{\} 2 keys$/);
      // `b` opens after its row is clicked: ArrowDown has nowhere to go until it is on the map.
      await b.waitFor();
      // A click makes `a` current; ArrowDown moves to its sibling `b`, and the selection goes with it.
      const header = await a.locator("text").first().boundingBox();
      if (!header) throw new Error("a is not on screen");
      await page.mouse.click(header.x + 4, header.y + header.height / 2);
      const view = page.locator("[data-map-view]");
      await expect
        .poll(() => view.getAttribute("data-map-selected"))
        .toBe(await a.getAttribute("data-map-node"));
      await expect.poll(() => focused(page)).toMatch(/^a \{\}/);
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focused(page)).toMatch(/^b \{\}/);
      await expect
        .poll(() => view.getAttribute("data-map-selected"))
        .toBe(await b.getAttribute("data-map-node"));

      // Decode all values in selection decodes under `b`, the current node, and nothing under `a`.
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Decode all values in selection");
      await palette
        .getByRole("option", { name: /Decode all values in selection/ })
        .first()
        .click();
      await node(page, /^b1 JSON/).waitFor();
      await node(page, /^b2 JSON/).waitFor();
      expect(
        await map(page)
          .getByRole("treeitem", { name: /^a[12] JSON/ })
          .count(),
      ).toBe(0);
    });
  });
});
