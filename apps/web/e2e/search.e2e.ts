// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";

import type { Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { expectMedianWithin, sampleRuns } from "./budget";
import { cachedHar, skipWithout } from "./fixtures";
import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
// The map is the default view; these tests drive the tree beside the source.
const inTree = { storage: { "quipu:document-view": "tree" } };

const HAR_2G = cachedHar("har-2g.har");
const SEARCH_BUDGET_MS = 2000;

const findInput = (page: Page) => page.getByLabel("Find in document");
const sourceToggle = (page: Page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Source" });
const treeToggle = (page: Page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Tree" });

function items(count: number) {
  return JSON.stringify(
    {
      title: "list",
      items: Array.from({ length: count }, (_, id) => ({ id, name: `item ${id}`, tags: ["a"] })),
    },
    null,
    2,
  );
}

async function openFind(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+f`);
  await findInput(page).waitFor();
  await findInput(page).fill(text);
  await findInput(page).press("Enter");
}

describe("find in the tree and the source", () => {
  it("counts hits, lights them and dims the rest, and steps with the keys", async () => {
    await withPage(async (page) => {
      await pasteText(page, items(400));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await openFind(page, "item 3");
      await page.getByText("1 of 111", { exact: true }).waitFor();

      // The tree opened the way to the first hit: its row is lit, the rows on the way stay
      // readable and the others are dimmed.
      const lit = page.locator('[role="treeitem"][data-hit]');
      await lit.first().waitFor();
      expect(await lit.first().textContent()).toContain("item 3");
      const dim = await page
        .locator('[role="treeitem"]:not([data-hit]):not([data-hit-path])')
        .first()
        .evaluate((element) => Number(getComputedStyle(element).opacity));
      expect(dim).toBeLessThan(1);

      await page.keyboard.press("F3");
      await page.getByText("2 of 111", { exact: true }).waitFor();
      await page.keyboard.press("Shift+F3");
      await page.keyboard.press("Shift+F3");
      await page.getByText("111 of 111", { exact: true }).waitFor();

      // The Source shows the same hits: the current one is marked, the text around it dimmed.
      await sourceToggle(page).click();
      const current = page.locator('[data-source-view] [data-hit="current"]').first();
      await current.waitFor();
      expect(await current.textContent()).toBe("item 3");
      const box = await current.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? -1) >= 0 && (box?.y ?? 9999) < 800).toBe(true);
      const around = await page
        .locator("[data-source-view] [data-row-code] span:not([data-hit])")
        .first()
        .evaluate((element) => Number(getComputedStyle(element).opacity));
      expect(around).toBeLessThan(1);
      await page.keyboard.press(`${MOD}+g`);
      await page.getByText("1 of 111", { exact: true }).waitFor();
      expect(
        await page.locator('[data-source-view] [data-hit="current"]').first().textContent(),
      ).toBe("item 3");
    }, inTree);
  });

  it("searches by regular expression, with case, and says what is wrong with a pattern", async () => {
    await withPage(async (page) => {
      await pasteText(page, items(400));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await openFind(page, "ITEM 3");
      await page.getByText("1 of 111", { exact: true }).waitFor();
      await page.getByLabel("Match case").click();
      await page.getByText("No matches", { exact: true }).waitFor();
      await page.getByLabel("Match case").click();
      await page.getByText("1 of 111", { exact: true }).waitFor();

      await page.getByLabel("Use regular expression").click();
      await findInput(page).fill("item 3\\d\\d\\b");
      await page.getByText("1 of 100", { exact: true }).waitFor();
      await findInput(page).fill("(");
      await page
        .getByRole("alert")
        .filter({ hasText: /regular expression/i })
        .waitFor();
      await findInput(page).fill('^\\s+"id": 39\\d?,?$');
      await page.getByText(/^\d+ of 11$/).waitFor();
    }, inTree);
  });

  it("matches the text of a string that holds JSON, and covers its escapes in the hit", async () => {
    await withPage(async (page) => {
      const inner = JSON.stringify({ error: "café", code: 7 });
      await pasteText(page, JSON.stringify({ body: inner, note: "café" }, null, 2));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await sourceToggle(page).click();
      await openFind(page, '"error":"café"');
      await page.getByText("1 of 1", { exact: true }).waitFor();
      const hit = page.locator('[data-source-view] [data-hit="current"]');
      await hit.first().waitFor();
      // The file holds \"error\":\"café\"; the hit covers exactly that.
      expect((await hit.allTextContents()).join("")).toBe('\\"error\\":\\"café\\"');
    }, inTree);
  });
});

describe("a pattern that backtracks", () => {
  it("is stopped at its time budget, says so, and leaves search working", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({ trap: `${"a".repeat(40)}!`, other: "needle" }, null, 2),
      );
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Use regular expression").click();
      await findInput(page).fill('^\\s*"trap": "(a+)+$');
      await findInput(page).press("Enter");
      await page.getByText(/skipped: the pattern took too long/).waitFor({ timeout: 30_000 });

      await findInput(page).fill("needle");
      await findInput(page).press("Enter");
      await page.getByText("1 of 1", { exact: true }).waitFor();
    }, inTree);
  }, 60_000);
});

describe("path queries and jq", () => {
  it("shows a path query's results and selects one in the tree", async () => {
    await withPage(async (page) => {
      await pasteText(page, items(40));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await page.keyboard.press(`${MOD}+Shift+f`);
      const input = page.getByLabel("Path query");
      await input.waitFor();
      await input.fill("$.items[*].name");
      await input.press("Enter");
      await page.getByText("40 results", { exact: true }).waitFor();
      const results = page.locator("[data-path-result]");
      await results.first().waitFor();
      // Each result names where it sits, then what it holds.
      expect(await results.first().textContent()).toBe("$.items[0].nameitem 0");

      await input.fill("$..tags[0]");
      await input.press("Enter");
      await page.getByText("40 results", { exact: true }).waitFor();

      await input.fill("$.items[?(@.id)]");
      await input.press("Enter");
      await page.getByText("40 results", { exact: true }).waitFor();

      await input.fill("$[(@.length-1)]");
      await input.press("Enter");
      await page
        .getByRole("alert")
        .filter({ hasText: /jq bar/ })
        .waitFor();

      await input.fill("$.items[-1].name");
      await input.press("Enter");
      await page.getByText("1 result", { exact: true }).waitFor();
      await page.locator("[data-path-result]").first().click();
      await page
        .locator('[role="treeitem"][aria-selected="true"]', { hasText: "item 39" })
        .first()
        .waitFor();
    }, inTree);
  });

  it("runs jq on the selected node and refuses one that is too large", async () => {
    await withPage(async (page) => {
      await pasteText(page, items(40));
      await page.getByRole("tree", { name: "Document tree" }).waitFor();
      await page.keyboard.press(`${MOD}+Alt+j`);
      const program = page.getByLabel("jq filter");
      await program.waitFor();
      await program.fill(".items | length");
      await program.press("Enter");
      const output = page.locator("[data-jq-output]");
      await output.waitFor();
      expect((await output.textContent())?.trim()).toBe("40");

      await program.fill(".items[0] | .name | ascii_upcase");
      await program.press("Enter");
      await page.locator('[data-jq-output]:has-text("ITEM 0")').waitFor();

      await program.fill("bogus(");
      await program.press("Enter");
      await page.locator("[data-jq-error]").waitFor();

      await program.fill("last(range(100000000000))");
      await program.press("Enter");
      await page
        .locator("[data-jq-error]")
        .filter({ hasText: /did not finish/ })
        .waitFor({
          timeout: 30_000,
        });
    }, inTree);
  }, 60_000);
});

describe("search on the 2 GiB HAR", () => {
  /** Non-overlapping count of `needle` in the file, read in 64 MiB pieces. */
  function countInFile(needle: string) {
    const bytes = Buffer.from(needle);
    const descriptor = NodeFS.openSync(HAR_2G.path, "r");
    const piece = Buffer.alloc(64 * 1024 * 1024 + bytes.length);
    let count = 0;
    let position = 0;
    let carry = 0;
    try {
      for (;;) {
        const read = NodeFS.readSync(descriptor, piece, carry, piece.length - carry, position);
        if (read === 0) break;
        const end = carry + read;
        let at = piece.indexOf(bytes, 0);
        let consumed = 0;
        while (at >= 0 && at + bytes.length <= end) {
          count++;
          consumed = at + bytes.length;
          at = piece.indexOf(bytes, consumed);
        }
        // Keep a tail so a hit across the piece edge is counted once.
        const keep = Math.min(end - consumed, bytes.length - 1);
        piece.copy(piece, 0, end - keep, end);
        carry = keep;
        position += read;
      }
    } finally {
      NodeFS.closeSync(descriptor);
    }
    return count;
  }

  it("counts every hit within 2 s of submit, and regex, next and previous work", async (context) => {
    skipWithout(context, HAR_2G);
    const needle = "application/json";
    const expected = countInFile(needle);
    expect(expected).toBeGreaterThan(1000);
    await withPage(async (page) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await dropFile(page, HAR_2G.path);
      await page.getByRole("tree", { name: "Document tree" }).waitFor({ timeout: 30_000 });
      await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 60_000 });

      await page.keyboard.press(`${MOD}+f`);
      const input = findInput(page);
      await input.waitFor();
      const samples = await sampleRuns(async () => {
        await input.fill("");
        await input.fill(needle);
        // Arm a clock that starts at the Enter keydown and stops in the frame after the
        // count on screen is the whole total.
        await page.evaluate((total) => {
          const field = document.querySelector<HTMLInputElement>('[aria-label="Find in document"]');
          const counter = document.querySelector("[data-search-count]");
          if (field === null || counter === null) throw new Error("no find bar");
          (window as unknown as { __searchMs: Promise<number> }).__searchMs = new Promise<number>(
            (resolve) => {
              let started = 0;
              const observer = new MutationObserver(() => {
                const text = counter.textContent ?? "";
                if (started > 0 && (text === `${total} matches` || text.endsWith(` of ${total}`))) {
                  observer.disconnect();
                  requestAnimationFrame(() => resolve(performance.now() - started));
                }
              });
              observer.observe(counter, { subtree: true, childList: true, characterData: true });
              field.addEventListener(
                "keydown",
                (event) => {
                  if (event.key === "Enter") started = event.timeStamp;
                },
                { capture: true, once: true },
              );
            },
          );
        }, expected.toLocaleString("en-US"));
        await input.press("Enter");
        const elapsed = await page.evaluate(
          () => (window as unknown as { __searchMs: Promise<number> }).__searchMs,
        );
        await page.getByText(`1 of ${expected.toLocaleString("en-US")}`, { exact: true }).waitFor();
        return elapsed;
      });
      expectMedianWithin(
        `har-2g: literal search, ${expected.toLocaleString("en-US")} hits on screen`,
        samples,
        SEARCH_BUDGET_MS,
      );
      await page.getByText(`1 of ${expected.toLocaleString("en-US")}`, { exact: true }).waitFor();

      // Next and previous move through the tree and the source.
      await page.keyboard.press("F3");
      await page.getByText(`2 of ${expected.toLocaleString("en-US")}`, { exact: true }).waitFor();
      await page
        .locator('[role="treeitem"][data-hit]', { hasText: "application/json" })
        .first()
        .waitFor();
      await sourceToggle(page).click();
      const current = page.locator('[data-source-view] [data-hit="current"]');
      await current.first().waitFor();
      // A hit can run across a wrapped row's end: its pieces together are the needle.
      expect((await current.allTextContents()).join("")).toBe(needle);
      const firstBefore = await page
        .locator("[data-source-view]")
        .first()
        .getAttribute("data-first-row-start");
      for (let n = 0; n < 5; n++) await page.keyboard.press("F3");
      await page.getByText(`7 of ${expected.toLocaleString("en-US")}`, { exact: true }).waitFor();
      await page.locator('[data-source-view] [data-hit="current"]').first().waitFor();
      const firstAfter = await page
        .locator("[data-source-view]")
        .first()
        .getAttribute("data-first-row-start");
      expect(firstAfter).not.toBe(firstBefore);
      await page.keyboard.press("Shift+F3");
      await page.getByText(`6 of ${expected.toLocaleString("en-US")}`, { exact: true }).waitFor();
      await treeToggle(page).click();
      await page.locator('[role="treeitem"][data-hit]').first().waitFor();

      // The same hits, found as a regular expression, are as many.
      await page.getByLabel("Use regular expression").click();
      await input.fill("application/js[o]n");
      await page.getByText(`of ${expected.toLocaleString("en-US")}`).waitFor({ timeout: 60_000 });

      // jq on the whole 2 GiB document is refused, in words, without reading it.
      await page.getByRole("treeitem").first().click();
      await page.keyboard.press("Home");
      await page.locator('[role="treeitem"][aria-level="1"][aria-selected="true"]').waitFor();
      await page.keyboard.press(`${MOD}+Alt+j`);
      const program = page.getByLabel("jq filter");
      await program.fill(".");
      await program.press("Enter");
      const refusal = page.locator("[data-jq-refusal]");
      await refusal.waitFor();
      expect(await refusal.textContent()).toContain("jq runs on up to");
      expect(errors).toEqual([]);
    }, inTree);
  }, 300_000);
});
