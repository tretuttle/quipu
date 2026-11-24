import { type SyntaxTable, syntaxTableForAppearance } from "@quipu/shared/syntaxTable";
import { useMemo, useSyncExternalStore } from "react";

import { getThemeDefinition, type ThemeAppearance } from "../themePalette";

export interface SyntaxTheme {
  /** The painted theme's id, empty for the stock light and dark. */
  readonly themeId: string;
  readonly appearance: ThemeAppearance;
  readonly table: SyntaxTable;
}

const OBSERVED_ATTRIBUTES = ["class", "data-theme-id"];

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: OBSERVED_ATTRIBUTES,
  });
  return () => observer.disconnect();
}

/** The painted theme's id and appearance, as `applyThemePalette` leaves them on the root element. */
function snapshot(): string {
  const root = document.documentElement;
  return `${root.classList.contains("dark") ? "dark" : "light"}:${root.dataset.themeId ?? ""}`;
}

const serverSnapshot = () => "light:";

/**
 * The syntax table the active theme paints JSON with: the theme's own when it
 * was imported with token colors, else the
 * pierre fallback for the active appearance. It follows the same root
 * attributes the palette sets, so a theme switch recolors the visible lines.
 */
export function useSyntaxTheme(): SyntaxTheme {
  const key = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return useMemo(() => {
    const separator = key.indexOf(":");
    const appearance: ThemeAppearance = key.slice(0, separator) === "dark" ? "dark" : "light";
    const themeId = key.slice(separator + 1);
    const definition = themeId === "" ? null : getThemeDefinition(themeId);
    return {
      themeId,
      appearance,
      table: syntaxTableForAppearance(definition?.syntax, appearance),
    };
  }, [key]);
}
