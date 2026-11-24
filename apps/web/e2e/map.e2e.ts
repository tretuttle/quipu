// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { expectMedianWithin, sampleRuns } from "./budget";
import { cachedHar, skipWithout } from "./fixtures";
import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();

const HAR_2G = cachedHar("har-2g.har");

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(name: string, contents: string): string {
  const file = NodePath.join(scratch, name);
  NodeFS.writeFileSync(file, contents);
  return file;
}

/** A drop the way the OS delivers one: CDP drag events that carry the file's path. */
async function dropFile(page: Page, path: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x: 640, y: 400, data });
  }
  await cdp.detach();
}

async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}

const map = (page: Page) => page.getByRole("tree", { name: "Document map" });
const node = (page: Page, name: RegExp) => map(page).getByRole("treeitem", { name });

/** The chevron of the row that names `rowId`, with the map fitted first so the row is on screen. */
async function toggleRow(page: Page, rowId: RegExp) {
  await page.getByRole("button", { name: "Zoom to fit" }).click();
  const row = map(page).locator("[data-map-row-id]").filter({ hasText: rowId }).first();
  await row.locator("[data-map-toggle]").click({ force: true });
}

/** The label of the focused map node, as a screen reader reads it. */
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("The element has no box.");
  return rect;
}

/** An element's box in world units, read through the camera transform, so a fit or pan does not move it. */
async function worldBox(page: Page, locator: Locator) {
  const [rect, host, camera] = await Promise.all([
    box(locator),
    box(page.getByLabel("Map canvas")),
    page.getByTestId("map-camera").getAttribute("transform"),
  ]);
  const match = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(camera ?? "");
  if (!match) throw new Error(`no camera transform: ${camera}`);
  const [tx, ty, k] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return {
    x: (rect.x - host.x - tx) / k,
    y: (rect.y - host.y - ty) / k,
    width: rect.width / k,
    height: rect.height / k,
  };
}

/** A capture with two hosts and two pages, the way DevTools writes one. */
function smallHar(): string {
  const entry = (n: number, host: string, pageref: string) => ({
    pageref,
    startedDateTime: "2026-10-11T07:40:00.000Z",
    request: { method: n % 2 ? "GET" : "POST", url: `https://${host}/asset/${n}`, headers: [] },
    response: { status: 200 + n, content: { mimeType: "text/plain", text: `body ${n}` } },
    time: 12.5,
  });
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "WebInspector", version: "537.36" },
      pages: [
        { id: "page_1", title: "Home", startedDateTime: "2026-10-11T07:40:00.000Z" },
        { id: "page_2", title: "Checkout", startedDateTime: "2026-10-11T07:41:00.000Z" },
      ],
      entries: [
        entry(0, "cdn.example", "page_1"),
        entry(1, "api.example", "page_1"),
        entry(2, "cdn.example", "page_2"),
        entry(3, "cdn.example", "page_1"),
      ],
    },
  });
}

