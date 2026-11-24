import { describe, expect, it } from "@effect/vitest";

import { MIN_ZOOM, visibleWorldBox } from "./camera.ts";
import { createEditor, type Editor } from "./editor.ts";
import { boxContainsBox, boxContainsPoint, type Box } from "./geometry.ts";
import { elementBox, linearWorldPoints } from "./hitTest.ts";
import { monospaceMeasure } from "./text.ts";
import { NO_MODIFIERS } from "./tools.ts";
import type { Element } from "./elements.ts";

function make(): Editor {
  return createEditor({
    seed: 7,
    measure: monospaceMeasure(),
    viewport: { width: 800, height: 600 },
  });
}

function drag(
  editor: Editor,
  from: [number, number],
  to: [number, number],
  steps = 4,
  modifiers = NO_MODIFIERS,
) {
  editor.pointerDown({ x: from[0], y: from[1] }, modifiers);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    editor.pointerMove(
      { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t },
      modifiers,
    );
  }
  editor.pointerUp({ x: to[0], y: to[1] }, modifiers);
}

/** Map nodes as the shell describes them: boxes the editor does not own. */
function describeMapNodes(editor: Editor, boxes: ReadonlyMap<string, Box>) {
  editor.setExternalTargets({
    boxOf: (id) => boxes.get(id) ?? null,
    hitAt: (world, threshold) => {
      for (const [id, box] of boxes) {
        if (boxContainsPoint(box, world, threshold)) return id;
      }
      return null;
    },
  });
}

function live(editor: Editor): ReadonlyArray<Element> {
  return editor.getState().elements;
}

