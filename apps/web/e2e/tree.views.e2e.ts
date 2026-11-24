// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, useBrowser } from "./harness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-tree-views-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(name: string, contents: string): string {
  const file = NodePath.join(scratch, name);
  NodeFS.writeFileSync(file, contents);
  return file;
}

/** Nested objects `depth` levels down, each with a padding string, an id and a one-item child array. */
function deepDocument(depth: number): string {
  let text = "";
  for (let level = 0; level < depth; level++) {
    text += `{"pad":"mike yankee zulu knot uniform","id":${level},"child":[`;
  }
  for (let level = 0; level < depth; level++) text += "]}";
  return text;
}

const SAMPLE = JSON.stringify({
  name: "quipu",
  knots: 3,
  open: true,
  closed: null,
  vendor: { name: "Holzhaus", city: "Basel", tags: ["wood", "pine"] },
  orders: [
    { id: 1, note: "first knot" },
    { id: 2, note: "plain" },
  ],
});

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const inTree = { storage: { "quipu:document-view": "tree" } };

/** WCAG contrast of pairs of CSS colors as the page computes them, through a probe so `color-mix` resolves. */
function contrastIn(page: Page, pairs: ReadonlyArray<readonly [string, string]>) {
  return page.evaluate((list) => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const canvas = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    })!;
    const rgb = (color: string) => {
      probe.style.color = color;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = getComputedStyle(probe).color;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const ratios = list.map(([a, b]) => {
      const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    });
    probe.remove();
    return ratios;
  }, pairs);
}

/** A CSS color as `getComputedStyle` reports it, to compare with what an element paints. */
const computed = (page: Page, value: string, property: "color" | "backgroundColor" = "color") =>
  page.evaluate(
    ([css, prop]) => {
      const probe = document.createElement("div");
      document.body.append(probe);
      probe.style[prop] = css;
      const color = getComputedStyle(probe)[prop];
      probe.remove();
      return color;
    },
    [value, property] as const,
  );

describe("the tree on a deep document", () => {
  it("keeps the focus and the rows' text in view after Expand all then End", async () => {
    const file = writeFixture("deep.json", deepDocument(1000));
    await withPage(async (page) => {
      await dropFile(page, file);
      const root = tree(page).getByRole("treeitem").first();
      await root.waitFor();
      await root.click();
      await page.keyboard.press(`${MOD}+Shift+ArrowRight`);
      // Expand all opens rows breadth first; wait until rows hundreds of levels down are listed.
      await page.waitForFunction(
        () => (document.querySelector("[data-tree-view] > div")?.scrollHeight ?? 0) > 600 * 28,
      );
      console.log(
        "BEFORE",
        await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 150)),
      );
      await page.keyboard.press("End");
      await page.waitForTimeout(2000);
      console.log(
        "DIAG",
        await page.evaluate(() => {
          const sc = document.querySelector<HTMLElement>("[data-tree-view] > div")!;
          const t = sc.querySelector('[tabindex="0"]');
          return [
            document.activeElement?.outerHTML.slice(0, 150),
            t?.outerHTML.slice(0, 200),
            sc.scrollTop,
            sc.scrollHeight,
          ].join("\n");
        }),
      );
      await page.waitForFunction(
        () => Number(document.activeElement?.getAttribute("aria-level") ?? 0) > 100,
      );
      const seen = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("[data-tree-view] > div")!;
        const box = scroller.getBoundingClientRect();
        const focused = document.activeElement as HTMLElement;
        const label = focused.querySelector<HTMLElement>("[data-tree-key]")!;
        const inside = (el: Element) => {
          const rect = el.getBoundingClientRect();
          return (
            rect.bottom > box.top &&
            rect.top < box.bottom &&
            rect.left >= box.left &&
            rect.right <= box.right
          );
        };
        return {
          role: focused.getAttribute("role"),
          labelInside: inside(label),
          readableRows: [...scroller.querySelectorAll("[data-tree-key]")].filter(inside).length,
          level: focused.querySelector("[data-tree-level]")?.textContent ?? "",
        };
      });
      expect(seen.role).toBe("treeitem");
      expect(seen.labelInside).toBe(true);
      expect(seen.readableRows).toBeGreaterThan(10);
      // A row deeper than the indent shows its level instead of moving right.
      expect(Number(seen.level)).toBeGreaterThan(100);
      await page.keyboard.press("Home");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-level") === "1");
    }, inTree);
  }, 120_000);
});

