import { DesktopThemeSchema } from "@quipu/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopKeybindings from "../../settings/DesktopKeybindings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export const setTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.shell.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    yield* electronTheme.setSource(theme);
  }),
});

// Only web and mail links leave the app; anything else (file:, custom schemes)
// stays inside so a document cannot launch programs through the renderer.
export const openExternal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.shell.openExternal")(function* (url) {
    const parsed = yield* Effect.try(() => new URL(url)).pipe(Effect.option);
    if (parsed._tag === "None" || !EXTERNAL_URL_PROTOCOLS.has(parsed.value.protocol)) {
      return false;
    }
    yield* Effect.promise(() => Electron.shell.openExternal(parsed.value.toString()));
    return true;
  }),
});

// The file the app reads. Nothing is on disk until a rule is saved, and a
// missing file cannot be opened, so an empty list (the defaults) is written first.
export const openKeybindingsFile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_KEYBINDINGS_FILE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.shell.openKeybindingsFile")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
    if (Option.isNone(yield* keybindings.get)) {
      yield* keybindings.set([]);
    }
    const failure = yield* Effect.promise(() =>
      Electron.shell.openPath(environment.keybindingsPath),
    );
    if (failure === "") return true;
    Electron.shell.showItemInFolder(environment.keybindingsPath);
    return false;
  }),
});
