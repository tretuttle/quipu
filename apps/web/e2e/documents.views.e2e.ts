// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { mapNode, mapRowOf, toggleRowOf } from "./mapHarness";

const withPage = useBrowser();
const inTree = { storage: { "quipu:document-view": "tree" } };

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-documents-views-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(name: string, contents: string | Uint8Array): string {
  const file = NodePath.join(scratch, name);
  NodeFS.writeFileSync(file, contents);
  return file;
}

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name });
const inspector = (page: Page) => page.locator("[data-inspector]");
const toggleOf = (page: Page, name: RegExp) => row(page, name).locator("[data-tree-toggle]");

/** The start of an MP4 file: a `ftyp` box, then bytes that are no image. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom", "latin1"),
  Buffer.alloc(200, 7),
]);
/** A 1×1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const LONG_FRAME = `${"lorem ipsum dolor sit amet ".repeat(30)}end`;

const CAPTURE = JSON.stringify({
  vendor: { name: "Holzhaus", city: "Basel", tags: ["wood"] },
  cursor: "eyJwYWdlIjoyfQ==",
  icon_b64: PNG,
  content: { mimeType: "video/mp4", encoding: "base64", text: MP4.toString("base64") },
  _webSocketMessages: [
    { type: "send", time: 1_700_000_000.123, opcode: 1, data: LONG_FRAME },
    { type: "receive", time: 1_700_000_001.5, opcode: 2, data: MP4.toString("base64") },
  ],
});

async function openInspector(page: Page) {
  await page.keyboard.press(`${MOD}+Alt+b`);
  await page
    .locator("[data-right-panel]")
    .or(page.getByRole("region", { name: "Right panel" }))
    .first()
    .waitFor();
}

describe("the Inspector", () => {
  it("lists a container's first members, open or closed, colored by type", async () => {
    await withPage(async (page) => {
      await pasteText(page, CAPTURE);
      await row(page, /^vendor/).click();
      await openInspector(page);
      const members = inspector(page).locator("[data-inspector-members]");
      await members.waitFor();
      expect(
        (await members.locator("li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")),
      ).toEqual(['name : "Holzhaus"', 'city : "Basel"', "tags : [] 1 items"]);
      const city = members.locator("li").nth(1).locator("span").last();
      expect(await city.evaluate((el) => getComputedStyle(el).color)).toBe(
        await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--syntax-string)";
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }),
      );
      // Opened in the tree, it still lists them; the root lists its own.
      await toggleOf(page, /^vendor/).click();
      await row(page, /^city/).waitFor();
      await members.locator("li").first().getByText("name").waitFor();
      await page.keyboard.press("Home");
      await inspector(page).getByRole("heading", { name: "root" }).waitFor();
      await members.locator("li").first().getByText("vendor").waitFor();
    }, inTree);
  });

  it("keeps a decoded title whole and does not repeat it beside it", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 1100, height: 800 });
      await pasteText(page, CAPTURE);
      await row(page, /^icon_b64/).click();
      await openInspector(page);
      const region = inspector(page).getByRole("region", { name: "Decoded: base64 · image/png" });
      await region.waitFor();
      const title = region.locator("h4");
      expect(await title.textContent()).toBe("Decoded: base64 · image/png");
      expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const hint = (await region.locator("h4 + span").textContent()) ?? "";
      expect(hint).not.toContain("image/png");
      expect(hint).toMatch(/\d/);
    }, inTree);
  });

  it("summarizes binary base64 that is not an image: type, size and first bytes", async () => {
    await withPage(async (page) => {
      await pasteText(page, CAPTURE);
      await toggleOf(page, /^content/).click();
      await row(page, /^text/).click();
      await openInspector(page);
      const summary = inspector(page).locator("[data-binary-summary]");
      await summary.waitFor();
      const text = await summary.innerText();
      expect(text).toContain("video/mp4");
      expect(text).toContain("First bytes");
      expect(text.replace(/\s+/g, " ")).toMatch(/00 00 00 18 66 74 79 70/i);
      // The dump keeps its rows: one line per row of the dump, scrolled sideways, never wrapped.
      const dump = summary.locator("[data-hex-dump]");
      const shape = await dump.evaluate((el) => {
        const style = getComputedStyle(el);
        const lines = (el.textContent ?? "").split("\n").filter((line) => line !== "").length;
        const padding =
          Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        return {
          whiteSpace: style.whiteSpace,
          lines,
          drawn: Math.round((el.scrollHeight - padding) / Number.parseFloat(style.lineHeight)),
        };
      });
      expect(shape.whiteSpace).toBe("pre");
      expect(shape.drawn).toBe(shape.lines);
    }, inTree);
  });

  it("keeps a WebSocket frame's type and size on one line and shows the rest of a long text", async () => {
    await withPage(async (page) => {
      await pasteText(page, CAPTURE);
      await row(page, /^_webSocketMessages/).click();
      await openInspector(page);
      const frames = inspector(page).getByRole("region", { name: "WebSocket frames" });
      await frames.locator("[data-frame]").nth(1).waitFor();
      for (const frame of await frames.locator("[data-frame]").all()) {
        const header = frame.locator("div").first();
        const height = await header.evaluate((el) => el.getBoundingClientRect().height);
        const size = await frame
          .locator("[data-frame-size]")
          .evaluate((el) => el.getClientRects().length);
        expect(height).toBeLessThan(28);
        expect(size).toBe(1);
      }
      const first = frames.locator("[data-frame]").first();
      const text = first.locator("[data-frame-text]");
      const closed = await text.evaluate((el) => el.getBoundingClientRect().height);
      await first.getByRole("button", { name: "Show more" }).click();
      const opened = await text.evaluate((el) => el.getBoundingClientRect().height);
      expect(opened).toBeGreaterThan(closed);
      await first.getByRole("button", { name: "Show less" }).waitFor();
    }, inTree);
  });
});

describe("restored unsaved edits", () => {
  const restored = (page: Page) => page.getByText(/^Restored \d+ unsaved edits?$/);

  async function editValue(page: Page, key: RegExp, text: string) {
    await row(page, key).locator("[data-tree-value]").dblclick();
    const input = tree(page).getByLabel("Value");
    await input.fill(text);
    await input.press("Enter");
    await row(page, new RegExp(`${key.source}.*${text}`)).waitFor();
  }

  it("shows one notice, for the document on screen, and drops it when another opens", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ first: 1 }));
      await editValue(page, /^first/, "2");
      page.once("dialog", (dialog) => void dialog.accept());
      await page.reload();
      await restored(page).waitFor();
      expect(await restored(page).count()).toBe(1);

      // Another document (its restored edits are let go): the first one's notice goes with it.
      await pasteText(page, JSON.stringify({ second: 1 }));
      await page
        .locator("[data-unsaved-changes-dialog]")
        .getByRole("button", { name: "Discard" })
        .click();
      await row(page, /^second/).waitFor();
      await restored(page).waitFor({ state: "detached" });

      // Its own restore shows one notice, not two stacked.
      await editValue(page, /^second/, "2");
      page.once("dialog", (dialog) => void dialog.accept());
      await page.reload();
      await restored(page).waitFor();
      await row(page, /^second.*2/).waitFor();
      expect(await restored(page).count()).toBe(1);
    }, inTree);
  });
});

describe("data: URLs", () => {
  const URLS = JSON.stringify({
    icon: `data:image/png;base64,${PNG}`,
    cursor: `data:application/json;base64,${Buffer.from('{"page":2}').toString("base64")}`,
  });

  it("previews the image a data: URL holds in the Inspector, and lists its JSON in the tree", async () => {
    await withPage(async (page) => {
      await pasteText(page, URLS);
      await row(page, /^icon/).click();
      await openInspector(page);
      const region = inspector(page).getByRole("region", { name: "Decoded: base64 · image/png" });
      await region.getByRole("img", { name: /^Decoded image\/png/ }).waitFor();
      expect(await region.locator("[data-binary-summary]").count()).toBe(0);
      // A data: URL that holds JSON opens into its members, like plain base64 does.
      await toggleOf(page, /^cursor/).click();
      await row(page, /^page.*2/).waitFor();
    }, inTree);
  });

  it("shows the same image on the map's decoded card", async () => {
    await withPage(
      async (page) => {
        await pasteText(page, URLS);
        const root = mapNode(page, /^root/);
        await root.waitFor();
        await toggleRowOf(page, root, /^icon/);
        const card = mapNode(page, /^icon .*image\/png/);
        await card.waitFor();
        const type = await mapRowOf(page, card, /^type/);
        expect(await type.textContent()).toBe("type: image/png");
        await card.locator("[data-map-preview]").waitFor();
      },
      { storage: { "quipu:document-view": "map" } },
    );
  });
});

describe("the Source view's scrollbar", () => {
  /** A small XML file: 33 lines that all fit, opened through a conversion. */
  const SMALL_XML = `<?xml version="1.0"?>\n<feed>\n${Array.from(
    { length: 30 },
    (_, n) => `  <item id="${n}">knot ${n}</item>`,
  ).join("\n")}\n</feed>\n`;

  it("shows no thumb when the whole file fits, in the view and in the right panel", async () => {
    await withPage(
      async (page) => {
        await dropFile(page, writeFixture("feed.xml", SMALL_XML));
        const main = page.locator("[data-document-workspace] [data-source-view]");
        await main.locator("[data-row-code]").filter({ hasText: "</feed>" }).waitFor();
        expect(await main.locator("[data-scroll-thumb]").count()).toBe(0);

        await openInspector(page);
        await page
          .getByRole("tab", { name: /Source/ })
          .last()
          .click();
        const panel = page
          .locator("[data-right-panel]")
          .or(page.getByRole("region", { name: "Right panel" }))
          .first();
        await panel.locator("[data-row-code]").filter({ hasText: "</feed>" }).waitFor();
        expect(await panel.locator("[data-scroll-thumb]").count()).toBe(0);
      },
      { storage: { "quipu:document-view": "source" } },
    );
  });

  it("shows a thumb when the file is longer than the view", async () => {
    const long = Array.from({ length: 400 }, (_, n) => `line ${n}`).join("\n");
    await withPage(async (page) => {
      await dropFile(page, writeFixture("long.txt", `${long}\n`));
      const main = page.locator("[data-document-workspace] [data-source-view]");
      await main
        .locator("[data-row-code]")
        .filter({ hasText: /^line 0$/ })
        .waitFor();
      await main.locator("[data-scroll-thumb]").waitFor();
    });
  });
});

