import { useCallback } from "react";

import { recordBoardSize } from "../../boards/boardStore";
import { DrawingSurface } from "./DrawingSurface";

/** A board: a blank drawing surface saved under the board's id. */
export function BoardView({ boardId }: { readonly boardId: string }) {
  const onSaved = useCallback((bytes: number) => recordBoardSize(boardId, bytes), [boardId]);
  return (
    <DrawingSurface
      storageKey={boardId}
      label="Board canvas"
      testIdPrefix="board"
      role="application"
      onSaved={onSaved}
    />
  );
}
