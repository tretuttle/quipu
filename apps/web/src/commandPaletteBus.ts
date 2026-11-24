// A tiny event bus: the shell's key handler, the native menu and the palette
// itself reach the palette through it without owning its React state.
const COMMAND_PALETTE_TOGGLE_EVENT = "quipu:toggle-command-palette";
const COMMAND_PALETTE_CHANGE_THEME_EVENT = "quipu:command-palette-change-theme";

/**
 * Whether the palette is open, known from the moment it is asked to open:
 * keys typed before its input takes the focus are the palette's, and must
 * not reach the canvas as tool shortcuts.
 */
let paletteOpen = false;

export function isCommandPaletteOpen(): boolean {
  return paletteOpen;
}

/** The palette reports its own state, so a close by Escape or a click is known here too. */
export function reportCommandPaletteOpen(open: boolean): void {
  paletteOpen = open;
}

/** Opens the palette, or closes it when it is open. */
export function toggleCommandPalette(): void {
  paletteOpen = !paletteOpen;
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_TOGGLE_EVENT));
}

export function onToggleCommandPalette(listener: () => void): () => void {
  window.addEventListener(COMMAND_PALETTE_TOGGLE_EVENT, listener);
  return () => window.removeEventListener(COMMAND_PALETTE_TOGGLE_EVENT, listener);
}

/** Opens the palette on its "Change theme" list (the `theme.select` chord). */
export function openChangeThemePalette(): void {
  paletteOpen = true;
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_CHANGE_THEME_EVENT));
}

export function onOpenChangeThemePalette(listener: () => void): () => void {
  window.addEventListener(COMMAND_PALETTE_CHANGE_THEME_EVENT, listener);
  return () => window.removeEventListener(COMMAND_PALETTE_CHANGE_THEME_EVENT, listener);
}
