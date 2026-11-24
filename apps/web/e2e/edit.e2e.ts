import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { MOD, pasteText, useBrowser } from "./harness";

const withPage = useBrowser();
// The map is the default view; editing starts in the tree, beside the source.
const inTree = { storage: { "quipu:document-view": "tree" } };

const SAMPLE = {
  name: "alpha",
  count: 1,
  tags: ["b", "a", "c"],
  nested: { z: 1, a: 2 },
  people: [
    { n: "b", age: 3 },
    { n: "a", age: 1 },
  ],
  marker: "needle-here",
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

const tree = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const row = (page: Page, key: string) =>
  page
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) });
const valueOf = (page: Page, key: string) => row(page, key).locator("[data-tree-value]");
const view = (page: Page, name: "Tree" | "Source") =>
  page.getByLabel("Document view").getByRole("button", { name }).click();

async function openSample(page: Page, value: unknown = SAMPLE) {
  await pasteText(page, pretty(value));
  await tree(page).waitFor();
  await row(page, "marker").waitFor();
}

/**
 * The document's text as the Source view shows it: rows of one line join
 * without a break where a long line was wrapped.
 */
async function sourceText(page: Page): Promise<string> {
  await view(page, "Source");
  await page.locator('[data-source-view][data-state="ready"]').waitFor();
  const rows = await page.locator("[data-source-view] [data-row-start]").evaluateAll((elements) =>
    elements.map((element) => ({
      start: Number((element as HTMLElement).dataset.rowStart),
      end: Number((element as HTMLElement).dataset.rowEnd),
      text: element.querySelector("[data-row-code]")?.textContent ?? "",
    })),
  );
  let text = "";
  rows.forEach((current, index) => {
    const previous = rows[index - 1];
    if (previous !== undefined) text += current.start === previous.end ? "" : "\n";
    text += current.text;
  });
  await view(page, "Tree");
  await tree(page).waitFor();
  return text;
}

/** The Source view's text once it shows `expected`, so a test waits for the edit, not a clock. */
async function sourceShows(page: Page, fragment: string) {
  await view(page, "Source");
  await page.locator("[data-source-view] [data-row-code]", { hasText: fragment }).first().waitFor();
  await view(page, "Tree");
}