describe("wrapped source rows", () => {
  it("break a long string of words between words in the right panel's Source", async () => {
    const note = Array.from({ length: 60 }, (_, n) => `w${n % 10}`).join(" ");
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ note }, null, 2));
      await row(page, /^note/).waitFor();
      await openInspector(page);
      await page
        .getByRole("tab", { name: /Source/ })
        .last()
        .click();
      const panel = page
        .locator("[data-right-panel]")
        .or(page.getByRole("region", { name: "Right panel" }))
        .first();
      await panel.locator("[data-row-code]").filter({ hasText: '"note"' }).waitFor();
      const rows = await panel
        .locator("[data-row-code]")
        .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
      const at = rows.findIndex((row) => row.includes('"note"'));
      // The note's line wraps onto several rows, and each of them ends between two words.
      const wrapped = rows.slice(at, rows.findIndex((row, i) => i > at && row.endsWith('"')) + 1);
      expect(wrapped.length).toBeGreaterThan(2);
      for (const piece of wrapped.slice(0, -1)) expect(piece, piece).toMatch(/ $/);
    }, inTree);
  });

  it("hang under their line's text in the right panel's Source", async () => {
    const email = `sales@${"clayworks-demo".repeat(6)}.example`;
    const text = JSON.stringify({ vendor: { contact: { email } } }, null, 2);
    await withPage(async (page) => {
      await pasteText(page, text);
      await row(page, /^vendor/).waitFor();
      await openInspector(page);
      await page
        .getByRole("tab", { name: /Source/ })
        .last()
        .click();
      const panel = page
        .locator("[data-right-panel]")
        .or(page.getByRole("region", { name: "Right panel" }))
        .first();
      const code = panel.locator("[data-row-code]");
      await code.filter({ hasText: '"email"' }).waitFor();
      const lefts = await panel.locator("[data-row-start]").evaluateAll((rows) =>
        rows.map((el) => ({
          text: el.querySelector("[data-row-code]")?.textContent ?? "",
          left: el.querySelector("[data-row-code]")?.getBoundingClientRect().left ?? 0,
          gutter: el.querySelector("[data-row-gutter]")?.textContent ?? "",
        })),
      );
      const at = lefts.findIndex((entry) => entry.text.includes('"email"'));
      const line = lefts[at]!;
      const next = lefts[at + 1]!;
      // The next row continues the email line (no line number) and starts right of where the line's text does.
      expect(next.gutter).toBe("");
      const indent = line.text.length - line.text.trimStart().length;
      const column = await panel
        .locator("[data-row-code]")
        .first()
        .evaluate((el) => {
          const probe = document.createElement("span");
          probe.textContent = "0".repeat(10);
          el.append(probe);
          const width = probe.getBoundingClientRect().width / 10;
          probe.remove();
          return width;
        });
      expect(next.left - line.left).toBeGreaterThanOrEqual(indent * column - 1);
    }, inTree);
  });
});

