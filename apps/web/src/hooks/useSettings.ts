/**
 * Client settings hooks.
 *
 * Quipu has no server, so every setting is a client setting: localStorage in
 * a browser, `client-settings.json` in the desktop app's data folder (through
 * the preload bridge). Reads are lazy and one-shot, and nothing persists until
 * a read has succeeded (see `persistedDocument.ts`).
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@quipu/contracts";
import * as Schema from "effect/Schema";

import { readBrowserClientSettings, writeBrowserClientSettings } from "~/clientPersistenceStorage";
import { createPersistedDocument } from "~/persistedDocument";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

const clientSettingsDocument = createPersistedDocument<ClientSettings>({
  name: "CLIENT_SETTINGS",
  defaults: DEFAULT_CLIENT_SETTINGS,
  read: async () => {
    const bridge = window.desktopBridge;
    if (bridge) {
      const stored = await bridge.getClientSettings();
      return stored === null ? null : decodeClientSettings(stored);
    }
    return readBrowserClientSettings();
  },
  write: async (settings) => {
    const bridge = window.desktopBridge;
    if (bridge) {
      await bridge.setClientSettings(settings);
      return;
    }
    writeBrowserClientSettings(settings);
  },
});

/** Applies a patch on top of the latest settings and persists it. */
export function persistClientSettingsPatch(patch: ClientSettingsPatch): Promise<ClientSettings> {
  return clientSettingsDocument.update((current) => ({ ...current, ...patch }));
}

/** Replaces every setting with its default. */
export function restoreClientSettingsDefaults(): Promise<ClientSettings> {
  return clientSettingsDocument.update(() => DEFAULT_CLIENT_SETTINGS);
}

export function useClientSettings<T = ClientSettings>(
  selector?: (settings: ClientSettings) => T,
): T {
  const settings = useSyncExternalStore(
    clientSettingsDocument.subscribe,
    clientSettingsDocument.getSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}
