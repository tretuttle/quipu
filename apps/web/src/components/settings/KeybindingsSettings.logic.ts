import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@quipu/contracts";
import { COMMAND_GROUPS, COMMANDS, commandGroupTitle, commandTitle } from "@quipu/shared/commands";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@quipu/shared/keybindings";

import { shortcutKeyFromEvent } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

/** Orders commands by `key`: a total order, so a new binding cannot reshuffle the page. */
function compareCommands(
  left: KeybindingCommand,
  right: KeybindingCommand,
  key: (command: KeybindingCommand) => string,
): number {
  return key(left).localeCompare(key(right));
}

/** Where each command sits in the palette's order, which the page follows. */
const COMMAND_ORDER = new Map(STATIC_KEYBINDING_COMMANDS.map((command, index) => [command, index]));

export type KeybindingSource = "Default" | "Custom";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = [
  "editableFocus",
  "rightPanelOpen",
  "isWeb",
  "isDesktop",
  "true",
  "false",
] as const;

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

/** The condition a new row of the builder starts as. */
export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "editableFocus";

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

/** What the remove button of a builder node says it removes: one condition, or a whole group. */
export function whenNodeRemoveLabel(node: KeybindingWhenNode, depth: number): string {
  if (depth === 0) return "Clear all conditions";
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return "Remove condition";
  }
  return "Remove group and its conditions";
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

/**
 * What each context key means to someone reading the keybindings list, when
 * it holds and when it does not. Listed in the order the phrases are read:
 * where focus is, then what is open or selected, then the text-field guard.
 */
const WHEN_PHRASES: ReadonlyArray<
  readonly [identifier: string, whenTrue: string, whenFalse: string]
> = [
  ["canvasFocus", "on the map or a board", "outside the map and boards"],
  ["treeFocus", "in the tree", "outside the tree"],
  ["documentFocus", "in a document view", "outside a document view"],
  ["documentOpen", "with a document open", "with no document open"],
  ["searchOpen", "while Find is open", "while Find is closed"],
  ["rightPanelOpen", "while the right panel is open", "while the right panel is closed"],
  ["mapNodeActive", "on a map node", "with no map node focused"],
  ["drawSelection", "with a drawing selected", "with no drawing selected"],
  ["isDesktop", "in the desktop app", "in the browser"],
  ["isWeb", "in the browser", "in the desktop app"],
  ["editableFocus", "while typing in a text field", "not while typing"],
];
const WHEN_PHRASE_ORDER = new Map(WHEN_PHRASES.map(([identifier], index) => [identifier, index]));
const WHEN_PHRASE_BY_IDENTIFIER = new Map(
  WHEN_PHRASES.map(([identifier, whenTrue, whenFalse]) => [identifier, { whenTrue, whenFalse }]),
);

function flattenWhen(
  node: KeybindingWhenNode,
  operator: "and" | "or",
): ReadonlyArray<KeybindingWhenNode> {
  return node.type === operator
    ? [...flattenWhen(node.left, operator), ...flattenWhen(node.right, operator)]
    : [node];
}

function describeWhenTerm(node: KeybindingWhenNode): { order: number; text: string } {
  const negated = node.type === "not";
  const inner = node.type === "not" ? node.node : node;
  if (inner.type === "identifier") {
    if (inner.name === "true" || inner.name === "false") {
      return { order: -1, text: (inner.name === "true") !== negated ? "anywhere" : "never" };
    }
    const phrase = WHEN_PHRASE_BY_IDENTIFIER.get(inner.name);
    if (phrase) {
      return {
        order: WHEN_PHRASE_ORDER.get(inner.name)!,
        text: negated ? phrase.whenFalse : phrase.whenTrue,
      };
    }
    return {
      order: WHEN_PHRASES.length,
      text: negated ? `when ${inner.name} is off` : `when ${inner.name} is on`,
    };
  }
  const described = describeWhenClause(inner);
  return { order: WHEN_PHRASES.length, text: negated ? `except ${described}` : described };
}

function describeWhenClause(node: KeybindingWhenNode): string {
  const alternatives = flattenWhen(node, "or");
  if (alternatives.length > 1) {
    return alternatives.map((alternative) => describeWhenClause(alternative)).join(", or ");
  }
  return describeConjunction(flattenWhen(node, "and"))
    .sort((left, right) => left.order - right.order)
    .map((term) => term.text)
    .join(", ");
}

