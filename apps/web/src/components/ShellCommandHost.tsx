import {
  DESKTOP_MENU_ACTIONS,
  type DesktopMenuAction,
  type KeybindingCommand,
} from "@quipu/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  getActiveBoardEditor,
  hasDrawSelection,
  isBoardCanvasFocused,
} from "../boards/boardEditorRegistry";
import { runOpenBoardCommand } from "../boards/boardActions";
import { createBoard } from "../boards/boardStore";
import {
  isCommandPaletteOpen,
  openChangeThemePalette,
  toggleCommandPalette,
} from "../commandPaletteBus";
import { goBack, goForward, installAppHistory } from "../appHistory";
import { mayRun, readCommandState } from "../commandAvailability";
import { decodeInSelection } from "../documents/decodeInSelection";
import { useDecodePreferences } from "../documents/decodePreferences";
import {
  type EditMode,
  type EditSurface,
  openDocument,
  runTransform,
  selectedTarget,
  startNodeEdit,
  stepHistory,
} from "../documents/documentEdits";
import { useDocumentSession } from "../documents/documentSession";
import { useDocumentView } from "../documentViewStore";
import { useTheme } from "../hooks/useTheme";
import { useSchemaStore } from "../documents/schemaStore";
import { useSearchStore } from "../documents/searchStore";
import { traceSelectedScalar } from "../documents/traceActions";
import { useExportDialog } from "../documents/exportDialogStore";
import { openWithDialog } from "../documents/openDocument";
import { saveOpenDocument } from "../documents/saveDocument";
import { resolveShortcutCommand } from "../keybindings";
import { useResolvedKeybindings } from "../keybindingsStore";
import { isEditableFocused } from "../lib/editableFocus";
import { useRightPanelStore } from "../rightPanelStore";
import {
  drawAlignEdgeForCommand,
  drawDistributeAxisForCommand,
  drawToolForCommand,
  NUDGE_STEP,
  PAN_STEP,
  registerShellCommandExecutor,
  rightPanelTabForCommand,
  runShellCommand,
  transformForCommand,
} from "../shellCommands";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { getActiveMapController, isMapNodeActive } from "./map/mapRegistry";
import { useSidebar } from "./ui/sidebar";
import { stackedToast, toastManager } from "./ui/toast";

const APPEARANCE_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;
const NEXT_APPEARANCE_MODE = { system: "light", light: "dark", dark: "system" } as const;

/** Runs a map navigation command on the active map; without one it is a no-op. */
function runMapCommand(command: KeybindingCommand): boolean {
  const map = getActiveMapController();
  if (map === null) return false;
  switch (command) {
    case "map.previous":
      map.focusSibling(-1);
      return true;
    case "map.next":
      map.focusSibling(1);
      return true;
    case "map.toChild":
      map.focusChild();
      return true;
    case "map.toParent":
      map.focusParent();
      return true;
    case "map.first":
      map.focusFirstSibling();
      return true;
    case "map.last":
      map.focusLastSibling();
      return true;
    case "map.toggle":
      map.toggleFocused();
      return true;
    case "map.expandAll":
      map.expandAll();
      return true;
    case "map.collapseAll":
      map.collapseAll();
      return true;
    case "map.expandUnder":
      map.expandUnder();
      return true;
    case "map.collapseUnder":
      map.collapseUnder();
      return true;
    default:
      return false;
  }
}