async function transform(page: Page, label: string) {
  await page.getByRole("button", { name: "Transform" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

async function editValueInTree(page: Page, key: string, text: string) {
  await valueOf(page, key).dblclick();
  const input = tree(page).getByLabel("Value");
  await input.fill(text);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

const unsavedDot = (page: Page): Locator => page.locator("[data-unsaved-dot]");

describe("editing a document", () => {
  it("edits a value in the tree, shows its type while typing, and undoes and redoes it", async () => {
    await withPage(async (page) => {
      await openSample(page);
      await valueOf(page, "count").dblclick();
      const input = tree(page).getByLabel("Value");
      await input.fill("hello");
      expect(await page.locator("[data-editor-type-badge]").textContent()).toBe("string");
      await input.fill("42");
      expect(await page.locator("[data-editor-type-badge]").textContent()).toBe("number");
      await input.press("Enter");
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
      // The document has something to save: the header and the sidebar say so.
      await unsavedDot(page).first().waitFor();
      expect(await page.getByText("Unsaved changes", { exact: true }).count()).toBe(1);
      expect(await sourceText(page)).toBe(pretty({ ...SAMPLE, count: 42 }));

      await page.keyboard.press(`${MOD}+z`);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      await unsavedDot(page).first().waitFor({ state: "detached" });
      await page.keyboard.press(`${MOD}+Shift+z`);
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
      await page.keyboard.press(`${MOD}+z`);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      await page.keyboard.press(`${MOD}+y`);
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
      // The header buttons follow the engine's history.
      await page.getByRole("button", { name: "Undo edit" }).click();
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      expect(await page.getByRole("button", { name: "Undo edit" }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Redo edit" }).isDisabled()).toBe(false);
      expect(await sourceText(page)).toBe(pretty(SAMPLE));
    }, inTree);
  });

  it("writes plain text as a string, and holds text that starts like JSON until it is fixed or kept as text", async () => {
    await withPage(async (page) => {
      await openSample(page);
      await editValueInTree(page, "marker", "plain words");
      await editValueInTree(page, "name", `{"x": [true, null]}`);

      // A slip in JSON is not written as a string behind the user's back.
      await valueOf(page, "count").dblclick();
      const input = tree(page).getByLabel("Value");
      await input.fill("[1,2");
      expect(await tree(page).locator("[data-editor-type-badge]").textContent()).toBe("not valid");
      await input.press("Enter");
      const alert = tree(page).getByRole("alert");
      await alert.filter({ hasText: /^Not valid JSON: / }).waitFor();
      // Fixed, it is the array, and the one edit: Undo goes straight back to the number.
      await input.fill("[1,2]");
      await input.press("Enter");
      await input.waitFor({ state: "detached" });
      await valueOf(page, "count").filter({ hasText: "2 items" }).waitFor();
      await page.keyboard.press(`${MOD}+z`);
      await valueOf(page, "count").filter({ hasText: /^1$/ }).waitFor();
      // Kept as text, the string.
      await valueOf(page, "marker").dblclick();
      await input.fill("007");
      await input.press("Enter");
      await alert.filter({ hasText: "007 is not a JSON number." }).waitFor();
      await tree(page).getByRole("button", { name: "Save as text" }).click();
      await input.waitFor({ state: "detached" });

      expect(JSON.parse(await sourceText(page))).toEqual({
        ...SAMPLE,
        marker: "007",
        name: { x: [true, null] },
      });
    }, inTree);
  });

  it("renames a key, and edits from the Inspector and the Source view", async () => {
    await withPage(async (page) => {
      await openSample(page);
      await row(page, "count").locator("[data-tree-key]").dblclick();
      const key = tree(page).getByLabel("Key");
      await key.fill("total");
      await key.press("Enter");
      await row(page, "total").waitFor();
      expect(await row(page, "count").count()).toBe(0);

      // The Inspector edits the selected value in several lines, with Apply.
      await row(page, "name").click();
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      const inspector = page.locator("[data-inspector]");
      await inspector.getByRole("button", { name: "Edit", exact: true }).click();
      const area = inspector.locator("[data-node-editor] textarea");
      expect(await area.inputValue()).toBe("alpha");
      await area.fill("gamma");
      await inspector.getByRole("button", { name: "Apply" }).click();
      await valueOf(page, "name").filter({ hasText: '"gamma"' }).waitFor();
      await page.getByRole("button", { name: "Toggle right panel" }).click();

      // The Source view: a double-click on a value edits it in place.
      await view(page, "Source");
      const line = page.locator("[data-source-view] [data-row-code]", { hasText: "needle-here" });
      await line.waitFor();
      const text = (await line.textContent()) ?? "";
      const box = await line.boundingBox();
      if (box === null) throw new Error("The marker's row is not on screen.");
      const charWidth = box.width / text.length;
      await page.mouse.dblclick(
        box.x + (text.indexOf("needle") + 2) * charWidth,
        box.y + box.height / 2,
      );
      const input = page.locator("[data-source-view] [data-node-editor]").getByLabel("Value");
      expect(await input.inputValue()).toBe("needle-here");
      await input.fill("found");
      await input.press("Enter");
      await page.locator("[data-source-view] [data-row-code]", { hasText: '"found"' }).waitFor();
      await view(page, "Tree");
      expect(await sourceText(page)).toBe(
        pretty({
          name: "gamma",
          total: 1,
          tags: SAMPLE.tags,
          nested: SAMPLE.nested,
          people: SAMPLE.people,
          marker: "found",
        }),
      );
    }, inTree);
  });

  it("runs each transform as one undoable edit", async () => {
    await withPage(async (page) => {
      await openSample(page);
      const parsed = async () => JSON.parse(await sourceText(page)) as typeof SAMPLE;

      await row(page, "nested").click();
      await transform(page, "Sort keys A to Z");
      await sourceShows(page, '"a": 2');
      expect(Object.keys((await parsed()).nested)).toEqual(["a", "z"]);

      await row(page, "tags").click();
      await transform(page, "Sort array ascending");
      await sourceShows(page, '"a",');
      expect((await parsed()).tags).toEqual(["a", "b", "c"]);

      await row(page, "people").click();
      await transform(page, "Sort array by field…");
      const dialog = page.locator("[data-sort-field-dialog]");
      await dialog.getByLabel("Field").fill("age");
      await dialog.getByRole("button", { name: "Sort" }).click();
      await dialog.waitFor({ state: "detached" });
      const sortedPeople = [SAMPLE.people[1], SAMPLE.people[0]];
      expect((await parsed()).people).toEqual(sortedPeople);
      // One edit, one undo.
      await page.keyboard.press(`${MOD}+z`);
      expect((await parsed()).people).toEqual(SAMPLE.people);
      await page.keyboard.press(`${MOD}+Shift+z`);

      const value = {
        ...SAMPLE,
        nested: { a: 2, z: 1 },
        tags: ["a", "b", "c"],
        people: sortedPeople,
      };
      await transform(page, "Minify document");
      await row(page, "marker").waitFor();
      expect(await sourceText(page)).toBe(JSON.stringify(value));
      await row(page, "marker").click();
      await page.keyboard.press("Shift+Alt+f");
      await sourceShows(page, '  "marker"');
      expect(await sourceText(page)).toBe(pretty(value));
      await page.keyboard.press(`${MOD}+z`);
      await row(page, "marker").waitFor();
      expect(await sourceText(page)).toBe(JSON.stringify(value));
    }, inTree);
  });

  it("finds a search hit and a path in the edited document, not the file", async () => {
    await withPage(async (page) => {
      await openSample(page);
      // A longer value early in the file moves every byte after it.
      await editValueInTree(page, "name", "a value a good deal longer than the one in the file");
      await page.keyboard.press(`${MOD}+f`);
      await page.getByLabel("Find in document").fill("needle");
      await page.getByLabel("Find in document").press("Enter");
      await page.getByText("1 of 1", { exact: true }).waitFor();
      await row(page, "marker").and(page.locator('[aria-selected="true"]')).waitFor();

      await editValueInTree(page, "count", "7");
      await row(page, "count").locator("[data-tree-key]").dblclick();
      await tree(page).getByLabel("Key").fill("total");
      await tree(page).getByLabel("Key").press("Enter");
      await row(page, "total").waitFor();
      await page.keyboard.press(`${MOD}+Shift+f`);
      const path = page.getByLabel("Path query");
      await path.fill("$.total");
      await path.press("Enter");
      await page.locator("[data-path-count]", { hasText: "1 result" }).waitFor();
      const result = page.locator("[data-path-result]");
      expect(await result.textContent()).toBe("$.total7");
      await path.fill("$.count");
      await path.press("Enter");
      await page.locator("[data-path-count]", { hasText: "No results" }).waitFor();
      await path.fill("$.marker");
      await path.press("Enter");
      await page.locator("[data-path-count]", { hasText: "1 result" }).waitFor();
      await page.locator("[data-path-result]").click();
      await row(page, "marker").and(page.locator('[aria-selected="true"]')).waitFor();
    }, inTree);
  });

  it("asks before replacing a document with unsaved edits", async () => {
    await withPage(async (page) => {
      await openSample(page);
      await editValueInTree(page, "count", "42");
      await pasteText(page, pretty({ other: true }));
      const dialog = page.locator("[data-unsaved-changes-dialog]");
      await dialog.getByText("Save changes to Pasted text?").waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();

      await pasteText(page, pretty({ other: true }));
      await dialog.getByRole("button", { name: "Discard" }).click();
      await row(page, "other").waitFor();
      expect(await unsavedDot(page).count()).toBe(0);
    }, inTree);
  });

  it("shows plain text as read-only, with the edit commands off and saying why", async () => {
    await withPage(async (page) => {
      await pasteText(page, "just some words, not JSON");
      await page.getByText("Read-only", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Transform" }).count()).toBe(0);
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByPlaceholder("Search commands and settings...").fill("edit value");
      // The command is listed, off, with the reason; it is not an option the keyboard can pick.
      await palette.getByText("Edit value", { exact: true }).waitFor();
      await palette.getByText("Plain text files are read-only.").first().waitFor();
      expect(await palette.getByRole("option", { name: /Edit value/ }).count()).toBe(0);
    });
  });
});

describe("sorting an array of objects", () => {
  it("offers to sort by a field instead of by a value no one sees, and says when no element has the field", async () => {
    await withPage(async (page) => {
      await openSample(page);
      await row(page, "people").click();
      await transform(page, "Sort array ascending");
      await page
        .getByText("Its elements are objects. Sort it by one of their fields instead.")
        .first()
        .waitFor();
      await page.getByRole("button", { name: "Sort array by field…" }).click();
      const dialog = page.locator("[data-sort-field-dialog]");
      await dialog.getByLabel("Field").fill("nope");
      await dialog.getByRole("button", { name: "Sort" }).click();
      await page.getByText('No element has a field named "nope".').first().waitFor();
      expect(await unsavedDot(page).count()).toBe(0);
    }, inTree);
  });
});

describe("renaming a key", () => {
  it("to a key the object already has is refused in the editor, with the reason", async () => {
    await withPage(async (page) => {
      await openSample(page);
      await row(page, "count").locator("[data-tree-key]").dblclick();
      const key = tree(page).getByLabel("Key");
      await key.fill("name");
      await key.press("Enter");
      await tree(page)
        .getByRole("alert")
        .filter({ hasText: 'This object already has a key named "name".' })
        .waitFor();
      // The editor stays open on what was typed; Escape leaves the key as it was.
      expect(await key.inputValue()).toBe("name");
      await key.press("Escape");
      await key.waitFor({ state: "detached" });
      await row(page, "count").waitFor();
      expect(await unsavedDot(page).count()).toBe(0);
    }, inTree);
  });
});

describe("editing an object or an array whole", () => {
  it("opens it with its JSON from the Inspector and F2, writes it back, and jq reads the edits", async () => {
    await withPage(async (page) => {
      await openSample(page);
      // The Inspector edits the selected object in several lines.
      await row(page, "nested").click();
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      const inspector = page.locator("[data-inspector]");
      await inspector.getByRole("button", { name: "Edit", exact: true }).click();
      const area = inspector.locator("[data-node-editor] textarea");
      expect(await area.inputValue()).toBe('{\n    "z": 1,\n    "a": 2\n  }');
      await area.fill('{"z": 9}');
      await inspector.getByRole("button", { name: "Apply" }).click();
      await inspector.locator("[data-node-editor]").waitFor({ state: "detached" });

      // F2 on an array's row opens it in the Inspector too, which has room for its lines.
      await row(page, "tags").click();
      await page.keyboard.press("F2");
      expect(await area.inputValue()).toBe('[\n    "b",\n    "a",\n    "c"\n  ]');
      await area.fill('["x"]');
      await area.press(`${MOD}+Enter`);
      await inspector.locator("[data-node-editor]").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Toggle right panel" }).click();
      await editValueInTree(page, "name", "edited");

      // jq answers about the document as it stands.
      await page.keyboard.press(`${MOD}+Alt+j`);
      await page.getByLabel("Run jq on").getByText("Document", { exact: true }).click();
      const program = page.getByLabel("jq filter");
      await program.fill("[.name, .nested, .tags]");
      await program.press("Enter");
      await page.locator("[data-jq-output]").filter({ hasText: '"edited"' }).waitFor();
      const output = (await page.locator("[data-jq-output]").textContent()) ?? "";
      expect(output.replace(/\s+/g, "")).toBe('["edited",{"z":9},["x"]]');
    }, inTree);
  });
});
