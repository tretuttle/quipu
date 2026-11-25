// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BUILT_IN_THEMES } from "@quipu/shared/themePalettes";
import { syntaxTableForAppearance, type SyntaxTable } from "@quipu/shared/syntaxTable";
import { parse as parseJsonc } from "jsonc-parser";
import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { parseVsCodeThemeFile } from "../src/vscodeThemeImport";
import { expectMedianWithin, sampleRuns } from "./budget";
import { cachedHar, skipWithout, useSmallFixture } from "./fixtures";
import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
// The map is the default view; these tests drive the tree beside the source.
const inTree = { storage: { "quipu:document-view": "tree" } };

const harOneMegabyte = useSmallFixture("har-1m.har");
const HAR_2G = cachedHar("har-2g.har");
const THEME_FIXTURES = new URL("../src/testFixtures/open-vsx/", import.meta.url).pathname;

const sourceToggle = (page: Page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Source" });
const treeToggle = (page: Page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Tree" });
const mainSource = (page: Page) => page.locator("[data-source-view]").first();
const rows = (scope: Locator) => scope.locator("[data-row-start]");

/** `#rrggbb[aa]` the way Chromium reports a computed color. */
function cssColor(hex: string): string {
  const digits = hex.replace("#", "");
  const full =
    digits.length === 3 || digits.length === 4
      ? [...digits].map((digit) => digit + digit).join("")
      : digits;
  const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);
  const alpha = full.length === 8 ? channel(6) / 255 : 1;
  return alpha === 1
    ? `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`
    : `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${Number(alpha.toFixed(3))})`;
}

function prettyList(count: number) {
  return JSON.stringify(
    {
      title: "list",
      items: Array.from({ length: count }, (_, id) => ({
        id,
        name: `item ${id}`,
        tags: ["a", "b"],
        active: id % 2 === 0,
      })),
    },
    null,
    2,
  );
}

describe("the source view", () => {
  it("shows a pasted document as text with line numbers, colored by the theme", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ name: "quipu", count: 3, ok: true }, null, 2));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await sourceToggle(page).click();
      const view = mainSource(page);
      await page.locator('[data-source-view][data-highlighter="shiki"]').waitFor();
      expect(await rows(view).locator("[data-row-code]").allTextContents()).toEqual([
        "{",
        '  "name": "quipu",',
        '  "count": 3,',
        '  "ok": true',
        "}",
      ]);
      expect(await rows(view).locator("[data-row-gutter]").allTextContents()).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
      // pierre-light's colors, through the source-view theme: key, string, number, literal.
      const colorOf = (text: string) =>
        view
          .locator("[data-row-code] span", { hasText: new RegExp(`^${text}$`) })
          .first()
          .evaluate((element) => getComputedStyle(element).color);
      expect(await colorOf('"name"')).toBe("rgb(213, 81, 47)");
      expect(await colorOf('"quipu"')).toBe("rgb(25, 159, 67)");
      expect(await colorOf("3")).toBe("rgb(28, 161, 199)");
      expect(await colorOf("true")).toBe("rgb(28, 161, 199)");
    }, inTree);
  });

  it("is reachable from the toggle, the chord, the palette and the right panel", async () => {
    await withPage(async (page) => {
      await pasteText(page, prettyList(3));
      const tree = page.getByRole("tree", { name: "Document tree" });
      await tree.waitFor();

      await sourceToggle(page).click();
      await mainSource(page).waitFor();
      expect(await tree.count()).toBe(0);

      await page.keyboard.press(`${MOD}+Alt+2`);
      await tree.waitFor();
      expect(await page.locator("[data-source-view]").count()).toBe(0);

      await page.keyboard.press(`${MOD}+Alt+3`);
      await mainSource(page).waitFor();
      await page.keyboard.press(`${MOD}+Alt+2`);
      await tree.waitFor();

      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("option", { name: /Show source view/ }).click();
      await mainSource(page).waitFor();
      await treeToggle(page).click();
      await tree.waitFor();

      await page.keyboard.press(`${MOD}+Alt+b`);
      await page.getByRole("tab", { name: "Source" }).click();
      const panel = page.getByRole("complementary", { name: "Right panel" });
      await panel.locator("[data-source-view]").waitFor();
      expect(await rows(panel).first().locator("[data-row-code]").textContent()).toBe("{");
    }, inTree);
  });

  it("scrolls to a node chosen in the tree and highlights it, and answers a click with the node", async () => {
    await withPage(async (page) => {
      await pasteText(page, prettyList(400));
      const tree = page.getByRole("tree", { name: "Document tree" });
      await tree.getByRole("treeitem", { name: /^items/ }).waitFor();
      await page.keyboard.press(`${MOD}+Alt+b`);
      await page.getByRole("tab", { name: "Source" }).click();
      const panel = page.getByRole("complementary", { name: "Right panel" });
      const source = panel.locator("[data-source-view]");
      await source.waitFor();

      // Walk to items[150] by keyboard: the tree shares what it lands on with the source.
      const items = tree.getByRole("treeitem", { name: /^items/ });
      await items.focus();
      await page.keyboard.press("ArrowRight");
      await tree.getByRole("treeitem", { name: /^0\b/ }).waitFor();
      await page.keyboard.press("ArrowRight");
      await tree.getByRole("treeitem", { selected: true, name: /^0\b/ }).waitFor();
      // One press at a time: each lands before the next, as a person's would.
      for (let step = 1; step <= 150; step++) {
        await page.keyboard.press("ArrowDown");
        await tree
          .getByRole("treeitem", { selected: true, name: new RegExp(`^${step}\\b`) })
          .waitFor();
      }
      await tree.getByRole("treeitem", { selected: true, name: /^150/ }).waitFor();

      // The element's bytes are on screen and marked, starting at its opening brace.
      await source.locator("[data-selected]").first().waitFor();
      const marked = await source.locator("[data-selected]").allTextContents();
      expect(marked.join("")).toContain('"id": 150');
      expect(marked[0]?.startsWith("{")).toBe(true);
      expect(await source.locator("[data-row-code]", { hasText: '"id": 150' }).count()).toBe(1);

      // A click on another element's value in the source moves the tree to that node.
      const target = source.locator("[data-row-code] span", { hasText: /^"item 152"$/ }).first();
      await target.waitFor();
      await target.click();
      await tree.getByRole("treeitem", { selected: true, name: /name.*item 152/ }).waitFor();
    }, inTree);
  });

  it("colors a document too big for shiki from the structural index", async () => {
    await withPage(async (page) => {
      expect(NodeFS.statSync(harOneMegabyte()).size).toBeGreaterThan(1024 * 1024);
      await dropFile(page, harOneMegabyte());
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await sourceToggle(page).click();
      const view = page.locator('[data-source-view][data-highlighter="index"]');
      await view.waitFor();
      const keyColor = await view
        .locator("[data-row-code] span", { hasText: /^"log"$/ })
        .first()
        .evaluate((element) => getComputedStyle(element).color)
        .catch(() => null);
      // The HAR is one line: rows are cut, and the first row holds the opening of the log.
      const first = await rows(view).first().locator("[data-row-code]").textContent();
      expect(first?.startsWith('{"log":{"version":"1.2"')).toBe(true);
      expect(keyColor).toBe("rgb(213, 81, 47)");
    }, inTree);
  });
});