describe("documents that open with nothing or a little", () => {
  it("lists every format that opens with a structure in the empty state", async () => {
    await withPage(async (page) => {
      const hint = page.getByText(/Any file opens;/);
      await hint.waitFor();
      const text = (await hint.textContent()) ?? "";
      for (const format of [
        "JSON",
        "JSONC",
        "HAR",
        "NDJSON",
        "YAML",
        "TOML",
        "XML",
        "CSV",
        "TSV",
      ]) {
        expect(text, format).toMatch(new RegExp(`\\b${format}\\b`));
      }
    });
  });

  it("says that a zero-byte file is empty", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("empty.json", ""));
      await page.locator("[data-empty-file]").getByText("empty.json is empty").waitFor();
    }, inTree);
  });

  it("offers a short base64 cursor for decoding", async () => {
    await withPage(async (page) => {
      await pasteText(page, CAPTURE);
      await row(page, /^cursor/)
        .getByText(/base64/)
        .waitFor();
    }, inTree);
  });
});

describe("the remembered view", () => {
  it("stays the user's choice after a text document and after a view asked for with nothing open", async () => {
    await withPage(async (page) => {
      // A view chord with nothing open is not a choice.
      await page.keyboard.press(`${MOD}+Alt+4`);
      await pasteText(page, "just some words, not json\nsecond line");
      await page.getByLabel("Document text").getByText("second line").waitFor();
      // Source is a text document's only view: picking it again is not a choice either.
      await page.keyboard.press(`${MOD}+Alt+4`);
      await page.getByRole("group", { name: "Document view" }).getByText("Source").click();
      await dropFile(page, writeFixture("after-text.json", '{"status":"ok"}'));
      await row(page, /^status/).waitFor();
      expect(await page.evaluate(() => localStorage.getItem("quipu:document-view"))).toBe("tree");
    }, inTree);
  });
});

