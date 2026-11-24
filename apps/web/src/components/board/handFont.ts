import { isTextBearing } from "@quipu/canvas/elements";
import type { EditorState } from "@quipu/canvas/editor";

/** The bundled hand-drawn face; the system handwriting fonts in `--font-hand` stay as fallbacks. */
const HAND_FONT_FAMILY = "Kalam";

let loading: Promise<void> | null = null;

/**
 * Loads the hand font's stylesheet and its Latin face once. Callers re-measure
 * text afterwards: widths taken with a fallback face are wrong for Kalam.
 */
export function loadHandFont(): Promise<void> {
  loading ??= import("@fontsource/kalam/400.css")
    .then(() => document.fonts.load(`16px "${HAND_FONT_FAMILY}"`))
    .then(() => undefined);
  return loading;
}

/** True when the drawing shows hand-font text, or the next text or note will use it. */
export function needsHandFont(state: EditorState): boolean {
  const armed = state.tool === "text" || state.tool === "note" || state.editingTextId !== null;
  if (armed && state.textStyle.fontFamily === "hand") return true;
  return state.elements.some((element) => isTextBearing(element) && element.fontFamily === "hand");
}
