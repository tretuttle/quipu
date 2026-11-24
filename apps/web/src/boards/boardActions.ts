import { requestConfirmDialog } from "../confirmDialog";
import { stackedToast, toastManager } from "../components/ui/toast";
import { deleteBoard, findBoard, requestBoardRename } from "./boardStore";

/** The board a `/boards/<id>` path shows, or null for any other page. */
export function openBoardId(pathname: string): string | null {
  const match = /^\/boards\/([^/]+)$/.exec(pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/**
 * Asks, then deletes the board. When the board is the one on screen,
 * `leaveBoard` runs first, so the page that showed it goes away before it does.
 */
export async function confirmAndDeleteBoard(
  id: string,
  options: { readonly isOpen: boolean; readonly leaveBoard: () => void | Promise<void> },
): Promise<boolean> {
  const board = findBoard(id);
  if (!board) return false;
  const message = `Delete ${board.name}?\nIts drawing and images are removed. This can't be undone.`;
  const confirmed = await (requestConfirmDialog(message, {
    confirmLabel: "Delete",
    variant: "destructive",
  }) ?? Promise.resolve(window.confirm(message)));
  if (!confirmed) return false;
  try {
    if (options.isOpen) await options.leaveBoard();
    await deleteBoard(id);
    toastManager.add({ type: "success", title: `Deleted ${board.name}` });
    return true;
  } catch (error) {
    toastManager.add(
      stackedToast({
        type: "error",
        title: `Couldn't delete ${board.name}`,
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
    return false;
  }
}

/** Runs `board.rename` or `board.delete` on the open board; elsewhere they do nothing. */
export function runOpenBoardCommand(
  command: "board.rename" | "board.delete",
  pathname: string,
  goHome: () => void | Promise<void>,
): void {
  const id = openBoardId(pathname);
  if (id === null || findBoard(id) === null) return;
  if (command === "board.rename") requestBoardRename(id);
  else void confirmAndDeleteBoard(id, { isOpen: true, leaveBoard: goHome });
}
