// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { map, mapNode as node, mapRowOf, toggleRowOf } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-edit-map-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const SAMPLE = { name: "alpha", count: 1, nested: { a: 2 } };
const root = (page: Page) => node(page, /^root \{\} 3 keys$/);
const editor = (page: Page) => page.locator("[data-map-row-editor]");
const showView = (page: Page, name: "Tree" | "Source" | "Map") =>
  page.getByLabel("Document view").getByRole("button", { name }).click();

/** Double-clicks a row's key (its first text) or its value (its second). */
async function dblclickRow(page: Page, row: Locator, part: "key" | "value") {
  const text = row.locator("text").nth(part === "key" ? 0 : 1);
  const at = await text.boundingBox();
  if (!at) throw new Error("the row's text is not on screen");
  await page.mouse.dblclick(at.x + Math.min(at.width / 2, 12), at.y + at.height / 2);
}

/** The editor sits on its row: their boxes overlap vertically. */
async function expectOnRow(page: Page, row: Locator) {
  const [box, rowBox] = await Promise.all([editor(page).boundingBox(), row.boundingBox()]);
  if (!box || !rowBox) throw new Error("no box");
  expect(box.y).toBeLessThan(rowBox.y + rowBox.height);
  expect(box.y + box.height).toBeGreaterThan(rowBox.y);
}

async function commit(page: Page, label: "Value" | "Key", text: string) {
  const field = editor(page).getByLabel(label);
  await field.fill(text);
  await field.press("Enter");
  await editor(page).waitFor({ state: "detached" });
}

const focusedMapNode = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-map-node") ?? null);
const cameraOf = (page: Page) => page.getByTestId("map-camera").getAttribute("transform");

