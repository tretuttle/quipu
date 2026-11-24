import type { Flow } from "../flows.ts";

/** A new board: two shapes joined by an arrow, a sticky note and a line of text. */
export const board: Flow = {
  id: "board",
  title: "Draw on a new board",
  run: async ({ page, click, drag, moveTo, press, type, wait }) => {
    await moveTo({ x: 500, y: 420 }, 500);
    await click(page.getByRole("button", { name: "New board" }), 700);
    const canvas = page.getByRole("application", { name: "Board canvas" });
    await canvas.waitFor();
    await page.getByTestId("board-save-status").getByText("Saved").waitFor();
    await wait(500);

    const box = await canvas.boundingBox();
    if (box === null) throw new Error("The board canvas has no box.");
    // Drawing coordinates, kept right of the style panel that covers the canvas's top left.
    const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
    const tool = async (name: string) => {
      await click(page.getByRole("radio", { name, exact: true }), 650);
      await page.getByRole("radio", { name, exact: true, checked: true }).waitFor();
    };
    const element = (type: string) => page.locator(`[data-element-type="${type}"]`);

    await tool("Rectangle");
    await drag(at(320, 220), at(500, 340), 600);
    await element("rectangle").waitFor();
    await wait(400);

    await tool("Ellipse");
    await drag(at(680, 220), at(860, 340), 600);
    await element("ellipse").waitFor();
    await wait(400);

    // Pressed inside the rectangle and dropped on the ellipse, the arrow joins their edges.
    await tool("Arrow");
    await drag(at(470, 280), at(720, 280), 600);
    await element("arrow").waitFor();
    await wait(500);

    await tool("Sticky note");
    await click(at(330, 440), 600);
    await page.getByRole("textbox", { name: "Sticky note text" }).waitFor();
    await type("Check the wind sensor", 45);
    await press("Escape");
    // The note wraps its text onto two lines.
    await element("note").filter({ hasText: "Check the wind" }).waitFor();
    await wait(400);

    await tool("Text");
    await click(at(640, 470), 600);
    await page.getByRole("textbox", { name: "Text", exact: true }).waitFor();
    await type("Winter plan", 60);
    await press("Escape");
    await element("text").filter({ hasText: "Winter plan" }).waitFor();
    await moveTo(at(560, 600), 600);
    await wait(1000);
  },
};
