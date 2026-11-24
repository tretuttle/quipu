import {
  ClientSettingsSchema,
  KeybindingsConfig,
  PersistedKeybindingsConfig,
} from "@quipu/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopKeybindings from "../../settings/DesktopKeybindings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.settings.getClientSettings")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.settings.setClientSettings")(function* (settings) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    yield* clientSettings.set(settings);
  }),
});

export const getKeybindings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_KEYBINDINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(PersistedKeybindingsConfig),
  handler: Effect.fn("desktop.ipc.settings.getKeybindings")(function* () {
    const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
    return Option.getOrNull(yield* keybindings.get);
  }),
});

export const setKeybindings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_KEYBINDINGS_CHANNEL,
  payload: KeybindingsConfig,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.settings.setKeybindings")(function* (rules) {
    const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
    yield* keybindings.set(rules);
  }),
});