describe("clicking and toggling rows", () => {
  it("selects on click, toggles from the triangle, the keyboard and a double-click", async () => {
    const file = writeFixture("sample.json", SAMPLE);
    await withPage(async (page) => {
      await dropFile(page, file);
      const vendor = row(page, /^vendor/);
      await vendor.waitFor();
      // Clicking a closed container selects it and leaves it closed.
      await vendor.click();
      expect(await vendor.getAttribute("aria-expanded")).toBe("false");
      expect(await vendor.getAttribute("aria-selected")).toBe("true");
      // The triangle opens it; clicking the open row keeps it open.
      await vendor.locator("[data-tree-toggle]").click();
      await row(page, /^city/).waitFor();
      await vendor.click();
      expect(await vendor.getAttribute("aria-expanded")).toBe("true");
      // A double-click on its summary closes it; Space, Enter, Right and Left work from the keyboard.
      await vendor.locator("[data-tree-value]").dblclick();
      await row(page, /^city/).waitFor({ state: "detached" });
      await page.keyboard.press("Space");
      await row(page, /^city/).waitFor();
      await page.keyboard.press("Enter");
      await row(page, /^city/).waitFor({ state: "detached" });
      await page.keyboard.press("ArrowRight");
      await row(page, /^city/).waitFor();
      await page.keyboard.press("ArrowLeft");
      await row(page, /^city/).waitFor({ state: "detached" });
      // A double-click on a scalar's value, or on a key, still opens the editor.
      await row(page, /^knots/)
        .locator("[data-tree-value]")
        .dblclick();
      const value = tree(page).getByRole("textbox", { name: "Value" });
      await value.waitFor();
      await page.keyboard.press("Escape");
      await value.waitFor({ state: "detached" });
      await vendor.locator("[data-tree-key]").dblclick();
      await tree(page).getByRole("textbox", { name: "Key" }).waitFor();
      expect(await vendor.getAttribute("aria-expanded")).toBe("false");
    }, inTree);
  });
});

