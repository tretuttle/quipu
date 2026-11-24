/**
 * The tool vocabulary: which tools exist, their keyboard shortcuts,
 * and the states a gesture moves through. The machine itself runs inside the
 * editor (`editor.ts`), which owns the scene it mutates.
 */
export const TOOLS = [
  "select",
  "hand",
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "freehand",
  "text",
  "note",
  "frame",
  "eraser",
  "image",
] as const;
export type Tool = (typeof TOOLS)[number];

export function isTool(value: unknown): value is Tool {
  return typeof value === "string" && (TOOLS as readonly string[]).includes(value);
}

/** The single-key shortcut for each tool. */
export const TOOL_KEYS: Readonly<Record<Tool, string>> = {
  select: "v",
  hand: "h",
  rectangle: "r",
  ellipse: "o",
  diamond: "d",
  arrow: "a",
  line: "l",
  freehand: "p",
  text: "t",
  note: "n",
  frame: "f",
  eraser: "e",
  image: "i",
};

export const TOOL_LABELS: Readonly<Record<Tool, string>> = {
  select: "Select",
  hand: "Hand",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  arrow: "Arrow",
  line: "Line",
  freehand: "Freehand",
  text: "Text",
  note: "Sticky note",
  frame: "Frame",
  eraser: "Eraser",
  image: "Image",
};

/** Tools that create a box by dragging. */
const BOX_TOOLS = ["rectangle", "ellipse", "diamond", "frame", "note"] as const;
export type BoxTool = (typeof BOX_TOOLS)[number];

/** The eight resize handles plus rotation, named by compass direction. */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"] as const;
export type Handle = (typeof HANDLES)[number];

/** What the select tool is doing right now. */
export type SelectState =
  | { readonly kind: "idle" }
  | { readonly kind: "pointingCanvas"; readonly origin: Point2 }
  | {
      readonly kind: "pointingShape";
      readonly origin: Point2;
      readonly id: string;
      readonly wasSelected: boolean;
    }
  | { readonly kind: "translating"; readonly origin: Point2; readonly last: Point2 }
  | { readonly kind: "brushing"; readonly origin: Point2; readonly current: Point2 }
  | { readonly kind: "resizing"; readonly handle: Handle; readonly origin: Point2 }
  | { readonly kind: "rotating"; readonly origin: Point2; readonly startAngle: number }
  | { readonly kind: "draggingEnd"; readonly id: string; readonly end: "start" | "end" }
  | { readonly kind: "editingText"; readonly id: string };

export type GestureState =
  | { readonly tool: "select"; readonly state: SelectState }
  | {
      readonly tool: "hand";
      readonly state:
        | { readonly kind: "idle" }
        | { readonly kind: "dragging"; readonly last: Point2 };
    }
  | {
      readonly tool: BoxTool;
      readonly state:
        | { readonly kind: "idle" }
        | { readonly kind: "dragging"; readonly id: string; readonly origin: Point2 };
    }
  | {
      readonly tool: "line" | "arrow";
      readonly state:
        | { readonly kind: "idle" }
        | { readonly kind: "dragging"; readonly id: string };
    }
  | {
      readonly tool: "freehand";
      readonly state: { readonly kind: "idle" } | { readonly kind: "drawing"; readonly id: string };
    }
  | {
      readonly tool: "text";
      readonly state: { readonly kind: "idle" } | { readonly kind: "editing"; readonly id: string };
    }
  | {
      readonly tool: "eraser";
      readonly state:
        | { readonly kind: "idle" }
        | { readonly kind: "dragging"; readonly hit: ReadonlySet<string> };
    }
  | { readonly tool: "image"; readonly state: { readonly kind: "idle" } };

type Point2 = { readonly x: number; readonly y: number };

export interface PointerModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  /** Reported pen/touch pressure, 0.5 when the device has none. */
  readonly pressure: number;
}

export const NO_MODIFIERS: PointerModifiers = {
  shift: false,
  alt: false,
  ctrl: false,
  meta: false,
  pressure: 0.5,
};
