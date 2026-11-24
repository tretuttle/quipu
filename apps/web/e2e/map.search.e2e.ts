// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { map, mapNode as node, toggleMapRow } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-search-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const findInput = (page: Page) => page.getByLabel("Find in document");

async function openFind(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+f`);
  await findInput(page).waitFor();
  await findInput(page).fill(text);
  await findInput(page).press("Enter");
}

const opacity = (locator: Locator) =>
  locator.evaluate((element) => Number(getComputedStyle(element).opacity));

/** A map row by the text it shows. */
const row = (scope: Locator, text: RegExp) =>
  scope.locator("[data-map-row]").filter({ hasText: text }).first();

/** Whether the element lies inside the map canvas on screen. */
async function onScreen(page: Page, locator: Locator) {
  const [rect, host] = await Promise.all([
    locator.boundingBox(),
    page.getByLabel("Map canvas").boundingBox(),
  ]);
  if (!rect || !host) return false;
  return (
    rect.x >= host.x &&
    rect.y >= host.y &&
    rect.x + rect.width <= host.x + host.width &&
    rect.y + rect.height <= host.y + host.height
  );
}

/**
 * The contrast of a row's index key (`0:`) as drawn: its fill against the
 * card's surface with the row's own backgrounds (Find's hit, the selection)
 * laid over it in the order they are painted.
 */
function indexContrast(rowLocator: Locator) {
  return rowLocator.evaluate((row) => {
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const card = row.closest("[data-map-node]")!.querySelector(":scope > rect")!;
    const layers = [card, ...row.querySelectorAll(":scope > rect")].map(
      (rect) => getComputedStyle(rect).fill,
    );
    const key = getComputedStyle(row.querySelector("text")!).fill;
    const seen = (fills: string[]) => {
      paint.clearRect(0, 0, 1, 1);
      for (const fill of fills) {
        paint.fillStyle = fill;
        paint.fillRect(0, 0, 1, 1);
      }
      return Array.from(paint.getImageData(0, 0, 1, 1).data.subarray(0, 3));
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [hi, lo] = [luminance(seen([...layers, key])), luminance(seen(layers))].sort(
      (a, b) => b - a,
    );
    return (hi! + 0.05) / (lo! + 0.05);
  });
}

describe("find on the map", () => {
  it("lights the nodes and rows holding a hit, dims the rest, and brings each hit into view", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({
          title: "list",
          items: Array.from({ length: 400 }, (_, id) => ({ id, name: `item ${id}` })),
        }),
      );
      const root = node(page, /^root \{\} 2 keys$/);
      await root.waitFor();
      expect(await map(page).locator("[data-hit]").count()).toBe(0);

      await openFind(page, "item 3");
      await page.getByText("1 of 111", { exact: true }).waitFor();

      // The map opened the way to the first hit and shows it: its node and its row are lit.
      const first = node(page, /^3 \{\} 2 keys$/);
      await first.waitFor();
      await expect.poll(() => first.getAttribute("data-hit")).toBe("");
      const firstName = row(first, /^name/);
      await expect.poll(() => firstName.getAttribute("data-hit")).toBe("");
      expect(await firstName.locator("[data-map-search-hit]").count()).toBe(1);
      expect(await opacity(row(first, /^id/))).toBeLessThan(1);
      expect(await onScreen(page, firstName)).toBe(true);

      // The rows leading to it are lit too; a row without a hit is dimmed.
      expect(await root.getAttribute("data-hit")).toBe("");
      expect(await row(root, /^items/).getAttribute("data-hit")).toBe("");
      expect(await opacity(row(root, /^title/))).toBeLessThan(1);
      const items = node(page, /^items \[\] 400 items$/);
      expect(await items.getAttribute("data-hit")).toBe("");
      expect(await row(items, /^3: /).getAttribute("data-hit")).toBe("");
      expect(await opacity(row(items, /^4: /))).toBeLessThan(1);

      // The next match opens and shows its own node.
      await page.keyboard.press("F3");
      await page.getByText("2 of 111", { exact: true }).waitFor();
      const second = node(page, /^30 \{\} 2 keys$/);
      await second.waitFor();
      const secondName = row(second, /^name/);
      await expect.poll(() => secondName.getAttribute("data-hit")).toBe("");
      await expect.poll(() => onScreen(page, secondName)).toBe(true);

      // Closing the search takes the marks away.
      await findInput(page).press("Escape");
      await expect.poll(() => map(page).locator("[data-hit]").count()).toBe(0);
      expect(await opacity(row(root, /^title/))).toBe(1);
    });
  });

  it("opens the host, page and request of a hit in a HAR capture", async () => {
    await withPage(async (page) => {
      const entry = (n: number, host: string, pageref: string) => ({
        pageref,
        request: { method: "GET", url: `https://${host}/asset/${n}` },
        response: { status: 200 },
      });
      const file = NodePath.join(scratch, "search.har");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          log: {
            version: "1.2",
            pages: [
              { id: "page_1", title: "Home" },
              { id: "page_2", title: "Checkout" },
            ],
            entries: [
              entry(0, "cdn.example", "page_1"),
              entry(1, "api.example", "page_1"),
              entry(2, "cdn.example", "page_2"),
              entry(3, "cdn.example", "page_1"),
            ],
          },
        }),
      );
      await dropFile(page, file);
      const capture = node(page, /^Capture 4 requests, 2 hosts$/);
      await capture.waitFor();

      await openFind(page, "asset/3");
      await page.getByText("1 of 1", { exact: true }).waitFor();
      await node(page, /^cdn\.example 3 requests, 2 pages$/).waitFor();
      const home = node(page, /^Home 2 requests$/);
      await home.waitFor();
      await expect.poll(() => row(home, /asset\/3/).getAttribute("data-hit")).toBe("");
      expect(await opacity(row(home, /asset\/0/))).toBeLessThan(1);
      const request = node(page, /^request \{\} 2 keys$/);
      await request.waitFor();
      const url = row(request, /^url/);
      await expect.poll(() => url.getAttribute("data-hit")).toBe("");
      await expect.poll(() => onScreen(page, url)).toBe(true);
    });
  });

  it("lights the hits and fades the rest at the zoom floor, where cards show their titles", async () => {
    await withPage(async (page) => {
      // 70 groups of 100: a node lists 100 rows, so the map reaches 7 000 nodes through groups.
      const wide: Record<string, Record<string, { v: number }>> = {};
      for (let g = 0; g < 70; g += 1) {
        const group: Record<string, { v: number }> = {};
        for (let i = 0; i < 100; i += 1) group[`k${i}`] = { v: g * 100 + i };
        wide[`g${g}`] = group;
      }
      await pasteText(page, JSON.stringify(wide));
      await node(page, /^root \{\}/).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 10 } });
      const nodeCount = async () => {
        const text = (await page.getByTestId("map-status").textContent()) ?? "";
        return Number(/([\d,]+) nodes?/.exec(text)?.[1]?.replaceAll(",", "") ?? 0);
      };
      await page.keyboard.press("Control+Shift+ArrowRight");
      await expect.poll(nodeCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(5000);
      await page.keyboard.press("Control+Shift+ArrowRight");
      await expect.poll(nodeCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(7001);
      // Fit gives a readable frame first; pressed again, as much of the map as the floor shows.
      await page.keyboard.press("Shift+1");
      await page.keyboard.press("Shift+1");
      await expect
        .poll(() => page.locator("[data-map-view]").getAttribute("data-map-detail"))
        .toBe("titles");
      expect(await map(page).locator("[data-map-node][data-hit]").count()).toBe(0);

      // `"k1` is in 11 of each group's 100 keys: those cards are lit, the rest fade.
      await openFind(page, '"k1');
      await page.getByText(/^1 of 770$/).waitFor();
      const lit = map(page).locator("[data-map-node][data-hit]");
      await expect.poll(() => lit.count()).toBeGreaterThan(0);
      expect(await lit.first().locator("[data-map-title]").count()).toBe(1);
      // A card fades inside its opaque backing, so no edge shows through it.
      const unlit = map(page).locator("[data-map-node]:not([data-hit])").first();
      expect(await opacity(unlit.locator("g[opacity]").first())).toBeLessThan(1);
    });
  }, 120_000);

  for (const scheme of ["light", "dark"] as const) {
    it(`draws array indices readably on plain rows, rows lit by Find and the current hit (${scheme})`, async () => {
      await withPage(async (page) => {
        await page.emulateMedia({ colorScheme: scheme });
        await pasteText(
          page,
          JSON.stringify({ orders: [{ id: 1 }, { id: 2 }], list: ["alpha", "beta", "gamma"] }),
        );
        const root = node(page, /^root \{\} 2 keys$/);
        await root.waitFor();
        await toggleMapRow(page, /^list/);
        const list = node(page, /^list \[\] 3 items$/);
        await list.waitFor();
        expect(await indexContrast(row(list, /^0: /))).toBeGreaterThanOrEqual(4.5);

        // `"id` is in both orders: the orders' rows `0:` and `1:` are lit on the way to them.
        await openFind(page, '"id');
        await page.getByText("1 of 2", { exact: true }).waitFor();
        const orders = node(page, /^orders \[\] 2 items$/);
        await orders.waitFor();
        const lit = row(orders, /^1: /);
        await expect.poll(() => lit.getAttribute("data-hit")).toBe("");
        expect(await indexContrast(lit)).toBeGreaterThanOrEqual(4.5);
        await findInput(page).press("Escape");

        // The current hit is an element of the list itself.
        await openFind(page, "beta");
        await page.getByText("1 of 1", { exact: true }).waitFor();
        const current = row(list, /^1: /);
        await expect.poll(() => current.getAttribute("data-hit")).toBe("");
        expect(await indexContrast(current)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
