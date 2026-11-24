import type { DesktopMenuAction, KeybindingCommand } from "@quipu/contracts";
import { commandTitle } from "@quipu/shared/commands";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@quipu/desktop/window/DesktopApplicationMenu") {}

/**
 * The menu template for a platform. Items run the shell's commands, under the
 * same titles the command palette shows, and carry no accelerator of their
 * own: a native accelerator would fire before the renderer sees the key, so a
 * user who rebinds a command would still trigger it on the old chord. The
 * renderer owns every chord and shows the current one in its tooltips. The one
 * exception is Settings (Cmd/Ctrl+,), which is not a rebindable command.
 */
export function buildApplicationMenuTemplate(input: {
  readonly platform: NodeJS.Platform;
  readonly displayName: string;
  readonly dispatch: (action: DesktopMenuAction) => void;
}): Electron.MenuItemConstructorOptions[] {
  const { dispatch, displayName, platform } = input;
  const action = (label: string, menuAction: DesktopMenuAction, accelerator?: string) =>
    ({
      label,
      ...(accelerator === undefined ? {} : { accelerator }),
      click: () => dispatch(menuAction),
    }) satisfies Electron.MenuItemConstructorOptions;
  const command = (menuAction: DesktopMenuAction & KeybindingCommand) =>
    action(commandTitle(menuAction), menuAction);
  const settings = action("Settings…", "open-settings", "CmdOrCtrl+,");
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (platform === "darwin") {
    template.push({
      label: displayName,
      submenu: [
        action(`About ${displayName}`, "open-about"),
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${displayName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${displayName}` },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        command("document.open"),
        command("document.save"),
        command("document.saveAs"),
        command("document.export"),
        command("document.close"),
        command("board.new"),
        { type: "separator" as const },
        ...(platform === "darwin" ? [] : [settings, { type: "separator" as const }]),
        { role: platform === "darwin" ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        command("commandPalette.toggle"),
        command("sidebar.toggle"),
        command("rightPanel.toggle"),
        { type: "separator" },
        command("view.map"),
        command("view.tree"),
        command("view.source"),
        { type: "separator" },
        command("map.fit"),
        command("map.zoomIn"),
        command("map.zoomOut"),
        command("map.zoomReset"),
        command("map.expandAll"),
        command("map.collapseAll"),
        command("map.expandUnder"),
        command("map.collapseUnder"),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [command("navigation.back"), command("navigation.forward")],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      role: "help",
      submenu: [
        command("keybindings.show"),
        ...(platform === "darwin" ? [] : [action(`About ${displayName}`, "open-about")]),
      ],
    },
  );

  return template;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const dispatch = (menuAction: DesktopMenuAction) => {
    void runPromise(
      desktopWindow.dispatchMenuAction(menuAction).pipe(
        Effect.annotateLogs({ action: menuAction }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action: menuAction, cause });
          return Effect.logError(error.message, error);
        }),
      ),
    );
  };

  const configure = electronMenu
    .setApplicationMenu(
      buildApplicationMenuTemplate({
        platform: environment.platform,
        displayName: environment.displayName,
        dispatch,
      }),
    )
    .pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({ configure });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
