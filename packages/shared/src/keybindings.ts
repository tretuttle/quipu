import {
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@quipu/contracts";

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  repeat?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

function matchesKeybindingShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesKeybindingShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

/**
 * Chord and `when` evaluation walk this list from the end, so a later rule
 * shadows an earlier rule on the same chord. A custom entry replaces every
 * default for its command (see `mergeWithDefaultKeybindings`).
 *
 * Grouped as the command palette lists them, with two exceptions that the
 * shadowing needs: drawing comes after search (Mod+G finds the next match
 * unless a canvas has the focus), and the document's own rules come last (with
 * a document view focused, Mod+Z undoes a data edit and Mod+D decodes).
 */
const CANVAS = "canvasFocus && !editableFocus";
const SELECTION = "canvasFocus && drawSelection && !editableFocus";
const MAP_NODE = "canvasFocus && mapNodeActive && !drawSelection && !editableFocus";
const NO_MAP_NODE = "canvasFocus && !mapNodeActive && !drawSelection && !editableFocus";

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  // General
  { key: "mod+k", command: "commandPalette.toggle" },
  { key: "shift+?", command: "keybindings.show", when: "!editableFocus" },
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  // Mod+Alt+1..3 switch the document's views, so the panel's tabs take Shift.
  {
    key: "mod+alt+shift+1",
    command: "rightPanel.inspector",
    when: "rightPanelOpen && !editableFocus",
  },
  {
    key: "mod+alt+shift+2",
    command: "rightPanel.source",
    when: "rightPanelOpen && !editableFocus",
  },
  { key: "mod+[", command: "navigation.back", when: "!editableFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!editableFocus" },

  // Appearance
  { key: "mod+alt+a", command: "theme.select", when: "!editableFocus" },
  { key: "mod+alt+shift+a", command: "appearance.cycle", when: "!editableFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },

  // Document (the edit history is at the end)
  { key: "mod+o", command: "document.open", when: "!editableFocus" },
  // Mod+W belongs to the browser; Mod+Alt+W is free on every platform.
  { key: "mod+alt+w", command: "document.close", when: "documentOpen && !editableFocus" },
  // Saving works from a field too (the find box, an inline edit), as in an editor.
  { key: "mod+s", command: "document.save", when: "documentOpen" },
  { key: "mod+shift+s", command: "document.saveAs", when: "documentOpen" },

  // View, in the order of the view toggle
  { key: "mod+alt+1", command: "view.map", when: "!editableFocus" },
  { key: "mod+alt+2", command: "view.tree", when: "!editableFocus" },
  { key: "mod+alt+3", command: "view.source", when: "!editableFocus" },
  { key: "mod+shift+arrowright", command: "tree.expandAll", when: "treeFocus && !editableFocus" },
  { key: "mod+shift+arrowleft", command: "tree.collapseAll", when: "treeFocus && !editableFocus" },

  // Search
  { key: "mod+f", command: "search.open", when: "documentOpen" },
  { key: "f3", command: "search.next", when: "searchOpen" },
  { key: "shift+f3", command: "search.previous", when: "searchOpen" },
  { key: "mod+g", command: "search.next", when: "searchOpen" },
  { key: "mod+shift+g", command: "search.previous", when: "searchOpen" },
  { key: "mod+shift+f", command: "search.path", when: "documentOpen" },
  // Mod+Shift+J is the browser's console; Mod+Alt+J is free.
  { key: "mod+alt+j", command: "search.jq", when: "documentOpen" },

  // Map: with a node focused the arrows walk the tree: siblings up and down,
  // child right, parent left.
  { key: "arrowleft", command: "map.toParent", when: MAP_NODE },
  { key: "arrowright", command: "map.toChild", when: MAP_NODE },
  { key: "arrowup", command: "map.previous", when: MAP_NODE },
  { key: "arrowdown", command: "map.next", when: MAP_NODE },
  { key: "home", command: "map.first", when: "canvasFocus && mapNodeActive && !editableFocus" },
  { key: "end", command: "map.last", when: "canvasFocus && mapNodeActive && !editableFocus" },
  { key: "enter", command: "map.toggle", when: "canvasFocus && mapNodeActive && !editableFocus" },
  // With a drawing selected, the same chords align it (see Draw below).
  {
    key: "mod+shift+arrowright",
    command: "map.expandAll",
    when: "canvasFocus && !drawSelection && !editableFocus",
  },
  {
    key: "mod+shift+arrowleft",
    command: "map.collapseAll",
    when: "canvasFocus && !drawSelection && !editableFocus",
  },

  // Canvas: the map and boards. With no node focused and nothing selected the arrows pan.
  { key: "shift+1", command: "map.fit", when: CANVAS },
  { key: "=", command: "map.zoomIn", when: CANVAS },
  { key: "+", command: "map.zoomIn", when: CANVAS },
  { key: "-", command: "map.zoomOut", when: CANVAS },
  { key: "0", command: "map.zoomReset", when: CANVAS },
  { key: "arrowup", command: "map.panUp", when: NO_MAP_NODE },
  { key: "arrowdown", command: "map.panDown", when: NO_MAP_NODE },
  { key: "arrowleft", command: "map.panLeft", when: NO_MAP_NODE },
  { key: "arrowright", command: "map.panRight", when: NO_MAP_NODE },
  { key: "pageup", command: "map.panPageUp", when: CANVAS },
  { key: "pagedown", command: "map.panPageDown", when: CANVAS },
  { key: "shift+pageup", command: "map.panPageLeft", when: CANVAS },
  { key: "shift+pagedown", command: "map.panPageRight", when: CANVAS },

  // Board
  { key: "mod+alt+n", command: "board.new", when: "!editableFocus" },

  // Draw: single-key tools only while a canvas has the focus and no text field does.
  { key: "mod+z", command: "edit.undo", when: "!editableFocus" },
  { key: "mod+shift+z", command: "edit.redo", when: "!editableFocus" },
  { key: "mod+y", command: "edit.redo", when: "!editableFocus" },
  { key: "v", command: "draw.tool.select", when: CANVAS },
  { key: "h", command: "draw.tool.hand", when: CANVAS },
  { key: "r", command: "draw.tool.rectangle", when: CANVAS },
  { key: "o", command: "draw.tool.ellipse", when: CANVAS },
  { key: "d", command: "draw.tool.diamond", when: CANVAS },
  { key: "a", command: "draw.tool.arrow", when: CANVAS },
  { key: "l", command: "draw.tool.line", when: CANVAS },
  { key: "p", command: "draw.tool.freehand", when: CANVAS },
  { key: "t", command: "draw.tool.text", when: CANVAS },
  { key: "n", command: "draw.tool.note", when: CANVAS },
  { key: "f", command: "draw.tool.frame", when: CANVAS },
  { key: "e", command: "draw.tool.eraser", when: CANVAS },
  { key: "i", command: "draw.tool.image", when: CANVAS },
  { key: "mod+a", command: "draw.selectAll", when: CANVAS },
  { key: "backspace", command: "draw.delete", when: SELECTION },
  { key: "delete", command: "draw.delete", when: SELECTION },
  { key: "mod+d", command: "draw.duplicate", when: CANVAS },
  { key: "mod+g", command: "draw.group", when: CANVAS },
  { key: "mod+shift+g", command: "draw.ungroup", when: CANVAS },
  // Arrows nudge a selection; without one they move between map nodes or pan.
  { key: "arrowup", command: "draw.nudgeUp", when: SELECTION },
  { key: "arrowdown", command: "draw.nudgeDown", when: SELECTION },
  { key: "arrowleft", command: "draw.nudgeLeft", when: SELECTION },
  { key: "arrowright", command: "draw.nudgeRight", when: SELECTION },
  { key: "]", command: "draw.bringForward", when: SELECTION },
  { key: "[", command: "draw.sendBackward", when: SELECTION },
  { key: "shift+]", command: "draw.bringToFront", when: SELECTION },
  { key: "shift+[", command: "draw.sendToBack", when: SELECTION },
  { key: "mod+shift+arrowleft", command: "draw.alignLeft", when: SELECTION },
  { key: "mod+shift+arrowright", command: "draw.alignRight", when: SELECTION },
  { key: "mod+shift+arrowup", command: "draw.alignTop", when: SELECTION },
  { key: "mod+shift+arrowdown", command: "draw.alignBottom", when: SELECTION },
  { key: "alt+shift+h", command: "draw.distributeHorizontal", when: SELECTION },
  { key: "alt+shift+v", command: "draw.distributeVertical", when: SELECTION },
  { key: "mod+'", command: "draw.toggleGrid", when: CANVAS },
  { key: "mod+shift+'", command: "draw.toggleSketch", when: CANVAS },

  // Edit, Decode and the document's history: a focused document view takes these
  // chords from the drawing layer, so they come last.
  { key: "f2", command: "node.editValue", when: "documentFocus && !editableFocus" },
  { key: "shift+f2", command: "node.renameKey", when: "documentFocus && !editableFocus" },
  {
    key: "shift+alt+f",
    command: "transform.formatDocument",
    when: "documentFocus && !editableFocus",
  },
  { key: "mod+d", command: "decode.toggle", when: "treeFocus && !editableFocus" },
  // On the map, a focused node decodes its selected row; with no node focused the chord duplicates a drawing.
  { key: "mod+d", command: "decode.toggle", when: "mapNodeActive && !editableFocus" },
  { key: "mod+z", command: "document.undo", when: "documentFocus && !editableFocus" },
  { key: "mod+shift+z", command: "document.redo", when: "documentFocus && !editableFocus" },
  { key: "mod+y", command: "document.redo", when: "documentFocus && !editableFocus" },
];

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: ReadonlyArray<KeybindingRule>,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingRule[] = [];
  for (const rule of config) {
    const result = compileResolvedKeybindingRule(rule);
    if (result) {
      compiled.push(result);
    }
  }
  return compiled.slice(-MAX_KEYBINDINGS_COUNT);
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

export function mergeWithDefaultKeybindings(
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