/** A document with every kind of token, small enough to be on screen at once. */
const EQUALITY_DOCUMENT = `{
  "name": "quipu",
  "tags": ["a", "b", true, false, null, 1, -2.5e+3, 0.25],
  "meta": {"ok": true, "none": null, "list": [[1, 2], [true], {"deep": [null, {"inner": false}]}]},
  "empty": {}, "nothing": [], "blank": "",
  "escapes": {"quote\\"key": "line\\nbreak \\u00e9 \\\\ \\/ \\t", "café": "𐍈 café", "{": "}", "true": "true", "1": 1},
  "stringified": "{\\"a\\":true,\\"b\\":[null]}",
  "ten": {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": {"j": {"k": true, "m": [1]}}}}}}}}}}}
}`;

interface Painted {
  readonly rows: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly color: string }>>;
}

async function paintedRows(page: Page, cell: "shiki" | "index"): Promise<Painted> {
  return page.evaluate((mode) => {
    const host = document.querySelector(`[data-equality-cell="${mode}"]`);
    if (host === null) throw new Error(`No ${mode} view`);
    const rows = [...host.querySelectorAll("[data-row-code]")].map((row) =>
      [...row.children].map((span) => ({
        text: span.textContent ?? "",
        color: getComputedStyle(span).color,
      })),
    );
    return { rows };
  }, cell);
}