const isTerm = (node: KeybindingWhenNode, name: string, negated: boolean) =>
  negated
    ? node.type === "not" && node.node.type === "identifier" && node.node.name === name
    : node.type === "identifier" && node.name === name;

/**
 * The terms of an "and", read together where one says more than another: a
 * focused map node is on the map already, and "on the map or a board" with no
 * map node focused reads as a board or the bare map.
 */
function describeConjunction(
  terms: ReadonlyArray<KeybindingWhenNode>,
): Array<{ order: number; text: string }> {
  const onCanvas = terms.some((term) => isTerm(term, "canvasFocus", false));
  const onNode = terms.some((term) => isTerm(term, "mapNodeActive", false));
  const offNode = terms.some((term) => isTerm(term, "mapNodeActive", true));
  return terms.flatMap((term) => {
    if (isTerm(term, "canvasFocus", false) && onNode) return [];
    if (isTerm(term, "mapNodeActive", true) && onCanvas) return [];
    if (isTerm(term, "canvasFocus", false) && offNode) {
      return [
        {
          order: WHEN_PHRASE_ORDER.get("canvasFocus")!,
          text: "on a board, or the map with no node focused",
        },
      ];
    }
    return [describeWhenTerm(term)];
  });
}

/**
 * A `when` condition in words for the keybindings list: "On the map or a
 * board, with a drawing selected, not while typing". The
 * expression itself stays one click away in the condition editor.
 */
export function describeWhen(node: KeybindingWhenNode | undefined): string {
  if (!node) return "Anywhere";
  if (
    node.type === "not" &&
    node.node.type === "identifier" &&
    node.node.name === "editableFocus"
  ) {
    return "Anywhere except text fields";
  }
  const text = describeWhenClause(node);
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  return isDefault ? "Default" : "Custom";
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => entry.command === binding.command)
  );
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: { readonly rowId: string; readonly key: string; readonly when: string },
): ReadonlyArray<string> {
  if (input.key.trim().length === 0) return [];
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      candidate.key === input.key &&
      conflictsWithWhen(candidate.when, input.when)
    ) {
      conflicts.push(commandLabel(candidate.command));
    }
  }
  return [...new Set(conflicts)].toSorted();
}

export interface KeybindingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
}

/** Splits sorted rows into the page's sections, dropping sections with no rows. */
export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
): ReadonlyArray<KeybindingGroup> {
  const rowsByGroup = new Map<string, Array<KeybindingRow>>();
  for (const row of rows) {
    const id = COMMANDS[row.command].group;
    const bucket = rowsByGroup.get(id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(id, [row]);
  }
  return COMMAND_GROUPS.flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  query: string,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  const rows = keybindings.map((binding, index) => {
    const defaultBinding = defaultBindingForBinding(binding);
    const key = shortcutToKeybindingInput(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    return {
      id: `${keybindingRowId(binding.command, key, when)}\u0000${index}`,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      defaultKey: defaultBinding ? shortcutToKeybindingInput(defaultBinding.shortcut) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
    } satisfies KeybindingRow;
  });

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(rows, {
      rowId: row.id,
      key: row.key,
      when: row.when,
    });
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  rowsWithConflicts.sort((left, right) => {
    const commandCompare =
      (COMMAND_ORDER.get(left.command) ?? 0) - (COMMAND_ORDER.get(right.command) ?? 0);
    if (commandCompare !== 0) return commandCompare;
    return left.key.localeCompare(right.key);
  });

  if (normalizedQuery.length === 0) {
    return rowsWithConflicts;
  }

  return rowsWithConflicts.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command).toLowerCase().includes(normalizedQuery) ||
      commandGroupTitle(row.command).toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<string> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

/** Every command a binding can be added for, alphabetical by label. */
export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) => compareCommands(left, right, commandLabel));
}

export function commandLabel(command: KeybindingCommand): string {
  return commandTitle(command);
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

/** Turns a keydown into a binding such as `mod+shift+k` or `tab`. Null for modifier-only presses. */
export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): string | null {
  const keyToken = normalizeShortcutKeyToken(shortcutKeyFromEvent(event));
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(keyToken);
  return parts.join("+");
}