describe("reloading the page", () => {
  it("opens the tab's document again, in the view it had", async () => {
    await withPage(async (page) => {
      await pasteText(page, JSON.stringify({ kept: "after reload" }));
      await row(page, /^kept/).waitFor();
      await page.reload();
      await row(page, /^kept.*after reload/).waitFor();
      await page.getByRole("navigation", { name: "Documents" }).getByText("Pasted text").waitFor();
    }, inTree);
  });
});

describe("converted, read-only and invalid documents", () => {
  const YAML =
    "store:\n  book:\n    - title: Sayings\n      price: 8.95\n    - title: Sword\n      price: 12.99\n";

  it("offers path queries and jq on a converted format", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("store.yaml", YAML));
      await row(page, /^store/).waitFor();
      await page.keyboard.press(`${MOD}+Shift+f`);
      const tabs = page.getByRole("tablist", { name: "Query kind" });
      await page.getByLabel("Path query").waitFor();
      expect(await tabs.getByRole("tab").allTextContents()).toEqual(["Find", "Path", "jq"]);
      await page.getByLabel("Path query").fill("$..price");
      await page.getByLabel("Path query").press("Enter");
      await page.locator("[data-path-count]", { hasText: "2 results" }).waitFor();
      expect(await page.locator("[data-path-result-path]").allTextContents()).toEqual([
        "$.store.book[0].price",
        "$.store.book[1].price",
      ]);
    }, inTree);
  });

  it("keeps the chosen view through a converted format and a text document", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("view.yaml", YAML));
      await row(page, /^store/).waitFor();
      await dropFile(page, writeFixture("notes.txt", "plain words\nsecond line"));
      await page.getByLabel("Document text").getByText("second line").waitFor();
      await page.getByRole("group", { name: "Document view" }).getByText("Source").click();
      await dropFile(page, writeFixture("after.json", '{"status":"ok"}'));
      await row(page, /^status/).waitFor();
      expect(await page.evaluate(() => localStorage.getItem("quipu:document-view"))).toBe("tree");
    }, inTree);
  });

  it("says an empty file is empty whatever its format, with no problem notice", async () => {
    await withPage(async (page) => {
      for (const name of ["empty.yaml", "nothing.json"]) {
        await dropFile(page, writeFixture(name, ""));
        await page.locator("[data-empty-file]").getByText(`${name} is empty`).waitFor();
        expect(await page.locator("[data-document-problem]").count()).toBe(0);
      }
    }, inTree);
  });

  it("opens an invalid or converted document again after a reload, notice and format included", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("broken.json", '{\n  "items": [1, 2,\n    "missing": }\n'));
      await page
        .locator("[data-document-problem]")
        .getByText(/Not valid JSON/)
        .waitFor();
      // A reload brings back the document the tab had open once it is among the recent
      // documents, which is written after the document shows.
      const recent = (name: string) =>
        page.getByTestId("recent-document").filter({ hasText: name });
      await recent("broken.json").waitFor();
      await page.reload();
      await page
        .locator("[data-document-problem]")
        .getByText(/Not valid JSON/)
        .waitFor();
      await page.locator("[data-document-format-badge]").filter({ hasText: "Not valid" }).waitFor();

      await dropFile(page, writeFixture("again.yaml", YAML));
      await row(page, /^store/).waitFor();
      await recent("again.yaml").waitFor();
      await page.reload();
      await row(page, /^store/).waitFor();
      await page.locator("[data-document-format-badge]").filter({ hasText: "YAML" }).waitFor();
    }, inTree);
  });
});