/** Runs a board command on the active board; without one it is a no-op. */
function runBoardCommand(command: KeybindingCommand): void {
  if (runMapCommand(command)) return;
  const editor = getActiveBoardEditor();
  if (editor === null) return;
  const tool = drawToolForCommand(command);
  if (tool !== null) {
    editor.setTool(tool);
    return;
  }
  const edge = drawAlignEdgeForCommand(command);
  if (edge !== null) {
    editor.alignSelection(edge);
    return;
  }
  const axis = drawDistributeAxisForCommand(command);
  if (axis !== null) {
    editor.distributeSelection(axis);
    return;
  }
  const { viewport } = editor.getState();
  switch (command) {
    case "edit.undo":
      editor.undo();
      return;
    case "edit.redo":
      editor.redo();
      return;
    case "draw.delete":
      editor.deleteSelection();
      return;
    case "draw.duplicate":
      editor.duplicateSelection();
      return;
    case "draw.group":
      editor.groupSelection();
      return;
    case "draw.ungroup":
      editor.ungroupSelection();
      return;
    case "draw.selectAll":
      editor.selectAll();
      return;
    case "draw.nudgeUp":
      editor.nudgeSelection(0, -NUDGE_STEP);
      return;
    case "draw.nudgeDown":
      editor.nudgeSelection(0, NUDGE_STEP);
      return;
    case "draw.nudgeLeft":
      editor.nudgeSelection(-NUDGE_STEP, 0);
      return;
    case "draw.nudgeRight":
      editor.nudgeSelection(NUDGE_STEP, 0);
      return;
    case "draw.bringForward":
      editor.bringForward();
      return;
    case "draw.sendBackward":
      editor.sendBackward();
      return;
    case "draw.bringToFront":
      editor.bringToFront();
      return;
    case "draw.sendToBack":
      editor.sendToBack();
      return;
    case "draw.toggleGrid":
      editor.toggleGrid();
      return;
    case "draw.toggleSketch":
      editor.setStyle({ roughness: editor.getState().style.roughness > 0 ? 0 : 1 });
      return;
    case "map.fit":
      editor.zoomToFit();
      return;
    case "map.zoomIn":
      editor.zoomIn();
      return;
    case "map.zoomOut":
      editor.zoomOut();
      return;
    case "map.zoomReset":
      editor.zoomReset();
      return;
    case "map.panUp":
      editor.pan(0, PAN_STEP);
      return;
    case "map.panDown":
      editor.pan(0, -PAN_STEP);
      return;
    case "map.panLeft":
      editor.pan(PAN_STEP, 0);
      return;
    case "map.panRight":
      editor.pan(-PAN_STEP, 0);
      return;
    case "map.panPageUp":
      editor.pan(0, viewport.height);
      return;
    case "map.panPageDown":
      editor.pan(0, -viewport.height);
      return;
    case "map.panPageLeft":
      editor.pan(viewport.width, 0);
      return;
    case "map.panPageRight":
      editor.pan(-viewport.width, 0);
      return;
    default:
      return;
  }
}

/**
 * True when the keyboard belongs to the open document: its page is showing and
 * the focus is not on a drawing surface. A map node counts as the document; the
 * drawing layer around it does not.
 */
function hasDocumentFocus(target: EventTarget | null): boolean {
  if (useDocumentSession.getState().session.phase !== "open") return false;
  if (document.querySelector("[data-document-workspace]") === null) return false;
  return !isBoardCanvasFocused(target) || isMapNodeActive(target);
}

/**
 * Where "Edit value" and "Rename key" open their editor: in the view that has the
 * focus, or the one on screen. A container's value is edited in the Inspector,
 * which has room for several lines.
 */
function editSurface(mode: EditMode, kind: string): EditSurface {
  const focused = document.activeElement;
  if (focused?.closest("[data-inspector]")) return "inspector";
  if (mode === "value" && (kind === "object" || kind === "array")) return "inspector";
  if (focused?.closest("[data-map-node]")) return "map";
  if (focused?.closest("[data-tree-view]")) return "tree";
  if (focused?.closest("[data-source-view]")) return "source";
  const view = useDocumentView.getState().view;
  return view === "tree" ? "tree" : view === "source" ? "source" : "inspector";
}

function editSelected(mode: EditMode) {
  const target = selectedTarget(openDocument());
  const surface = target === null ? "inspector" : editSurface(mode, target.node.kind);
  if (startNodeEdit(target, mode, surface) && surface === "inspector") {
    useRightPanelStore.getState().showTab("inspector");
  }
}

function isDesktopMenuAction(action: string): action is DesktopMenuAction {
  return (DESKTOP_MENU_ACTIONS as readonly string[]).includes(action);
}

