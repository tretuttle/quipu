// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
// yaml, smol-toml, csv-parse and the page's DOMParser are the reference parsers the exported bytes are
// read back with; none of them is the code that wrote the bytes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parse as parseCsv } from "csv-parse/sync";
import { chromium, type Page } from "playwright-core";
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, inject, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import { cachedHar, skipWithout } from "./fixtures";
import { dropFile, MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();

const HAR_2G = cachedHar("har-2g.har");

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-save-e2e-"));
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

/**
 * The save dialog, stubbed: it answers a handle to a file of the suggested name
 * in the origin's private file system, the disk the test reads back.
 */
async function stubSavePicker(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options: { suggestedName: string }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      },
    });
  });
}

/** A file of the private file system, opened through a stubbed open dialog that answers its handle. */
async function openThroughPicker(page: Page, name: string, contents: string) {
  await page.evaluate(
    async ({ fileName, text }) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      Object.defineProperty(window, "showOpenFilePicker", {
        configurable: true,
        value: async () => [handle],
      });
    },
    { fileName: name, text: contents },
  );
  await page.keyboard.press(`${MOD}+o`);
}

const readPrivateFile = (page: Page, name: string) =>
  page.evaluate(async (fileName) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(fileName)).getFile();
    return { text: await file.text(), size: file.size, lastModified: file.lastModified };
  }, name);

const toast = (page: Page, text: string | RegExp) => page.getByText(text).first().waitFor();

async function exportAs(page: Page, label: string) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Export / });
  await dialog.getByRole("combobox", { name: "Format" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await dialog.getByRole("button", { name: "Export…" }).click();
  return dialog;
}

const RECORDS = [
  { id: 1, name: "quipu", ok: true },
  { id: 2, name: "khipu, the knot", ok: false },
];
const CATALOG = { catalog: { "@version": "2", title: "Knots", entry: ["square", "clove hitch"] } };

describe("saving", () => {
  it("writes a document opened through the picker back in place, unchanged", async () => {
    const contents = '{\n  "a" : 1,\n  "b": [true,   null]\n}\n';
    await withPage(async (page) => {
      await stubSavePicker(page);
      await page.evaluate(() => {
        // Saving in place must not ask where to save.
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: () => Promise.reject(new Error("the save dialog was shown")),
        });
      });
      await openThroughPicker(page, "picked.json", contents);
      await tree(page)
        .getByRole("treeitem", { name: /^a : 1/ })
        .waitFor();
      const before = await readPrivateFile(page, "picked.json");
      await page.keyboard.press(`${MOD}+s`);
      await toast(page, "Saved picked.json");
      const after = await readPrivateFile(page, "picked.json");
      expect(after.text).toBe(contents);
      expect(after.lastModified).toBeGreaterThanOrEqual(before.lastModified);
      // The document reopened from what is on disk.
      await tree(page)
        .getByRole("treeitem", { name: /^a : 1/ })
        .waitFor();
    }, inTree);
  });

  it("saves as a new file through the save dialog, and the document becomes that file", async () => {
    const contents = '{"list":[1,2,3],"name":"quipu"}';
    await withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("original.json", contents));
      await tree(page)
        .getByRole("treeitem", { name: /^name : "quipu"/ })
        .waitFor();
      await page.keyboard.press(`${MOD}+Shift+s`);
      await toast(page, "Saved original.json");
      expect((await readPrivateFile(page, "original.json")).text).toBe(contents);
    }, inTree);
  });

  it("saves a document with no file of its own through the save dialog, from the header and the palette", async () => {
    await withPage(async (page) => {
      await stubSavePicker(page);
      await pasteText(page, '{"from":"header"}');
      await tree(page).getByRole("treeitem", { name: /^from/ }).waitFor();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await toast(page, "Saved Pasted text.json");
      expect((await readPrivateFile(page, "Pasted text.json")).text).toBe('{"from":"header"}');
      // Saving reopened the document from the new file, which Save as offers by its name.
      await page
        .getByRole("navigation", { name: "Documents" })
        .getByText("Pasted text.json")
        .waitFor();
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Save as");
      await palette.getByRole("option", { name: /Save as/ }).click();
      await toast(page, "Saved Pasted text.json");
    }, inTree);
  });

  it("saves a read-only document as the file it is, comments and all", async () => {
    const contents = "# the service\nservice: quipu # inline\nreplicas: 3\n";
    await withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("service.yaml", contents));
      await tree(page)
        .getByRole("treeitem", { name: /^service : "quipu"/ })
        .waitFor();
      await page.keyboard.press(`${MOD}+Shift+s`);
      await toast(page, "Saved service.yaml");
      expect((await readPrivateFile(page, "service.yaml")).text).toBe(contents);
    }, inTree);
  });

  it("downloads the bytes where the browser has no save dialog", async () => {
    const contents = '{"downloaded" : [1, 2, 3]}\n';
    await withPage(async (page) => {
      await page.evaluate(() => {
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: undefined,
        });
      });
      await pasteText(page, contents);
      await tree(page)
        .getByRole("treeitem", { name: /^downloaded/ })
        .waitFor();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.keyboard.press(`${MOD}+s`),
      ]);
      expect(download.suggestedFilename()).toBe("Pasted text.json");
      const saved = NodePath.join(scratch, "downloaded.json");
      await download.saveAs(saved);
      expect(NodeFS.readFileSync(saved, "utf8")).toBe(contents);
    }, inTree);
  });

  it("saves a 2 GiB document, streamed", async (test) => {
    skipWithout(test, HAR_2G);
    const size = NodeFS.statSync(HAR_2G.path).size;
    // A fresh context is incognito-like and its private file system refuses 2 GiB; a profile on disk does not.
    const profile = NodeFS.mkdtempSync(NodePath.join(scratch, "profile-"));
    const context = await chromium.launchPersistentContext(profile, {
      viewport: { width: 1280, height: 800 },
    });
    try {
      await context.addInitScript(() => localStorage.setItem("quipu:document-view", "tree"));
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(inject("e2eBaseUrl"));
      await page.locator("[data-app-sidebar]").waitFor();
      await stubSavePicker(page);
      await dropFile(page, HAR_2G.path);
      await tree(page).getByRole("treeitem", { name: /^log/ }).waitFor({ timeout: 60_000 });
      await page.keyboard.press(`${MOD}+Shift+s`);
      await page
        .getByText(/^(Saved|Could not save) har-2g\.har$/)
        .first()
        .waitFor({ timeout: 240_000 });
      await page.getByText("Saved har-2g.har").first().waitFor({ timeout: 1000 });
      expect(
        await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          return (await (await root.getFileHandle("har-2g.har")).getFile()).size;
        }),
      ).toBe(size);
    } finally {
      await context.close();
      NodeFS.rmSync(profile, { recursive: true, force: true });
    }
  }, 360_000);
});

