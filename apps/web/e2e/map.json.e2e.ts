import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { pasteText, useBrowser } from "./harness";
import { map, mapNode as node, toggleMapRow as toggleRow } from "./mapHarness";

const withPage = useBrowser();

/** The painted color of an element (SVG `fill` or HTML `color`) as rgba bytes, whatever syntax it computed to. */
function colorOf(locator: Locator, property: "fill" | "color") {
  return locator.evaluate((element, which) => {
    const value = getComputedStyle(element)[which];
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data].join(",");
  }, property);
}

/** The Source view's span showing exactly `text`. */
const sourceSpan = (page: Page, text: string) =>
  page
    .locator("[data-source-view] [data-row-code] span")
    .filter({ hasText: new RegExp(`^${text}$`) });

describe("JSON on the map", () => {
  it("chunks a large array into [0…999] ranges and shows the values inside one", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({ list: Array.from({ length: 2003 }, (_, i) => `v${i}`) }),
      );
      await node(page, /^root \{\} 1 key$/).waitFor();
      await toggleRow(page, /^list/);
      const list = node(page, /^list \[\] 2,003 items$/);
      await list.waitFor();
      await list.getByText("[0…999]").waitFor();
      await list.getByText("[1000…1999]").waitFor();
      await list.getByText("[2000…2002]").waitFor();
      expect(await list.locator("[data-map-row]").count()).toBe(3);

      await toggleRow(page, /^\[2000…2002\]/);
      const chunk = node(page, /^\[2000…2002\] 3 items$/);
      await chunk.waitFor();
      expect(
        await chunk
          .locator("[data-map-row]")
          .evaluateAll((rows) => rows.map((row) => row.textContent)),
      ).toEqual(['2000: "v2000"', '2001: "v2001"', '2002: "v2002"']);
      await expect.poll(() => map(page).locator("[data-map-edge]").count()).toBe(2);

      // The range closes again.
      await toggleRow(page, /^\[2000…2002\]/);
      await chunk.waitFor({ state: "detached" });
    });
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`paints keys, strings, numbers and literals in their syntax colors, as the source does (${scheme})`, async () => {
      await withPage(async (page) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.reload();
        await page.locator("[data-app-sidebar]").waitFor();
        await pasteText(
          page,
          JSON.stringify({ skey: "sval", nkey: 42, bkey: true, zkey: null, flags: [false] }),
        );
        const root = node(page, /^root \{\} 5 keys$/);
        await root.waitFor();
        await toggleRow(page, /^flags/);
        const flags = node(page, /^flags \[\] 1 item$/);
        await flags.waitFor();
        const fill = (scope: Locator, text: RegExp) =>
          colorOf(scope.locator("text").filter({ hasText: text }), "fill");
        const onMap = {
          key: await fill(root, /^skey/),
          string: await fill(root, /^"sval"$/),
          number: await fill(root, /^42$/),
          literalInObject: await fill(root, /^true$/),
          nullInObject: await fill(root, /^null$/),
          literalInArray: await fill(flags, /^false$/),
        };
        // Each JSON type has its own color (the theme gives literals in an object the number's color).
        expect(new Set([onMap.key, onMap.string, onMap.number, onMap.literalInArray]).size).toBe(4);
        expect(onMap.nullInObject).toBe(onMap.literalInObject);

        // The source view paints the same tokens with the same colors.
        await page.getByLabel("Document view").getByRole("button", { name: "Source" }).click();
        const color = (text: string) => colorOf(sourceSpan(page, text).first(), "color");
        await sourceSpan(page, '"skey"').first().waitFor();
        expect({
          key: await color('"skey"'),
          string: await color('"sval"'),
          number: await color("42"),
          literalInObject: await color("true"),
          nullInObject: await color("null"),
          literalInArray: await color("false"),
        }).toEqual(onMap);
      });
    });
  }
});