describe("tree colors", () => {
  it("colors values by type with the syntax colors the source view uses", async () => {
    const file = writeFixture("types.json", SAMPLE);
    await withPage(async (page) => {
      await dropFile(page, file);
      await row(page, /^closed/).waitFor();
      const colorOf = (name: RegExp, part: "value" | "key") =>
        row(page, name)
          .locator(`[data-tree-${part}]`)
          .evaluate((el) => getComputedStyle(el).color);
      const painted = {
        string: await colorOf(/^name/, "value"),
        number: await colorOf(/^knots/, "value"),
        boolean: await colorOf(/^open/, "value"),
        null: await colorOf(/^closed/, "value"),
        key: await colorOf(/^knots/, "key"),
      };
      expect(painted.string).toBe(await computed(page, "var(--syntax-string)"));
      expect(painted.number).toBe(await computed(page, "var(--syntax-number)"));
      expect(painted.boolean).toBe(await computed(page, "var(--syntax-literal-object)"));
      expect(painted.null).toBe(await computed(page, "var(--syntax-literal-object)"));
      expect(painted.key).toBe(await computed(page, "var(--syntax-key-1)"));
    }, inTree);
  });

  it("paints the selected row with the selection role, with the keyboard and without", async () => {
    const file = writeFixture("selected.json", SAMPLE);
    await withPage(async (page) => {
      await dropFile(page, file);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const knots = row(page, /^knots/);
        await knots.click();
        const active = await knots.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(active, scheme).toBe(
          await computed(page, "var(--tree-row-selected)", "backgroundColor"),
        );
        // Without the keyboard (the focus in the find bar) the row keeps a neutral band.
        await page.keyboard.press(`${MOD}+f`);
        await page.getByLabel("Find in document").waitFor();
        const inactive = await knots.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(inactive, scheme).toBe(
          await computed(page, "var(--tree-row-selected-inactive)", "backgroundColor"),
        );
        expect(inactive, scheme).not.toBe(active);
        // And the marker beside it, which is what makes an unfocused selection easy to find.
        const marker = await knots.evaluate((el) => ({
          width: getComputedStyle(el).borderInlineStartWidth,
          color: getComputedStyle(el).borderInlineStartColor,
        }));
        expect(marker.width, scheme).toBe("2px");
        expect(marker.color, scheme).toBe(await computed(page, "var(--tree-row-marker-inactive)"));
        await page.keyboard.press("Escape");
      }
    }, inTree);
  });

  it("keeps the selected row and the value colors readable in every palette, light and dark", async () => {
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
            const label = `${mode}: ${name}`;
            const [band, inactiveBand, marker, text, string, number, literal, s2, n2, l2] =
              await contrastIn(page, [
                ["var(--tree-row-selected)", "var(--background)"],
                ["var(--tree-row-selected-inactive)", "var(--background)"],
                ["var(--tree-row-marker)", "var(--background)"],
                ["var(--foreground)", "var(--tree-row-selected)"],
                ["var(--syntax-string)", "var(--tree-row-selected)"],
                ["var(--syntax-number)", "var(--tree-row-selected)"],
                ["var(--syntax-literal-object)", "var(--tree-row-selected)"],
                ["var(--syntax-string)", "var(--background)"],
                ["var(--syntax-number)", "var(--background)"],
                ["var(--syntax-literal-object)", "var(--background)"],
              ]);
            const onCanvas = { string: s2, number: n2, literal: l2 };
            // An unfocused selection is found by its marker, a UI indicator too.
            const [inactiveMarker] = await contrastIn(page, [
              ["var(--tree-row-marker-inactive)", "var(--tree-row-selected-inactive)"],
            ]);
            expect(inactiveMarker, label).toBeGreaterThanOrEqual(3);
            // The band stands out from the canvas, and the marker beside it reads as a UI indicator (3:1).
            expect(band, label).toBeGreaterThanOrEqual(1.15);
            expect(inactiveBand, label).toBeGreaterThanOrEqual(1.1);
            expect(marker, label).toBeGreaterThanOrEqual(3);
            // Text on the selected row stays readable. Each value color stays at the 4.5:1 a
            // body text needs, or keeps 80 % of the contrast the palette gives it on the canvas.
            expect(text, label).toBeGreaterThanOrEqual(4.5);
            for (const [kind, onBand] of [
              ["string", string],
              ["number", number],
              ["literal", literal],
            ] as const) {
              const floor = Math.min(4.5, 0.8 * onCanvas[kind]!);
              expect(onBand, `${label}: ${kind}`).toBeGreaterThanOrEqual(floor);
            }
          }
        }
      },
      { path: "/settings/appearance" },
    );
  }, 120_000);
});

describe("search in the tree", () => {
  it("marks the matched text, keeps the way to a hit readable and dims the rest", async () => {
    const file = writeFixture("search.json", SAMPLE);
    await withPage(async (page) => {
      await dropFile(page, file);
      await row(page, /^orders/).waitFor();
      await row(page, /^orders/)
        .locator("[data-tree-toggle]")
        .click();
      await row(page, /^0\b/).locator("[data-tree-toggle]").click();
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Find in document").fill("knot");
      // The triangles selected `0` under orders: the search starts at the first hit after it.
      await page.locator("[data-search-count]").getByText("2 of 2").waitFor();
      const note = row(page, /^note.*first knot/);
      await note.waitFor();
      expect(await note.locator("[data-search-mark]").allTextContents()).toEqual(["knot"]);
      expect(
        await row(page, /^knots/)
          .locator("[data-search-mark]")
          .allTextContents(),
      ).toEqual(["knot"]);
      const opacity = (name: RegExp) =>
        row(page, name).evaluate((el) => Number(getComputedStyle(el).opacity));
      // `orders` and its first element lead to the hit and stay readable; unrelated rows dim.
      expect(await opacity(/^orders/)).toBe(1);
      expect(await opacity(/^0\b/)).toBe(1);
      expect(await opacity(/^note.*first knot/)).toBe(1);
      expect(await opacity(/^closed/)).toBeLessThan(0.6);
      expect(await opacity(/^1\b/)).toBeLessThan(0.6);
    }, inTree);
  });
});
