import { commandTitle } from "@quipu/shared/commands";
import { FileOutputIcon, SaveIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { HEADER_ACTION_LABEL_CLASS } from "~/components/WorkspaceHeader";
import { useResolvedKeybindings } from "~/keybindingsStore";
import { shortcutLabelForCommand } from "~/keybindings";
import { runShellCommand } from "~/shellCommands";

import { DOCUMENT_FORMATS } from "./documentFormats.ts";
import type { OpenDocument } from "./documentSession.ts";

/**
 * The header's file controls for the open document: its detected format (with
 * why it opened read-only or as text, when it did), Save and Export.
 */
export function DocumentFileActions({ document }: { readonly document: OpenDocument }) {
  const keybindings = useResolvedKeybindings();
  const saveShortcut = shortcutLabelForCommand(keybindings, "document.save");
  const exportShortcut = shortcutLabelForCommand(keybindings, "document.export");
  const label = DOCUMENT_FORMATS[document.format].label;
  const readOnly = document.structure !== "none" && !document.editable;
  const invalid = document.problem !== null;
  const formatBadge = (
    <Badge variant={invalid ? "error" : "outline"} size="default" data-document-format-badge="">
      {label}
      {invalid ? " · Not valid" : readOnly ? " · Read-only" : ""}
    </Badge>
  );
  const why = document.problem?.message ?? document.note;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {why === null ? (
        formatBadge
      ) : (
        <Tooltip>
          <TooltipTrigger render={formatBadge} />
          <TooltipPopup side="bottom">{why}</TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Save"
              onClick={() => runShellCommand("document.save")}
              size="sm"
              variant="ghost"
            />
          }
        >
          <SaveIcon />
          <span className={HEADER_ACTION_LABEL_CLASS}>Save</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {commandTitle("document.save")}
          {saveShortcut ? ` (${saveShortcut})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Export"
              onClick={() => runShellCommand("document.export")}
              size="sm"
              variant="ghost"
            />
          }
        >
          <FileOutputIcon />
          <span className={HEADER_ACTION_LABEL_CLASS}>Export</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {commandTitle("document.export")}
          {exportShortcut ? ` (${exportShortcut})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
