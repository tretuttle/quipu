/**
 * The keybindings the app resolves shortcuts against.
 *
 * A saved file holds only the rules the user changed. It replaces the
 * defaults of every command it mentions (`mergeWithDefaultKeybindings`), and
 * a missing file means the defaults. Browsers keep it in localStorage;
 * the desktop app keeps `keybindings.json` in its data folder.
 */
import { useSyncExternalStore } from "react";
import {
  PersistedKeybindingsConfig,
  type KeybindingRule,
  type KeybindingsConfig,
  type ResolvedKeybindingsConfig,
} from "@quipu/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@quipu/shared/keybindings";
import * as Schema from "effect/Schema";

import { removeRule, upsertRule } from "./keybindingEdits";
import { readBrowserKeybindings, writeBrowserKeybindings } from "./clientPersistenceStorage";
import { createPersistedDocument } from "./persistedDocument";

const decodeKeybindings = Schema.decodeUnknownSync(PersistedKeybindingsConfig);
const NO_CUSTOM_KEYBINDINGS: KeybindingsConfig = [];

const keybindingsDocument = createPersistedDocument<KeybindingsConfig>({
  name: "KEYBINDINGS",
  defaults: NO_CUSTOM_KEYBINDINGS,
  read: async () => {
    const bridge = window.desktopBridge;
    if (bridge) {
      const stored = await bridge.getKeybindings();
      return stored === null ? null : decodeKeybindings(stored);
    }
    return readBrowserKeybindings();
  },
  write: async (keybindings) => {
    const bridge = window.desktopBridge;
    if (bridge) {
      await bridge.setKeybindings(keybindings);
      return;
    }
    writeBrowserKeybindings(keybindings);
  },
});

function resolveKeybindings(custom: KeybindingsConfig): ResolvedKeybindingsConfig {
  return custom.length === 0
    ? DEFAULT_RESOLVED_KEYBINDINGS
    : mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(custom));
}

let resolvedFor: KeybindingsConfig = NO_CUSTOM_KEYBINDINGS;
let resolved: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS;
function getResolvedSnapshot(): ResolvedKeybindingsConfig {
  const custom = keybindingsDocument.getSnapshot();
  if (custom !== resolvedFor) {
    resolvedFor = custom;
    resolved = resolveKeybindings(custom);
  }
  return resolved;
}

/** The effective rules: defaults, with the saved rules replacing the commands they name. */
export function useResolvedKeybindings(): ResolvedKeybindingsConfig {
  return useSyncExternalStore(
    keybindingsDocument.subscribe,
    getResolvedSnapshot,
    () => DEFAULT_RESOLVED_KEYBINDINGS,
  );
}

/** Saves one rule. `replace` names the rule being edited, so it does not stay beside the new one. */
export function upsertKeybinding(
  rule: KeybindingRule,
  replace?: KeybindingRule,
): Promise<KeybindingsConfig> {
  return keybindingsDocument.update((current) => upsertRule(current, rule, replace));
}

/** Drops one saved rule; a command left with none gets its defaults back. */
export function removeKeybinding(rule: KeybindingRule): Promise<KeybindingsConfig> {
  return keybindingsDocument.update((current) => removeRule(current, rule));
}