/**
 * Runs the shell's commands and routes shortcuts and native menu items to them.
 * Mounted once, inside the sidebar provider, so `sidebar.toggle` can reach it.
 */
export function ShellCommandHost() {
  const navigate = useNavigate();
  const router = useRouter();
  const { toggleSidebar } = useSidebar();
  const keybindings = useResolvedKeybindings();
  const toggleSidebarRef = useRef(toggleSidebar);
  useEffect(() => {
    toggleSidebarRef.current = toggleSidebar;
  }, [toggleSidebar]);

  const themeState = useTheme();
  const themeStateRef = useRef(themeState);
  useEffect(() => {
    themeStateRef.current = themeState;
  }, [themeState]);

  useEffect(() => installAppHistory(router), [router]);

  useEffect(
    () =>
      registerShellCommandExecutor((command) => {
        // A command that cannot run here does nothing, now or later.
        if (!mayRun(command, readCommandState())) return;
        const tab = rightPanelTabForCommand(command);
        if (tab !== null) {
          useRightPanelStore.getState().showTab(tab);
          return;
        }
        const transform = transformForCommand(command);
        if (transform !== null) {
          void runTransform(transform);
          return;
        }
        switch (command) {
          case "sidebar.toggle":
            toggleSidebarRef.current();
            return;
          case "rightPanel.toggle":
            useRightPanelStore.getState().toggle();
            return;
          case "navigation.back":
            goBack();
            return;
          case "navigation.forward":
            goForward();
            return;
          case "keybindings.show":
            void navigate({ to: "/settings/keybindings" });
            return;
          case "commandPalette.toggle":
            toggleCommandPalette();
            return;
          case "theme.select":
            openChangeThemePalette();
            return;
          case "appearance.cycle": {
            const { appearanceMode, setAppearanceMode } = themeStateRef.current;
            const nextMode = NEXT_APPEARANCE_MODE[appearanceMode];
            if (setAppearanceMode(nextMode)) {
              toastManager.add({
                id: "appearance-cycle",
                title: `Appearance: ${APPEARANCE_LABELS[nextMode]}`,
                timeout: 1500,
              });
            } else {
              toastManager.add(
                stackedToast({
                  type: "error",
                  title: "Couldn't save theme selection",
                  description: "Try again.",
                }),
              );
            }
            return;
          }
          case "themeEditor.toggle": {
            const { theme, themeHalves, resolvedTheme } = themeStateRef.current;
            toggleThemeEditorForTheme({ theme, themeHalves, initialAppearance: resolvedTheme });
            return;
          }
          case "document.open":
            void openWithDialog();
            return;
          case "document.save":
            void saveOpenDocument("save");
            return;
          case "document.saveAs":
            void saveOpenDocument("saveAs");
            return;
          case "document.export":
            useExportDialog.getState().setOpen(true);
            return;
          case "document.inferSchema": {
            const { session } = useDocumentSession.getState();
            if (session.phase === "open") void useSchemaStore.getState().infer(session.document);
            return;
          }
          case "document.validateSchema": {
            const { session } = useDocumentSession.getState();
            if (session.phase === "open") {
              void useSchemaStore.getState().prepareValidationFromShape(session.document);
            }
            return;
          }
          case "document.generateTypes": {
            const { session } = useDocumentSession.getState();
            if (session.phase === "open") {
              void useSchemaStore.getState().openCodegen(session.document);
            }
            return;
          }
          case "view.map":
            useDocumentView.getState().setView("map");
            return;
          case "view.tree":
            useDocumentView.getState().setView("tree");
            return;
          case "view.table":
            useDocumentView.getState().setView("table");
            return;
          case "view.compare":
            useDocumentView.getState().setView("compare");
            return;
          case "view.source":
            useDocumentView.getState().setView("source");
            return;
          case "search.open":
            useSearchStore.getState().open("find");
            return;
          case "search.path":
            useSearchStore.getState().open("path");
            return;
          case "search.jq":
            useSearchStore.getState().open("jq");
            return;
          case "search.traceValue": {
            const { session } = useDocumentSession.getState();
            if (session.phase === "open") void traceSelectedScalar(session.document);
            return;
          }
          case "search.next":
            void useSearchStore.getState().step(1);
            return;
          case "search.previous":
            void useSearchStore.getState().step(-1);
            return;
          case "map.exportPng":
          case "map.exportSvg": {
            const map = getActiveMapController();
            if (map !== null) {
              void map
                .exportImage(command === "map.exportPng" ? "png" : "svg", "whole")
                .catch((error: unknown) => {
                  toastManager.add(
                    stackedToast({
                      type: "error",
                      title: "Map export failed",
                      description:
                        error instanceof Error ? error.message : "Could not export map image.",
                    }),
                  );
                });
            }
            return;
          }
          case "decode.toggle": {
            const { session } = useDocumentSession.getState();
            const tree = session.phase === "open" ? session.document.tree : null;
            void tree?.toggleSelectedDecode();
            return;
          }
          case "decode.expandAll":
          case "decode.collapseAll": {
            const { session } = useDocumentSession.getState();
            const tree = session.phase === "open" ? session.document.tree : null;
            if (tree) void decodeInSelection(tree, command === "decode.expandAll");
            return;
          }
          case "decode.auto": {
            const { auto, setAuto } = useDecodePreferences.getState();
            setAuto({ ...auto, enabled: !auto.enabled });
            return;
          }
          case "tree.expandAll":
          case "tree.collapseAll": {
            const { session } = useDocumentSession.getState();
            const tree = session.phase === "open" ? session.document.tree : null;
            if (command === "tree.expandAll") void tree?.expandAll();
            else tree?.collapseAll();
            return;
          }
          case "document.undo":
            void stepHistory("undo");
            return;
          case "document.redo":
            void stepHistory("redo");
            return;
          case "document.close":
            void useDocumentSession.getState().closeDocument();
            return;
          case "node.editValue":
            editSelected("value");
            return;
          case "node.renameKey":
            editSelected("key");
            return;
          case "board.new":
            void createBoard()
              .then((board) => navigate({ to: "/boards/$boardId", params: { boardId: board.id } }))
              .catch((error: unknown) => {
                toastManager.add(
                  stackedToast({
                    type: "error",
                    title: "Unable to create a board",
                    description:
                      error instanceof Error ? error.message : "An unexpected error occurred.",
                  }),
                );
              });
            return;
          case "board.rename":
          case "board.delete":
            runOpenBoardCommand(command, router.state.location.pathname, () =>
              navigate({ to: "/" }),
            );
            return;
          default:
            runBoardCommand(command);
        }
      }),
    [navigate, router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // The editor's capture control records the chord; it must not also run it.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          editableFocus: isEditableFocused(event.target),
          rightPanelOpen: useRightPanelStore.getState().isOpen,
          documentOpen: readCommandState().document !== null,
          searchOpen: useSearchStore.getState().panel !== null,
          treeFocus:
            event.target instanceof Element && event.target.closest("[data-tree-view]") !== null,
          // While the palette is open (or opening), keys are its own, never canvas or document shortcuts.
          canvasFocus: isBoardCanvasFocused(event.target) && !isCommandPaletteOpen(),
          documentFocus: hasDocumentFocus(event.target) && !isCommandPaletteOpen(),
          mapNodeActive: isMapNodeActive(event.target) && !isCommandPaletteOpen(),
          drawSelection: hasDrawSelection(),
        },
      });
      if (command === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      runShellCommand(command);
    };

    // Capture, so a focused editor cannot consume a chord such as Mod+B first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (!isDesktopMenuAction(action)) return;
      switch (action) {
        case "open-settings":
          void navigate({ to: "/settings/general" });
          return;
        case "open-about":
          void navigate({ to: "/settings/general", hash: "about" });
          return;
        default:
          runShellCommand(action);
      }
    });
  }, [navigate]);

  return null;
}
