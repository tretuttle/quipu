// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  getThemeColorsForMode,
  OCEAN_THEME,
  OCEAN_THEME_ID,
  ORCHID_THEME,
  ORCHID_THEME_ID,
  QUIPU_THEME,
  THEME_PREVIEW_ID,
} from "../../themePalette";
import { ThemeEditorHost } from "./ThemeEditorHost";
import { toggleThemeEditorForTheme } from "./themeEditorStore";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme-id");
  document.documentElement.removeAttribute("style");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ThemeEditorHost));
  });
});

afterEach(async () => {
  if (document.querySelector("[data-theme-editor-panel]")) {
    await act(async () => {
      toggleThemeEditorForTheme({
        theme: ORCHID_THEME_ID,
        themeHalves: null,
        initialAppearance: "light",
      });
    });
  }
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("toggleThemeEditorForTheme", () => {
  it("opens a new editor seeded from the theme active for the current appearance", async () => {
    await act(async () => {
      toggleThemeEditorForTheme({
        theme: ORCHID_THEME_ID,
        themeHalves: { dark: OCEAN_THEME_ID },
        initialAppearance: "dark",
      });
      await import("./ThemeEditorPanel");
    });

    expect(document.documentElement.dataset.themeId).toBe(THEME_PREVIEW_ID);
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).toBe(
      getThemeColorsForMode(OCEAN_THEME, "dark")!.canvas,
    );
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).not.toBe(
      getThemeColorsForMode(ORCHID_THEME, "dark")!.canvas,
    );
  });

  it("closes an open editor", async () => {
    await act(async () => {
      toggleThemeEditorForTheme({
        theme: ORCHID_THEME_ID,
        themeHalves: null,
        initialAppearance: "light",
      });
      await import("./ThemeEditorPanel");
    });
    expect(document.documentElement.dataset.themeId).toBe(THEME_PREVIEW_ID);
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).toBe(
      getThemeColorsForMode(ORCHID_THEME, "light")!.canvas,
    );

    await act(async () => {
      toggleThemeEditorForTheme({
        theme: ORCHID_THEME_ID,
        themeHalves: null,
        initialAppearance: "light",
      });
    });

    // Nothing is stored, so closing goes back to the default palette.
    expect(document.querySelector("[data-theme-editor-panel]")).toBeNull();
    expect(document.documentElement.dataset.themeId).toBe(QUIPU_THEME.id);
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).toBe(
      getThemeColorsForMode(QUIPU_THEME, "light")!.canvas,
    );
  });
});