describe("the map view", () => {
  it("opens a document as a node with its keys and values, expands a nested node, fits and zooms", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({ name: "quipu", knots: 3, nested: { depth: 2, deeper: { leaf: true } } }),
      );
      const root = node(page, /^root \{\} 3 keys$/);
      await root.waitFor();
      await root.getByText('"quipu"').waitFor();
      await root.getByText("nested").waitFor();
      expect(await map(page).getByRole("treeitem").count()).toBe(1);

      await toggleRow(page, /nested/);
      const nested = node(page, /^nested \{\} 2 keys$/);
      await nested.waitFor();
      await nested.getByText("depth").waitFor();
      // The child sits in the next column, right of its parent.
      expect((await box(nested)).x).toBeGreaterThan((await box(root)).x + (await box(root)).width);
      await expect.poll(() => map(page).locator("[data-map-edge]").count()).toBe(1);

      await toggleRow(page, /deeper/);
      await node(page, /^deeper \{\} 1 key$/).waitFor();
      await page.getByTestId("map-status").getByText("3 nodes").waitFor();

      // Zoom from the keyboard, then fit: the readout and the geometry follow.
      const canvas = page.getByLabel("Map canvas");
      await canvas.click({ position: { x: 30, y: 30 } });
      const zoom = page.getByTestId("map-zoom");
      await zoom.getByText("100%").waitFor();
      const before = await box(root);
      const zoomPercent = async () => Number.parseInt((await zoom.textContent()) ?? "0", 10);
      await page.keyboard.press("-");
      await expect.poll(zoomPercent).toBeLessThan(100);
      expect((await box(root)).width).toBeLessThan(before.width);
      await page.keyboard.press("Shift+1");
      await expect.poll(zoomPercent).toBe(100);
      await page.keyboard.press("=");
      await expect.poll(zoomPercent).toBeGreaterThan(100);
      expect((await box(root)).width).toBeGreaterThan(before.width);
      await page.getByRole("button", { name: "Zoom to fit" }).click();
      await expect.poll(zoomPercent).toBe(100);
      // The whole map is on screen: the minimap would only repeat it. Zoomed in, it shows.
      expect(await page.getByRole("img", { name: "Minimap" }).count()).toBe(0);
      for (let i = 0; i < 12; i += 1) await page.keyboard.press("=");
      await page.getByRole("img", { name: "Minimap" }).waitFor();
    });
  });

  it("walks the map from the keyboard: child, siblings, parent, with roving focus", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({ first: { a: 1 }, second: { b: 2 }, third: { c: [1, 2, 3] } }),
      );
      const root = node(page, /^root/);
      await root.waitFor();
      await root.click({ position: { x: 40, y: 12 } });
      expect(await focusedLabel(page)).toBe("root {} 3 keys");
      expect(await root.getAttribute("tabindex")).toBe("0");

      // Right opens the node and lands on its first child.
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focusedLabel(page)).toBe("first {} 1 key");
      await expect.poll(() => root.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => focusedLabel(page)).toBe("second {} 1 key");
      await page.keyboard.press("End");
      await expect.poll(() => focusedLabel(page)).toBe("third {} 1 key");
      expect(await node(page, /^third/).getAttribute("aria-posinset")).toBe("3");
      expect(await node(page, /^third/).getAttribute("aria-setsize")).toBe("3");
      expect(await node(page, /^third/).getAttribute("aria-level")).toBe("2");
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => focusedLabel(page)).toBe("second {} 1 key");
      await page.keyboard.press("Home");
      await expect.poll(() => focusedLabel(page)).toBe("first {} 1 key");
      // Only the focused item is in the tab order.
      expect(await map(page).locator('[data-map-node][tabindex="0"]').count()).toBe(1);
      // Left on a closed node goes to the parent; Left again closes it.
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => focusedLabel(page)).toBe("root {} 3 keys");
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => root.getAttribute("aria-expanded")).toBe("false");
      await node(page, /^first/).waitFor({ state: "detached" });
      // Enter toggles the focused node open again.
      await page.keyboard.press("Enter");
      await node(page, /^first/).waitFor();
    });
  });

  it("keeps every card titled down to its zoom floor, and brings the rows back", async () => {
    await withPage(async (page) => {
      // 70 groups of 100: a node lists 100 rows, so the map reaches 7 000 nodes through groups.
      const wide: Record<string, Record<string, { v: number }>> = {};
      for (let g = 0; g < 70; g += 1) {
        const group: Record<string, { v: number }> = {};
        for (let i = 0; i < 100; i += 1) group[`k${i}`] = { v: g * 100 + i };
        wide[`g${g}`] = group;
      }
      await pasteText(page, JSON.stringify(wide));
      const root = node(page, /^root \{\}/);
      await root.waitFor();
      const canvas = page.getByLabel("Map canvas");
      await canvas.click({ position: { x: 10, y: 10 } });
      // Expand all opens 5 000 containers per command; the chunks count as nodes too.
      const nodeCount = async () => {
        const text = (await page.getByTestId("map-status").textContent()) ?? "";
        return Number(/([\d,]+) nodes?/.exec(text)?.[1]?.replaceAll(",", "") ?? 0);
      };
      await page.keyboard.press("Control+Shift+ArrowRight");
      await expect.poll(nodeCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(5000);
      await page.keyboard.press("Control+Shift+ArrowRight");
      await expect.poll(nodeCount, { timeout: 30_000 }).toBeGreaterThanOrEqual(7001);

      const view = page.locator("[data-map-view]");
      const detail = () => view.getAttribute("data-map-detail");
      const zoomText = () => page.getByTestId("map-zoom").textContent();
      // Fit gives a readable frame first; pressed again, as much of the map as its
      // floor shows. The whole map is too big for it: the frame starts at the top left
      // and the status bar says so.
      await page.keyboard.press("Shift+1");
      await page.keyboard.press("Shift+1");
      await expect.poll(zoomText).toBe("25%");
      await page
        .getByTestId("map-notice")
        .getByText("The whole map does not fit at 25 %: showing its top left")
        .waitFor();
      expect(await detail()).toBe("titles");
      // Every card on screen carries its title, at a size it can be read at; the
      // root's is at the top left, below the toolbar.
      const cards = await map(page).getByRole("treeitem").count();
      expect(cards).toBeGreaterThan(100);
      const titles = map(page).locator("[data-map-title]");
      expect(await titles.count()).toBe(cards);
      const sizes = await titles.evaluateAll((texts) =>
        texts.map((text) => text.getBoundingClientRect().height),
      );
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10.5);
      expect(await root.locator("[data-map-title]").textContent()).toMatch(/^r/);
      const [rootBox, toolbar] = await Promise.all([
        box(root),
        box(page.getByTestId("board-toolbar")),
      ]);
      expect(rootBox.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
      // Zoom out stops at the floor, and says so by turning off.
      const zoomOut = page.getByRole("button", { name: "Zoom out" });
      expect(await zoomOut.isDisabled()).toBe(true);
      await page.keyboard.press("-");
      expect(await zoomText()).toBe("25%");

      // Zooming in brings back the rows.
      const host = await box(canvas);
      await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
      await page.keyboard.down("Control");
      const zoomUntil = async (wanted: string) => {
        // Chromium delivers a ctrl+wheel as a 5 % zoom step.
        for (let i = 0; i < 400; i += 1) {
          if ((await detail()) === wanted) return;
          await page.mouse.wheel(0, -60);
        }
        throw new Error(`the map never reached ${wanted} detail`);
      };
      await zoomUntil("full");
      await page.keyboard.up("Control");
      await map(page).locator("text").filter({ hasText: "v" }).first().waitFor();
    });
  }, 120_000);

  it("shares its selection with the tree, and back", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ alpha: 1, beta: { gamma: 2 }, delta: 3 }));
      const root = node(page, /^root/);
      await root.waitFor();
      await map(page).locator("[data-map-row-id]").filter({ hasText: "delta" }).click();
      await page.getByLabel("Document view").getByText("Tree").click();
      const tree = page.getByRole("tree", { name: "Document tree" });
      const delta = tree.getByRole("treeitem", { name: /delta.*3/ });
      await delta.waitFor();
      expect(await delta.getAttribute("aria-selected")).toBe("true");

      await tree.getByRole("treeitem", { name: /alpha/ }).click();
      await page.getByLabel("Document view").getByText("Map").click();
      await node(page, /^root/).waitFor();
      // alpha is a scalar: its row carries the selection highlight, and only it.
      const alphaRow = map(page).locator("[data-map-row-id]").filter({ hasText: "alpha" });
      await alphaRow.waitFor();
      await expect.poll(() => alphaRow.locator("rect").count()).toBe(1);
      expect(await map(page).locator("[data-map-row] rect").count()).toBe(1);
    });
  });

  it("groups a HAR capture by host, page and request, and opens a request into its data", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("small.har", smallHar()));
      const capture = node(page, /^Capture 4 requests, 2 hosts$/);
      await capture.waitFor();
      await capture.getByText("cdn.example").waitFor();
      await capture.getByText("api.example").waitFor();
      await toggleRow(page, /cdn\.example/);
      const host = node(page, /^cdn\.example 3 requests, 2 pages$/);
      await host.waitFor();
      await host.getByText("Home").waitFor();
      await host.getByText("Checkout").waitFor();
      await toggleRow(page, /Home/);
      const home = node(page, /^Home 2 requests$/);
      await home.waitFor();
      await home.getByText("POST /asset/0").waitFor();
      await home.getByText("GET /asset/3").waitFor();
      await toggleRow(page, /GET \/asset\/3/);
      const entry = node(page, /^GET \/asset\/3 \{\}/);
      await entry.waitFor();
      await entry.getByText("request").waitFor();
      await entry.getByText("response").waitFor();
      await toggleRow(page, /^response/);
      await node(page, /^response \{\}/)
        .getByText("content")
        .waitFor();
    });
  });

  it("keeps an arrow attached to a node through a collapse and an expand", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({
          upper: { rows: Array.from({ length: 8 }, (_, i) => i) },
          lower: { value: "target" },
        }),
      );
      const root = node(page, /^root/);
      await root.waitFor();
      await toggleRow(page, /lower/);
      const lower = node(page, /^lower \{\} 1 key$/);
      await lower.waitFor();
      const lowerBefore = await worldBox(page, lower);
      const lowerScreen = await box(lower);

      // Draw an arrow from empty canvas into the lower node.
      const canvas = page.getByLabel("Map canvas");
      await canvas.click({ position: { x: 30, y: 30 } });
      await page.keyboard.press("a");
      await page.getByRole("radio", { name: "Arrow", checked: true }).waitFor();
      const from = { x: lowerScreen.x - 160, y: lowerScreen.y + lowerScreen.height + 120 };
      const to = {
        x: lowerScreen.x + lowerScreen.width / 2,
        y: lowerScreen.y + lowerScreen.height / 2,
      };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(
          from.x + ((to.x - from.x) * i) / 8,
          from.y + ((to.y - from.y) * i) / 8,
        );
      }
      await page.mouse.up();
      const arrow = page.locator('[data-element-type="arrow"]');
      await arrow.waitFor();
      await page.keyboard.press("v");
      /** The arrowhead's vertex, in world units: the arrow's paths live inside the camera group. */
      const tipOf = async () => {
        const d = (await arrow.locator("path").last().getAttribute("d")) ?? "";
        const match = /L([-\d.]+) ([-\d.]+)L/.exec(d);
        if (!match) throw new Error(`no arrowhead in ${d}`);
        return { x: Number(match[1]), y: Number(match[2]) };
      };
      /** True when the tip sits on the target's outline: just outside it, never deep inside. */
      const onOutline = (tip: { x: number; y: number }, target: typeof lowerBefore) => {
        const dx = Math.max(target.x - tip.x, tip.x - (target.x + target.width), 0);
        const dy = Math.max(target.y - tip.y, tip.y - (target.y + target.height), 0);
        const insideDepth = Math.min(
          tip.x - target.x,
          target.x + target.width - tip.x,
          tip.y - target.y,
          target.y + target.height - tip.y,
        );
        return Math.hypot(dx, dy) <= 8 && insideDepth <= 8;
      };
      const tipBefore = await tipOf();
      expect(onOutline(tipBefore, lowerBefore)).toBe(true);

      // Expanding `upper` grows the column above: `lower` moves down, the arrow's tip with it.
      await toggleRow(page, /upper/);
      await node(page, /^upper \{\} 1 key$/).waitFor();
      await toggleRow(page, /rows/);
      await node(page, /^rows \[\] 8 items$/).waitFor();
      await expect
        .poll(async () => (await worldBox(page, lower)).y)
        .toBeGreaterThan(lowerBefore.y + 100);
      const lowerMoved = await worldBox(page, lower);
      const shift = lowerMoved.y - lowerBefore.y;
      const tipMoved = await tipOf();
      expect(onOutline(tipMoved, lowerMoved)).toBe(true);
      // A center-anchored end re-aims at the fixed start as its node moves, so the tip
      // slides along the outline: it follows most of the shift, not all of it.
      expect(tipMoved.y - tipBefore.y).toBeGreaterThan(shift / 2);

      // Collapsing `upper` puts `lower` back, and the arrow with it.
      await toggleRow(page, /upper/);
      await node(page, /^upper \{\}/).waitFor({ state: "detached" });
      await expect
        .poll(async () => Math.abs((await worldBox(page, lower)).y - lowerBefore.y))
        .toBeLessThan(2);
      const tipBack = await tipOf();
      expect(Math.abs(tipBack.y - tipBefore.y)).toBeLessThan(3);
      expect(Math.abs(tipBack.x - tipBefore.x)).toBeLessThan(3);
      await page
        .getByTestId("map-save-status")
        .getByText("Drawings saved", { exact: true })
        .waitFor();
    });
  });

  it("recolors the nodes when the theme changes, and paints only through theme tokens", async () => {
    await withPage(async (page) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      await pasteText(page, JSON.stringify({ name: "quipu", knots: 3 }));
      const root = node(page, /^root/);
      await root.waitFor();
      const value = root.locator("text").filter({ hasText: '"quipu"' });
      const lightFill = await value.evaluate((el) => getComputedStyle(el).fill);
      const paints = await map(page)
        .locator("rect, path, text, line")
        .evaluateAll((els) =>
          els
            .flatMap((el) => [el.getAttribute("fill"), el.getAttribute("stroke")])
            .filter((v) => v !== null),
        );
      expect(paints.length).toBeGreaterThan(5);
      for (const paint of paints) expect(paint).toMatch(/^(var\(--[a-z0-9-]+\)|none)$/);

      // The paste is recorded in Recents after it opens (fingerprint, stored copy,
      // then the database): its sidebar row appears once that write is done, and
      // a reload before then would find no "Pasted text" to reopen.
      await page.getByTestId("recent-document").getByText("Pasted text").waitFor();
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      await page.getByTestId("recent-document").getByText("Pasted text").click();
      await node(page, /^root/).waitFor();
      const darkValue = node(page, /^root/).locator("text").filter({ hasText: '"quipu"' });
      const darkFill = await darkValue.evaluate((el) => getComputedStyle(el).fill);
      expect(darkFill).not.toBe(lightFill);
      expect(darkFill).toMatch(/^(rgb|oklch|color)/);
    });
  });

  it("reaches the map's commands from the palette", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ a: { b: { c: 1 } } }));
      await node(page, /^root/).waitFor();
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type("Expand all on map");
      await palette.getByRole("option", { name: /Expand all on map/ }).click();
      await node(page, /^b \{\} 1 key$/).waitFor();
      await page.keyboard.press(`${MOD}+k`);
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.type("Show tree");
      await palette.getByRole("option", { name: /Show tree view/ }).click();
      await palette.waitFor({ state: "hidden" });
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await page.keyboard.press(`${MOD}+Alt+1`);
      await map(page).waitFor();
    });
  });
});