describe("editor gestures", () => {
  it("drags a rectangle, ellipse and diamond into the boxes the pointer covered", () => {
    const editor = make();
    for (const tool of ["rectangle", "ellipse", "diamond"] as const) {
      editor.setTool(tool);
      drag(editor, [100, 100], [220, 180]);
    }
    const elements = live(editor);
    expect(elements.map((e) => e.type)).toEqual(["rectangle", "ellipse", "diamond"]);
    for (const e of elements)
      expect(elementBox(e)).toEqual({ x: 100, y: 100, width: 120, height: 80 });
    expect(editor.getState().tool).toBe("select");
    expect(editor.getState().selectedIds).toEqual(new Set([elements[2]?.id]));
  });

  it("a hollow ellipse hits on its stroke until selected, then anywhere in its box", () => {
    const editor = make();
    editor.setTool("ellipse");
    drag(editor, [100, 100], [400, 140]);
    const id = live(editor)[0]?.id;
    editor.escape();
    expect(editor.getState().selectedIds.size).toBe(0);
    // Near the box corner, 13 units from the outline: outside the 10px slop.
    expect(editor.hitTest({ x: 102, y: 102 })).toBeNull();
    // The center is 20 units from the outline (the half-height), not 150.
    expect(editor.hitTest({ x: 250, y: 120 })).toBeNull();
    expect(editor.hitTest({ x: 250, y: 101 })).toBe(id);
    editor.select([id as string]);
    expect(editor.hitTest({ x: 102, y: 102 })).toBe(id);
    expect(editor.hitTest({ x: 250, y: 120 })).toBe(id);

    // At the smallest zoom the slop is 100 world units, which reaches the center.
    editor.escape();
    editor.setCamera({ x: 0, y: 0, k: MIN_ZOOM });
    expect(editor.hitTest(editor.screenPoint({ x: 250, y: 120 }))).toBe(id);
    expect(editor.hitTest(editor.screenPoint({ x: 250, y: 260 }))).toBeNull();
  });

  it("a click with a box tool creates nothing, and shift constrains to a square", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [10, 10], [11, 11], 1);
    expect(live(editor)).toHaveLength(0);
    editor.setTool("rectangle");
    drag(editor, [10, 10], [110, 40], 2, { ...NO_MODIFIERS, shift: true });
    expect(elementBox(live(editor)[0] as Element)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
    });
  });

  it("one drag is one undo entry, and redo restores it", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [0, 0], [50, 50]);
    const id = live(editor)[0]?.id as string;
    drag(editor, [25, 25], [125, 85], 10);
    expect(elementBox(live(editor)[0] as Element)).toMatchObject({ x: 100, y: 60 });
    editor.undo();
    expect(elementBox(live(editor)[0] as Element)).toMatchObject({ x: 0, y: 0 });
    editor.undo();
    expect(live(editor)).toHaveLength(0);
    editor.redo();
    expect(live(editor)[0]?.id).toBe(id);
    editor.redo();
    expect(elementBox(live(editor)[0] as Element)).toMatchObject({ x: 100, y: 60 });
    expect(editor.getState().canRedo).toBe(false);
  });

  it("an arrow drawn onto a shape binds to it and follows when the shape moves", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [300, 100], [400, 200]);
    const target = live(editor)[0] as Element;
    editor.setTool("arrow");
    drag(editor, [100, 150], [350, 150], 6);
    const arrow = live(editor).find((e) => e.type === "arrow");
    expect(arrow?.type === "arrow" && arrow.endBinding?.targetId).toBe(target.id);
    const endBefore = linearWorldPoints(arrow as never)[1] as { x: number; y: number };
    expect(endBefore.x).toBeCloseTo(300 - 4, 3);
    // Move the rectangle down by 100: the arrow end lands on its new left edge,
    // where the ray from the new center (350, 250) toward the start (100, 150) leaves.
    editor.select([target.id]);
    drag(editor, [350, 150], [350, 250], 5);
    expect(elementBox(live(editor).find((e) => e.id === target.id) as Element)).toEqual({
      x: 300,
      y: 200,
      width: 100,
      height: 100,
    });
    const movedArrow = live(editor).find((e) => e.type === "arrow") as Element;
    const endAfter = linearWorldPoints(movedArrow as never)[1] as { x: number; y: number };
    expect(endAfter.x).toBeCloseTo(300 - 4, 3);
    expect(endAfter.y).toBeCloseTo(250 - 100 * (54 / 250), 3);
    const startAfter = linearWorldPoints(movedArrow as never)[0] as { x: number; y: number };
    expect(startAfter).toEqual({ x: 100, y: 150 });
  });

  it("an arrow dropped on a map node binds to it and follows the node through a re-layout", () => {
    const editor = make();
    // A map node is a box the editor does not own; the shell describes it.
    const boxes = new Map([["map:1.42", { x: 300, y: 100, width: 100, height: 100 }]]);
    describeMapNodes(editor, boxes);
    editor.setTool("arrow");
    drag(editor, [100, 150], [350, 150], 6);
    const arrow = live(editor).find((e) => e.type === "arrow");
    expect(arrow?.type === "arrow" && arrow.endBinding?.targetId).toBe("map:1.42");
    expect(linearWorldPoints(arrow as never)[1]?.x).toBeCloseTo(300 - 4, 3);

    // The layout moves the node down by 200 (a sibling above it expanded).
    boxes.set("map:1.42", { x: 300, y: 300, width: 100, height: 100 });
    const canUndoBefore = editor.getState().canUndo;
    editor.refreshExternalBindings();
    const followed = live(editor).find((e) => e.type === "arrow") as Element;
    const end = linearWorldPoints(followed as never)[1] as { x: number; y: number };
    expect(end.x).toBeCloseTo(300 - 4, 3);
    expect(end.y).toBeGreaterThan(290);
    expect(end.y).toBeLessThan(350);
    expect(linearWorldPoints(followed as never)[0]).toEqual({ x: 100, y: 150 });
    // Following a layout is not an edit the user can undo.
    expect(editor.getState().canUndo).toBe(canUndoBefore);

    // A node that is not drawn right now keeps its binding; the arrow stays put.
    boxes.delete("map:1.42");
    editor.refreshExternalBindings();
    const kept = live(editor).find((e) => e.type === "arrow");
    expect(kept?.type === "arrow" && kept.endBinding?.targetId).toBe("map:1.42");

    // Fit frames the map's bounds too, not just the drawing.
    editor.setContentBounds(() => ({ x: 0, y: 0, width: 4000, height: 100 }));
    editor.zoomToFit();
    expect(editor.getState().camera.k).toBeLessThan(0.25);
  });

  it("a note dropped on a map node rides along with the node, and floats free once dragged off it", () => {
    const editor = make();
    const boxes = new Map([["map:1.7", { x: 300, y: 100, width: 200, height: 200 }]]);
    describeMapNodes(editor, boxes);
    editor.setTool("note");
    drag(editor, [320, 120], [321, 121], 1);
    const noteId = editor.getState().editingTextId as string;
    editor.commitText(noteId, "pinned");
    const noteBox = () => elementBox(editor.scene.get(noteId) as Element);
    expect(noteBox()).toEqual({ x: 320, y: 120, width: 160, height: 160 });
    // An arrow bound to the note follows it too.
    editor.setTool("arrow");
    drag(editor, [50, 200], [400, 200], 6);
    const arrowEnd = () => {
      const arrow = live(editor).find((e) => e.type === "arrow");
      return linearWorldPoints(arrow as never)[1] as { x: number; y: number };
    };
    expect(arrowEnd().x).toBeCloseTo(320 - 4, 3);

    // The layout moves the node down by 300 and right by 50.
    boxes.set("map:1.7", { x: 350, y: 400, width: 200, height: 200 });
    const canUndoBefore = editor.getState().canUndo;
    editor.refreshExternalBindings();
    expect(noteBox()).toEqual({ x: 370, y: 420, width: 160, height: 160 });
    expect(arrowEnd().x).toBeCloseTo(370 - 4, 3);
    expect(arrowEnd().y).toBeGreaterThan(420);
    expect(arrowEnd().y).toBeLessThan(580);
    expect(editor.getState().canUndo).toBe(canUndoBefore);

    // A node that is not drawn right now leaves the note where it is.
    boxes.delete("map:1.7");
    editor.refreshExternalBindings();
    expect(noteBox()).toEqual({ x: 370, y: 420, width: 160, height: 160 });

    // Dragged off the node, the note no longer follows it.
    boxes.set("map:1.7", { x: 350, y: 400, width: 200, height: 200 });
    editor.setTool("select");
    drag(editor, [450, 560], [450, 960], 4, { ...NO_MODIFIERS, alt: true });
    expect(noteBox()).toEqual({ x: 370, y: 820, width: 160, height: 160 });
    boxes.set("map:1.7", { x: 0, y: 0, width: 200, height: 200 });
    editor.refreshExternalBindings();
    expect(noteBox()).toEqual({ x: 370, y: 820, width: 160, height: 160 });

    // Dropped back on a node, it attaches again.
    drag(editor, [450, 900], [100, 100], 4, { ...NO_MODIFIERS, alt: true });
    expect(noteBox()).toEqual({ x: 20, y: 20, width: 160, height: 160 });
    boxes.set("map:1.7", { x: 1000, y: 0, width: 200, height: 200 });
    editor.refreshExternalBindings();
    expect(noteBox()).toEqual({ x: 1020, y: 20, width: 160, height: 160 });
  });

  it("an arrow started inside a shape starts on the shape's edge facing its other end", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [100, 100], [200, 200]);
    editor.setTool("arrow");
    // Pressed near the rectangle's top-left corner, drawn out to the right.
    drag(editor, [120, 120], [400, 150], 6);
    const arrow = live(editor).find((e) => e.type === "arrow");
    const [start, end] = linearWorldPoints(arrow as never);
    // The right edge, 4 units out, on the line toward the end.
    expect(start?.x).toBeCloseTo(204, 0);
    expect(start?.y).toBeGreaterThan(140);
    expect(start?.y).toBeLessThan(160);
    expect(end).toEqual({ x: 400, y: 150 });
  });

  it("a frame's name is edited from its label, is undoable, and an emptied name goes back to Frame", () => {
    const editor = make();
    editor.setTool("frame");
    drag(editor, [100, 100], [300, 250]);
    const frameId = live(editor)[0]?.id as string;
    const name = () => {
      const frame = editor.scene.get(frameId);
      return frame?.type === "frame" ? frame.name : null;
    };
    // A double-click inside the frame is not on its label.
    editor.doubleClick({ x: 200, y: 180 });
    expect(editor.getState().editingTextId).toBeNull();
    // The label sits in the band just above the frame.
    editor.doubleClick({ x: 130, y: 90 });
    expect(editor.getState().editingTextId).toBe(frameId);
    editor.commitText(frameId, "  Checkout  ");
    expect(name()).toBe("Checkout");
    editor.undo();
    expect(name()).toBe("Frame");
    editor.redo();
    expect(name()).toBe("Checkout");

    // Cancelling keeps the name; an emptied name goes back to the default.
    editor.doubleClick({ x: 130, y: 90 });
    editor.cancelText();
    expect(name()).toBe("Checkout");
    editor.select([frameId]);
    editor.editSelectedText();
    expect(editor.getState().editingTextId).toBe(frameId);
    editor.commitText(frameId, "   ");
    expect(name()).toBe("Frame");
  });

  it("a marquee selects only elements fully inside it, and the eraser tombstones what it crosses", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [0, 0], [50, 50]);
    editor.setTool("rectangle");
    drag(editor, [100, 100], [150, 150]);
    editor.setTool("rectangle");
    drag(editor, [300, 300], [350, 350]);
    editor.setTool("select");
    editor.escape();
    drag(editor, [-10, -10], [200, 200]);
    expect(editor.getState().selectedIds.size).toBe(2);
    editor.setTool("eraser");
    drag(editor, [90, 125], [160, 125], 8);
    expect(live(editor).map((e) => elementBox(e).x)).toEqual([0, 300]);
    expect(editor.allElements()).toHaveLength(3);
    editor.undo();
    expect(live(editor)).toHaveLength(3);
  });

  it("on the map, dragging empty space pans; Shift+drag still draws the marquee; a shape still moves", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [100, 100], [150, 150]);
    editor.setTool("select");
    editor.escape();
    editor.setEmptyDragPans(true);
    const before = editor.getState().camera;
    drag(editor, [400, 400], [460, 430]);
    const after = editor.getState().camera;
    expect([after.x - before.x, after.y - before.y]).toEqual([60, 30]);
    expect(editor.getState().marquee).toBeNull();
    expect(editor.getState().tool).toBe("select");
    // Shift+drag over the rectangle selects it with a marquee, without panning.
    drag(editor, [90, 90], [220, 220], 4, { ...NO_MODIFIERS, shift: true });
    expect(editor.getState().camera).toEqual(after);
    expect(editor.getState().selectedIds.size).toBe(1);
    // Dragging the rectangle moves it, not the camera.
    const [moved] = live(editor);
    // The pan moved it on screen by (60, 30): its middle is now at (185, 155).
    drag(editor, [185, 155], [205, 155]);
    expect(editor.getState().camera).toEqual(after);
    expect(elementBox(live(editor)[0]!).x).toBeCloseTo(elementBox(moved!).x + 20 / after.k, 5);
  });

  it("without it (a board), dragging empty space draws a marquee and the camera stays", () => {
    const editor = make();
    const before = editor.getState().camera;
    editor.pointerDown({ x: 400, y: 400 });
    editor.pointerMove({ x: 460, y: 430 });
    expect(editor.getState().marquee).not.toBeNull();
    editor.pointerUp({ x: 460, y: 430 });
    expect(editor.getState().camera).toEqual(before);
  });

  it("stops zooming out at a floor the owner sets", () => {
    const editor = make();
    editor.setZoomFloor(0.12);
    for (let i = 0; i < 60; i += 1) editor.zoomOut();
    expect(editor.getState().camera.k).toBeCloseTo(0.12, 6);
    expect(editor.getState().zoomFloor).toBe(0.12);
  });

  it("lets the owner decide what Zoom to fit shows", () => {
    const editor = make();
    editor.setContentBounds(() => ({ x: 0, y: 0, width: 100, height: 50_000 }));
    editor.setFitPolicy((_camera, _viewport, minZoom) => ({
      x: 10,
      y: 20,
      k: Math.max(minZoom, 0.85),
    }));
    editor.zoomToFit();
    expect(editor.getState().camera).toEqual({ x: 10, y: 20, k: 0.85 });
    // A policy that declines leaves the plain fit.
    editor.setFitPolicy(() => null);
    editor.zoomToFit();
    expect(editor.getState().camera.k).toBeLessThan(0.1);
  });

  it("starts and ends an arrow bound to map cards on the cards' edges, not over their rows", () => {
    const editor = make();
    const cards = new Map<string, Box>([
      ["left", { x: 100, y: 100, width: 200, height: 160 }],
      ["right", { x: 500, y: 140, width: 200, height: 100 }],
    ]);
    describeMapNodes(editor, cards);
    editor.setTool("arrow");
    // Pressed over a row inside the left card, released over a row inside the right one.
    drag(editor, [180, 200], [560, 190]);
    const arrow = live(editor).find((element) => element.type === "arrow")!;
    const points = linearWorldPoints(arrow as Parameters<typeof linearWorldPoints>[0]);
    const [start, end] = [points[0]!, points.at(-1)!];
    const inside = (p: { x: number; y: number }, box: Box) =>
      p.x > box.x + 1 &&
      p.x < box.x + box.width - 1 &&
      p.y > box.y + 1 &&
      p.y < box.y + box.height - 1;
    expect(inside(start, cards.get("left")!)).toBe(false);
    expect(inside(end, cards.get("right")!)).toBe(false);
    // Just outside each card's edge facing the other card.
    expect(start.x).toBeGreaterThanOrEqual(300);
    expect(end.x).toBeLessThanOrEqual(500);
  });

  it("freehand keeps the input points and the tool stays armed", () => {
    const editor = make();
    editor.setTool("freehand");
    drag(editor, [10, 10], [60, 40], 5);
    const stroke = live(editor)[0];
    expect(stroke?.type).toBe("freehand");
    expect(stroke?.type === "freehand" && stroke.points.length).toBe(6);
    expect(editor.getState().tool).toBe("freehand");
  });

  it("text is committed with a measured box, and an empty text is discarded", () => {
    const editor = make();
    editor.setTool("text");
    editor.pointerDown({ x: 40, y: 40 });
    const id = editor.getState().editingTextId as string;
    editor.commitText(id, "hello");
    const text = live(editor)[0];
    expect(text?.type === "text" && text.text).toBe("hello");
    expect(text?.width).toBeCloseTo(5 * 0.6 * 20, 6);
    editor.setTool("text");
    editor.pointerDown({ x: 200, y: 200 });
    editor.commitText(editor.getState().editingTextId as string, "   ");
    expect(live(editor)).toHaveLength(1);
    expect(editor.allElements()).toHaveLength(1);
  });

  it("the Clean style writes text in the interface font and Sketch in the hand font", () => {
    const editor = make();
    editor.setTool("text");
    drag(editor, [20, 20], [20, 20], 1);
    const textId = editor.getState().editingTextId as string;
    editor.commitText(textId, "hello");
    const font = () => {
      const element = editor.scene.get(textId);
      return element?.type === "text" ? element.fontFamily : null;
    };
    expect(font()).toBe("hand");
    editor.select([textId]);
    editor.setStyle({ roughness: 0 });
    expect(font()).toBe("sans");
    editor.setStyle({ roughness: 1 });
    expect(font()).toBe("hand");

    // New text follows the style too, and monospace text keeps its font.
    editor.escape();
    editor.setStyle({ roughness: 0 });
    editor.setTool("note");
    drag(editor, [300, 20], [300, 20], 1);
    const noteId = editor.getState().editingTextId as string;
    editor.commitText(noteId, "clean note");
    const note = editor.scene.get(noteId);
    expect(note?.type === "note" && note.fontFamily).toBe("sans");
    editor.setTextStyle({ fontFamily: "mono" });
    editor.setStyle({ roughness: 1 });
    expect(editor.getState().textStyle.fontFamily).toBe("mono");
  });

  it("a sticky note gets a default size from a click and opens for editing", () => {
    const editor = make();
    editor.setTool("note");
    drag(editor, [20, 20], [21, 21], 1);
    const note = live(editor)[0];
    expect(note?.type).toBe("note");
    expect(elementBox(note as Element)).toEqual({ x: 20, y: 20, width: 160, height: 160 });
    expect(editor.getState().editingTextId).toBe(note?.id);
  });

  it("a frame adopts the elements inside it and moves them with it", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [20, 20], [60, 60]);
    editor.setTool("frame");
    drag(editor, [0, 0], [100, 100]);
    const frame = live(editor).find((e) => e.type === "frame") as Element;
    const inner = live(editor).find((e) => e.type === "rectangle") as Element;
    expect(inner.frameId).toBe(frame.id);
    editor.select([frame.id]);
    drag(editor, [50, 90], [250, 90], 4);
    expect(elementBox(live(editor).find((e) => e.type === "rectangle") as Element).x).toBe(220);
  });

  it("duplicate, group, align and distribute act on the selection in one entry each", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [0, 0], [40, 40]);
    editor.setTool("rectangle");
    drag(editor, [100, 50], [140, 90]);
    editor.setTool("rectangle");
    drag(editor, [300, 20], [340, 60]);
    editor.selectAll();
    editor.alignSelection("top");
    expect(live(editor).every((e) => e.y === 0)).toBe(true);
    editor.distributeSelection("horizontal");
    const xs = live(editor)
      .map((e) => e.x)
      .sort((a, b) => a - b);
    expect(xs).toEqual([0, 150, 300]);
    editor.groupSelection();
    expect(live(editor).every((e) => e.groupIds.length === 1)).toBe(true);
    editor.duplicateSelection();
    expect(live(editor)).toHaveLength(6);
    expect(editor.getState().selectedIds.size).toBe(3);
    editor.undo();
    expect(live(editor)).toHaveLength(3);
    editor.undo();
    expect(live(editor).every((e) => e.groupIds.length === 0)).toBe(true);
    editor.undo();
    expect(
      live(editor)
        .map((e) => e.x)
        .sort((a, b) => a - b),
    ).toEqual([0, 100, 300]);
  });

  it("clicking one member of a group selects the group, and nudging moves it", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [0, 0], [40, 40]);
    editor.setTool("rectangle");
    drag(editor, [100, 0], [140, 40]);
    editor.selectAll();
    editor.groupSelection();
    editor.escape();
    expect(editor.getState().selectedIds.size).toBe(0);
    // On the first rectangle's top edge: a hollow shape hits on its stroke.
    editor.pointerDown({ x: 20, y: 1 });
    editor.pointerUp({ x: 20, y: 1 });
    expect(editor.getState().selectedIds.size).toBe(2);
    editor.nudgeSelection(10, 0);
    expect(live(editor).map((e) => e.x)).toEqual([10, 110]);
  });

  it("resizing from the south-east handle and rotating change geometry; the hand tool pans", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [100, 100], [200, 200]);
    drag(editor, [200, 200], [300, 250], 3);
    expect(elementBox(live(editor)[0] as Element)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 150,
    });
    const rotateHandle = editor.getState().handles.find((h) => h.handle === "rotate");
    expect(rotateHandle).toBeDefined();
    editor.pointerDown({ x: rotateHandle!.point.x, y: rotateHandle!.point.y });
    editor.pointerMove({ x: 400, y: 175 });
    editor.pointerUp({ x: 400, y: 175 });
    expect((live(editor)[0] as Element).angle).toBeCloseTo(Math.PI / 2, 3);
    editor.setTool("hand");
    drag(editor, [10, 10], [60, 30], 2);
    expect(editor.getState().camera).toEqual({ x: 50, y: 20, k: 1 });
  });

  it("wheel with ctrl zooms about the cursor; plain wheel pans; fit frames the content", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [100, 100], [300, 200]);
    const before = editor.worldPoint({ x: 150, y: 150 });
    editor.wheel(
      { x: 150, y: 150 },
      { deltaX: 0, deltaY: -100, ctrl: true, meta: false, shift: false },
    );
    expect(editor.getState().camera.k).toBeGreaterThan(1);
    const after = editor.worldPoint({ x: 150, y: 150 });
    expect(after.x).toBeCloseTo(before.x, 3);
    editor.wheel(
      { x: 0, y: 0 },
      { deltaX: 10, deltaY: 20, ctrl: false, meta: false, shift: false },
    );
    editor.zoomToFit();
    const { camera } = editor.getState();
    expect(camera.k).toBeLessThanOrEqual(1);
    const center = editor.screenPoint({ x: 200, y: 150 });
    expect(center).toEqual({ x: 400, y: 300 });
  });

  it("style changes apply to the selection and to new elements; the style is reflected in persisted records", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [0, 0], [10, 10]);
    editor.setStyle({ stroke: "blue", roughness: 0 });
    expect((live(editor)[0] as Element).style).toMatchObject({ stroke: "blue", roughness: 0 });
    editor.setTool("ellipse");
    drag(editor, [50, 50], [80, 80]);
    expect((live(editor)[1] as Element).style).toMatchObject({ stroke: "blue", roughness: 0 });
    editor.undo();
    editor.undo();
    expect((live(editor)[0] as Element).style.stroke).toBe("default");
  });

  it("loading elements replaces the scene and clears history; z-order commands reorder", () => {
    const editor = make();
    editor.setTool("rectangle");
    drag(editor, [0, 0], [10, 10]);
    editor.setTool("rectangle");
    drag(editor, [5, 5], [15, 15]);
    const [bottom, top] = live(editor);
    editor.select([bottom!.id]);
    editor.bringToFront();
    expect(live(editor).map((e) => e.id)).toEqual([top!.id, bottom!.id]);
    editor.sendBackward();
    expect(live(editor).map((e) => e.id)).toEqual([bottom!.id, top!.id]);
    const saved = editor.allElements();
    const fresh = make();
    fresh.loadElements(saved);
    expect(fresh.getState().elements.map((e) => e.id)).toEqual([bottom!.id, top!.id]);
    expect(fresh.getState().canUndo).toBe(false);
  });
});

describe("the zoom floor", () => {
  it("fits content taller than the viewport allows at MIN_ZOOM, and the wheel stops at that fit", () => {
    const editor = make();
    const tall = { x: 0, y: 0, width: 400, height: 60_000 };
    editor.setContentBounds(() => tall);
    editor.zoomToFit();
    const fitted = editor.getState().camera;
    expect(fitted.k).toBeLessThan(MIN_ZOOM);
    expect(boxContainsBox(visibleWorldBox(fitted, editor.getState().viewport), tall)).toBe(true);
    const wheel = { deltaX: 0, deltaY: 100_000, ctrl: true, meta: false, shift: false };
    for (let i = 0; i < 20; i += 1) editor.wheel({ x: 400, y: 300 }, wheel);
    expect(editor.getState().camera.k).toBeCloseTo(fitted.k, 6);
    editor.zoomOut();
    expect(editor.getState().camera.k).toBeCloseTo(fitted.k, 6);
    // A board (no external content) keeps the `MIN_ZOOM` floor.
    editor.setContentBounds(null);
    editor.zoomOut();
    expect(editor.getState().camera.k).toBe(MIN_ZOOM);
  });
});
