import type { KeybindingCommand } from "@quipu/contracts";

import { canGoBack, canGoForward, currentPathname } from "./appHistory";
import { openBoardId } from "./boards/boardActions";
import { getActiveBoardEditor, hasDrawSelection } from "./boards/boardEditorRegistry";
import { getActiveMapController } from "./components/map/mapRegistry";
import {
  documentBlocker,
  nodeBlocker,
  selectedTarget,
  transformBlocker,
} from "./documents/documentEdits";
import { type OpenDocument, useDocumentSession } from "./documents/documentSession";
import { useSearchStore } from "./documents/searchStore";
import { transformForCommand } from "./shellCommands";

/**
 * What a command needs before it can run. A command whose surface is not on
 * screen (no document, no map, no board) is hidden from the palette; one whose
 * surface is there but which cannot run yet is listed disabled with the reason.
 * Either way it does nothing when a key or a menu runs it, so no effect is
 * queued for a document that opens later.
 */
type Requirement =
  | "none"
  | "back"
  | "forward"
  /** A document on screen, or one on its way there (opening, or reopening after Save as). */
  | "document"
  /** A document on screen that has structure (JSON, HAR), not plain text. */
  | "structure"
  | "search"
  | "edit"
  /** The document's map on screen. */
  | "map"
  /** A canvas on screen: the document's map or a board. */
  | "canvas"
  | "drawSelection"
  | "openBoard";

const REQUIREMENTS: Readonly<Record<KeybindingCommand, Requirement>> = {
  "commandPalette.toggle": "none",
  "keybindings.show": "none",
  "sidebar.toggle": "none",
  "rightPanel.toggle": "none",
  "rightPanel.inspector": "none",
  "rightPanel.source": "none",
  "navigation.back": "back",
  "navigation.forward": "forward",
  "document.open": "none",
  "document.close": "document",
  "document.save": "document",
  "document.saveAs": "document",
  "document.export": "document",
  "document.inferSchema": "structure",
  "document.validateSchema": "structure",
  "document.generateTypes": "structure",
  "document.undo": "edit",
  "document.redo": "edit",
  "view.map": "structure",
  "view.tree": "structure",
  "view.table": "structure",
  "view.compare": "structure",
  "view.source": "document",
  "tree.expandAll": "structure",
  "tree.collapseAll": "structure",
  "search.open": "document",
  "search.next": "search",
  "search.previous": "search",
  "search.path": "structure",
  "search.jq": "structure",
  "search.traceValue": "structure",
  "node.editValue": "edit",
  "node.renameKey": "edit",
  "transform.sortKeys": "edit",
  "transform.sortKeysDescending": "edit",
  "transform.sortArray": "edit",
  "transform.sortArrayDescending": "edit",
  "transform.sortArrayByField": "edit",
  "transform.format": "edit",
  "transform.minify": "edit",
  "transform.formatDocument": "edit",
  "transform.minifyDocument": "edit",
  "decode.toggle": "structure",
  "decode.expandAll": "structure",
  "decode.collapseAll": "structure",
  // A preference over every document, set before one opens as well.
  "decode.auto": "none",
  "map.toParent": "map",
  "map.toChild": "map",
  "map.previous": "map",
  "map.next": "map",
  "map.first": "map",
  "map.last": "map",
  "map.toggle": "map",
  "map.expandAll": "map",
  "map.collapseAll": "map",
  "map.expandUnder": "map",
  "map.collapseUnder": "map",
  "map.exportPng": "map",
  "map.exportSvg": "map",
  "map.fit": "canvas",
  "map.zoomIn": "canvas",
  "map.zoomOut": "canvas",
  "map.zoomReset": "canvas",
  "map.panUp": "canvas",
  "map.panDown": "canvas",
  "map.panLeft": "canvas",
  "map.panRight": "canvas",
  "map.panPageUp": "canvas",
  "map.panPageDown": "canvas",
  "map.panPageLeft": "canvas",
  "map.panPageRight": "canvas",
  "board.new": "none",
  "board.rename": "openBoard",
  "board.delete": "openBoard",
  "edit.undo": "canvas",
  "edit.redo": "canvas",
  "draw.tool.select": "canvas",
  "draw.tool.hand": "canvas",
  "draw.tool.rectangle": "canvas",
  "draw.tool.ellipse": "canvas",
  "draw.tool.diamond": "canvas",
  "draw.tool.arrow": "canvas",
  "draw.tool.line": "canvas",
  "draw.tool.freehand": "canvas",
  "draw.tool.text": "canvas",
  "draw.tool.note": "canvas",
  "draw.tool.frame": "canvas",
  "draw.tool.eraser": "canvas",
  "draw.tool.image": "canvas",
  "draw.selectAll": "canvas",
  "draw.delete": "drawSelection",
  "draw.duplicate": "drawSelection",
  "draw.group": "drawSelection",
  "draw.ungroup": "drawSelection",
  "draw.nudgeUp": "drawSelection",
  "draw.nudgeDown": "drawSelection",
  "draw.nudgeLeft": "drawSelection",
  "draw.nudgeRight": "drawSelection",
  "draw.bringForward": "drawSelection",
  "draw.sendBackward": "drawSelection",
  "draw.bringToFront": "drawSelection",
  "draw.sendToBack": "drawSelection",
  "draw.alignLeft": "drawSelection",
  "draw.alignCenterX": "drawSelection",
  "draw.alignRight": "drawSelection",
  "draw.alignTop": "drawSelection",
  "draw.alignCenterY": "drawSelection",
  "draw.alignBottom": "drawSelection",
  "draw.distributeHorizontal": "drawSelection",
  "draw.distributeVertical": "drawSelection",
  "draw.toggleGrid": "canvas",
  "draw.toggleSketch": "canvas",
  "theme.select": "none",
  "appearance.cycle": "none",
  "themeEditor.toggle": "none",
};

