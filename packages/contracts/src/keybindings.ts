import * as Schema from "effect/Schema";
import { ForwardCompatibleArray, TrimmedString } from "./baseSchemas.ts";

const MAX_KEYBINDING_VALUE_LENGTH = 64;
const MAX_KEYBINDING_WHEN_LENGTH = 256;
export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_KEYBINDINGS_COUNT = 256;

export const STATIC_KEYBINDING_COMMANDS = [
  "commandPalette.toggle",
  "keybindings.show",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.inspector",
  "rightPanel.source",
  "navigation.back",
  "navigation.forward",
  "document.open",
  "document.close",
  "document.save",
  "document.saveAs",
  "document.export",
  "document.undo",
  "document.redo",
  "view.map",
  "view.tree",
  "view.source",
  "tree.expandAll",
  "tree.collapseAll",
  "search.open",
  "search.next",
  "search.previous",
  "search.path",
  "search.jq",
  "node.editValue",
  "node.renameKey",
  "transform.sortKeys",
  "transform.sortKeysDescending",
  "transform.sortArray",
  "transform.sortArrayDescending",
  "transform.sortArrayByField",
  "transform.format",
  "transform.minify",
  "transform.formatDocument",
  "transform.minifyDocument",
  "decode.toggle",
  "decode.expandAll",
  "decode.collapseAll",
  "decode.auto",
  "map.toParent",
  "map.toChild",
  "map.previous",
  "map.next",
  "map.first",
  "map.last",
  "map.toggle",
  "map.expandAll",
  "map.collapseAll",
  "map.expandUnder",
  "map.collapseUnder",
  "map.fit",
  "map.zoomIn",
  "map.zoomOut",
  "map.zoomReset",
  "map.panUp",
  "map.panDown",
  "map.panLeft",
  "map.panRight",
  "map.panPageUp",
  "map.panPageDown",
  "map.panPageLeft",
  "map.panPageRight",
  "board.new",
  "board.rename",
  "board.delete",
  "edit.undo",
  "edit.redo",
  "draw.tool.select",
  "draw.tool.hand",
  "draw.tool.rectangle",
  "draw.tool.ellipse",
  "draw.tool.diamond",
  "draw.tool.arrow",
  "draw.tool.line",
  "draw.tool.freehand",
  "draw.tool.text",
  "draw.tool.note",
  "draw.tool.frame",
  "draw.tool.eraser",
  "draw.tool.image",
  "draw.selectAll",
  "draw.delete",
  "draw.duplicate",
  "draw.group",
  "draw.ungroup",
  "draw.nudgeUp",
  "draw.nudgeDown",
  "draw.nudgeLeft",
  "draw.nudgeRight",
  "draw.bringForward",
  "draw.sendBackward",
  "draw.bringToFront",
  "draw.sendToBack",
  "draw.alignLeft",
  "draw.alignCenterX",
  "draw.alignRight",
  "draw.alignTop",
  "draw.alignCenterY",
  "draw.alignBottom",
  "draw.distributeHorizontal",
  "draw.distributeVertical",
  "draw.toggleGrid",
  "draw.toggleSketch",
  "theme.select",
  "appearance.cycle",
  "themeEditor.toggle",
] as const;

export const KeybindingCommand = Schema.Literals(STATIC_KEYBINDING_COMMANDS);
export type KeybindingCommand = typeof KeybindingCommand.Type;

export const KeybindingValue = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH),
);

export const KeybindingWhen = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_WHEN_LENGTH),
);
export const KeybindingRule = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});
export type KeybindingRule = typeof KeybindingRule.Type;

export const KeybindingsConfig = Schema.Array(KeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type KeybindingsConfig = typeof KeybindingsConfig.Type;

/**
 * The file as it is persisted: rules whose command this build does not know
 * (written by a newer build) are skipped instead of failing the whole file.
 */
export const PersistedKeybindingsConfig = ForwardCompatibleArray(KeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

export const KeybindingShortcut = Schema.Struct({
  key: KeybindingValue,
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});
export type KeybindingShortcut = typeof KeybindingShortcut.Type;

const KeybindingWhenNodeRef = Schema.suspend(
  (): Schema.Codec<KeybindingWhenNode> => KeybindingWhenNode,
);
export const KeybindingWhenNode = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("identifier"),
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("not"),
    node: KeybindingWhenNodeRef,
  }),
  Schema.Struct({
    type: Schema.Literal("and"),
    left: KeybindingWhenNodeRef,
    right: KeybindingWhenNodeRef,
  }),
  Schema.Struct({
    type: Schema.Literal("or"),
    left: KeybindingWhenNodeRef,
    right: KeybindingWhenNodeRef,
  }),
]);
export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export const ResolvedKeybindingRule = Schema.Struct({
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst: Schema.optional(KeybindingWhenNode),
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type ResolvedKeybindingRule = typeof ResolvedKeybindingRule.Type;

/**
 * The command set grows over time, so a file may hold rules this build cannot
 * represent (a command or `when` node added after it shipped). Decoding drops
 * those rules instead of failing the whole payload.
 */
export const ResolvedKeybindingsConfig = ForwardCompatibleArray(ResolvedKeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type ResolvedKeybindingsConfig = typeof ResolvedKeybindingsConfig.Type;
