/**
 * Edits to the saved keybinding rules, as the editor on the Keybindings page
 * makes them. A saved file holds only the rules the user changed, and a
 * command that appears in it loses its defaults, so an edit first copies the
 * command's defaults in; after the edit, a command whose saved rules equal its
 * defaults is dropped from the file again.
 */
import type { KeybindingRule, KeybindingsConfig } from "@quipu/contracts";
import { DEFAULT_KEYBINDINGS } from "@quipu/shared/keybindings";

function sameRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? "") === (right.when ?? "")
  );
}

function withoutRedundantRules(rules: KeybindingsConfig): KeybindingsConfig {
  const commands = new Set(rules.map((rule) => rule.command));
  const redundant = new Set<string>();
  for (const command of commands) {
    const saved = rules.filter((rule) => rule.command === command);
    const defaults = DEFAULT_KEYBINDINGS.filter((rule) => rule.command === command);
    if (
      saved.length === defaults.length &&
      saved.every((rule) => defaults.some((entry) => sameRule(entry, rule)))
    ) {
      redundant.add(command);
    }
  }
  return redundant.size === 0 ? rules : rules.filter((rule) => !redundant.has(rule.command));
}

/** Saves `rule`, replacing `replace` (the row being edited) when it is given. */
export function upsertRule(
  current: KeybindingsConfig,
  rule: KeybindingRule,
  replace?: KeybindingRule,
): KeybindingsConfig {
  const seeded = current.some((entry) => entry.command === rule.command)
    ? current
    : [...current, ...DEFAULT_KEYBINDINGS.filter((entry) => entry.command === rule.command)];
  return withoutRedundantRules([
    ...seeded.filter(
      (entry) => !(replace !== undefined && sameRule(entry, replace)) && !sameRule(entry, rule),
    ),
    rule,
  ]);
}

/** Removes one saved rule. A command left with no rules gets its defaults back. */
export function removeRule(current: KeybindingsConfig, target: KeybindingRule): KeybindingsConfig {
  return withoutRedundantRules(current.filter((entry) => !sameRule(entry, target)));
}