describe("exporting", () => {
  it.each([
    ["YAML", "records.yaml", (text: string) => parseYaml(text) as unknown],
    [
      "NDJSON",
      "records.ndjson",
      (text: string) =>
        text
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as unknown),
    ],
    ["JSON", "records.json", (text: string) => JSON.parse(text) as unknown],
  ] as const)(
    "writes a list of records as %s that reads back as the same data",
    (label, name, read) =>
      withPage(async (page) => {
        await stubSavePicker(page);
        await dropFile(page, writeFixture("records.json", JSON.stringify(RECORDS)));
        await tree(page).getByRole("treeitem").first().waitFor();
        await exportAs(page, label);
        await toast(page, `Exported ${name}`);
        expect(read((await readPrivateFile(page, name)).text)).toEqual(RECORDS);
      }, inTree),
  );

  it.each([
    ["CSV", "records.csv", ","],
    ["TSV", "records.tsv", "\t"],
  ] as const)("writes a list of records as %s, one row each", (label, name, delimiter) =>
    withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("records.json", JSON.stringify(RECORDS)));
      await tree(page).getByRole("treeitem").first().waitFor();
      await exportAs(page, label);
      await toast(page, `Exported ${name}`);
      const rows = parseCsv((await readPrivateFile(page, name)).text, { columns: true, delimiter });
      // CSV has no types: every cell is text.
      expect(rows).toEqual(RECORDS.map((r) => ({ id: `${r.id}`, name: r.name, ok: `${r.ok}` })));
    }, inTree),
  );

  it("writes an object as TOML and as XML that read back as the same data", async () => {
    await withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("catalog.json", JSON.stringify(CATALOG)));
      await tree(page)
        .getByRole("treeitem", { name: /^catalog/ })
        .waitFor();
      await exportAs(page, "TOML");
      await toast(page, "Exported catalog.toml");
      expect(parseToml((await readPrivateFile(page, "catalog.toml")).text)).toEqual(CATALOG);
      await exportAs(page, "XML");
      await toast(page, "Exported catalog.xml");
      const xml = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const text = await (await (await root.getFileHandle("catalog.xml")).getFile()).text();
        const document = new DOMParser().parseFromString(text, "application/xml");
        const element = document.documentElement;
        return {
          error: document.querySelector("parsererror") !== null,
          root: element.tagName,
          version: element.getAttribute("version"),
          title: element.querySelector("title")?.textContent,
          entries: [...element.querySelectorAll("entry")].map((entry) => entry.textContent),
        };
      });
      expect(xml).toEqual({
        error: false,
        root: "catalog",
        version: "2",
        title: "Knots",
        entries: ["square", "clove hitch"],
      });
    }, inTree);
  });

  it("converts a YAML file to JSON", async () => {
    await withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("service.yaml", "service: quipu\nlimits:\n  cpu: 2\n"));
      await tree(page)
        .getByRole("treeitem", { name: /^service/ })
        .waitFor();
      await exportAs(page, "JSON");
      await toast(page, "Exported service.json");
      expect(JSON.parse((await readPrivateFile(page, "service.json")).text) as unknown).toEqual({
        service: "quipu",
        limits: { cpu: 2 },
      });
    }, inTree);
  });

  it("names the formats that cannot hold the document, and the node a refused export stopped at", async () => {
    await withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("nulls.json", '{"a":{"b":[1,null]}}'));
      await tree(page).getByRole("treeitem", { name: /^a/ }).waitFor();
      // Through the palette this time.
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Export");
      await palette.getByRole("option", { name: /Export…/ }).click();
      const dialog = page.getByRole("dialog", { name: /^Export / });
      const unavailable = dialog.getByRole("list", {
        name: "Formats that cannot hold this document",
      });
      await unavailable.getByText("CSV needs a list of records at the top level.").waitFor();
      await unavailable.getByText("NDJSON needs a list at the top level.").waitFor();
      // A null is cheap to find up front: TOML is listed as unable, with where.
      await unavailable.getByText("TOML has no null, and the value at $.a.b[1] is null.").waitFor();
      await dialog.getByRole("combobox", { name: "Format" }).click();
      for (const label of ["CSV", "TOML"]) {
        expect(
          await page
            .getByRole("option", { name: label, exact: true })
            .getAttribute("aria-disabled"),
        ).toBe("true");
      }
    }, inTree);
  });

  it("keeps the dialog open with the reason when a format refuses only while writing", async () => {
    await withPage(async (page) => {
      await stubSavePicker(page);
      // An element name XML cannot have, below the top level: found only by the writer.
      await dropFile(page, writeFixture("names.json", '{"doc":{"a b":1}}'));
      await tree(page).getByRole("treeitem", { name: /^doc/ }).waitFor();
      const dialog = await exportAs(page, "XML");
      const alert = dialog.getByRole("alert");
      await alert.getByText("Could not export to XML").waitFor();
      await alert.getByText('At $.doc["a b"]').waitFor();
      // The dialog stays, so another format can be picked.
      await dialog.getByRole("combobox", { name: "Format" }).waitFor();
    }, inTree);
  });

  it("reads CSV columns from every row when a key first appears after the first 1,024", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) =>
      i === 1050 ? { id: i, late: true } : { id: i },
    );
    await withPage(async (page) => {
      await stubSavePicker(page);
      await dropFile(page, writeFixture("late.json", JSON.stringify(rows)));
      await tree(page).getByRole("treeitem").first().waitFor();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Export / });
      await dialog.getByRole("combobox", { name: "Format" }).click();
      await page.getByRole("option", { name: "CSV", exact: true }).click();
      await dialog.getByText(/such as "late": read the columns from every row\./).waitFor();
      await dialog.getByRole("combobox", { name: "Columns" }).getByText("From every row").waitFor();
      await dialog.getByRole("button", { name: "Export…" }).click();
      await toast(page, "Exported late.csv");
      const csv = parseCsv((await readPrivateFile(page, "late.csv")).text, { columns: true });
      expect(csv).toHaveLength(1100);
      expect(csv[1050]).toEqual({ id: "1050", late: "true" });
    }, inTree);
  });
});