describe("editing on the map", () => {
  it("edits a value on the map, and the tree and the source show it", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      const count = await mapRowOf(page, root(page), /^count/);
      const camera = await cameraOf(page);
      await dblclickRow(page, count, "value");
      await editor(page).waitFor();
      await expectOnRow(page, count);
      expect(await editor(page).getByLabel("Value").inputValue()).toBe("1");
      await commit(page, "Value", "42");
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^count: 42$/ })
        .waitFor();
      // The camera stays, and the edited node keeps the keyboard and the selection.
      expect(await cameraOf(page)).toBe(camera);
      await expect.poll(() => focusedMapNode(page)).not.toBeNull();
      expect(await page.locator("[data-map-view]").getAttribute("data-map-selected-row")).toBe("1");

      await showView(page, "Tree");
      await page
        .getByRole("tree", { name: "Document tree" })
        .locator("[data-tree-value]", { hasText: /^42$/ })
        .waitFor();
      await showView(page, "Source");
      await page
        .locator("[data-source-view] [data-row-code]", { hasText: '"count": 42' })
        .waitFor();
    });
  });

  it("renames a key on the map, and undoes it with the map focused", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      const name = await mapRowOf(page, root(page), /^name/);
      await dblclickRow(page, name, "key");
      expect(await editor(page).getByLabel("Key").inputValue()).toBe("name");
      await commit(page, "Key", "title");
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^title: "alpha"$/ })
        .waitFor();
      expect(await focusedMapNode(page)).not.toBeNull();
      await page.keyboard.press(`${MOD}+z`);
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^name: "alpha"$/ })
        .waitFor();
      await page.keyboard.press(`${MOD}+Shift+z`);
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^title: "alpha"$/ })
        .waitFor();
    });
  });

  it("opens the editor from the keyboard on the selected row, and Escape gives the keyboard back", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      const count = await mapRowOf(page, root(page), /^count/);
      const at = await count.locator("text").first().boundingBox();
      if (!at) throw new Error("the row is not on screen");
      await page.mouse.click(at.x + 4, at.y + at.height / 2);
      await expect.poll(() => focusedMapNode(page)).not.toBeNull();
      await page.keyboard.press("F2");
      await editor(page).getByLabel("Value").waitFor();
      await page.keyboard.press("Escape");
      await editor(page).waitFor({ state: "detached" });
      await expect.poll(() => focusedMapNode(page)).not.toBeNull();
      await page.keyboard.press("Enter");
      await commit(page, "Value", "7");
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^count: 7$/ })
        .waitFor();
      await page.keyboard.press("Shift+F2");
      await commit(page, "Key", "total");
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^total: 7$/ })
        .waitFor();
    });
  });

  it("puts the editor on its row zoomed in and zoomed out", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      const zoom = page.getByTestId("map-zoom");
      const zoomPercent = async () => Number.parseInt((await zoom.textContent()) ?? "0", 10);
      await root(page).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 30, y: 30 } });
      for (let step = 0; step < 4; step += 1) await page.keyboard.press("=");
      await expect.poll(zoomPercent).toBeGreaterThan(130);
      const count = root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^count/ });
      await dblclickRow(page, count, "value");
      await expectOnRow(page, count);
      await commit(page, "Value", "2");
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^count: 2$/ })
        .waitFor();

      await page.getByRole("button", { name: "Zoom to fit" }).click();
      await page.getByLabel("Map canvas").click({ position: { x: 30, y: 30 } });
      for (let step = 0; step < 3; step += 1) await page.keyboard.press("-");
      await expect.poll(zoomPercent).toBeLessThan(80);
      const name = root(page).locator("[data-map-row]").filter({ hasText: /^name/ });
      await dblclickRow(page, name, "value");
      await expectOnRow(page, name);
      await commit(page, "Value", "zoomed out");
      await root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^name: "zoomed out"$/ })
        .waitFor();
    });
  });

  it("draws the editor as its row's own box, growing past it only below a readable size", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(SAMPLE, null, 2));
      const zoom = page.getByTestId("map-zoom");
      const zoomPercent = async () => Number.parseInt((await zoom.textContent()) ?? "0", 10);
      await root(page).waitFor();
      const count = root(page)
        .locator("[data-map-row]")
        .filter({ hasText: /^count/ });
      /** The size of the editor's text on screen, and how far its middle is from the row's. */
      const measure = async () => {
        const field = editor(page).getByLabel("Value");
        const text = await field.evaluate((input: HTMLInputElement) => {
          const shown = input.getBoundingClientRect().height / input.offsetHeight;
          return Number.parseFloat(getComputedStyle(input).fontSize) * shown;
        });
        const [box, rowBox] = await Promise.all([editor(page).boundingBox(), count.boundingBox()]);
        if (!box || !rowBox) throw new Error("no box");
        const offCenter = Math.abs(box.y + box.height / 2 - (rowBox.y + rowBox.height / 2));
        return { text, offCenter };
      };
      /**
       * The editor's box against its row's: the row is one 20 unit line under the
       * card's 28 unit header, at the camera's zoom.
       */
      const againstRow = () =>
        // One synchronous read, so the boxes and the camera come from the same frame.
        page.evaluate(() => {
          const editorBox = document
            .querySelector("[data-map-row-editor]")!
            .getBoundingClientRect();
          const card = document.querySelector("[data-map-node] > rect")!.getBoundingClientRect();
          const camera = document
            .querySelector('[data-testid="map-camera"]')!
            .getAttribute("transform");
          const row = [...document.querySelectorAll("[data-map-row]")].find((element) =>
            element.textContent?.startsWith("count"),
          )!;
          const value = row.querySelectorAll("text")[1]!.getBoundingClientRect();
          const k = Number(/scale\(([-\d.]+)\)/.exec(camera ?? "")?.[1]);
          const top = card.y + (28 + Number(row.getAttribute("data-map-row")) * 20) * k;
          return {
            topOff: Math.abs(editorBox.y - top),
            heightOff: Math.abs(editorBox.height - 20 * k),
            widerThanValue: editorBox.width >= value.width,
          };
        });
      const expectRowBox = async () => {
        await editor(page).getByLabel("Value").waitFor();
        const fit = await againstRow();
        expect(fit.topOff).toBeLessThan(1.5);
        expect(fit.heightOff).toBeLessThan(1.5);
        expect(fit.widerThanValue).toBe(true);
      };

      // Zoomed out to 56 %: smaller than at 100 %, but still readable, and centered on its row.
      await page.getByLabel("Map canvas").click({ position: { x: 30, y: 30 } });
      for (let step = 0; step < 6; step += 1) await page.keyboard.press("-");
      await expect.poll(zoomPercent).toBe(56);
      await dblclickRow(page, count, "value");
      await editor(page).waitFor();
      const out = await measure();
      expect(out.text).toBeGreaterThanOrEqual(9.9);
      expect(out.text).toBeLessThan(11);
      expect(out.offCenter).toBeLessThan(2);
      // Below the readable size it is taller than the row it sits on.
      expect((await againstRow()).heightOff).toBeGreaterThan(1.5);
      await editor(page).getByLabel("Value").press("Escape");
      await editor(page).waitFor({ state: "detached" });

      // At 100 %: the editor is the row's own box, covering no row above or below.
      await page.getByLabel("Map canvas").click({ position: { x: 30, y: 30 } });
      for (let step = 0; step < 6; step += 1) await page.keyboard.press("=");
      await expect.poll(zoomPercent).toBe(100);
      await dblclickRow(page, count, "value");
      // Measured once the value has loaded into its field, not while it says "Reading…".
      await editor(page).getByLabel("Value").waitFor();
      await expectRowBox();
      await editor(page).getByLabel("Value").press("Escape");
      await editor(page).waitFor({ state: "detached" });

      // Zoomed in to over 200 %: its text as large as the row's, and still the row's box.
      await page.getByLabel("Map canvas").click({ position: { x: 30, y: 30 } });
      for (let step = 0; step < 8; step += 1) await page.keyboard.press("=");
      await expect.poll(zoomPercent).toBeGreaterThan(200);
      const rowText = 12 * ((await zoomPercent()) / 100);
      await dblclickRow(page, count, "value");
      await editor(page).waitFor();
      const inside = await measure();
      expect(inside.text).toBeGreaterThan(rowText * 0.97);
      expect(inside.offCenter).toBeLessThan(2);
      await expectRowBox();
    });
  });

  it("offers no editor on a decoded value's rows or on a capture's groups", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ body: JSON.stringify({ id: 7, name: "Ada" }) }));
      const card = node(page, /^body JSON · 2 keys$/);
      const top = node(page, /^root \{\} 1 key$/);
      const body = await mapRowOf(page, top, /^body/);
      await expect.poll(() => body.locator("[data-decode-badge]").count()).toBe(1);
      await toggleRowOf(page, top, /^body/);
      const id = await mapRowOf(page, card, /^id/);
      const at = await id.locator("text").first().boundingBox();
      if (!at) throw new Error("the decoded row is not on screen");
      await page.mouse.click(at.x + 4, at.y + at.height / 2);
      // Enter on the decoded row opens nothing; F2 says why it is not editable.
      await page.keyboard.press("Enter");
      expect(await editor(page).count()).toBe(0);
      await page.keyboard.press("F2");
      await page.getByText("Decoded values are read-only.").first().waitFor();
      expect(await editor(page).count()).toBe(0);
    });
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "small.har");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          log: {
            version: "1.2",
            creator: { name: "WebInspector", version: "537.36" },
            pages: [{ id: "page_1", title: "Home" }],
            entries: [
              {
                pageref: "page_1",
                request: { method: "GET", url: "https://cdn.example/a", headers: [] },
                response: { status: 200, content: { mimeType: "text/plain", text: "a" } },
              },
            ],
          },
        }),
      );
      await dropFile(page, file);
      const capture = node(page, /^Capture /);
      const host = await mapRowOf(page, capture, /cdn\.example/);
      await dblclickRow(page, host, "key");
      // The double-click opens the group, as it always has; no editor comes with it.
      await node(page, /^cdn\.example /).waitFor();
      expect(await editor(page).count()).toBe(0);
      expect(await map(page).locator("[data-map-row-editor]").count()).toBe(0);
    });
  });
});
