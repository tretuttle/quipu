import { describe, expect, it } from "vite-plus/test";

import {
  catchFileChoosers,
  openNewBoard,
  OX,
  click,
  drag,
  elementBox,
  TOLERANCE,
  EXACT,
  useCleanStyle,
  drawBox,
  paintOrder,
  runFromPalette,
} from "./boardsHarness";
import { MOD, useBrowser } from "./harness";

const withPage = useBrowser();

describe("boards", () => {
  it("creates a board from the sidebar, lists it, and reaches it from the palette too", async () => {
    await withPage(async (page) => {
      await page.getByText("No boards yet").waitFor();
      await openNewBoard(page);
      await expect.poll(() => page.url()).toMatch(/\/boards\/board(:|%3A)/);
      await page
        .getByRole("navigation", { name: "Workspace breadcrumb" })
        .getByText("Board 1")
        .waitFor();
      await page.getByRole("link", { name: "Board 1" }).waitFor();

      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("option", { name: /New board/ }).click();
      await palette.waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Board 2" }).waitFor();
      await page
        .getByRole("navigation", { name: "Workspace breadcrumb" })
        .getByText("Board 2")
        .waitFor();
    });
  });

  it("draws every shape with its key and renders the geometry the pointer covered", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      const choosers = catchFileChoosers(page);

      await page.keyboard.press("r");
      await page.getByRole("radio", { name: "Rectangle", checked: true }).waitFor();
      await drag(page, canvas, [100, 100], [220, 180]);
      const rect = await elementBox(page, canvas, "rectangle");
      expect(Math.abs(rect.x - 100)).toBeLessThan(TOLERANCE);
      expect(Math.abs(rect.y - 100)).toBeLessThan(TOLERANCE);
      expect(Math.abs(rect.width - 120)).toBeLessThan(TOLERANCE * 2);
      expect(Math.abs(rect.height - 80)).toBeLessThan(TOLERANCE * 2);

      await page.keyboard.press("o");
      await drag(page, canvas, [300, 100], [400, 200]);
      const ellipse = await elementBox(page, canvas, "ellipse");
      expect(Math.abs(ellipse.width - 100)).toBeLessThan(TOLERANCE * 2);
      expect(Math.abs(ellipse.x - 300)).toBeLessThan(TOLERANCE);

      await page.keyboard.press("d");
      await drag(page, canvas, [500, 100], [600, 200]);
      const diamond = await elementBox(page, canvas, "diamond");
      expect(Math.abs(diamond.x - 500)).toBeLessThan(TOLERANCE);
      expect(Math.abs(diamond.height - 100)).toBeLessThan(TOLERANCE * 2);

      await page.keyboard.press("l");
      await drag(page, canvas, [100, 300], [300, 300]);
      const line = await elementBox(page, canvas, "line");
      expect(Math.abs(line.width - 200)).toBeLessThan(TOLERANCE * 2);
      expect(line.height).toBeLessThan(TOLERANCE * 2);

      await page.keyboard.press("a");
      await drag(page, canvas, [100, 400], [300, 450]);
      const arrow = await elementBox(page, canvas, "arrow");
      expect(Math.abs(arrow.x - 100)).toBeLessThan(TOLERANCE * 2);
      expect(Math.abs(arrow.x + arrow.width - 300)).toBeLessThan(TOLERANCE * 2);
      expect(await page.locator('[data-element-type="arrow"] path').count()).toBe(2);

      await page.keyboard.press("p");
      await drag(page, canvas, [400, 300], [500, 350]);
      const stroke = await elementBox(page, canvas, "freehand");
      expect(stroke.width).toBeGreaterThan(80);
      await page.keyboard.press("v");

      await page.keyboard.press("t");
      await click(page, canvas, [600, 300]);
      const editor = page.getByRole("textbox", { name: "Text" });
      await editor.fill("hello board");
      await page.keyboard.press("Escape");
      await page.locator('[data-element-type="text"]').getByText("hello board").waitFor();

      await page.keyboard.press("n");
      await click(page, canvas, [600, 400]);
      await page.getByRole("textbox", { name: "Sticky note text" }).fill("remember");
      await page.keyboard.press("Escape");
      await page.locator('[data-element-type="note"]').getByText("remember").waitFor();
      const note = await elementBox(page, canvas, "note");
      expect(Math.abs(note.width - 160)).toBeLessThan(TOLERANCE);

      await page.keyboard.press("f");
      await drag(page, canvas, [80, 80], [260, 220]);
      const frame = await elementBox(page, canvas, "frame");
      expect(Math.abs(frame.width - 180)).toBeLessThan(TOLERANCE);
      await page.locator('[data-element-type="frame"]').getByText("Frame").waitFor();

      // The image tool opens a file picker; a chosen file becomes an image element at its size.
      const png = await page.evaluate(() => {
        const bitmap = document.createElement("canvas");
        bitmap.width = 60;
        bitmap.height = 40;
        bitmap.getContext("2d")?.fillRect(0, 0, 60, 40);
        return bitmap.toDataURL("image/png").split(",")[1] ?? "";
      });
      await page.keyboard.press("i");
      await (
        await choosers.next()
      ).setFiles({
        name: "swatch.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
      await page.locator('[data-element-type="image"] image').waitFor();
      const image = await elementBox(page, canvas, "image");
      expect(Math.abs(image.width - 60)).toBeLessThan(2);
      expect(Math.abs(image.height - 40)).toBeLessThan(2);

      // The eraser tombstones what it crosses.
      await page.keyboard.press("e");
      await drag(page, canvas, [90, 300], [310, 300]);
      await page.locator('[data-element-type="line"]').waitFor({ state: "hidden" });
      expect(await page.locator('[data-element-type="rectangle"]').count()).toBe(1);

      await page.keyboard.press("h");
      await page.getByRole("radio", { name: "Hand", checked: true }).waitFor();
      await drag(page, canvas, [640, 500], [600, 500]);
      const movedRect = await elementBox(page, canvas, "rectangle");
      expect(Math.abs(movedRect.x - (rect.x - 40))).toBeLessThan(TOLERANCE);
    });
  });

  it("keeps an arrow attached to the shape it was dropped on", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await page.keyboard.press("r");
      await drag(page, canvas, [400, 200], [520, 320]);
      await page.keyboard.press("a");
      await drag(page, canvas, [100, 260], [460, 260]);
      await page.locator('[data-element-type="arrow"]').waitFor();
      const before = await elementBox(page, canvas, "arrow");
      expect(Math.abs(before.x + before.width - 400)).toBeLessThan(TOLERANCE * 2);

      // Select the hollow rectangle on its top edge, then drag it from inside down by 150:
      // the arrow's end follows its left edge.
      await page.keyboard.press("v");
      await click(page, canvas, [440, 200]);
      await drag(page, canvas, [440, 290], [440, 440]);
      await expect
        .poll(
          async () =>
            (await elementBox(page, canvas, "arrow")).y +
            (await elementBox(page, canvas, "arrow")).height,
        )
        .toBeGreaterThan(before.y + before.height + 100);
      const after = await elementBox(page, canvas, "arrow");
      expect(Math.abs(after.x - 100)).toBeLessThan(TOLERANCE * 2);
      expect(Math.abs(after.x + after.width - 400)).toBeLessThan(TOLERANCE * 2);
    });
  });

  it("starts an arrow drawn from inside a shape on the shape's edge", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await useCleanStyle(page, canvas);
      await drawBox(page, canvas, "r", [100, 100], [200, 200]);
      // Pressed inside the rectangle, near its left side, and drawn out to the right.
      await drawBox(page, canvas, "a", [120, 150], [400, 150]);
      const arrow = await elementBox(page, canvas, "arrow");
      const rect = await elementBox(page, canvas, "rectangle");
      // The arrow begins just right of the rectangle, never over it.
      expect(arrow.x).toBeGreaterThanOrEqual(rect.x + rect.width);
      expect(arrow.x - (rect.x + rect.width)).toBeLessThan(TOLERANCE);
    });
  });

  it("names a frame from its label, undoably, and keeps the name across a reload", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await drawBox(page, canvas, "f", [100, 120], [400, 320]);
      const label = (name: string) =>
        page.locator('[data-element-type="frame"] text').getByText(name, { exact: true });
      const field = page.getByRole("textbox", { name: "Frame name" });
      const rename = async (from: string, to: string, key: "Enter" | "Escape") => {
        await label(from).dblclick();
        await field.fill(to);
        await field.press(key);
        await field.waitFor({ state: "detached" });
      };

      await rename("Frame", "Checkout", "Enter");
      await label("Checkout").waitFor();
      // Escape leaves the name as it was; an emptied name goes back to "Frame".
      await rename("Checkout", "Not this", "Escape");
      await label("Checkout").waitFor();
      await rename("Checkout", "", "Enter");
      await label("Frame").waitFor();
      await page.keyboard.press(`${MOD}+z`);
      await label("Checkout").waitFor();

      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();
      await page.reload();
      await label("Checkout").waitFor();
    });
  });

  it("undoes and redoes a drawing", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await page.keyboard.press("r");
      await drag(page, canvas, [100, 100], [200, 200]);
      await page.locator('[data-element-type="rectangle"]').waitFor();
      await page.keyboard.press(`${MOD}+z`);
      await page.locator('[data-element-type="rectangle"]').waitFor({ state: "hidden" });
      await page.keyboard.press(`${MOD}+Shift+z`);
      await page.locator('[data-element-type="rectangle"]').waitFor();
      // Undo from the palette too.
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByPlaceholder("Search commands and settings...").fill("undo");
      await palette.getByRole("option", { name: /^Undo/ }).click();
      await page.locator('[data-element-type="rectangle"]').waitFor({ state: "hidden" });
    });
  });

  it("keeps the drawing across a reload", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await page.keyboard.press("o");
      await drag(page, canvas, [150, 150], [350, 250]);
      const before = await elementBox(page, canvas, "ellipse");
      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();
      await page.reload();
      await page.getByRole("application", { name: "Board canvas" }).waitFor();
      const after = await elementBox(
        page,
        page.getByRole("application", { name: "Board canvas" }),
        "ellipse",
      );
      expect(Math.abs(after.x - before.x)).toBeLessThan(2);
      expect(Math.abs(after.width - before.width)).toBeLessThan(2);
      await page.getByRole("link", { name: "Board 1" }).waitFor();
    });
  });

  it("recolors the ink when the theme changes, and paints only through theme tokens", async () => {
    await withPage(async (page) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.reload();
      await page.locator("[data-app-sidebar]").waitFor();
      const canvas = await openNewBoard(page);
      await page.keyboard.press("r");
      await drag(page, canvas, [100, 100], [200, 200]);
      const path = page.locator('[data-element-type="rectangle"] path').first();
      await path.waitFor();
      const lightStroke = await path.evaluate((node) => getComputedStyle(node).stroke);
      const attributes = await path.evaluate((node) => [
        node.getAttribute("stroke"),
        node.getAttribute("fill"),
      ]);
      for (const value of attributes) expect(value).toMatch(/^(var\(--[a-z-]+\)|none)$/);
      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();

      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await page.getByRole("application", { name: "Board canvas" }).waitFor();
      const darkPath = page.locator('[data-element-type="rectangle"] path').first();
      await darkPath.waitFor();
      const darkStroke = await darkPath.evaluate((node) => getComputedStyle(node).stroke);
      expect(darkStroke).not.toBe(lightStroke);
      expect(darkStroke).toMatch(/^(rgb|oklch|color)/);
    });
  });

  it("paints nothing while idle", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await page.keyboard.press("r");
      await drag(page, canvas, [100, 100], [200, 200]);
      await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();
      const mutations = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const svg = document.querySelector('[data-testid="board-svg"]');
            if (!svg) {
              resolve(-1);
              return;
            }
            let count = 0;
            const observer = new MutationObserver((records) => {
              count += records.length;
            });
            observer.observe(svg, {
              attributes: true,
              childList: true,
              subtree: true,
              characterData: true,
            });
            let frames = 0;
            const tick = () => {
              frames += 1;
              if (frames < 30) requestAnimationFrame(tick);
              else {
                observer.disconnect();
                resolve(count);
              }
            };
            requestAnimationFrame(tick);
          }),
      );
      expect(mutations).toBe(0);
    });
  });
  it("creates a board from the new-board shortcut", async () => {
    await withPage(async (page) => {
      await page.getByText("No boards yet").waitFor();
      await page.keyboard.press(`${MOD}+Alt+n`);
      await page.getByRole("application", { name: "Board canvas" }).waitFor();
      await expect.poll(() => page.url()).toMatch(/\/boards\/board(:|%3A)/);
      await page.getByRole("link", { name: "Board 1" }).waitFor();
      await page.keyboard.press(`${MOD}+Alt+n`);
      await page.getByRole("link", { name: "Board 2" }).waitFor();
      await page
        .getByRole("navigation", { name: "Workspace breadcrumb" })
        .getByText("Board 2")
        .waitFor();
    });
  });

  it("aligns and distributes the selection from the keyboard and the palette", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await useCleanStyle(page, canvas);
      await drawBox(page, canvas, "r", [60, 60], [120, 100]);
      await drawBox(page, canvas, "r", [200, 140], [280, 200]);
      await drawBox(page, canvas, "r", [420, 330], [460, 410]);
      const boxes = () =>
        Promise.all([0, 1, 2].map((nth) => elementBox(page, canvas, "rectangle", nth)));
      const start = await boxes();
      await page.keyboard.press(`${MOD}+a`);

      // Vertically: equal gaps between the three, the outer two stay put.
      await page.keyboard.press("Alt+Shift+v");
      await expect.poll(async () => (await boxes())[1].y).not.toBeCloseTo(start[1].y, 0);
      let [a, b, c] = await boxes();
      expect(Math.abs(b.y - (a.y + a.height) - (c.y - (b.y + b.height)))).toBeLessThan(EXACT);
      expect(Math.abs(a.y - start[0].y)).toBeLessThan(EXACT);
      expect(Math.abs(c.y - start[2].y)).toBeLessThan(EXACT);

      // Horizontally: the same, along x.
      await page.keyboard.press("Alt+Shift+h");
      await expect.poll(async () => (await boxes())[1].x).not.toBeCloseTo(start[1].x, 0);
      [a, b, c] = await boxes();
      expect(Math.abs(b.x - (a.x + a.width) - (c.x - (b.x + b.width)))).toBeLessThan(EXACT);

      // Top edges line up with the highest one.
      await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
      await expect.poll(async () => (await boxes())[2].y).toBeCloseTo(start[0].y, 0);
      for (const box of await boxes()) expect(Math.abs(box.y - start[0].y)).toBeLessThan(EXACT);

      // Left edges line up with the leftmost one, from the palette.
      await runFromPalette(page, "align left", /^Align left/);
      await expect.poll(async () => (await boxes())[2].x).toBeCloseTo(start[0].x, 0);
      for (const box of await boxes()) expect(Math.abs(box.x - start[0].x)).toBeLessThan(EXACT);

      // Right edges, from the keyboard again, against the rightmost edge.
      await canvas.focus();
      const rightEdge = Math.max(...(await boxes()).map((box) => box.x + box.width));
      await page.keyboard.press(`${MOD}+Shift+ArrowRight`);
      await expect
        .poll(async () => {
          const [first] = await boxes();
          return first.x + first.width;
        })
        .toBeCloseTo(rightEdge, 0);
      for (const box of await boxes()) {
        expect(Math.abs(box.x + box.width - rightEdge)).toBeLessThan(EXACT);
      }
    });
  });

  it("snaps a dragged shape to another's edge and shows the guide, unless Alt is held", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await useCleanStyle(page, canvas);
      await drawBox(page, canvas, "r", [100, 100], [200, 160]);
      await drawBox(page, canvas, "r", [300, 220], [380, 280]);
      const anchor = await elementBox(page, canvas, "rectangle", 0);
      const host = await canvas.boundingBox();
      if (!host) throw new Error("The canvas has no box.");

      // The selected shape moves up by 117, so its top passes 3 below the other's top.
      const dragUp = async (alt: boolean) => {
        if (alt) await page.keyboard.down("Alt");
        await page.mouse.move(host.x + OX + 340, host.y + 250);
        await page.mouse.down();
        for (let i = 1; i <= 6; i += 1) {
          await page.mouse.move(host.x + OX + 340, host.y + 250 - (117 * i) / 6);
        }
        const expectedTop = alt ? anchor.y + 3 : anchor.y;
        await expect
          .poll(async () => (await elementBox(page, canvas, "rectangle", 1)).y)
          .toBeCloseTo(expectedTop, 0);
        const guides = await page.getByTestId("board-guide").count();
        await page.mouse.up();
        if (alt) await page.keyboard.up("Alt");
        return guides;
      };

      expect(await dragUp(false)).toBeGreaterThan(0);
      await page.getByTestId("board-guide").first().waitFor({ state: "detached" });
      const snapped = await elementBox(page, canvas, "rectangle", 1);
      expect(Math.abs(snapped.y - anchor.y)).toBeLessThan(EXACT);

      await page.keyboard.press(`${MOD}+z`);
      await expect
        .poll(async () => (await elementBox(page, canvas, "rectangle", 1)).y)
        .toBeGreaterThan(anchor.y + 100);
      expect(await dragUp(true)).toBe(0);
      const free = await elementBox(page, canvas, "rectangle", 1);
      expect(Math.abs(free.y - (anchor.y + 3))).toBeLessThan(EXACT);
    });
  });

  it("moves a group as one and duplicates it", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await useCleanStyle(page, canvas);
      await drawBox(page, canvas, "r", [100, 100], [180, 160]);
      await drawBox(page, canvas, "o", [300, 100], [380, 160]);
      const rect = await elementBox(page, canvas, "rectangle");
      const ellipse = await elementBox(page, canvas, "ellipse");
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.press(`${MOD}+g`);
      await page.keyboard.press("Escape");

      // Pressing the rectangle's edge picks up the whole group; Alt keeps snapping out of it.
      await page.keyboard.down("Alt");
      await drag(page, canvas, [140, 100], [190, 150]);
      await page.keyboard.up("Alt");
      await expect
        .poll(async () => (await elementBox(page, canvas, "ellipse")).x)
        .toBeCloseTo(ellipse.x + 50, 0);
      const movedRect = await elementBox(page, canvas, "rectangle");
      const movedEllipse = await elementBox(page, canvas, "ellipse");
      expect(Math.abs(movedRect.x - rect.x - 50)).toBeLessThan(EXACT);
      expect(Math.abs(movedRect.y - rect.y - 50)).toBeLessThan(EXACT);
      expect(Math.abs(movedEllipse.x - ellipse.x - 50)).toBeLessThan(EXACT);
      expect(Math.abs(movedEllipse.y - ellipse.y - 50)).toBeLessThan(EXACT);

      // A duplicate of the group lands 10 down and right, above the original.
      await page.keyboard.press(`${MOD}+d`);
      await expect.poll(() => page.locator('[data-element-type="rectangle"]').count()).toBe(2);
      expect(await page.locator('[data-element-type="ellipse"]').count()).toBe(2);
      const copy = await elementBox(page, canvas, "rectangle", 1);
      expect(Math.abs(copy.x - movedRect.x - 10)).toBeLessThan(EXACT);
      expect(Math.abs(copy.y - movedRect.y - 10)).toBeLessThan(EXACT);
    });
  });

  it("sends a shape back and brings it forward in the paint order", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await drawBox(page, canvas, "r", [100, 100], [220, 200]);
      await drawBox(page, canvas, "o", [160, 140], [300, 260]);
      const ellipseId = await page
        .locator('[data-element-type="ellipse"]')
        .getAttribute("data-element-id");
      // The ellipse was drawn last, so it paints on top, and it is still selected.
      expect((await paintOrder(page)).at(-1)).toBe(ellipseId);
      await page.keyboard.press("Shift+[");
      await expect.poll(async () => (await paintOrder(page))[0]).toBe(ellipseId);
      await page.keyboard.press("]");
      await expect.poll(async () => (await paintOrder(page)).at(-1)).toBe(ellipseId);
      await runFromPalette(page, "send to back", /^Send to back/);
      await expect.poll(async () => (await paintOrder(page))[0]).toBe(ellipseId);
    });
  });

  it("switches a shape between the Sketch and Clean styles, named alike everywhere", async () => {
    await withPage(async (page) => {
      const canvas = await openNewBoard(page);
      await drawBox(page, canvas, "r", [100, 100], [200, 160]);
      await page.getByRole("radio", { name: "Sketch", checked: true }).waitFor();
      const path = page.locator('[data-element-type="rectangle"] path').first();
      // rough.js draws curves; the clean style draws the four straight sides.
      await expect.poll(() => path.getAttribute("d")).toMatch(/C/);

      await page.getByRole("radio", { name: "Clean" }).click();
      await expect.poll(() => path.getAttribute("d")).toMatch(/^M[^C]*h[^C]*v[^C]*Z$/);
      const clean = await elementBox(page, canvas, "rectangle");
      // The clean outline is exactly the dragged 100 by 60, plus half the 2 px stroke each side.
      expect(Math.abs(clean.width - 102)).toBeLessThan(EXACT);
      expect(Math.abs(clean.height - 62)).toBeLessThan(EXACT);

      await canvas.focus();
      await runFromPalette(page, "sketch style", /^Toggle sketch style/);
      await expect.poll(() => path.getAttribute("d")).toMatch(/C/);
      await page.getByRole("radio", { name: "Sketch", checked: true }).waitFor();

      // The keybindings page lists the command under the same name.
      await page.goto(new URL("/settings/keybindings", page.url()).href);
      await page.getByText("Toggle sketch style").first().waitFor();
    });
  });
});