export type CommandAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "hidden" }
  | { readonly kind: "disabled"; readonly reason: string };

/** The app's state as availability reads it; `readCommandState` takes it from the live app. */
export interface CommandState {
  /** The document on the home page, or null when none is open or another page shows. */
  readonly document: OpenDocument | null;
  /** A document is open or opening on the home page: its name is in the header. */
  readonly documentShowing: boolean;
  readonly searchOpen: boolean;
  readonly mapShowing: boolean;
  /** A drawing surface is on screen: a board, or the layer over the document's map. */
  readonly canvasShowing: boolean;
  readonly drawSelection: boolean;
  readonly boardOpen: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export function readCommandState(): CommandState {
  const { session } = useDocumentSession.getState();
  const pathname = currentPathname();
  const home = pathname === "/";
  const document = session.phase === "open" && home ? session.document : null;
  const editor = getActiveBoardEditor();
  return {
    document,
    documentShowing: home && (session.phase === "open" || session.phase === "opening"),
    searchOpen: useSearchStore.getState().panel !== null,
    mapShowing: document !== null && getActiveMapController() !== null,
    canvasShowing: editor !== null,
    drawSelection: editor !== null && hasDrawSelection(),
    boardOpen: openBoardId(pathname) !== null,
    canGoBack: canGoBack(),
    canGoForward: canGoForward(),
  };
}

const AVAILABLE: CommandAvailability = { kind: "available" };
const HIDDEN: CommandAvailability = { kind: "hidden" };
const disabled = (reason: string | null): CommandAvailability =>
  reason === null ? AVAILABLE : { kind: "disabled", reason };

/** Why an edit command cannot run on the document's selection, or null when it can. */
function editBlocker(command: KeybindingCommand, document: OpenDocument): string | null {
  const blocked = documentBlocker(document);
  if (blocked !== null) return blocked;
  switch (command) {
    case "document.undo":
      return document.edit.undoDepth === 0 ? "Nothing to undo." : null;
    case "document.redo":
      return document.edit.redoDepth === 0 ? "Nothing to redo." : null;
    case "node.editValue":
      return nodeBlocker(document, selectedTarget(document), "value");
    case "node.renameKey":
      return nodeBlocker(document, selectedTarget(document), "key");
    default: {
      const transform = transformForCommand(command);
      return transform === null
        ? null
        : transformBlocker(document, transform, selectedTarget(document));
    }
  }
}

/**
 * Whether a key, a menu item or the palette may run the command now. A hidden
 * one never runs. A disabled one does not either, except the edits: they run
 * and say why they cannot apply (F2 on a decoded value explains it is
 * read-only), which a key press would otherwise leave unexplained.
 */
export function mayRun(command: KeybindingCommand, state: CommandState): boolean {
  const availability = commandAvailability(command, state);
  return (
    availability.kind === "available" ||
    (availability.kind === "disabled" && REQUIREMENTS[command] === "edit")
  );
}

export function commandAvailability(
  command: KeybindingCommand,
  state: CommandState,
): CommandAvailability {
  const { document } = state;
  switch (REQUIREMENTS[command]) {
    case "none":
      return AVAILABLE;
    case "back":
      return disabled(state.canGoBack ? null : "Nothing to go back to.");
    case "forward":
      return disabled(state.canGoForward ? null : "Nothing to go forward to.");
    case "document":
      return state.documentShowing ? AVAILABLE : HIDDEN;
    case "structure":
      if (document === null) return HIDDEN;
      return disabled(document.tree === null ? "Plain text has no structure." : null);
    case "search":
      if (document === null) return HIDDEN;
      return disabled(state.searchOpen ? null : "Find something first.");
    case "edit":
      return document === null ? HIDDEN : disabled(editBlocker(command, document));
    case "map":
      if (document === null) return HIDDEN;
      return disabled(state.mapShowing ? null : "Switch to the map view first.");
    case "canvas":
      if (state.canvasShowing) return AVAILABLE;
      return document === null ? HIDDEN : disabled("Switch to the map view first.");
    case "drawSelection":
      if (!state.canvasShowing) {
        return document === null ? HIDDEN : disabled("Switch to the map view first.");
      }
      return disabled(state.drawSelection ? null : "Select a drawing first.");
    case "openBoard":
      return state.boardOpen ? AVAILABLE : HIDDEN;
  }
}
