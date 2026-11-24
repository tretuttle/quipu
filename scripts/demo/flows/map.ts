import type { Locator } from "playwright-core";

import type { Flow } from "../flows.ts";
import { SAMPLE_DOCUMENT } from "./sample.ts";

/**
 * The sample document pasted onto the Map: two levels opened, a JSON string
 * decoded into its own cards, then a search stepping through two hits.
 */
export const map: Flow = {
  id: "map",
  title: "Open, expand, decode and search a document on the Map",
  run: async ({ page, click, drag, moveTo, paste, press, type, wait }) => {
    const tree = page.getByRole("tree", { name: "Document map" });
    const node = (name: RegExp) => tree.getByRole("treeitem", { name });
    const toggle = (card: Locator, row: RegExp) =>
      card.locator("[data-map-row]").filter({ hasText: row }).first().locator("[data-map-toggle]");
    const open = async (card: Locator, row: RegExp, opened: Locator) => {
      await click(toggle(card, row), 650);
      await opened.waitFor();
      await wait(750);
    };

    await moveTo({ x: 700, y: 520 }, 600);
    await wait(300);
    const root = node(/^root \{\} 7 keys$/);
    await paste(SAMPLE_DOCUMENT, root);
    await wait(1000);

    const sensors = node(/^sensors \[\] 5 items$/);
    await open(root, /^sensors/, sensors);
    await open(sensors, /^2: /, node(/^2 \{\} 4 keys$/));
    const uplink = node(/^uplink \{\} 3 keys$/);
    await open(root, /^uplink/, uplink);
    const packet = node(/^last_packet JSON · 4 keys$/);
    await open(uplink, /^last_packet/, packet);

    // The decoded card opens past the right edge. Dragging empty space below the
    // cards brings it in, far enough up and left that its child clears the minimap.
    const canvas = await page.getByLabel("Map canvas").boundingBox();
    const card = await packet.boundingBox();
    if (canvas === null || card === null)
      throw new Error("The map or the decoded card has no box.");
    const from = { x: canvas.x + canvas.width - 260, y: canvas.y + canvas.height - 100 };
    await drag(
      from,
      {
        x: from.x - (card.x - (canvas.x + canvas.width * 0.3)),
        y: from.y - (card.y - (canvas.y + canvas.height * 0.4)),
      },
      900,
    );
    await wait(500);
    await open(packet, /^readings/, node(/^readings \{\} 4 keys$/));

    // Find selects each hit in turn and brings it into view; the camera follows the selected row.
    const view = page.locator("[data-map-view]");
    const selection = async () => ({
      node: await view.getAttribute("data-map-selected"),
      row: await view.getAttribute("data-map-selected-row"),
    });
    const attribute = (name: string, value: string | null) =>
      value === null ? "" : `[${name}=${JSON.stringify(value)}]`;
    const nextHit = (before: Awaited<ReturnType<typeof selection>>) => async () => {
      const unchanged = `${attribute("data-map-selected", before.node)}${attribute("data-map-selected-row", before.row)}`;
      await page
        .locator(
          `[data-map-view][data-map-selected]${unchanged === "" ? "" : `:not(${unchanged})`}`,
        )
        .waitFor({ state: "attached" });
      const now = await selection();
      const card = tree.locator(attribute("data-map-node", now.node));
      return now.row === null ? card : card.locator(attribute("data-map-row", now.row));
    };

    // A value picked in a plain card is where Find starts.
    await click(
      node(/^2 \{\} 4 keys$/)
        .locator("[data-map-row]")
        .filter({ hasText: /^unit/ }),
      650,
    );
    await wait(500);
    await press("Control+f");
    await wait(300);
    await type("snow", 90);
    await press("Enter", nextHit(await selection()));
    await wait(1500);
    await press("F3", nextHit(await selection()));
    await wait(1600);
  },
};
