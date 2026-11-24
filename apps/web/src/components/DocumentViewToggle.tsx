import type { KeybindingCommand } from "@quipu/contracts";
import { commandTitle } from "@quipu/shared/commands";

import { shortcutLabelForCommand } from "../keybindings";
import { useResolvedKeybindings } from "../keybindingsStore";
import { Toggle } from "./ui/toggle";
import { ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const DOCUMENT_VIEWS = ["map", "tree", "table", "source", "er"] as const;
export type DocumentView = (typeof DOCUMENT_VIEWS)[number];

const DOCUMENT_VIEW_LABELS: Readonly<Record<DocumentView, { label: string; hint: string }>> = {
  map: { label: "Map", hint: "Show the document as a map" },
  tree: { label: "Tree", hint: "Show the document as a tree" },
  table: { label: "Table", hint: "Show the document as a table" },
  source: { label: "Source", hint: "Show the document's text" },
  er: { label: "ER", hint: "Show the document as an entity-relationship diagram" },
};

/** The command each view has; its title and chord are the view's tooltip. */
const VIEW_COMMANDS: Partial<Record<DocumentView, KeybindingCommand>> = {
  map: "view.map",
  tree: "view.tree",
  source: "view.source",
};

function isDocumentView(value: unknown): value is DocumentView {
  return typeof value === "string" && (DOCUMENT_VIEWS as readonly string[]).includes(value);
}

/**
 * The segmented control that switches how an open document is drawn. Exactly
 * one view is always selected: pressing the selected one again keeps it.
 */
export function DocumentViewToggle({
  value,
  onValueChange,
  views = DOCUMENT_VIEWS,
}: {
  readonly value: DocumentView;
  readonly onValueChange: (view: DocumentView) => void;
  /** The views to offer, in order; every view by default. */
  readonly views?: ReadonlyArray<DocumentView>;
}) {
  const keybindings = useResolvedKeybindings();
  const hint = (view: DocumentView) => {
    const command = VIEW_COMMANDS[view];
    if (command === undefined) return DOCUMENT_VIEW_LABELS[view].hint;
    const shortcut = shortcutLabelForCommand(keybindings, command);
    return `${commandTitle(command)}${shortcut ? ` (${shortcut})` : ""}`;
  };
  return (
    <ToggleGroup
      aria-label="Document view"
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const view = next[0];
        if (isDocumentView(view)) onValueChange(view);
      }}
    >
      {views.map((view) => (
        <Tooltip key={view}>
          <TooltipTrigger render={<Toggle value={view} />}>
            {DOCUMENT_VIEW_LABELS[view].label}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{hint(view)}</TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
