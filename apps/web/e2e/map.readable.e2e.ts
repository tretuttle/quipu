// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { mapContrast } from "./mapContrast";
import { map, mapNode as node } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-readable-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const detail = (page: Page) => page.locator("[data-map-view]").getAttribute("data-map-detail");
const zoomPercent = async (page: Page) =>
  Number.parseFloat(((await page.getByTestId("map-zoom").textContent()) ?? "0").replace("<", ""));
const fit = (page: Page) => page.getByRole("button", { name: "Zoom to fit" }).click();

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("The element has no box.");
  return rect;
}

/** The part of the map canvas the toolbar, minimap and status leave free, on screen. */
async function usableArea(page: Page) {
  const canvas = await box(page.getByLabel("Map canvas"));
  const toolbar = await box(page.getByTestId("board-toolbar"));
  const minimap = page.getByRole("img", { name: "Minimap" });
  const bottom = (await minimap.count()) > 0 ? (await box(minimap)).y : canvas.y + canvas.height;
  return {
    left: canvas.x,
    top: toolbar.y + toolbar.height,
    right: canvas.x + canvas.width,
    bottom,
  };
}

/** A HAR with `hosts` hosts of `perHost` requests on one page. */
function har(hosts: number, perHost: number): string {
  const entries = [];
  for (let h = 0; h < hosts; h += 1) {
    for (let n = 0; n < perHost; n += 1) {
      entries.push({
        pageref: "page_1",
        request: { method: "GET", url: `https://host-${h}.example/r/${n}`, headers: [] },
        response: { status: 200, content: { mimeType: "text/plain", text: "ok" } },
      });
    }
  }
  return JSON.stringify({
    log: { version: "1.2", pages: [{ id: "page_1", title: "Home" }], entries },
  });
}

