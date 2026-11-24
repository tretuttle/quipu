import { commandGroupTitle, commandTitle } from "@quipu/shared/commands";
import { BracesIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { decodeInSelection } from "./decodeInSelection.ts";
import { DECODER_KIND_LABELS, DECODER_KINDS, useDecodePreferences } from "./decodePreferences.ts";
import type { TreeModel } from "./treeModel.ts";

/**
 * The document's decode control: decode or collapse every detected value in
 * the selection, and decode automatically while browsing, for every kind or
 * the kinds ticked. A value opened or closed by hand keeps the user's choice.
 * Everything here is named as the command table names it, as in the palette.
 */
export function DecodeMenu({ tree }: { readonly tree: TreeModel }) {
  const auto = useDecodePreferences((state) => state.auto);
  const setAuto = useDecodePreferences((state) => state.setAuto);
  const kinds = auto.kinds ?? DECODER_KINDS;
  return (
    <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost-muted" size="xs" />}>
        <BracesIcon />
        {auto.enabled ? commandTitle("decode.auto") : commandGroupTitle("decode.auto")}
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuGroup>
          <MenuItem onClick={() => void decodeInSelection(tree, true)}>
            {commandTitle("decode.expandAll")}
          </MenuItem>
          <MenuItem onClick={() => void decodeInSelection(tree, false)}>
            {commandTitle("decode.collapseAll")}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          variant="switch"
          checked={auto.enabled}
          onCheckedChange={(enabled) => setAuto({ ...auto, enabled })}
        >
          {commandTitle("decode.auto")}
        </MenuCheckboxItem>
        {DECODER_KINDS.map((kind) => (
          <MenuCheckboxItem
            key={kind}
            disabled={!auto.enabled}
            checked={kinds.includes(kind)}
            onCheckedChange={(on) => {
              const next = on ? [...kinds, kind] : kinds.filter((k) => k !== kind);
              setAuto({ ...auto, kinds: next.length === DECODER_KINDS.length ? null : next });
            }}
          >
            {DECODER_KIND_LABELS[kind]}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