/** One color per character, row by row. */
const perCharacter = (painted: Painted) =>
  painted.rows.map((row) => row.flatMap((run) => [...run.text].map(() => run.color)));

describe("the structural index and shiki", () => {
  const recorded = [
    { label: "Dracula", file: "theme-dracula.json" },
    { label: "Catppuccin Mocha", file: "theme-catppuccin-mocha.json" },
    { label: "Nord", file: "theme-nord.json" },
    { label: "Tokyo Night", file: "theme-tokyo-night.json" },
  ] as const;

  async function openEquality(page: Page) {
    await pasteText(page, EQUALITY_DOCUMENT);
    await page.getByRole("tree", { name: "Document tree" }).waitFor();
    // A string, so the test runner leaves the page's own `import()` alone.
    await page.evaluate(`(async () => {
      const harness = await import("/e2e/sourceHarness.tsx");
      window.__equality = harness;
      window.__unmount = harness.mountEquality();
    })()`);
  }

  async function settle(page: Page, theme: string) {
    await page
      .locator(`[data-equality-cell="shiki"] [data-source-view][data-theme="${theme}"]`)
      .waitFor();
    await page.locator('[data-equality-cell="shiki"] [data-highlighter="shiki"]').waitFor();
  }

  /** Both views draw the same characters in the same colors, and those are the table's. */
  async function expectEqual(page: Page, table: SyntaxTable, label: string) {
    const shiki = await paintedRows(page, "shiki");
    const index = await paintedRows(page, "index");
    expect(perCharacter(index), label).toEqual(perCharacter(shiki));
    const colors = new Set(perCharacter(shiki).flat());
    expect(colors.size, `${label} paints several colors`).toBeGreaterThanOrEqual(4);
    // The color of the character `at` places into the first occurrence of `text`.
    const colorOf = (text: string, at: number) => {
      const colorRows = perCharacter(shiki);
      for (const [index, row] of shiki.rows.entries()) {
        const found = row
          .map((run) => run.text)
          .join("")
          .indexOf(text);
        if (found >= 0) return colorRows[index]?.[found + at] ?? null;
      }
      return null;
    };
    expect(colorOf('"name"', 1), `${label} key`).toBe(cssColor(table.keyBody[0]));
    expect(colorOf('"quipu"', 1), `${label} string`).toBe(cssColor(table.stringBody));
    expect(colorOf("-2.5e+3", 0), `${label} number`).toBe(cssColor(table.number));
  }

  it("paint every character the same under all 8 built-in palettes", async () => {
    await withPage(async (page) => {
      await openEquality(page);
      const palettes = [{ id: "system", label: "Graphite", syntax: undefined }].concat(
        BUILT_IN_THEMES.map((theme) => ({
          id: theme.id,
          label: theme.label,
          syntax: theme.syntax,
        })),
      );
      expect(palettes).toHaveLength(8);
      for (const palette of palettes) {
        for (const appearance of ["light", "dark"] as const) {
          await page.evaluate(
            ([id, mode]) =>
              (
                window as unknown as {
                  __equality: { paintBuiltInTheme: (id: string, mode: string) => void };
                }
              ).__equality.paintBuiltInTheme(id as string, mode as string),
            [palette.id, appearance],
          );
          await settle(page, `${appearance}:${palette.id === "system" ? "" : palette.id}`);
          await expectEqual(
            page,
            syntaxTableForAppearance(palette.syntax, appearance),
            `${palette.label} ${appearance}`,
          );
        }
      }
    }, inTree);
  });

  it("paint every character the same under 4 recorded Open VSX themes", async () => {
    await withPage(async (page) => {
      await openEquality(page);
      for (const theme of recorded) {
        const source = NodeFS.readFileSync(NodePath.join(THEME_FIXTURES, theme.file), "utf8");
        const definition = parseVsCodeThemeFile(parseJsonc(source));
        const id = await page.evaluate(
          (json) =>
            (
              window as unknown as { __equality: { paintRecordedTheme: (json: string) => string } }
            ).__equality.paintRecordedTheme(json),
          JSON.stringify(parseJsonc(source)),
        );
        expect(id).toBe(definition.id);
        await settle(page, `${definition.appearance}:${id}`);
        await expectEqual(
          page,
          syntaxTableForAppearance(definition.syntax, definition.appearance),
          theme.label,
        );
      }
    }, inTree);
  });
});

