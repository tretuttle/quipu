import type { KeybindingCommand } from "@quipu/contracts";

/**
 * Every command's one title and group. The command palette, Settings →
 * Keybindings, tooltips and the desktop menu all read their names here, so a
 * command is called the same thing wherever it shows. Titles are sentence
 * case and make sense without their group.
 */
export const COMMAND_GROUPS = [
  { id: "general", title: "General" },
  { id: "document", title: "Document" },
  { id: "view", title: "View" },
  { id: "search", title: "Search" },
  { id: "edit", title: "Edit" },
  { id: "decode", title: "Decode" },
  { id: "map", title: "Map" },
  { id: "canvas", title: "Canvas" },
  { id: "board", title: "Board" },
  { id: "draw", title: "Draw" },
  { id: "appearance", title: "Appearance" },
] as const;

export type CommandGroupId = (typeof COMMAND_GROUPS)[number]["id"];

export interface CommandInfo {
  readonly title: string;
  readonly group: CommandGroupId;
}

/** In display order: the palette and the Keybindings page list commands this way. */
export const COMMANDS: Readonly<Record<KeybindingCommand, CommandInfo>> = {
  "commandPalette.toggle": { title: "Show all commands", group: "general" },
  "keybindings.show": { title: "Show keyboard shortcuts", group: "general" },
  "sidebar.toggle": { title: "Toggle sidebar", group: "general" },
  "rightPanel.toggle": { title: "Toggle right panel", group: "general" },
  "rightPanel.inspector": { title: "Show Inspector panel", group: "general" },
  "rightPanel.source": { title: "Show Source panel", group: "general" },
  "navigation.back": { title: "Go back", group: "general" },
  "navigation.forward": { title: "Go forward", group: "general" },

  "document.open": { title: "Open file…", group: "document" },
  "document.close": { title: "Close document", group: "document" },
  "document.save": { title: "Save document", group: "document" },
  "document.saveAs": { title: "Save as…", group: "document" },
  "document.export": { title: "Export…", group: "document" },
  "document.undo": { title: "Undo edit", group: "document" },
  "document.redo": { title: "Redo edit", group: "document" },
  "document.inferSchema": { title: "Infer schema", group: "document" },
  "document.validateSchema": { title: "Validate with schema", group: "document" },
  "document.generateTypes": { title: "Generate types", group: "document" },

  "view.map": { title: "Show map view", group: "view" },
  "view.tree": { title: "Show tree view", group: "view" },
  "view.table": { title: "Show table view", group: "view" },
  "view.compare": { title: "Compare documents", group: "view" },
  "view.source": { title: "Show source view", group: "view" },
  "tree.expandAll": { title: "Expand all in tree", group: "view" },
  "tree.collapseAll": { title: "Collapse all in tree", group: "view" },

  "search.open": { title: "Find in document", group: "search" },
  "search.next": { title: "Next match", group: "search" },
  "search.previous": { title: "Previous match", group: "search" },
  "search.path": { title: "Path query", group: "search" },
  "search.jq": { title: "jq filter", group: "search" },
  "search.traceValue": { title: "Trace value", group: "search" },

  "node.editValue": { title: "Edit value", group: "edit" },
  "node.renameKey": { title: "Rename key", group: "edit" },
  "transform.sortKeys": { title: "Sort keys A to Z", group: "edit" },
  "transform.sortKeysDescending": { title: "Sort keys Z to A", group: "edit" },
  "transform.sortArray": { title: "Sort array ascending", group: "edit" },
  "transform.sortArrayDescending": { title: "Sort array descending", group: "edit" },
  "transform.sortArrayByField": { title: "Sort array by field…", group: "edit" },
  "transform.format": { title: "Format selected value", group: "edit" },
  "transform.minify": { title: "Minify selected value", group: "edit" },
  "transform.formatDocument": { title: "Format document", group: "edit" },
  "transform.minifyDocument": { title: "Minify document", group: "edit" },

  "decode.toggle": { title: "Decode selected value", group: "decode" },
  "decode.expandAll": { title: "Decode all values in selection", group: "decode" },
  "decode.collapseAll": { title: "Collapse all decoded values in selection", group: "decode" },
  "decode.auto": { title: "Decode automatically", group: "decode" },

  "map.toParent": { title: "Go to parent node", group: "map" },
  "map.toChild": { title: "Go to child node", group: "map" },
  "map.previous": { title: "Previous sibling node", group: "map" },
  "map.next": { title: "Next sibling node", group: "map" },
  "map.first": { title: "First sibling node", group: "map" },
  "map.last": { title: "Last sibling node", group: "map" },
  "map.toggle": { title: "Expand or collapse node", group: "map" },
  "map.expandAll": { title: "Expand all on map", group: "map" },
  "map.collapseAll": { title: "Collapse all on map", group: "map" },
  "map.expandUnder": { title: "Expand all under selection", group: "map" },
  "map.collapseUnder": { title: "Collapse all under selection", group: "map" },
  "map.exportPng": { title: "Export map PNG", group: "map" },
  "map.exportSvg": { title: "Export map SVG", group: "map" },

  "map.fit": { title: "Zoom to fit", group: "canvas" },
  "map.zoomIn": { title: "Zoom in", group: "canvas" },
  "map.zoomOut": { title: "Zoom out", group: "canvas" },
  "map.zoomReset": { title: "Reset zoom", group: "canvas" },
  "map.panUp": { title: "Pan up", group: "canvas" },
  "map.panDown": { title: "Pan down", group: "canvas" },
  "map.panLeft": { title: "Pan left", group: "canvas" },
  "map.panRight": { title: "Pan right", group: "canvas" },
  "map.panPageUp": { title: "Pan up a page", group: "canvas" },
  "map.panPageDown": { title: "Pan down a page", group: "canvas" },
  "map.panPageLeft": { title: "Pan left a page", group: "canvas" },
  "map.panPageRight": { title: "Pan right a page", group: "canvas" },

  "board.new": { title: "New board", group: "board" },
  "board.rename": { title: "Rename board", group: "board" },
  "board.delete": { title: "Delete board", group: "board" },

  "edit.undo": { title: "Undo drawing", group: "draw" },
  "edit.redo": { title: "Redo drawing", group: "draw" },
  "draw.tool.select": { title: "Select tool", group: "draw" },
  "draw.tool.hand": { title: "Hand tool", group: "draw" },
  "draw.tool.rectangle": { title: "Rectangle tool", group: "draw" },
  "draw.tool.ellipse": { title: "Ellipse tool", group: "draw" },
  "draw.tool.diamond": { title: "Diamond tool", group: "draw" },
  "draw.tool.arrow": { title: "Arrow tool", group: "draw" },
  "draw.tool.line": { title: "Line tool", group: "draw" },
  "draw.tool.freehand": { title: "Freehand tool", group: "draw" },
  "draw.tool.text": { title: "Text tool", group: "draw" },
  "draw.tool.note": { title: "Sticky note tool", group: "draw" },
  "draw.tool.frame": { title: "Frame tool", group: "draw" },
  "draw.tool.eraser": { title: "Eraser tool", group: "draw" },
  "draw.tool.image": { title: "Image tool", group: "draw" },
  "draw.selectAll": { title: "Select all drawings", group: "draw" },
  "draw.delete": { title: "Delete selection", group: "draw" },
  "draw.duplicate": { title: "Duplicate selection", group: "draw" },
  "draw.group": { title: "Group selection", group: "draw" },
  "draw.ungroup": { title: "Ungroup selection", group: "draw" },
  "draw.nudgeUp": { title: "Nudge up", group: "draw" },
  "draw.nudgeDown": { title: "Nudge down", group: "draw" },
  "draw.nudgeLeft": { title: "Nudge left", group: "draw" },
  "draw.nudgeRight": { title: "Nudge right", group: "draw" },
  "draw.bringForward": { title: "Bring forward", group: "draw" },
  "draw.sendBackward": { title: "Send backward", group: "draw" },
  "draw.bringToFront": { title: "Bring to front", group: "draw" },
  "draw.sendToBack": { title: "Send to back", group: "draw" },
  "draw.alignLeft": { title: "Align left", group: "draw" },
  "draw.alignCenterX": { title: "Align horizontal centers", group: "draw" },
  "draw.alignRight": { title: "Align right", group: "draw" },
  "draw.alignTop": { title: "Align top", group: "draw" },
  "draw.alignCenterY": { title: "Align vertical centers", group: "draw" },
  "draw.alignBottom": { title: "Align bottom", group: "draw" },
  "draw.distributeHorizontal": { title: "Distribute horizontally", group: "draw" },
  "draw.distributeVertical": { title: "Distribute vertically", group: "draw" },
  "draw.toggleGrid": { title: "Toggle grid", group: "draw" },
  "draw.toggleSketch": { title: "Toggle sketch style", group: "draw" },

  "theme.select": { title: "Change theme", group: "appearance" },
  "appearance.cycle": { title: "Cycle light, dark and system", group: "appearance" },
  "themeEditor.toggle": { title: "Toggle theme editor", group: "appearance" },
};

export function commandTitle(command: KeybindingCommand): string {
  return COMMANDS[command].title;
}

export function commandGroupTitle(command: KeybindingCommand): string {
  const id = COMMANDS[command].group;
  return COMMAND_GROUPS.find((group) => group.id === id)!.title;
}

/** Commands in display order, grouped: groups in `COMMAND_GROUPS` order, commands in table order. */
export function commandsByGroup(): ReadonlyArray<{
  readonly id: CommandGroupId;
  readonly title: string;
  readonly commands: ReadonlyArray<KeybindingCommand>;
}> {
  const commands = Object.keys(COMMANDS) as KeybindingCommand[];
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    commands: commands.filter((command) => COMMANDS[command].group === group.id),
  }));
}
