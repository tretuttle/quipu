import { commandTitle } from "@quipu/shared/commands";
import type { KeybindingCommand } from "@quipu/contracts";
import { ArrowDownUpIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useDocumentSession } from "~/documents/documentSession";
import {
  documentBlocker,
  runTransform,
  stepHistory,
  targetOf,
  transformBlocker,
  type TransformKind,
} from "~/documents/documentEdits";
import { useResolvedKeybindings } from "~/keybindingsStore";
import { shortcutLabelForCommand } from "~/keybindings";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HEADER_ACTION_LABEL_CLASS } from "../WorkspaceHeader";

/** The Transform menu's entries, in the order shown, with the command each one runs. */
export const TRANSFORM_MENU: ReadonlyArray<
  ReadonlyArray<{
    readonly kind: TransformKind;
    readonly label: string;
    readonly command: KeybindingCommand;
  }>
> = [
  [
    { kind: "sortKeys", label: commandTitle("transform.sortKeys"), command: "transform.sortKeys" },
    {
      kind: "sortKeysDescending",
      label: commandTitle("transform.sortKeysDescending"),
      command: "transform.sortKeysDescending",
    },
  ],
  [
    {
      kind: "sortArray",
      label: commandTitle("transform.sortArray"),
      command: "transform.sortArray",
    },
    {
      kind: "sortArrayDescending",
      label: commandTitle("transform.sortArrayDescending"),
      command: "transform.sortArrayDescending",
    },
    {
      kind: "sortArrayByField",
      label: commandTitle("transform.sortArrayByField"),
      command: "transform.sortArrayByField",
    },
  ],
  [
    { kind: "format", label: commandTitle("transform.format"), command: "transform.format" },
    { kind: "minify", label: commandTitle("transform.minify"), command: "transform.minify" },
    {
      kind: "formatDocument",
      label: commandTitle("transform.formatDocument"),
      command: "transform.formatDocument",
    },
    {
      kind: "minifyDocument",
      label: commandTitle("transform.minifyDocument"),
      command: "transform.minifyDocument",
    },
  ],
];

function HistoryButton({
  direction,
  depth,
  blocked,
}: {
  readonly direction: "undo" | "redo";
  readonly depth: number;
  readonly blocked: string | null;
}) {
  const keybindings = useResolvedKeybindings();
  const shortcut = shortcutLabelForCommand(
    keybindings,
    direction === "undo" ? "document.undo" : "document.redo",
  );
  const label = commandTitle(direction === "undo" ? "document.undo" : "document.redo");
  const reason = blocked ?? (depth === 0 ? `Nothing to ${direction}` : null);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-sm"
            variant="ghost"
            disabled={reason !== null}
            onClick={() => void stepHistory(direction)}
          />
        }
      >
        {direction === "undo" ? <Undo2Icon /> : <Redo2Icon />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {reason ?? `${label}${shortcut ? ` (${shortcut})` : ""}`}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The document header's editing controls: undo and redo, whose state is the
 * engine's history, and the Transform menu, whose entries say why they are off
 * for what is selected.
 */
export function DocumentEditControls() {
  const session = useDocumentSession((state) => state.session);
  const document = session.phase === "open" ? session.document : null;
  const tree = document?.tree ?? null;
  // What the transforms act on: the reasons they are off follow the selection.
  const selection = useSyncExternalStore(tree?.subscribe ?? noSubscribe, tree?.selection ?? none);
  // Plain text and the formats read through a conversion have nothing to edit.
  if (document === null || document.tree === null || !document.editable) return null;
  const selected = targetOf(document.tree, selection);
  const blocked = documentBlocker(document);
  return (
    <div className="flex items-center gap-0.5" data-document-header="">
      <HistoryButton direction="undo" depth={document.edit.undoDepth} blocked={blocked} />
      <HistoryButton direction="redo" depth={document.edit.redoDepth} blocked={blocked} />
      <Menu>
        <MenuTrigger render={<Button size="sm" variant="ghost" aria-label="Transform" />}>
          <ArrowDownUpIcon />
          {/* A narrow header keeps the icon; the button's name stays. */}
          <span className={HEADER_ACTION_LABEL_CLASS}>Transform</span>
        </MenuTrigger>
        <MenuPopup align="end">
          {TRANSFORM_MENU.map((group, index) => (
            <MenuGroup key={group[0]?.kind ?? index}>
              {index > 0 ? <MenuSeparator /> : null}
              {index === 0 ? <MenuGroupLabel>Selected value</MenuGroupLabel> : null}
              {group.map((entry) => {
                const reason = transformBlocker(document, entry.kind, selected);
                return (
                  <MenuItem
                    key={entry.kind}
                    disabled={reason !== null}
                    data-transform={entry.kind}
                    onClick={() => void runTransform(entry.kind)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{entry.label}</span>
                      {reason !== null ? (
                        <span className="text-muted-foreground text-xs">{reason}</span>
                      ) : null}
                    </span>
                    <TransformShortcut command={entry.command} />
                  </MenuItem>
                );
              })}
            </MenuGroup>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function TransformShortcut({ command }: { readonly command: KeybindingCommand }) {
  const keybindings = useResolvedKeybindings();
  const shortcut = shortcutLabelForCommand(keybindings, command);
  return shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null;
}

const noSubscribe = () => () => {};
const none = () => null;
