import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, LayoutDashboardIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { confirmAndDeleteBoard, openBoardId } from "../../boards/boardActions";
import {
  endBoardRename,
  renameBoard,
  requestBoardRename,
  useBoardRenaming,
  useBoards,
  type BoardRecord,
} from "../../boards/boardStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { stackedToast, toastManager } from "../ui/toast";

/** The name field that replaces a row while it is renamed: Enter or leaving saves, Escape cancels. */
function BoardNameField({ board }: { readonly board: BoardRecord }) {
  const [value, setValue] = useState(board.name);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    endBoardRename();
    if (!save) return;
    void renameBoard(board.id, value).catch((error: unknown) => {
      toastManager.add(
        stackedToast({
          type: "error",
          title: `Couldn't rename ${board.name}`,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  };
  return (
    <Input
      aria-label="Board name"
      autoFocus
      onBlur={() => finish(true)}
      onChange={(event) => setValue(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      size="sm"
      value={value}
    />
  );
}

function BoardRow({
  board,
  isActive,
  renaming,
}: {
  readonly board: BoardRecord;
  readonly isActive: boolean;
  readonly renaming: boolean;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  // The keyboard goes back to the row when its name field closes.
  const wasRenaming = useRef(renaming);
  useEffect(() => {
    if (wasRenaming.current && !renaming) linkRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  if (renaming) {
    return (
      <SidebarMenuItem data-testid="board-row">
        <BoardNameField board={board} />
      </SidebarMenuItem>
    );
  }

  const remove = () =>
    void confirmAndDeleteBoard(board.id, {
      isOpen: isActive,
      leaveBoard: () => navigate({ to: "/" }),
    });

  return (
    <SidebarMenuItem
      className="flex items-center"
      data-testid="board-row"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <SidebarMenuButton
        isActive={isActive}
        onDoubleClick={() => requestBoardRename(board.id)}
        onKeyDown={(event) => {
          if (event.key === "F2") {
            event.preventDefault();
            requestBoardRename(board.id);
          }
        }}
        render={<Link ref={linkRef} to="/boards/$boardId" params={{ boardId: board.id }} />}
      >
        <LayoutDashboardIcon />
        <span className="min-w-0 flex-1 truncate">{board.name}</span>
      </SidebarMenuButton>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <Button aria-label={`Actions for ${board.name}`} size="icon-xs" variant="ghost" />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => requestBoardRename(board.id)}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MenuItem onClick={remove} variant="destructive">
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

export function BoardRows() {
  const boards = useBoards();
  const renamingId = useBoardRenaming();
  const openId = openBoardId(useLocation().pathname);
  return boards.map((board) => (
    <BoardRow
      key={board.id}
      board={board}
      isActive={board.id === openId}
      renaming={board.id === renamingId}
    />
  ));
}

/** A rename asked for from the palette opens the sidebar, so the name field can be seen. */
export function useRevealBoardRename(): boolean {
  const renamingId = useBoardRenaming();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (renamingId === null) return;
    if (isMobile) setOpenMobile(true);
    else if (!open) setOpen(true);
  }, [renamingId, isMobile, open, setOpen, setOpenMobile]);
  return renamingId !== null;
}
