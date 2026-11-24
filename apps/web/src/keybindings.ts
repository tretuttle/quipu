import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@quipu/contracts";
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  type ShortcutEventLike,
} from "@quipu/shared/keybindings";
import { isElectron } from "./env";

export type { ShortcutEventLike } from "@quipu/shared/keybindings";
export { shortcutKeyFromEvent } from "@quipu/shared/keybindings";

/**
 * The state a `when` expression reads. An identifier that is not listed here
 * (and not `true` or `false`) is false.
 */
export interface ShortcutMatchContext {
  isWeb: boolean;
  isDesktop: boolean;
  /** A text field, textarea, select or editor owns the keyboard. */
  editableFocus: boolean;
  /** The right panel is showing. */
  rightPanelOpen: boolean;
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  return {
    isWeb: !isElectron,
    isDesktop: isElectron,
    editableFocus: false,
    rightPanelOpen: false,
    ...options?.context,
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

function shortcutConflictKey(shortcut: KeybindingShortcut, platform = navigator.platform): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

export function effectiveShortcutsForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut[] {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();
  const effective: KeybindingShortcut[] = [];

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      effective.push(binding.shortcut);
    }
  }

  return effective;
}

function sameWhen(left: KeybindingWhenNode | undefined, right: KeybindingWhenNode | undefined) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The chord a label names for a command, wherever it applies: a rule counts
 * unless a later rule takes the same chord everywhere it does (no `when`, or
 * the same one). Search's F3 shows even while Find is closed, so the palette
 * and tooltips can teach it.
 */
function displayShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  platform: string,
): KeybindingShortcut | null {
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || binding.command !== command) continue;
    const chord = shortcutConflictKey(binding.shortcut, platform);
    const shadowed = keybindings
      .slice(index + 1)
      .some(
        (later) =>
          later.command !== command &&
          shortcutConflictKey(later.shortcut, platform) === chord &&
          (later.whenAst === undefined || sameWhen(later.whenAst, binding.whenAst)),
      );
    if (!shadowed) return binding.shortcut;
  }
  return null;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!matchesKeybindingShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

/** Keys whose name differs from their token, as each platform writes them. */
const NAMED_KEYS: Readonly<Record<string, { readonly mac: string; readonly other: string }>> = {
  " ": { mac: "Space", other: "Space" },
  space: { mac: "Space", other: "Space" },
  escape: { mac: "Esc", other: "Esc" },
  esc: { mac: "Esc", other: "Esc" },
  enter: { mac: "Return", other: "Enter" },
  tab: { mac: "Tab", other: "Tab" },
  backspace: { mac: "\u232b", other: "Backspace" },
  delete: { mac: "\u2326", other: "Delete" },
  insert: { mac: "Insert", other: "Insert" },
  arrowup: { mac: "\u2191", other: "\u2191" },
  arrowdown: { mac: "\u2193", other: "\u2193" },
  arrowleft: { mac: "\u2190", other: "\u2190" },
  arrowright: { mac: "\u2192", other: "\u2192" },
  pageup: { mac: "Page Up", other: "Page Up" },
  pagedown: { mac: "Page Down", other: "Page Down" },
  home: { mac: "Home", other: "Home" },
  end: { mac: "End", other: "End" },
};

/** One key's name the way the platform writes it: F3, Backspace (⌫ on a Mac), ←, Page Up. */
function shortcutKeyLabel(key: string, platform = navigator.platform): string {
  const lower = key.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return isMacPlatform(platform) ? named.mac : named.other;
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

/**
 * A shortcut's keys in the order the platform lists them: ⌃⌥⇧⌘ then the key
 * on a Mac, Ctrl Alt Shift Meta then the key elsewhere.
 */
export function formatShortcutParts(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string[] {
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const names = useMetaForMod
    ? { ctrl: "\u2303", alt: "\u2325", shift: "\u21e7", meta: "\u2318" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };
  const parts: string[] = [];
  if (showCtrl) parts.push(names.ctrl);
  if (shortcut.altKey) parts.push(names.alt);
  if (shortcut.shiftKey) parts.push(names.shift);
  if (showMeta) parts.push(names.meta);
  parts.push(shortcutKeyLabel(shortcut.key, platform));
  return parts;
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  return formatShortcutParts(shortcut, platform).join(isMacPlatform(platform) ? "" : "+");
}

/**
 * The label for a command's shortcut. With a `context`, only a chord that
 * would run the command in that state; without one, the chord it has wherever
 * it applies (see `displayShortcutForCommand`).
 */
export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  options?: string | ShortcutMatchOptions,
): string | null {
  if (command === null) return null;
  const resolvedOptions: ShortcutMatchOptions | undefined =
    typeof options === "string" ? { platform: options } : options;
  const platform = resolvePlatform(resolvedOptions);
  const shortcut =
    resolvedOptions?.context === undefined
      ? displayShortcutForCommand(keybindings, command, platform)
      : (effectiveShortcutsForCommand(keybindings, command, resolvedOptions)[0] ?? null);
  return shortcut ? formatShortcutLabel(shortcut, platform) : null;
}