describe("recoloring", () => {
  it("recolors the visible lines when the theme changes in another window", async () => {
    await withPage(async (page, context) => {
      await pasteText(page, JSON.stringify({ name: "quipu" }, null, 2));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await sourceToggle(page).click();
      const view = mainSource(page);
      const key = () =>
        view
          .locator("[data-row-code] span", { hasText: /^"name"$/ })
          .first()
          .evaluate((element) => getComputedStyle(element).color);
      await page.locator('[data-source-view][data-highlighter="shiki"]').waitFor();
      expect(await key()).toBe("rgb(213, 81, 47)");

      const other = await context.newPage();
      await other.goto(page.url());
      await other.evaluate(() => {
        window.localStorage.setItem("quipu:theme-appearance-mode", "dark");
      });
      await other.close();
      await page.waitForFunction(
        () =>
          document
            .querySelector("[data-source-view]")
            ?.getAttribute("data-theme")
            ?.startsWith("dark:") === true,
      );
      await page.locator('[data-source-view][data-highlighter="shiki"]').waitFor();
      // pierre-dark's key color.
      expect(await key()).toBe("rgb(255, 133, 94)");
    }, inTree);
  });
});

describe("a 2 GiB HAR", () => {
  const LIMIT = 300;

  /** The byte range of the one string longer than `minimum` bytes, found without loading the file. */
  function bigString(file: string, minimum: number): { start: number; end: number } {
    const descriptor = NodeFS.openSync(file, "r");
    try {
      const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
      let position = 0;
      let lastQuote = -1;
      for (;;) {
        const read = NodeFS.readSync(descriptor, chunk, 0, chunk.length, position);
        if (read === 0) break;
        let at = chunk.indexOf(0x22);
        while (at >= 0 && at < read) {
          const absolute = position + at;
          if (lastQuote >= 0 && absolute - lastQuote > minimum) {
            return { start: lastQuote + 1, end: absolute };
          }
          lastQuote = absolute;
          at = chunk.indexOf(0x22, at + 1);
        }
        position += read;
      }
    } finally {
      NodeFS.closeSync(descriptor);
    }
    throw new Error("no string that long");
  }

  it("shows the 600 MiB body's first screen within 300 ms, reaches the end and any offset", async (context) => {
    skipWithout(context, HAR_2G);
    const size = NodeFS.statSync(HAR_2G.path).size;
    expect(size).toBeGreaterThanOrEqual(HAR_2G.spec.minBytes);
    const body = bigString(HAR_2G.path, HAR_2G.spec.bigBodyChars / 2);
    expect(body.end - body.start).toBeGreaterThanOrEqual(HAR_2G.spec.bigBodyChars);

    await withPage(async (page) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await dropFile(page, HAR_2G.path);
      await page.getByRole("tree", { name: "Document tree" }).waitFor({ timeout: 30_000 });
      await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 60_000 });

      // Select the body node the way the tree does when its row takes focus.
      await page.evaluate(`(async () => {
        const { useDocumentSession } = await import("/src/documents/documentSession.ts");
        const { useSelectionStore } = await import("/src/documents/selectionStore.ts");
        const { session } = useDocumentSession.getState();
        if (session.phase !== "open") throw new Error("no document");
        const { path } = await session.document.source.nodeAt(${body.start + 1000});
        const node = path[path.length - 1]?.node;
        if (node === undefined) throw new Error("no node at the body");
        useSelectionStore.getState().select({
          documentId: node.ref.documentId,
          ref: node.ref,
          range: { start: node.key ?? node.range.start, end: node.range.end },
          origin: "tree",
          path: null,
        });
      })()`);

      // From the click on the toggle to rows of the body on screen (median of 5 runs).
      const samples = await sampleRuns(async (run) => {
        if (run > 0) {
          await treeToggle(page).click();
          await page.getByRole("tree", { name: "Document tree" }).waitFor();
        }
        const elapsed = await page.evaluate(
          ([from, to]) =>
            new Promise<number>((resolve, reject) => {
              const toggle = [
                ...document.querySelectorAll('[aria-label="Document view"] button'),
              ].find((button) => button.textContent?.trim() === "Source") as
                | HTMLElement
                | undefined;
              if (toggle === undefined) {
                reject(new Error("no Source toggle"));
                return;
              }
              const started = performance.now();
              const check = () => {
                const view = document.querySelector("[data-source-view]");
                const first = Number(view?.getAttribute("data-first-row-start") ?? Number.NaN);
                const shown = document.querySelectorAll("[data-row-start]").length;
                if (
                  view?.getAttribute("data-state") === "ready" &&
                  first >= from &&
                  first < to &&
                  shown > 0
                ) {
                  observer.disconnect();
                  resolve(performance.now() - started);
                }
              };
              const observer = new MutationObserver(check);
              observer.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
              });
              toggle.click();
            }),
          [body.start - 10_000_000, body.end] as const,
        );
        return elapsed;
      });
      expectMedianWithin("har-2g: Source on the 600 MiB body, first screen", samples, LIMIT);

      const view = mainSource(page);
      // The member is marked from its key, and the rows below it are the base64 body.
      const marked = (await view.locator("[data-selected]").allTextContents()).join("");
      expect(marked.startsWith('"text":"')).toBe(true);
      const lastRow = rows(view).last();
      expect(await lastRow.locator("[data-row-code]").textContent()).toMatch(/^[A-Za-z0-9+/=]+$/);
      // Past the line-counting limit the gutter shows the row's byte offset instead.
      expect(await lastRow.locator("[data-row-gutter]").textContent()).toBe(
        await lastRow.getAttribute("data-row-start"),
      );

      // The end of the file.
      await view.getByRole("document", { name: "Document text" }).focus();
      await page.keyboard.press("End");
      await page.waitForFunction((total) => {
        const last = [...document.querySelectorAll("[data-row-end]")].at(-1);
        // The file ends with a newline, which belongs to no row.
        return Number(last?.getAttribute("data-row-end")) === total - 1;
      }, size);
      const lastText = await rows(view).last().locator("[data-row-code]").textContent();
      expect(lastText?.endsWith("}}")).toBe(true);

      // Any offset: the middle of the file, through the scrollbar.
      const track = view.getByRole("scrollbar", { name: "Document position" });
      const box = await track.boundingBox();
      if (box === null) throw new Error("no scrollbar");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5);
      await page.waitForFunction((total) => {
        const first = Number(
          document.querySelector("[data-source-view]")?.getAttribute("data-first-row-start"),
        );
        return first > total * 0.45 && first < total * 0.55;
      }, size);
      expect(errors).toEqual([]);
    }, inTree);
  }, 300_000);
});
