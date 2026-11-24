// Served by the dev server and imported by the e2e page: mounts the source view
// twice over the open document, once colored by shiki and once from the
// structural index, so a test can compare what Chromium paints for each.
import { createRoot } from "react-dom/client";

import { useDocumentSession } from "../src/documents/documentSession";
import { SourceView } from "../src/documents/SourceView";
import { installCustomTheme } from "../src/themePalette";
import { parseVsCodeThemeFile } from "../src/vscodeThemeImport";

const THEME_KEY = "quipu:theme";
const APPEARANCE_KEY = "quipu:theme-appearance-mode";

/**
 * Repaints from storage the way a change made in another window does: the app's
 * theme store listens for `storage` events, and a null key means "reread it all".
 */
const applyStoredTheme = () => window.dispatchEvent(new StorageEvent("storage", { key: null }));

export function mountEquality(): () => void {
  const { session } = useDocumentSession.getState();
  if (session.phase !== "open") throw new Error("Open a document first.");
  const host = document.createElement("div");
  host.dataset.equalityHost = "";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    background: "white",
  });
  document.body.append(host);
  const roots = (["shiki", "index"] as const).map((mode) => {
    const cell = document.createElement("div");
    cell.dataset.equalityCell = mode;
    Object.assign(cell.style, { height: "100%", display: "flex", minWidth: "0" });
    host.append(cell);
    const root = createRoot(cell);
    root.render(<SourceView document={session.document} highlighter={mode} />);
    return root;
  });
  return () => {
    for (const root of roots) root.unmount();
    host.remove();
  };
}

/** Paints a built-in theme (by id; "light" and "dark" are Graphite, the stock look). */
export function paintBuiltInTheme(themeId: string, appearance: "light" | "dark"): void {
  window.localStorage.setItem(THEME_KEY, themeId);
  window.localStorage.setItem(APPEARANCE_KEY, appearance);
  applyStoredTheme();
}

/**
 * Installs a VS Code theme the way the import does (token colors resolve into
 * its syntax table) and paints it. The test hands over strict JSON: a parser
 * only this file imported would be discovered by the dev server late and reload
 * the page under the test.
 */
export function paintRecordedTheme(json: string): string {
  const definition = installCustomTheme(parseVsCodeThemeFile(JSON.parse(json)));
  window.localStorage.setItem(THEME_KEY, definition.id);
  window.localStorage.setItem(APPEARANCE_KEY, definition.appearance);
  applyStoredTheme();
  return definition.id;
}