describe("the map shows something readable", () => {
  it("opens a wide document readable at the top left, and fits again to the whole map", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(Array.from({ length: 150_000 }, (_, i) => i)));
      const root = node(page, /^root \[\] 150,000 items$/);
      await root.waitFor();
      // The first frame draws text: the root's first ranges, under the toolbar.
      await expect.poll(() => detail(page)).toBe("full");
      await root.getByText("[0…999]").waitFor();
      const area = await usableArea(page);
      const rootBox = await box(root);
      expect(rootBox.y).toBeGreaterThanOrEqual(area.top);
      expect(rootBox.x).toBeGreaterThanOrEqual(area.left);
      // The root lists a page of its ranges, then a row that shows more (below the fold: page down to it).
      const more = root.locator("[data-map-more]").getByText("… 50 more · show 50");
      await page.getByLabel("Map canvas").focus();
      for (let i = 0; i < 8 && (await more.count()) === 0; i += 1) {
        await page.keyboard.press("PageDown");
      }
      await more.waitFor();

      // Zoom to fit keeps that readable frame; pressed again it shows the whole map, titles kept.
      await fit(page);
      expect(await detail(page)).toBe("full");
      const readable = await zoomPercent(page);
      await fit(page);
      await expect.poll(() => zoomPercent(page)).toBeLessThan(readable);
      expect(await detail(page)).not.toBe("full");
      await fit(page);
      await expect.poll(() => detail(page)).toBe("full");
    });
  });

  it("keeps a node's title on screen at a zoom too far out for its rows", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ alpha: { a: 1 }, beta: { b: 2 } }));
      const root = node(page, /^root \{\} 2 keys$/);
      await root.waitFor();
      await page.getByLabel("Map canvas").focus();
      for (let i = 0; i < 8; i += 1) await page.keyboard.press("-");
      await expect.poll(() => zoomPercent(page)).toBeLessThan(55);
      expect(await detail(page)).toBe("titles");
      const title = root.locator("[data-map-title]");
      expect(await title.textContent()).toBe("root");
      // Drawn at a readable size on screen: at least 10 px tall.
      expect((await box(title)).height).toBeGreaterThanOrEqual(10);
    });
  });

  it("frames a HAR on its capture node once grouping settles", async () => {
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "framed.har");
      NodeFS.writeFileSync(file, har(40, 120));
      await dropFile(page, file);
      const capture = node(page, /^Capture 4,800 requests, 40 hosts$/);
      await capture.waitFor({ timeout: 30_000 });
      await expect.poll(() => detail(page)).toBe("full");
      const area = await usableArea(page);
      await expect
        .poll(async () => {
          const at = await box(capture);
          return (
            // At the top of the area the chrome leaves free, and inside it.
            at.y >= area.top &&
            at.y < area.top + 80 &&
            at.x >= area.left &&
            at.x + at.width <= area.right
          );
        })
        .toBe(true);
      await capture.getByText("host-0.example").waitFor();
      // Comfortable, not merely drawn: the capture fits whole only at about 55 %, so the
      // frame anchors on it at full size instead; the same after opening a host, and after a fit.
      expect(await zoomPercent(page)).toBeGreaterThanOrEqual(80);
      const hostRow = capture.locator("[data-map-row]").filter({ hasText: /^host-3\.example/ });
      await hostRow.locator("[data-map-toggle]").click({ force: true });
      await node(page, /^host-3\.example 120 requests, 1 page$/).waitFor();
      expect(await zoomPercent(page)).toBeGreaterThanOrEqual(80);
      await fit(page);
      expect(await zoomPercent(page)).toBeGreaterThanOrEqual(80);
      expect(await detail(page)).toBe("full");
    });
  });

  it("wraps a long expanded list into columns, so the whole map has a shape", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({
          records: Array.from({ length: 2500 }, (_, id) => ({ id, name: `r${id}` })),
        }),
      );
      await node(page, /^root \{\} 1 key$/).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 400 } });
      await page.keyboard.press("Control+Shift+ArrowRight");
      await expect
        .poll(async () => map(page).getByRole("treeitem").count(), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            Number(
              ((await page.getByTestId("map-status").textContent()) ?? "")
                .match(/[\d,]+/)?.[0]
                ?.replace(",", ""),
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(300);
      // The whole map, pressed twice: not a hairline at a fraction of a percent.
      await fit(page);
      await fit(page);
      await expect.poll(() => zoomPercent(page)).toBeGreaterThanOrEqual(3);
      // The minimap draws a block, not a line: its marks are at least a fifth as wide as tall.
      // (It hides while the whole map is on screen: zoom in until it shows.)
      const minimap = page.getByRole("img", { name: "Minimap" });
      await page.getByLabel("Map canvas").focus();
      for (let i = 0; i < 10 && (await minimap.count()) === 0; i += 1) {
        await page.keyboard.press("=");
      }
      const shape = await page
        .getByRole("img", { name: "Minimap" })
        .locator("canvas")
        .first()
        .evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let [minX, minY, maxX, maxY] = [canvas.width, canvas.height, -1, -1];
          for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
              if (data[(y * canvas.width + x) * 4 + 3]! === 0) continue;
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minY = Math.min(minY, y);
              maxY = Math.max(maxY, y);
            }
          }
          return { width: maxX - minX + 1, height: maxY - minY + 1 };
        });
      expect(shape.width / shape.height).toBeGreaterThan(0.2);
    });
  }, 120_000);

  it("keeps long keys and values inside their node, in the font it draws with", async () => {
    await withPage(async (page) => {
      // A font about 8 px wide per character, wider than the 7.2 px the layout assumes.
      await page.addStyleTag({ content: "[data-map-view] svg text { letter-spacing: 0.8px; }" });
      await pasteText(
        page,
        JSON.stringify({
          [`longKey_${"x".repeat(60)}`]: "a key that is very long to test overflow",
          longString: "Lorem ipsum dolor sit amet, ".repeat(8),
          base64Payload: "eyJoZWxsbyI6IndvcmxkIiwibiI6MTIzNDU2Nzg5MCwibGlzdCI6WzEsMiwzXX0=",
          form: "grant_type=client_credentials&scope=read%20write&client_id=abc123def456",
          名前: "東京タワー".repeat(8),
          emoji: "🚀 launch ✅ 🙂 ".repeat(4),
        }),
      );
      const root = node(page, /^root \{\} 6 keys$/);
      await root.getByText("longString").waitFor();
      const edge = await box(root.locator("rect").first());
      const rows = root.locator("[data-map-row] text");
      await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(8);
      // Each value starts after its key: wide characters are counted as the two columns they take.
      for (const row of await root.locator("[data-map-row]").all()) {
        const texts = await row.locator("text").all();
        if (texts.length < 2) continue;
        const [key, value] = [await box(texts[0]!), await box(texts[1]!)];
        expect(value.x, (await row.textContent()) ?? "").toBeGreaterThanOrEqual(
          key.x + key.width - 1,
        );
      }
      for (const text of await rows.all()) {
        const at = await box(text);
        expect(at.x + at.width, (await text.textContent()) ?? "").toBeLessThanOrEqual(
          edge.x + edge.width + 1,
        );
      }
    });
  });

  it("follows the focus when ArrowRight opens a child, and keeps it clear of the chrome", async () => {
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "drill.har");
      NodeFS.writeFileSync(file, har(3, 4));
      await dropFile(page, file);
      const capture = node(page, /^Capture 12 requests, 3 hosts$/);
      await capture.waitFor();
      await capture.focus();
      const labels = [/^host-0\.example/, /^Home/, /^GET \/r\/0/, /^pageref|^request|^response/];
      for (const label of labels) {
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""))
          .toMatch(label);
        const focused = page.locator(":focus");
        const area = await usableArea(page);
        await expect
          .poll(async () => {
            const at = await box(focused);
            return (
              at.x >= area.left &&
              at.y >= area.top &&
              at.x + Math.min(at.width, 120) <= area.right &&
              at.y + Math.min(at.height, 40) <= area.bottom
            );
          })
          .toBe(true);
      }
    });
  });

  it("pans when empty map space is dragged; Shift+drag does not", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ a: 1 }));
      await node(page, /^root/).waitFor();
      const camera = () => page.getByTestId("map-camera").getAttribute("transform");
      const canvas = await box(page.getByLabel("Map canvas"));
      const before = await camera();
      const [x, y] = [canvas.x + 60, canvas.y + canvas.height - 120];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80, y - 40, { steps: 5 });
      await page.mouse.up();
      const panned = await camera();
      expect(panned).not.toBe(before);
      await page.keyboard.down("Shift");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80, y - 40, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      expect(await camera()).toBe(panned);
    });
  });

  it("says when Expand All stopped at its limit, in numbers that agree with the node count", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ i }))));
      await node(page, /^root/).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 400 } });
      await page.keyboard.press("Control+Shift+ArrowRight");
      const notice = page.getByTestId("map-notice");
      await notice.waitFor({ timeout: 30_000 });
      const said =
        /^ · Opened 5,000 objects and arrays, the most it opens at once; ([\d,]+) nodes are on the map, the rest behind “more” rows\. Run it again to open more\.$/.exec(
          (await notice.textContent()) ?? "",
        );
      expect(said).not.toBeNull();
      const status = (await page.getByTestId("map-status").textContent()) ?? "";
      expect(status.startsWith(`${said![1]} nodes`)).toBe(true);
    });
  }, 60_000);

  it("shows no save status until something is drawn on the map", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ a: 1 }));
      await node(page, /^root/).waitFor();
      expect(await page.getByTestId("map-save-status").count()).toBe(0);
      await page.getByRole("radio", { name: "Rectangle" }).click();
      const canvas = await box(page.getByLabel("Map canvas"));
      await page.mouse.move(canvas.x + 80, canvas.y + 500);
      await page.mouse.down();
      await page.mouse.move(canvas.x + 160, canvas.y + 560, { steps: 4 });
      await page.mouse.up();
      await page.getByTestId("map-save-status").getByText("Drawings saved").waitFor();
    });
  });

  it("keeps typed letters out of the canvas while the palette opens", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ a: 1 }));
      await node(page, /^root/).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 400 } });
      // Typed at once, before the palette's input has the focus: "d" is the diamond tool's key.
      await page.keyboard.press(`${MOD}+k`);
      await page.keyboard.type("dra", { delay: 0 });
      await page.getByRole("dialog", { name: "Command palette" }).waitFor();
      await page.keyboard.press("Escape");
      expect(await page.getByRole("radio", { name: "Select" }).getAttribute("aria-checked")).toBe(
        "true",
      );
    });
  });

  it("draws node borders, hints and array indices with contrast in every palette, light and dark", async () => {
    await withPage(
      async (page) => {
        const names = await page
          .getByRole("button", { name: /^Use .* theme/ })
          .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
        expect(names.length).toBeGreaterThan(1);
        for (const mode of ["light", "dark"]) {
          await page.getByRole("button", { name: `Use ${mode} mode` }).click();
          for (const name of names) {
            await page.getByRole("button", { name }).click();
            const contrast = await mapContrast(page, `${mode}: ${name}`);
            expect(contrast.borderOnCanvas, contrast.palette).toBeGreaterThanOrEqual(1.7);
            expect(contrast.borderOnNode, contrast.palette).toBeGreaterThanOrEqual(1.7);
            expect(contrast.hintOnNode, contrast.palette).toBeGreaterThanOrEqual(4.5);
            // Array indices read as well as the other text, on every background their row shows.
            for (const [state, value] of Object.entries(contrast.indexOn)) {
              expect(value, `${contrast.palette}: index on ${state}`).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      },
      { path: "/settings/appearance" },
    );
  }, 120_000);

  it("draws every edge beneath opaque cards, and routes wrapped columns' edges through the gutters", async () => {
    await withPage(async (page) => {
      const record = (i: number) => ({ a: i, b: `v${i}`, c: true, d: null, e: i * 2, f: "x" });
      await pasteText(
        page,
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, record(i)])),
        ),
      );
      await node(page, /^root \{\} 40 keys$/).waitFor();
      await page.getByLabel("Map canvas").click({ position: { x: 10, y: 400 } });
      await page.keyboard.press("Control+Shift+ArrowRight");
      await page.getByTestId("map-status").getByText("41 nodes").waitFor();
      // A search dims the cards that miss it.
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Find in document").fill('"v1');
      await page.getByLabel("Find in document").press("Enter");
      await page.getByText(/^1 of \d+$/).waitFor();
      // The whole map: fit, then fit again.
      await fit(page);
      await fit(page);
      await expect.poll(() => map(page).locator("[data-map-edge]").count()).toBe(40);
      // Some cards hold a hit; the rest are dimmed.
      await expect
        .poll(() => map(page).locator("[data-map-node][data-hit]").count())
        .toBeGreaterThan(0);

      const report = await map(page).evaluate((svg) => {
        const edges = [...svg.querySelectorAll<SVGPathElement>("[data-map-edge]")];
        // Each card's surface: the first rect of its node.
        const cards = [
          ...svg.querySelectorAll<SVGRectElement>("[data-map-node] > rect:first-of-type"),
        ];
        // Paint order: an edge before every card.
        const edgeAfterCard = edges.some((edge) =>
          cards.some(
            (card) => card.compareDocumentPosition(edge) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        );
        // Opaque: the card's fill and everything above it up to the SVG.
        const probe = document
          .createElement("canvas")
          .getContext("2d", { willReadFrequently: true })!;
        const alphaOf = (color: string) => {
          probe.clearRect(0, 0, 1, 1);
          probe.fillStyle = color;
          probe.fillRect(0, 0, 1, 1);
          return probe.getImageData(0, 0, 1, 1).data[3]!;
        };
        const translucent = cards.filter((card) => {
          if (alphaOf(getComputedStyle(card).fill) < 255) return true;
          for (let at: Element | null = card; at !== null && at !== svg; at = at.parentElement) {
            if (Number(getComputedStyle(at).opacity) < 1) return true;
          }
          return false;
        }).length;
        // Geometry: no point of an edge inside a card, on screen.
        const boxes = cards.map((card) => card.getBoundingClientRect());
        let crossings = 0;
        for (const edge of edges) {
          const matrix = edge.getScreenCTM()!;
          const length = edge.getTotalLength();
          for (let at = 0; at <= length; at += 2) {
            const p = edge.getPointAtLength(at).matrixTransform(matrix);
            if (
              boxes.some(
                (b) =>
                  p.x > b.left + 2 && p.x < b.right - 2 && p.y > b.top + 2 && p.y < b.bottom - 2,
              )
            ) {
              crossings += 1;
              break;
            }
          }
        }
        return { edgeAfterCard, translucent, crossings, cards: cards.length };
      });
      expect(report.cards).toBe(41);
      expect(report.edgeAfterCard).toBe(false);
      expect(report.translucent).toBe(0);
      expect(report.crossings).toBe(0);
    });
  }, 90_000);
});
