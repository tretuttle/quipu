import {
  ClientSettingsSchema,
  PersistedKeybindingsConfig,
  type ClientSettings,
  type KeybindingsConfig,
} from "@quipu/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "quipu:client-settings:v1";
const KEYBINDINGS_STORAGE_KEY = "quipu:keybindings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

export function readBrowserKeybindings(): KeybindingsConfig | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(KEYBINDINGS_STORAGE_KEY, PersistedKeybindingsConfig);
}

export function writeBrowserKeybindings(keybindings: KeybindingsConfig): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(KEYBINDINGS_STORAGE_KEY, keybindings, PersistedKeybindingsConfig);
}
