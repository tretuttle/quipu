import { TOOL_KEYS, TOOL_LABELS, TOOLS, type Tool } from "@quipu/canvas/tools";
import {
  ArrowRightIcon,
  CircleIcon,
  DiamondIcon,
  EraserIcon,
  FrameIcon,
  HandIcon,
  ImageIcon,
  MinusIcon,
  MousePointer2Icon,
  PencilIcon,
  SquareIcon,
  StickyNoteIcon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react";

import { commandTitle } from "@quipu/shared/commands";

import { toolCommand } from "../../shellCommands";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TOOL_ICONS: Readonly<Record<Tool, LucideIcon>> = {
  select: MousePointer2Icon,
  hand: HandIcon,
  rectangle: SquareIcon,
  ellipse: CircleIcon,
  diamond: DiamondIcon,
  arrow: ArrowRightIcon,
  line: MinusIcon,
  freehand: PencilIcon,
  text: TypeIcon,
  note: StickyNoteIcon,
  frame: FrameIcon,
  eraser: EraserIcon,
  image: ImageIcon,
};

/**
 * The tool bar: a radiogroup of radios, each announcing its single-key
 * shortcut, so a screen reader and a sighted user get the same keys.
 */
export function BoardToolbar({
  tool,
  onSelectTool,
  hints,
}: {
  readonly tool: Tool;
  readonly onSelectTool: (tool: Tool) => void;
  /** A line under a tool's name in its tooltip, where a surface changes what the tool does (the map). */
  readonly hints?: Partial<Record<Tool, string>> | undefined;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Drawing tools"
      className="surface-glass pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border/60 p-1 shadow-sm"
      data-testid="board-toolbar"
    >
      {TOOLS.map((candidate) => {
        const Icon = TOOL_ICONS[candidate];
        const label = TOOL_LABELS[candidate];
        const key = TOOL_KEYS[candidate];
        return (
          <Tooltip key={candidate}>
            <TooltipTrigger
              render={
                <Button
                  role="radio"
                  aria-checked={tool === candidate}
                  aria-label={label}
                  aria-keyshortcuts={key}
                  data-pressed={tool === candidate ? "" : undefined}
                  onClick={() => onSelectTool(candidate)}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Icon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {commandTitle(toolCommand(candidate))} ({key.toUpperCase()})
              {hints?.[candidate] ? (
                <span className="block text-muted-foreground">{hints[candidate]}</span>
              ) : null}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
