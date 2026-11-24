import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The usual mark of a document with unsaved edits, in its sidebar row and its header. */
export function UnsavedDot() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsaved changes"
            data-unsaved-dot=""
            className="size-2 shrink-0 rounded-full bg-foreground/70"
          />
        }
      />
      <TooltipPopup side="bottom">Unsaved changes</TooltipPopup>
    </Tooltip>
  );
}
