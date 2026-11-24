import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { fixturePath, fixtureProblem } from "../../../scripts/fixtures/fixtures.ts";
import { expectMedianWithin, sampleRuns } from "./budget";
import { dropFile, MOD, useBrowser } from "./harness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

/** A value edit commits within this, Enter to the new value on the row. */
const EDIT_BUDGET_MS = 1000;
/** And no task on the page's main thread runs longer than this while it does. */
const LONG_TASK_BUDGET_MS = 200;

/** The two 2 GiB shapes: a HAR whose entries the eager index lists, and a flat array it cuts. */
const FIXTURES = [
  { name: "har-2g.har", path: "$.log.entries[5].request.url", key: "url" },
  { name: "json-2g-wide.json", path: "$[5].name", key: "name" },
] as const;

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });

/** Starts recording the longest main-thread task from now on. */
const watchLongTasks = (page: Page) =>
  page.evaluate(() => {
    const state = window as unknown as { longest: number; observer?: PerformanceObserver };
    state.observer?.disconnect();
    state.longest = 0;
    const since = performance.now();
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= since) state.longest = Math.max(state.longest, entry.duration);
      }
    });
    state.observer.observe({ type: "longtask" });
  });
const longestTask = (page: Page) =>
  page.evaluate(() => (window as unknown as { longest: number }).longest);

describe("editing a 2 GiB document", () => {
  for (const fixture of FIXTURES) {
    it(`commits a value edit in ${fixture.name} in well under a second, and undoes it`, async (context) => {
      const missing = fixtureProblem(fixture.name);
      if (missing !== null) context.skip(missing);
      await withPage(async (page) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await dropFile(page, fixturePath(fixture.name));
        await tree(page).waitFor({ timeout: 30_000 });
        await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 120_000 });

        // Reach the value through a path query; choosing the result selects its row in the tree.
        await page.keyboard.press(`${MOD}+Shift+f`);
        const path = page.getByLabel("Path query");
        await path.fill(fixture.path);
        await path.press("Enter");
        await page.locator("[data-path-result]").first().click();
        const row = tree(page)
          .locator('[role="treeitem"][aria-selected="true"]')
          .filter({
            has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${fixture.key}$`) }),
          });
        await row.waitFor({ timeout: 30_000 });
        const original = (await row.locator("[data-tree-value]").textContent()) ?? "";

        const samples = await sampleRuns(async (run) => {
          await row.locator("[data-tree-value]").dblclick();
          const input = tree(page).getByLabel("Value");
          await input.fill(`edited ${run}`);
          await watchLongTasks(page);
          const started = Date.now();
          await input.press("Enter");
          await row
            .locator("[data-tree-value]", { hasText: `"edited ${run}"` })
            .waitFor({ timeout: 60_000 });
          return { ms: Date.now() - started, longest: await longestTask(page) };
        });
        expectMedianWithin(
          `${fixture.name}: value edit, Enter to the new value on the row`,
          samples.map((sample) => sample.ms),
          EDIT_BUDGET_MS,
        );
        expectMedianWithin(
          `${fixture.name}: longest main-thread task during the edit`,
          samples.map((sample) => sample.longest),
          LONG_TASK_BUDGET_MS,
        );

        // Each undo steps back one edit, to the original value.
        await row.click();
        for (let run = samples.length - 2; run >= -1; run--) {
          await page.keyboard.press(`${MOD}+z`);
          const expected = run >= 0 ? `"edited ${run}"` : original;
          await row
            .locator("[data-tree-value]", { hasText: expected })
            .waitFor({ timeout: 60_000 });
        }
        expect(errors).toEqual([]);
      }, inTree);
    }, 900_000);
  }
});
