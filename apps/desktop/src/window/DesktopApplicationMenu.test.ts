import { describe, expect, it } from "vite-plus/test";
import type { DesktopMenuAction } from "@quipu/contracts";
import type * as Electron from "electron";

import { buildApplicationMenuTemplate } from "./DesktopApplicationMenu.ts";

type Item = Electron.MenuItemConstructorOptions;

function build(platform: NodeJS.Platform) {
  const dispatched: DesktopMenuAction[] = [];
  const template = buildApplicationMenuTemplate({
    platform,
    displayName: "Quipu (Alpha)",
    dispatch: (action) => dispatched.push(action),
  });
  return { template, dispatched };
}

function menuNamed(template: readonly Item[], label: string): readonly Item[] {
  const menu = template.find((item) => item.label === label);
  if (!menu || !Array.isArray(menu.submenu)) throw new Error(`No ${label} menu.`);
  return menu.submenu;
}

function click(items: readonly Item[], label: string): void {
  const item = items.find((candidate) => candidate.label === label);
  if (!item?.click) throw new Error(`No clickable ${label} item.`);
  (item.click as () => void)();
}

describe("application menu", () => {
  it("mirrors the shell commands in View and Go under their palette titles", () => {
    const { template, dispatched } = build("linux");
    const view = menuNamed(template, "View");
    click(view, "Toggle sidebar");
    click(view, "Toggle right panel");
    click(view, "Show all commands");
    const go = menuNamed(template, "Go");
    click(go, "Go back");
    click(go, "Go forward");

    expect(dispatched).toEqual([
      "sidebar.toggle",
      "rightPanel.toggle",
      "commandPalette.toggle",
      "navigation.back",
      "navigation.forward",
    ]);
  });

  it("opens and closes a document from File", () => {
    const { template, dispatched } = build("linux");
    click(menuNamed(template, "File"), "Open file…");
    click(menuNamed(template, "File"), "Close document");
    expect(dispatched).toEqual(["document.open", "document.close"]);
  });

  it("opens settings pages from the menu", () => {
    const { template, dispatched } = build("linux");
    click(menuNamed(template, "File"), "Settings…");
    click(menuNamed(template, "Help") as Item[], "Show keyboard shortcuts");
    click(menuNamed(template, "Help") as Item[], "About Quipu (Alpha)");

    expect(dispatched).toEqual(["open-settings", "keybindings.show", "open-about"]);
  });

  it("gives no shell command a native accelerator, so rebinding one cannot be overridden", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { template } = build(platform);
      const withAccelerator = template
        .flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu : []))
        .filter((item) => item.accelerator !== undefined)
        .map((item) => item.label);
      expect(withAccelerator).toEqual(["Settings…"]);
    }
  });

  it("puts the app menu first on macOS, with About and Settings in it", () => {
    const { template, dispatched } = build("darwin");
    expect(template[0]?.label).toBe("Quipu (Alpha)");
    const appMenu = menuNamed(template, "Quipu (Alpha)");
    click(appMenu, "About Quipu (Alpha)");
    click(appMenu, "Settings…");
    expect(dispatched).toEqual(["open-about", "open-settings"]);
    expect(template.some((menu) => menu.label === "File")).toBe(true);
    expect(menuNamed(template, "File").some((item) => item.label === "Settings…")).toBe(false);
  });

  it("has no app menu on Linux and Windows, and quits from File", () => {
    for (const platform of ["linux", "win32"] as const) {
      const { template } = build(platform);
      expect(template[0]?.label).toBe("File");
      expect(menuNamed(template, "File").some((item) => item.role === "quit")).toBe(true);
    }
  });
});
