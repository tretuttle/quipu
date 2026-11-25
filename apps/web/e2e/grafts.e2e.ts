// @effect-diagnostics nodeBuiltinImport:off - reads generated temp fixture files and downloads inside Playwright E2E tests.
import * as NodeFS from "node:fs";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { runFromPalette } from "./boardsHarness";
import { createE2eFixtures, type GeneratedFixtures } from "./graftFixtures";
import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();

let fixtures: GeneratedFixtures;

beforeAll(() => {
  fixtures = createE2eFixtures();
});

afterAll(() => {
  fixtures?.cleanup();
});

async function openDropped(page: Page, path: string, waitTree = false): Promise<void> {
  await dropFile(page, path);
  if (waitTree) {
    await page.getByRole("tree", { name: "Document tree" }).waitFor({ timeout: 30_000 });
  } else {
    await page.locator("[data-map-node]").first().waitFor({ timeout: 30_000 });
  }
  await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 30_000 });
}

async function openFind(page: Page, query: string, deep = false): Promise<void> {
  await page.keyboard.press(`${MOD}+f`);
  const input = page.getByLabel("Find in document");
  await input.waitFor();
  if (deep) {
    const toggle = page.locator("[data-deep-decode]");
    await toggle.waitFor();
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      await toggle.click();
    }
  }
  await input.fill(query);
  await input.press("Enter");
}

async function ensureRightPanelOpen(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Toggle right panel" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
}

