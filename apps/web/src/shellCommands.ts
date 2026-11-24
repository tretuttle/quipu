import type { AlignEdge, DistributeAxis } from "@quipu/canvas/arrange";
import type { Tool } from "@quipu/canvas/tools";
import type { KeybindingCommand } from "@quipu/contracts";

import type { TransformKind } from "./documents/documentEdits";
import { RIGHT_PANEL_TABS, type RightPanelTab } from "./rightPanelStore";

/**
 * Every shell command has one executor, registered by `ShellCommandHost`. A
 * keybinding, the command palette and a native menu item all run through
 * `runShellCommand`, so they cannot drift apart.
 */
type ShellCommandExecutor = (command: KeybindingCommand) => void;

let executor: ShellCommandExecutor | null = null;

export function registerShellCommandExecutor(next: ShellCommandExecutor): () => void {
  executor = next;
  return () => {
    if (executor === next) executor = null;
  };
}

/** False when no host is mounted to run the command. */
export function runShellCommand(command: KeybindingCommand): boolean {
  if (executor === null) return false;
  executor(command);
  return true;
}

export const RIGHT_PANEL_TAB_COMMANDS = {
  inspector: "rightPanel.inspector",
  source: "rightPanel.source",
} as const satisfies Record<RightPanelTab, KeybindingCommand>;

export function rightPanelTabForCommand(command: KeybindingCommand): RightPanelTab | null {
  return RIGHT_PANEL_TABS.find((tab) => RIGHT_PANEL_TAB_COMMANDS[tab] === command) ?? null;
}

const TRANSFORM_COMMANDS = {
  "transform.sortKeys": "sortKeys",
  "transform.sortKeysDescending": "sortKeysDescending",
  "transform.sortArray": "sortArray",
  "transform.sortArrayDescending": "sortArrayDescending",
  "transform.sortArrayByField": "sortArrayByField",
  "transform.format": "format",
  "transform.minify": "minify",
  "transform.formatDocument": "formatDocument",
  "transform.minifyDocument": "minifyDocument",
} as const satisfies Partial<Record<KeybindingCommand, TransformKind>>;

export function transformForCommand(command: KeybindingCommand): TransformKind | null {
  return command in TRANSFORM_COMMANDS
    ? TRANSFORM_COMMANDS[command as keyof typeof TRANSFORM_COMMANDS]
    : null;
}

/** The editor method a board command runs; null when it needs no board. */
export const DRAW_TOOL_COMMANDS = {
  "draw.tool.select": "select",
  "draw.tool.hand": "hand",
  "draw.tool.rectangle": "rectangle",
  "draw.tool.ellipse": "ellipse",
  "draw.tool.diamond": "diamond",
  "draw.tool.arrow": "arrow",
  "draw.tool.line": "line",
  "draw.tool.freehand": "freehand",
  "draw.tool.text": "text",
  "draw.tool.note": "note",
  "draw.tool.frame": "frame",
  "draw.tool.eraser": "eraser",
  "draw.tool.image": "image",
} as const satisfies Partial<Record<KeybindingCommand, string>>;

/** The edge each align command lines the selection up on. */
const DRAW_ALIGN_COMMANDS = {
  "draw.alignLeft": "left",
  "draw.alignCenterX": "centerX",
  "draw.alignRight": "right",
  "draw.alignTop": "top",
  "draw.alignCenterY": "centerY",
  "draw.alignBottom": "bottom",
} as const satisfies Partial<Record<KeybindingCommand, AlignEdge>>;

/** The axis each distribute command spaces the selection along. */
const DRAW_DISTRIBUTE_COMMANDS = {
  "draw.distributeHorizontal": "horizontal",
  "draw.distributeVertical": "vertical",
} as const satisfies Partial<Record<KeybindingCommand, DistributeAxis>>;

export function drawAlignEdgeForCommand(command: KeybindingCommand): AlignEdge | null {
  return command in DRAW_ALIGN_COMMANDS
    ? DRAW_ALIGN_COMMANDS[command as keyof typeof DRAW_ALIGN_COMMANDS]
    : null;
}

export function drawDistributeAxisForCommand(command: KeybindingCommand): DistributeAxis | null {
  return command in DRAW_DISTRIBUTE_COMMANDS
    ? DRAW_DISTRIBUTE_COMMANDS[command as keyof typeof DRAW_DISTRIBUTE_COMMANDS]
    : null;
}

/** The command that picks `tool`, for its title. */
export function toolCommand(tool: Tool): keyof typeof DRAW_TOOL_COMMANDS {
  return (Object.keys(DRAW_TOOL_COMMANDS) as Array<keyof typeof DRAW_TOOL_COMMANDS>).find(
    (command) => DRAW_TOOL_COMMANDS[command] === tool,
  )!;
}

export function drawToolForCommand(command: KeybindingCommand): Tool | null {
  return command in DRAW_TOOL_COMMANDS
    ? DRAW_TOOL_COMMANDS[command as keyof typeof DRAW_TOOL_COMMANDS]
    : null;
}

/** Pixels an arrow key moves a selection, and the camera. */
export const NUDGE_STEP = 10;
export const PAN_STEP = 40;
