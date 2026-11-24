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
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-formats-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(name: string, contents: string): string {
  const file = NodePath.join(scratch, name);
  NodeFS.writeFileSync(file, contents);
  return file;
}

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const inTree = { storage: { "quipu:document-view": "tree" } };
const formatBadge = (page: Page) => page.locator("[data-document-format-badge]");

/** Expands every row of the tree, from its first row. */
async function expandAll(page: Page) {
  const first = tree(page).getByRole("treeitem").first();
  await first.focus();
  await page.keyboard.press(`${MOD}+Shift+ArrowRight`);
}

const FORMATS: ReadonlyArray<{
  readonly name: string;
  readonly contents: string;
  readonly badge: string;
  /** Rows the tree shows once expanded. */
  readonly rows: ReadonlyArray<RegExp>;
}> = [
  {
    name: "service.yaml",
    contents: "service: quipu\nreplicas: 3\nowner:\n  name: khipu\n",
    badge: "YAML · Read-only",
    rows: [/^service : "quipu"/, /^replicas : 3/, /^name : "khipu"/],
  },
  {
    name: "service.toml",
    contents: 'service = "quipu"\nreplicas = 3\n\n[owner]\nname = "khipu"\n',
    badge: "TOML · Read-only",
    rows: [/^service : "quipu"/, /^replicas : 3/, /^name : "khipu"/],
  },
  {
    name: "feed.xml",
    contents: '<?xml version="1.0"?>\n<feed lang="en"><title>Knots</title></feed>\n',
    badge: "XML · Read-only",
    rows: [/^feed/, /^@lang : "en"/, /^title : "Knots"/],
  },
  {
    name: "people.csv",
    contents: "name,size\nquipu,2\nkhipu,3\n",
    badge: "CSV · Read-only",
    rows: [/^name : "quipu"/, /^size : "3"/],
  },
  {
    name: "people.tsv",
    contents: "name\tsize\nquipu\t2\nkhipu\t3\n",
    badge: "TSV · Read-only",
    rows: [/^name : "khipu"/, /^size : "2"/],
  },
  {
    name: "events.ndjson",
    contents: '{"event":"open","n":1}\n{"event":"close","n":2}\n',
    badge: "NDJSON · Read-only",
    rows: [/^event : "open"/, /^event : "close"/],
  },
  {
    name: "settings.jsonc",
    contents: '{\n  // the service\n  "service": "quipu",\n  "tags": ["a", "b",],\n}\n',
    badge: "JSONC · Read-only",
    rows: [/^service : "quipu"/, /^tags/],
  },
];

describe("opening other formats", () => {
  it.each(FORMATS)("shows $name as a tree, read-only, with its format in the header", (sample) =>
    withPage(async (page) => {
      await dropFile(page, writeFixture(sample.name, sample.contents));
      await formatBadge(page).filter({ hasText: sample.badge }).waitFor();
      expect(await formatBadge(page).textContent()).toBe(sample.badge);
      await tree(page).getByRole("treeitem").first().waitFor();
      await expandAll(page);
      for (const row of sample.rows) {
        await tree(page).getByRole("treeitem", { name: row }).first().waitFor();
      }
    }, inTree),
  );

  it("shows the file's own text in the Source view, highlighted as its format", async () => {
    await withPage(
      async (page) => {
        await dropFile(page, writeFixture("colors.yaml", "service: quipu\nreplicas: 3\n"));
        const text = page.getByLabel("Document text");
        await text.getByText("service: quipu").waitFor();
        // Clicks here do not reach the tree, and the view says why.
        await page
          .getByRole("note")
          .getByText("The file as written. The tree reads it converted to JSON")
          .waitFor();
        await text.getByText("replicas: 3").waitFor();
        // Shiki's YAML grammar colors the key and the value differently; the row repaints once it loads.
        await page.waitForFunction(() => {
          const colors = new Set<string>();
          const rows = document.querySelectorAll<HTMLElement>(
            '[aria-label="Document text"] [data-row-code] span',
          );
          for (const span of rows) {
            if (span.textContent === "service" || span.textContent === "quipu") {
              colors.add(getComputedStyle(span).color);
            }
          }
          return colors.size === 2;
        });
      },
      { storage: { "quipu:document-view": "source" } },
    );
  });

  it("opens a file with a syntax error as text, and says why", async () => {
    await withPage(async (page) => {
      await dropFile(page, writeFixture("broken.yaml", "a: 1\nb: [unclosed\nc: 3\n"));
      await page.getByLabel("Document text").getByText("b: [unclosed").waitFor();
      await page
        .getByRole("note")
        .getByText(
          "This YAML file has a list in [ ] that is not closed or not indented enough at line 3, so it opens as text.",
        )
        .waitFor();
      expect(await tree(page).count()).toBe(0);
    }, inTree);
  });

  it("opens a .txt file as text, even with lines that look like YAML", async () => {
    await withPage(async (page) => {
      await dropFile(
        page,
        writeFixture(
          "notes.txt",
          "Meeting notes\nAttendees: Ana, Bo\nAction items:\n- send the draft\n- book a room\n",
        ),
      );
      await page.getByLabel("Document text").getByText("Action items:").waitFor();
      await formatBadge(page)
        .filter({ hasText: /^Text$/ })
        .waitFor();
      expect(await page.getByRole("note").count()).toBe(0);
      expect(await page.getByText(/YAML/).count()).toBe(0);
    }, inTree);
  });
});
