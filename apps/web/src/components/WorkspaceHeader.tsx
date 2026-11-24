import { commandTitle } from "@quipu/shared/commands";
import { PanelRightIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../env";
import { useResolvedKeybindings } from "../keybindingsStore";
import { shortcutLabelForCommand } from "../keybindings";
import { useRightPanelStore } from "../rightPanelStore";
import { runShellCommand } from "../shellCommands";
import { DocumentViewToggle, type DocumentView } from "./DocumentViewToggle";
import { UnsavedDot } from "./UnsavedDot";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * The header gives way in steps as it narrows, so the open item's name goes
 * last: first the action buttons drop their words (keeping their icons and
 * tooltips), then the section name before the open item's.
 */
export const HEADER_ACTION_LABEL_CLASS = "@max-[58rem]/workspace-header:hidden";
const SECTION_CRUMB_CLASS = "@max-[44rem]/workspace-header:hidden";

export interface OpenDocumentHeaderState {
  readonly name: string;
  readonly view: DocumentView;
  /** The document has edits that are not saved. */
  readonly dirty?: boolean;
}

function RightPanelToggleButton() {
  const isOpen = useRightPanelStore((state) => state.isOpen);
  const toggle = useRightPanelStore((state) => state.toggle);
  const keybindings = useResolvedKeybindings();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "rightPanel.toggle");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={commandTitle("rightPanel.toggle")}
            aria-pressed={isOpen}
            data-right-panel-toggle=""
            onClick={toggle}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <PanelRightIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {commandTitle("rightPanel.toggle")}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function CloseDocumentButton() {
  const keybindings = useResolvedKeybindings();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "document.close");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={commandTitle("document.close")}
            className="shrink-0"
            onClick={() => runShellCommand("document.close")}
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {commandTitle("document.close")}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The open item's name: cut short with an ellipsis when the header is narrow, whole in its tooltip. */
function CurrentName({ name }: { readonly name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 truncate" data-breadcrumb-name="" />}>
        {name}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{name}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The page header: breadcrumbs on the left, the document's view toggle (only
 * while a document is open) and the right-panel toggle on the right.
 */
export function WorkspaceHeader({
  document,
  board = null,
  onViewChange,
  views,
  documentActions = null,
}: {
  /** The open document, or null when none is open. */
  readonly document: OpenDocumentHeaderState | null;
  /** The open board, which has a name but no document views. */
  readonly board?: { readonly name: string } | null;
  readonly onViewChange?: (view: DocumentView) => void;
  /** The views the toggle offers; every view when omitted. */
  readonly views?: ReadonlyArray<DocumentView>;
  /** Controls for the open document (undo, redo, transforms), before the view toggle. */
  readonly documentActions?: ReactNode;
}) {
  return (
    <WorkspacePageHeader electron={isElectron} className="@container/workspace-header">
      <WorkspaceBreadcrumb ariaLabel="Workspace breadcrumb" className="flex-1">
        {board !== null ? (
          <>
            <WorkspaceBreadcrumbItem className={SECTION_CRUMB_CLASS}>
              Boards
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator className={SECTION_CRUMB_CLASS} />
            <WorkspaceBreadcrumbItem current>
              <CurrentName name={board.name} />
            </WorkspaceBreadcrumbItem>
          </>
        ) : document === null ? (
          <WorkspaceBreadcrumbItem current>Documents</WorkspaceBreadcrumbItem>
        ) : (
          <>
            <WorkspaceBreadcrumbItem className={SECTION_CRUMB_CLASS}>
              Documents
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator className={SECTION_CRUMB_CLASS} />
            <WorkspaceBreadcrumbItem current>
              <span className="flex min-w-0 items-center gap-1">
                <CurrentName name={document.name} />
                {document.dirty ? <UnsavedDot /> : null}
                <CloseDocumentButton />
              </span>
            </WorkspaceBreadcrumbItem>
          </>
        )}
      </WorkspaceBreadcrumb>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        {documentActions}
        {document !== null ? (
          <DocumentViewToggle
            value={document.view}
            onValueChange={(view) => onViewChange?.(view)}
            {...(views === undefined ? {} : { views })}
          />
        ) : null}
        <RightPanelToggleButton />
      </div>
    </WorkspacePageHeader>
  );
}