describe("a 2 GiB HAR on the map", () => {
  it("paints the capture within a second of the drop and groups it", async (context) => {
    skipWithout(context, HAR_2G);
    const name = NodePath.basename(HAR_2G.path);
    // Each run drops the file on a fresh page; the first one also waits for the grouping.
    const samples = await sampleRuns((run) =>
      withPage(async (page) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const started = Date.now();
        await dropFile(page, HAR_2G.path);
        const marks: string[] = [];
        await page.getByText(`Opening ${name}`).waitFor({ timeout: 10_000 });
        marks.push(`opening ${Date.now() - started} ms`);
        await page.locator("[data-document-format]").waitFor({ timeout: 10_000 });
        marks.push(`session open ${Date.now() - started} ms`);
        await page.locator("[data-map-view]").waitFor({ timeout: 10_000 });
        marks.push(`map view mounted ${Date.now() - started} ms`);
        await page.getByTestId("map-status").getByText(/node/).waitFor({ timeout: 10_000 });
        marks.push(`first node built ${Date.now() - started} ms`);
        // A capture shows as one from its first frame, before its requests are grouped.
        const capture = node(page, /^Capture/);
        await capture.getByText("Capture").waitFor({ timeout: 10_000 });
        const firstPaint = Date.now() - started;
        console.log(
          `har-2g run ${run + 1}: ${marks.join("; ")}; drop to first map paint ${firstPaint} ms`,
        );

        if (run === 0) {
          await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 60_000 });
          await expect
            .poll(() => capture.getAttribute("aria-label"), { timeout: 300_000 })
            .toMatch(/requests, [\d,]+ hosts$/);
          console.log(
            `har-2g: grouped ${await capture.getAttribute("aria-label")} after ${Date.now() - started} ms`,
          );
        }
        expect(errors).toEqual([]);
        return firstPaint;
      }),
    );
    expectMedianWithin("har-2g: drop to first map paint", samples, 1000);
  }, 900_000);
});
