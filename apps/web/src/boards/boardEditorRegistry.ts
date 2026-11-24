/**
 * The board view that currently owns the keyboard. Shell commands (a chord,
 * a palette row, a native menu item) reach the editor through here, the way
 * `ShellCommandHost` reaches the sidebar: one registered target at a time.
 */
import type { Editor } from "@quipu/canvas/editor";

let active: Editor | null = null;

export function registerBoardEditor(editor: Editor): () => void {
  active = editor;
  return () => {
    if (active === editor) active = null;
  };
}

export function getActiveBoardEditor(): Editor | null {
  return active;
}

/** True when the element (or an ancestor) is a board canvas. */
export function isBoardCanvasFocused(target: EventTarget | null): boolean {
  const element =
    target instanceof Element
      ? target
      : document.activeElement instanceof Element
        ? document.activeElement
        : null;
  return element?.closest("[data-board-canvas]") !== null && element !== null;
}

/** True when the active board has a drawing selection (the `drawSelection` context key). */
export function hasDrawSelection(): boolean {
  return (active?.getState().selectedIds.size ?? 0) > 0;
}
