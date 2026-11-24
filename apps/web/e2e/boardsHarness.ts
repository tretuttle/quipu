import type { FileChooser, Locator, Page } from "playwright-core";

import { MOD } from "./harness";

export async function openNewBoard(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "New board" }).click();
  const canvas = page.getByRole("application", { name: "Board canvas" });
  await canvas.waitFor();
  await page.getByTestId("board-save-status").getByText("Saved").waitFor();
  await canvas.click({ position: { x: 20, y: 560 } });
  return canvas;
}

/** Drawing coordinates start right of the floating style panel, which covers the canvas's top-left. */
export const OX = 240;

export async function click(page: Page, canvas: Locator, at: [number, number]) {
  await canvas.click({ position: { x: at[0] + OX, y: at[1] } });
}

/** Drags on the canvas from one point to another, in drawing pixels. */
export async function drag(
  page: Page,
  canvas: Locator,
  from: [number, number],
  to: [number, number],
) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The canvas has no box.");
  await page.mouse.move(box.x + OX + from[0], box.y + from[1]);
  await page.mouse.down();
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      box.x + OX + from[0] + ((to[0] - from[0]) * i) / steps,
      box.y + from[1] + ((to[1] - from[1]) * i) / steps,
    );
  }
  await page.mouse.up();
}

export async function elementBox(page: Page, canvas: Locator, type: string, nth = 0) {
  const element = page.locator(`[data-element-type="${type}"]`).nth(nth);
  await element.waitFor();
  const [box, host] = await Promise.all([element.boundingBox(), canvas.boundingBox()]);
  if (!box || !host) throw new Error(`No box for ${type}.`);
  return { x: box.x - host.x - OX, y: box.y - host.y, width: box.width, height: box.height };
}

/** Rough strokes wobble a few pixels around the geometry; clean strokes do not. */
export const TOLERANCE = 8;

/** Geometry the clean style draws exactly: a snapped or aligned edge lands within this. */
export const EXACT = 0.5;

/** Switches new shapes to the clean style, whose rendered outline is the exact geometry plus the stroke. */
export async function useCleanStyle(page: Page, canvas: Locator) {
  // The style panel shows while a drawing tool is armed.
  await page.keyboard.press("r");
  await page.getByRole("radio", { name: "Clean" }).click();
  await page.getByRole("radio", { name: "Clean", checked: true }).waitFor();
  await canvas.focus();
}

export async function drawBox(
  page: Page,
  canvas: Locator,
  key: string,
  from: [number, number],
  to: [number, number],
) {
  await page.keyboard.press(key);
  await drag(page, canvas, from, to);
}

/** The ids of the drawn elements in paint order, bottom first. */
export async function paintOrder(page: Page): Promise<string[]> {
  return page
    .locator("[data-element-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-element-id") ?? ""));
}

export async function runFromPalette(page: Page, query: string, option: RegExp) {
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByPlaceholder("Search commands and settings...").fill(query);
  // While the list re-filters it can briefly hold a command twice; each copy runs it.
  await palette.getByRole("option", { name: option }).first().click();
  await palette.waitFor({ state: "hidden" });
}

/**
 * Catches the file pickers the page opens from now on. Playwright switches
 * chooser interception on with a message it does not wait for, so a listener
 * added just before the key that opens the picker can lose that race on a
 * busy machine: the picker then opens uncaught and headless Chromium cancels
 * it. Register this before the steps that lead up to the picker.
 */
export function catchFileChoosers(page: Page): { readonly next: () => Promise<FileChooser> } {
  const caught: FileChooser[] = [];
  const waiting: Array<(chooser: FileChooser) => void> = [];
  page.on("filechooser", (chooser) => {
    const resolve = waiting.shift();
    if (resolve) resolve(chooser);
    else caught.push(chooser);
  });
  return {
    next: () => {
      const chooser = caught.shift();
      return chooser ? Promise.resolve(chooser) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}