describe("Quipu extended capabilities", () => {
  it("deep-decode search finds encoded payloads in sample HARs and displays decode chain", async () => {
    await withPage(
      async (page) => {
        await openDropped(page, fixtures.smallHar, true);
        await openFind(page, "usr_8c41f0a9d2e7", true);
        await page.locator("[data-search-count]").getByText("1 of 2").waitFor({ timeout: 15_000 });

        await ensureRightPanelOpen(page);
        await page.getByRole("tab", { name: "Inspector" }).click();
        await page.locator("[data-decode-chain]").waitFor({ timeout: 10_000 });
        const chainText = await page.locator("[data-decode-chain]").textContent();
        expect(chainText).toMatch(/base64|json/i);

        await openDropped(page, fixtures.orderTraceHar, true);
        await openFind(page, "tok_smoke_decoded", true);
        await page.locator("[data-search-count]").getByText("1 of 1").waitFor({ timeout: 15_000 });
      },
      { storage: { "quipu:document-view": "tree" } },
    );
  });

  it("exact Value Trace finds 4 occurrences, edits 1, and re-traces to 3", async () => {
    await withPage(
      async (page) => {
        await openDropped(page, fixtures.smallHar, true);
        await page.keyboard.press(`${MOD}+Shift+f`);
        const pathInput = page.getByLabel("Path query");
        await pathInput.waitFor();
        await pathInput.fill("$.log.entries[10].request.headers[8].value");
        await pathInput.press("Enter");
        await page.locator("[data-path-result]").first().click();

        await ensureRightPanelOpen(page);
        await page.getByRole("tab", { name: "Inspector" }).click();
        await page.locator("[data-inspector-trace]").waitFor();
        await page.locator("[data-inspector-trace]").click();

        const tracePanel = page.locator("[data-trace-panel]");
        await tracePanel.waitFor();
        await tracePanel.getByText("4 occurrences").waitFor({ timeout: 15_000 });
        expect(await tracePanel.locator("[data-trace-occurrence]").count()).toBe(4);

        const entry10Btn = page.locator('[data-trace-entry="10"] [data-trace-occurrence]').first();
        await entry10Btn.click();
        await page.getByRole("tab", { name: "Inspector" }).click();
        await page.locator("[data-inspector]").getByRole("button", { name: "Edit" }).click();
        const editor = page.locator('[data-node-editor="panel"]').getByLabel("Value");
        await editor.fill("sess_edited_once");
        await editor.press(`${MOD}+Enter`);
        await page
          .locator('[data-node-editor="panel"]')
          .waitFor({ state: "detached", timeout: 10_000 });
        await page.locator("[data-unsaved]").waitFor({ timeout: 10_000 });

        await pathInput.fill("$.log.entries[57].request.headers[8].value");
        await pathInput.press("Enter");
        await page.locator("[data-path-result]", { hasText: "entries[57]" }).first().click();
        await page
          .locator("[data-inspector]")
          .getByText("sess_Q7mX4zR9kP2vLw8NbT3cYh6D")
          .waitFor({ timeout: 10_000 });
        await page.locator("[data-inspector-trace]").waitFor();
        await page.locator("[data-inspector-trace]").click();
        await tracePanel.getByText("3 occurrences").waitFor({ timeout: 15_000 });
        expect(await tracePanel.locator("[data-trace-occurrence]").count()).toBe(3);
      },
      { storage: { "quipu:document-view": "tree" } },
    );

    await withPage(
      async (page) => {
        await pasteText(
          page,
          JSON.stringify({ a: { tok: "arc_tok_42" }, b: { tok: "arc_tok_42" } }),
        );
        await page.locator("[data-map-node]").first().waitFor();
        await runFromPalette(page, "Expand all on map", /Expand all on map/);
        await openFind(page, "arc_tok_42", false);
        await page.locator("[data-search-count]").getByText("1 of 2").waitFor();
        await runFromPalette(page, "Trace value", /Trace value/);
        await page.locator("[data-trace-arcs] path").first().waitFor({ timeout: 10_000 });
      },
      { storage: { "quipu:document-view": "map" } },
    );
  });

  it("Show matches only filters Tree, Table, and Map and restores all rows when toggled off", async () => {
    const sample = JSON.stringify([
      { id: 1, tag: "needle_token", status: "ok" },
      { id: 2, tag: "other_alpha", status: "skip" },
      { id: 3, tag: "other_beta", status: "skip" },
    ]);
    await withPage(
      async (page) => {
        await pasteText(page, sample);
        await page.getByRole("tree", { name: "Document tree" }).waitFor();
        await openFind(page, "needle_token", false);
        await page.locator("[data-search-count]").getByText("1 of 1").waitFor();

        const toggle = page.locator("[data-match-filter]");
        await toggle.click();
        await page.waitForTimeout(150);

        const treeTextFiltered = await page
          .getByRole("tree", { name: "Document tree" })
          .textContent();
        expect(treeTextFiltered).toContain("needle_token");
        expect(treeTextFiltered).not.toContain("other_alpha");

        await page.getByLabel("Document view").getByRole("button", { name: "Table" }).click();
        await page.locator('[data-table-row="0"]').waitFor({ timeout: 10_000 });
        expect(await page.locator("[data-table-row]").count()).toBe(1);

        await page.getByLabel("Document view").getByRole("button", { name: "Map" }).click();
        await page.locator("[data-map-node]").first().waitFor();
        const filteredMapNodes = await page.locator("[data-map-node]").count();

        await toggle.click();
        await page.waitForTimeout(150);
        const restoredMapNodes = await page.locator("[data-map-node]").count();
        expect(restoredMapNodes).toBeGreaterThanOrEqual(filteredMapNodes);

        await page.getByLabel("Document view").getByRole("button", { name: "Table" }).click();
        await page
          .locator("[data-table-row-count]")
          .getByText("3 rows")
          .waitFor({ timeout: 10_000 });
        expect(await page.locator("[data-table-row]").count()).toBe(3);
      },
      { storage: { "quipu:document-view": "tree" } },
    );
  });

  it(
    "jq element mode runs over large JSON array (>64 MiB) and returns exact filtered count",
    { timeout: 60_000 },
    async () => {
      await withPage(async (page) => {
        await openDropped(page, fixtures.largeEventsJson);
        await page.keyboard.press(`${MOD}+Alt+j`);
        const jqInput = page.getByLabel("jq filter");
        await jqInput.waitFor();
        await jqInput.fill('.[] | select(.duration_ms > 4990 and .user.plan == "pro")');
        await page.locator("[data-jq-refusal]").waitFor();
        const elBtn = page.locator("[data-jq-element-run]");
        await elBtn.waitFor();
        await elBtn.click();

        await page
          .locator("[data-jq-element-status]")
          .getByText(/Processed 290,000 of 290,000/)
          .waitFor({ timeout: 45_000 });
        const output = (await page.locator("[data-jq-output]").textContent()) ?? "";
        const objects = output.match(/^}$/gm) ?? [];
        expect(objects).toHaveLength(3997);
      });
    },
  );

  it(
    "JSONPath predicate filter returns exact status >= 400 count (117) on medium HAR",
    { timeout: 45_000 },
    async () => {
      await withPage(async (page) => {
        await openDropped(page, fixtures.mediumHar);
        await page.keyboard.press(`${MOD}+Shift+f`);
        const pathInput = page.getByLabel("Path query");
        await pathInput.waitFor();
        await pathInput.fill("$.log.entries[?(@.response.status >= 400)]");
        await pathInput.press("Enter");
        await page
          .locator("[data-path-count]")
          .getByText("117 results")
          .waitFor({ timeout: 15_000 });
      });
    },
  );

  it("Compare / Diff shows { same: 5, added: 1, removed: 1, changed: 1 } and expands body diff", async () => {
    await withPage(async (page) => {
      await openDropped(page, fixtures.diffAHar);
      await page.getByLabel("Document view").getByRole("button", { name: "Compare" }).click();
      await page.locator("[data-compare-view]").waitFor();

      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page
          .locator("[data-compare-view]")
          .getByRole("button", { name: "Open file…" })
          .first()
          .click(),
      ]);
      await chooser.setFiles(fixtures.diffEHar);

      const counts = page.locator("[data-har-diff-counts]");
      await counts.waitFor({ timeout: 15_000 });
      const countsText = (await counts.textContent()) ?? "";
      expect(countsText).toContain("=5");
      expect(countsText).toContain("+1");
      expect(countsText).toContain("-1");
      expect(countsText).toContain("~1");

      const changedRow = page.locator('[data-har-class="changed"]').first();
      await changedRow.waitFor();
      await changedRow.getByRole("button").first().click();
      await changedRow.locator("[data-diff-mark]").first().waitFor({ timeout: 10_000 });
    });
  });

  it("Schema infer, local validate, refuse remote $ref with 0 network requests, and Codegen", async () => {
    const sampleDoc = JSON.stringify({
      order: { id: 0, price: 25, currency: "GBP", items: [1] },
    });

    await withPage(async (page, _context, network) => {
      await pasteText(page, sampleDoc);
      await page.locator("[data-map-node]").first().waitFor();

      await runFromPalette(page, "Infer schema", /Infer schema/);
      const schemaPanel = page.locator("[data-schema-panel]");
      await schemaPanel.waitFor({ timeout: 10_000 });
      await schemaPanel.getByRole("button", { name: "order", exact: true }).waitFor();
      await schemaPanel.getByRole("button", { name: "order", exact: true }).click();
      await page.getByLabel("Path query").waitFor();

      await schemaPanel.getByRole("button", { name: "Generate Types" }).click();
      const preview = page.locator("[data-codegen-preview]");
      await preview.waitFor({ timeout: 10_000 });
      expect(await preview.textContent()).toContain("export interface");
      await page.getByRole("tab", { name: "Rust" }).click();
      await preview.getByText(/pub struct/).waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");

      await schemaPanel.getByRole("button", { name: "Validate with Schema" }).click();
      const problemsPanel = page.locator("[data-problems-panel]");
      await problemsPanel.waitFor();
      const schemaArea = problemsPanel.getByLabel("JSON Schema");
      await schemaArea.fill(fixtures.orderSchema);
      await problemsPanel.getByRole("button", { name: "Validate" }).click();
      await problemsPanel.getByText(/problems/).waitFor({ timeout: 10_000 });

      await schemaArea.fill(fixtures.remoteSchema);
      await problemsPanel.getByRole("button", { name: "Validate" }).click();
      await problemsPanel.locator("[data-schema-error]").waitFor({ timeout: 10_000 });
      expect(network.external()).toEqual([]);
    });
  });

  it("Table view opens HAR waterfall + scrubber, sorts, filters URL, and persists inline edit through undo", async () => {
    await withPage(async (page) => {
      await openDropped(page, fixtures.smallHar);
      await page.getByLabel("Document view").getByRole("button", { name: "Table" }).click();
      await page.locator("[data-har-timeline]").waitFor({ timeout: 15_000 });
      await page.locator("[data-table-row]").first().waitFor({ timeout: 15_000 });
      expect(await page.locator("[data-har-timeline] svg").count()).toBeGreaterThan(0);
      await page
        .locator("[data-table-row] [data-har-waterfall]")
        .first()
        .waitFor({ timeout: 10_000 });
      expect(await page.locator("[data-table-row] [data-har-waterfall]").count()).toBeGreaterThan(
        0,
      );

      await page.locator('[data-column-sort="status"]').click();
      await page.waitForTimeout(100);
      const urlFilter = page.getByLabel("Filter url");
      await urlFilter.fill("/api");
      await urlFilter.press("Enter");
      await page
        .locator("[data-table-row-count]")
        .getByText(/of 147 rows/)
        .waitFor({ timeout: 10_000 });

      await page.locator("[data-clear-table-filters]").click();
      await page
        .locator("[data-table-row-count]")
        .getByText("147 rows")
        .waitFor({ timeout: 10_000 });

      const statusCell = page.locator('[data-table-cell="0:status"]');
      const before = (await statusCell.textContent())?.trim();
      await statusCell.dblclick();
      const editInput = page.locator('[data-table-row="0"]').getByLabel("Value");
      await editInput.fill("599");
      await editInput.press("Enter");
      await statusCell.getByText("599").waitFor({ timeout: 10_000 });
      await page.locator("[data-unsaved]").waitFor();

      await page.keyboard.press(`${MOD}+z`);
      await statusCell.getByText(before ?? "200").waitFor({ timeout: 10_000 });
    });
  });

  it("Sort root then search immediately without saving succeeds with exact hits", async () => {
    const unsorted = JSON.stringify({
      z: "omega_target",
      a: "alpha_target",
      m: "middle_value",
    });
    await withPage(
      async (page) => {
        await pasteText(page, unsorted);
        await page.getByRole("tree", { name: "Document tree" }).waitFor();

        await runFromPalette(page, "Sort keys", /Sort keys/);
        await page.locator("[data-unsaved]").waitFor({ timeout: 10_000 });

        await openFind(page, "alpha_target", false);
        await page.locator("[data-search-count]").getByText("1 of 1").waitFor({ timeout: 10_000 });
      },
      { storage: { "quipu:document-view": "tree" } },
    );
  });

  it("CSP blocks external hosts, High Contrast activates, and Map PNG export downloads valid <= 8192px PNG", async () => {
    const sample = JSON.stringify({
      service: { name: "quipu", status: "ok", count: 42 },
      tags: ["fast", "local"],
    });
    await withPage(async (page, _context, network) => {
      await pasteText(page, sample);
      await page.locator("[data-map-node]").first().waitFor();

      const blocked = await page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            window.addEventListener(
              "securitypolicyviolation",
              (event) => resolve(event.blockedURI),
              { once: true },
            );
            void fetch("https://elsewhere.invalid/ping").catch(() => null);
          }),
      );
      expect(blocked).toBe("https://elsewhere.invalid/ping");

      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByPlaceholder("Search commands and settings...").fill("Change theme");
      await palette
        .getByRole("option", { name: /Change theme/ })
        .first()
        .click();
      await palette
        .getByRole("option", { name: /High Contrast/ })
        .first()
        .click();
      await palette.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.documentElement.dataset.themeId === "high-contrast",
      );

      const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
      await runFromPalette(page, "Export map PNG", /Export map PNG/);
      const download = await downloadPromise;
      const filePath = await download.path();
      expect(filePath).not.toBeNull();
      const buf = NodeFS.readFileSync(filePath!);
      expect(buf.byteLength).toBeGreaterThan(64);
      expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(8192);
      expect(height).toBeLessThanOrEqual(8192);

      expect(network.external()).toEqual([]);
    });
  });
});
