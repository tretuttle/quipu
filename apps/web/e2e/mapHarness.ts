import type { Locator, Page } from "playwright-core";

export const map = (page: Page) => page.getByRole("tree", { name: "Document map" });
export const mapNode = (page: Page, name: RegExp) => map(page).getByRole("treeitem", { name });

/**
 * Pans the map until `target` is in the middle of the canvas, with a
 * middle-button drag (it pans from anywhere, even over a card).
 */
async function panTo(page: Page, target: Locator) {
  const canvas = await page.getByLabel("Map canvas").boundingBox();
  if (!canvas) throw new Error("The map has no box.");
  const [cx, cy] = [canvas.x + canvas.width / 2, canvas.y + canvas.height / 2];
  // Drags start in the canvas, so each moves the map at most half a canvas.
  const reach = (delta: number, half: number) => Math.max(-half, Math.min(half, delta));
  for (let step = 0; step < 20; step += 1) {
    const box = await target.boundingBox();
    if (!box) throw new Error("The target has no box.");
    // The target's top left corner: a card taller than the screen is read from its top.
    const [w, h] = [Math.min(box.width, 40), Math.min(box.height, 40)];
    const inside =
      box.x >= canvas.x + 24 &&
      box.y >= canvas.y + 72 &&
      box.x + w <= canvas.x + canvas.width - 24 &&
      box.y + h <= canvas.y + canvas.height - 200;
    if (inside) return;
    const dx = reach(cx - (box.x + w / 2), canvas.width / 2 - 40);
    const dy = reach(cy - (box.y + h / 2), canvas.height / 2 - 40);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(cx + dx, cy + dy, { steps: 4 });
    await page.mouse.up({ button: "middle" });
  }
  throw new Error("The target never came into view.");
}

/** The chevron of the row that names `rowId`, after a fit, panned into view. */
export async function toggleMapRow(page: Page, rowId: RegExp) {
  await page.getByRole("button", { name: "Zoom to fit" }).click();
  const toggle = map(page)
    .locator("[data-map-row-id]")
    .filter({ hasText: rowId })
    .first()
    .locator("[data-map-toggle]");
  await toggle.waitFor();
  await panTo(page, toggle);
  await toggle.click({ force: true });
}

/**
 * Fits the map, then zooms in on `target` until rows show as text, so a row of
 * a node deep in a wide map can be read and clicked.
 */
async function zoomOnto(page: Page, target: Locator) {
  // The node must be laid out before the fit, or the fit leaves it outside the view.
  await target.waitFor();
  const fit = page.getByRole("button", { name: "Zoom to fit" });
  const view = page.locator("[data-map-view]");
  await fit.click();
  // Fit gives a readable frame at the top left first, which a wide map's far
  // nodes lie outside of; pressed again it shows the whole map to zoom in from.
  const canvas = await page.getByLabel("Map canvas").boundingBox();
  const shown = await target.boundingBox();
  const inside =
    canvas !== null &&
    shown !== null &&
    shown.x >= canvas.x &&
    shown.y >= canvas.y &&
    shown.x + Math.min(shown.width, 200) <= canvas.x + canvas.width &&
    shown.y + Math.min(shown.height, 60) <= canvas.y + canvas.height;
  if (!inside) await fit.click();
  for (let step = 0; (await view.getAttribute("data-map-detail")) !== "full"; step += 1) {
    if (step === 100) throw new Error("the map never showed its rows");
    const box = await target.boundingBox();
    if (!box) throw new Error("the node is not on the map");
    // Chromium turns a ctrl+wheel into a 5 % zoom about the pointer.
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 12));
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
  }
}

/** A row of `target` by the text it shows, with the map zoomed in so it can be clicked. */
export async function mapRowOf(page: Page, target: Locator, text: RegExp) {
  await zoomOnto(page, target);
  return target.locator("[data-map-row]").filter({ hasText: text }).first();
}

/** Opens or closes the row of `target` showing `text`, by its chevron. */
export async function toggleRowOf(page: Page, target: Locator, text: RegExp) {
  const row = await mapRowOf(page, target, text);
  const toggle = row.locator("[data-map-toggle]");
  await panTo(page, toggle);
  await toggle.click({ force: true });
}
