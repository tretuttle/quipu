import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { touchBoard, useBoards } from "../boards/boardStore";
import { BoardView } from "../components/board/BoardView";
import { RightPanel } from "../components/RightPanel";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

export const Route = createFileRoute("/boards/$boardId")({
  component: BoardRouteView,
});

function BoardRouteView() {
  const { boardId } = Route.useParams();
  const boards = useBoards();
  const board = boards.find((candidate) => candidate.id === boardId) ?? null;

  useEffect(() => {
    void touchBoard(boardId).catch(() => undefined);
  }, [boardId]);

  return (
    <SidebarInset className="h-dvh min-h-0 flex-row overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-content-area="">
        <WorkspaceHeader document={null} board={board ? { name: board.name } : null} />
        {board ? (
          <BoardView key={board.id} boardId={board.id} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <div className="flex max-w-xs flex-col items-center gap-3 text-center">
              <h1 className="font-medium text-foreground text-sm">Board not found</h1>
              <p className="text-xs leading-normal text-muted-foreground/80">
                This board was deleted or saved somewhere else.
              </p>
              <Button render={<Link to="/" replace />} size="sm" variant="ghost">
                Go to documents
              </Button>
            </div>
          </div>
        )}
      </div>
      <RightPanel />
    </SidebarInset>
  );
}
