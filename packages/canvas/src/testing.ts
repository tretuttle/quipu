/** Shared fixtures for the package's own tests. */
import { DEFAULT_STYLE, type Element, type ElementStyle } from "./elements.ts";

export interface RectPatch {
  readonly id?: string;
  readonly angle?: number;
  readonly seed?: number;
  readonly style?: Partial<ElementStyle>;
}

let counter = 0;

export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  patch: RectPatch = {},
): Element {
  counter += 1;
  const { style, ...rest } = patch;
  return {
    id: `r${counter}`,
    type: "rectangle",
    x,
    y,
    width,
    height,
    angle: 0,
    index: `V${counter.toString(36).padStart(4, "1")}`,
    seed: 1 + counter,
    version: 0,
    isDeleted: false,
    locked: false,
    groupIds: [],
    frameId: null,
    style: { ...DEFAULT_STYLE, ...style },
    ...rest,
  };
}
