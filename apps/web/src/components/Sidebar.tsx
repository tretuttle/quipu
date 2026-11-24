import * as Schema from "effect/Schema";
import { PlusIcon, XIcon } from "lucide-react";
import { useCallback } from "react";

import { toggleCommandPalette } from "../commandPaletteBus";
import { useBoards } from "../boards/boardStore";
import { useDocumentSession } from "../documents/documentSession";
import { forgetRecent, openRecent } from "../documents/openDocument";
import { useRecentDocuments } from "../documents/recents";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { formatBytes } from "../lib/formatBytes";
import { runShellCommand } from "../shellCommands";
import { BoardRows, useRevealBoardRename } from "./sidebar/BoardRows";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Button } from "./ui/button";
import { CollapsibleSectionHeader } from "./ui/collapsible-section-header";
import { SidebarContent, SidebarGroup, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { UnsavedDot } from "./UnsavedDot";
import { isElectron } from "../env";

const DOCUMENTS_SHELF_EXPANDED_KEY = "quipu:sidebar:documents-expanded";
const BOARDS_SHELF_EXPANDED_KEY = "quipu:sidebar:boards-expanded";

function useShelfExpanded(storageKey: string): [boolean, () => void] {
  const [expanded, setExpanded] = useLocalStorage(storageKey, true, Schema.Boolean);
  const toggle = useCallback(() => setExpanded((current) => !current), [setExpanded]);
  return [expanded, toggle];
}

/**
 * One shelf: a collapsible header over its rows, or its empty state. A
 * collapsed shelf names its count. An empty shelf offers a bordered add action
 * that opens the command palette.
 */
function SidebarShelf({
  id,
  label,
  count,
  emptyLabel,
  addLabel,
  onAdd,
  storageKey,
  action,
  forceExpanded = false,
  children,
}: {
  id: "documents" | "boards";
  label: string;
  count: number;
  emptyLabel: string;
  addLabel: string;
  /** What the empty shelf's add action does. */
  onAdd: () => void;
  storageKey: string;
  action?: React.ReactNode;
  /** Shows the rows without changing the remembered state (a row is being renamed). */
  forceExpanded?: boolean;
  children?: React.ReactNode;
}) {
  const [storedExpanded, toggle] = useShelfExpanded(storageKey);
  const expanded = storedExpanded || forceExpanded;
  return (
    <section aria-label={label} data-testid={`sidebar-${id}-shelf`} className="flex flex-col">
      <div className="mx-0.5 flex h-8 items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            onClick={toggle}
            expanded={expanded}
            data-testid={`sidebar-${id}-shelf-toggle`}
          >
            {/* A collapsed shelf with rows says how many; an empty one needs no "(0)". */}
            {expanded || count === 0 ? label : `${label} (${count})`}
          </CollapsibleSectionHeader>
        </div>
        {action}
      </div>
      {expanded ? (
        count === 0 ? (
          <div
            data-testid={`sidebar-${id}-empty`}
            className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60"
          >
            <span>{emptyLabel}</span>
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon aria-hidden className="-mx-0.5 size-3" />
              {addLabel}
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-px">{children}</ul>
        )
      ) : null}
    </section>
  );
}

/**
 * Takes a document off the recent list. The open document is closed first: a
 * document is never on screen while the sidebar lists it nowhere. Keeping it
 * open (when asked about its unsaved edits) keeps it listed.
 */
async function removeRecent(id: string, isOpen: boolean) {
  if (isOpen && !(await useDocumentSession.getState().closeDocument())) return;
  await forgetRecent(id);
}

/** The recent documents, newest first; the open one is marked. */
function RecentDocumentRows() {
  const documents = useRecentDocuments((state) => state.documents);
  const session = useDocumentSession((state) => state.session);
  const openName = session.phase === "open" ? session.document.name : null;
  // The open document's size changes with its edits; the list keeps the size it was opened at.
  const openSize = session.phase === "open" ? session.document.size : null;
  const dirty = session.phase === "open" && session.document.edit.dirty;
  return documents.map((entry) => (
    <SidebarMenuItem key={entry.id} className="flex items-center" data-testid="recent-document">
      <SidebarMenuButton
        isActive={entry.name === openName}
        onClick={() => void openRecent(entry.id)}
      >
        <span className="min-w-0 flex-1 truncate" data-recent-name="">
          {entry.name}
        </span>
        {dirty && entry.name === openName ? <UnsavedDot /> : null}
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {formatBytes(entry.name === openName && openSize !== null ? openSize : entry.size)}
        </span>
      </SidebarMenuButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${entry.name} from recent documents`}
              onClick={() => void removeRecent(entry.id, entry.name === openName)}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {entry.name === openName
            ? "Close and remove from recent documents"
            : "Remove from recent documents"}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  ));
}

function NewBoardButton() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="New board"
            className="shrink-0"
            onClick={() => runShellCommand("board.new")}
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup side="right">New board</TooltipPopup>
    </Tooltip>
  );
}

/** The sidebar's content: recent documents and boards. */
export function DocumentsSidebar() {
  const recentCount = useRecentDocuments((state) => state.documents.length);
  const boards = useBoards();
  const renamingBoard = useRevealBoardRename();
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="flex-1" role="presentation">
          <SidebarShelf
            id="documents"
            label="Documents"
            count={recentCount}
            emptyLabel="No documents yet"
            addLabel="Open document"
            onAdd={toggleCommandPalette}
            storageKey={DOCUMENTS_SHELF_EXPANDED_KEY}
          >
            <RecentDocumentRows />
          </SidebarShelf>
          <SidebarShelf
            id="boards"
            label="Boards"
            count={boards.length}
            emptyLabel="No boards yet"
            addLabel="New board"
            onAdd={() => runShellCommand("board.new")}
            storageKey={BOARDS_SHELF_EXPANDED_KEY}
            // An empty shelf offers the same action in its body.
            action={boards.length > 0 ? <NewBoardButton /> : null}
            forceExpanded={renamingBoard}
          >
            <BoardRows />
          </SidebarShelf>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
