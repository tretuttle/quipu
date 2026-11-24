import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { FileTextIcon, type LucideIcon, ScanSearchIcon, XIcon } from "lucide-react";
import { commandTitle } from "@quipu/shared/commands";

import { getInspectSource, useDocumentSession } from "../documents/documentSession";
import { SourceView } from "../documents/LazySourceView";
import { isElectron } from "../env";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../hooks/useResizableWidth";
import { shortcutLabelForCommand } from "../keybindings";
import { useResolvedKeybindings } from "../keybindingsStore";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import {
  RIGHT_PANEL_TABS,
  RIGHT_PANEL_TAB_LABELS,
  useRightPanelStore,
  type RightPanelTab,
} from "../rightPanelStore";
import { RIGHT_PANEL_TAB_COMMANDS } from "../shellCommands";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { usePanelAnimationSettings } from "../panelAnimations";
import { Inspector } from "./Inspector";
import { RightPanelResizeHandle } from "./RightPanelResizeHandle";
import { Button } from "./ui/button";
import { Sheet, SheetPopup } from "./ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const RIGHT_PANEL_WIDTH_STORAGE_KEY = "quipu:right-panel-width";
const RIGHT_PANEL_DEFAULT_WIDTH = 24 * 16;
const RIGHT_PANEL_MIN_WIDTH = 18 * 16;
const RIGHT_PANEL_MAX_WIDTH = 48 * 16;

const TAB_ICONS: Readonly<Record<RightPanelTab, LucideIcon>> = {
  inspector: ScanSearchIcon,
  source: FileTextIcon,
};

const TAB_EMPTY_STATES: Readonly<Record<RightPanelTab, { title: string; description: string }>> = {
  inspector: {
    title: "Nothing to inspect",
    description: "Select an item in a document to see its value and path here.",
  },
  source: {
    title: "No source to show",
    description: "Open a document to read its text here.",
  },
};

function RightPanelEmptyState({ tab }: { tab: RightPanelTab }) {
  const Icon = TAB_ICONS[tab];
  const copy = TAB_EMPTY_STATES[tab];
  return (
    <div
      className={cn(
        "scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none",
        // The topbar sits above this container; matching bottom padding keeps
        // the message centered against the full panel, not the leftover.
        "pb-(--workspace-topbar-height)",
      )}
    >
      <div className="flex w-full max-w-xs flex-col items-center gap-2 py-6 text-center">
        <Icon aria-hidden className="size-5 text-icon-muted" />
        <h3 className="font-medium text-foreground text-sm">{copy.title}</h3>
        <p className="text-xs leading-normal text-muted-foreground/80">{copy.description}</p>
      </div>
    </div>
  );
}

function RightPanelTabBar({ sheet }: { readonly sheet: boolean }) {
  const activeTab = useRightPanelStore((state) => state.activeTab);
  const showTab = useRightPanelStore((state) => state.showTab);
  const keybindings = useResolvedKeybindings();
  const tabRefs = useRef(new Map<RightPanelTab, HTMLButtonElement>());

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = RIGHT_PANEL_TABS.indexOf(activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % RIGHT_PANEL_TABS.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (index - 1 + RIGHT_PANEL_TABS.length) % RIGHT_PANEL_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = RIGHT_PANEL_TABS.length - 1;
    if (nextIndex === null) return;
    const next = RIGHT_PANEL_TABS[nextIndex];
    if (!next) return;
    event.preventDefault();
    showTab(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2 pr-3",
        // A sheet floats over the window's own title bar region.
        !sheet && isElectron && "drag-region",
        !sheet && isElectron && "wco:pr-(--workspace-native-controls-inset)",
        !sheet && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-right-panel-tabbar
    >
      <div
        role="tablist"
        aria-label="Right panel"
        aria-orientation="horizontal"
        className="flex min-w-0 items-center gap-1"
        onKeyDown={handleKeyDown}
      >
        {RIGHT_PANEL_TABS.map((tab) => {
          const selected = tab === activeTab;
          const Icon = TAB_ICONS[tab];
          const shortcut = shortcutLabelForCommand(keybindings, RIGHT_PANEL_TAB_COMMANDS[tab]);
          return (
            <Tooltip key={tab}>
              <TooltipTrigger
                render={
                  <button
                    ref={(element) => {
                      if (element) tabRefs.current.set(tab, element);
                      else tabRefs.current.delete(tab);
                    }}
                    type="button"
                    role="tab"
                    id={`right-panel-tab-${tab}`}
                    aria-selected={selected}
                    aria-controls="right-panel-tabpanel"
                    tabIndex={selected ? 0 : -1}
                    data-active-tab={selected}
                    onClick={() => showTab(tab)}
                    className={cn(
                      "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isElectron && "[-webkit-app-region:no-drag]",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  />
                }
              >
                <Icon aria-hidden className="size-3.5" />
                <span className="truncate">{RIGHT_PANEL_TAB_LABELS[tab]}</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {commandTitle(RIGHT_PANEL_TAB_COMMANDS[tab])}
                {shortcut ? ` (${shortcut})` : ""}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      {sheet ? <CloseSheetButton /> : null}
    </div>
  );
}

/** The sheet's way out, beside its tabs; Escape and a click outside it close it too. */
function CloseSheetButton() {
  const toggle = useRightPanelStore((state) => state.toggle);
  const keybindings = useResolvedKeybindings();
  const shortcut = shortcutLabelForCommand(keybindings, "rightPanel.toggle");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Close right panel"
            className="ms-auto shrink-0"
            onClick={toggle}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Close right panel (Esc{shortcut ? ` or ${shortcut}` : ""})
      </TooltipPopup>
    </Tooltip>
  );
}

/** The tab bar and the selected tab's content, the same inline and in the sheet. */
function RightPanelBody({ sheet }: { readonly sheet: boolean }) {
  const activeTab = useRightPanelStore((state) => state.activeTab);
  const session = useDocumentSession((state) => state.session);
  const tree = session.phase === "open" ? session.document.tree : null;
  return (
    <>
      <RightPanelTabBar sheet={sheet} />
      <div
        role="tabpanel"
        id="right-panel-tabpanel"
        aria-labelledby={`right-panel-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
      >
        {activeTab === "source" && session.phase === "open" ? (
          <SourceView key={session.document.documentId} document={session.document} compact />
        ) : activeTab === "inspector" && tree !== null ? (
          <Inspector tree={tree} source={getInspectSource()} />
        ) : (
          <RightPanelEmptyState tab={activeTab} />
        )}
      </div>
    </>
  );
}

/**
 * The width the page keeps beside the inline panel: its header (the document's
 * name, file and edit actions, the view toggle) and the map's drawing toolbar
 * fit in it. Where the panel would leave less, it opens as a sheet over the
 * page instead.
 */
const PAGE_MIN_WIDTH = 37 * 16;

function RightPanelSheet() {
  const isOpen = useRightPanelStore((state) => state.isOpen);
  const toggle = useRightPanelStore((state) => state.toggle);
  const { durationMs } = usePanelAnimationSettings();
  return (
    // Focus stays in the sheet, but the header above it keeps working: a click there closes the
    // sheet and does what it was for. The header's own panel toggle closes it by itself.
    <Sheet
      modal="trap-focus"
      open={isOpen}
      onOpenChange={(open, details) => {
        const target = details.event?.target;
        if (target instanceof Element && target.closest("[data-right-panel-toggle]")) return;
        if (open !== isOpen) toggle();
      }}
    >
      <SheetPopup
        aria-label="Right panel"
        data-right-panel
        data-state={isOpen ? "open" : "closed"}
        transitionDurationMs={durationMs}
        side="right"
        showCloseButton={false}
        belowTopbar
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0"
      >
        <RightPanelBody sheet />
      </SheetPopup>
    </Sheet>
  );
}

/**
 * The right panel with the Inspector and Source tabs: a resizable column
 * beside the page on a wide window, a sheet over it on a narrow one. While
 * closed the column stays mounted at zero width, so opening it can animate
 * (see `data-panel-animations`) and its tab is remembered.
 */
export function RightPanel() {
  const [asSheet, setAsSheet] = useState(false);
  const sentinel = useRef<HTMLSpanElement>(null);
  // The room is what the window leaves beside the sidebar, open, closed or resized.
  useEffect(() => {
    const page = sentinel.current?.parentElement;
    if (!page) return;
    return observeResize(page, () =>
      setAsSheet(page.clientWidth < PAGE_MIN_WIDTH + RIGHT_PANEL_MIN_WIDTH),
    );
  }, []);
  return (
    <>
      <span ref={sentinel} hidden />
      {asSheet ? <RightPanelSheet /> : <InlineRightPanel />}
    </>
  );
}

function InlineRightPanel() {
  const isOpen = useRightPanelStore((state) => state.isOpen);
  const { width, handlers } = useResizableWidth({
    storageKey: RIGHT_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    edge: "left",
  });

  return (
    <aside
      aria-label="Right panel"
      data-right-panel
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 shrink-0 flex-col self-stretch border-l border-border bg-background",
        isOpen && "min-w-72",
        "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        !isOpen && "pointer-events-none border-l-0",
      )}
      inert={!isOpen}
      style={
        {
          [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
          width: isOpen ? `var(${RESIZABLE_WIDTH_PROPERTY})` : "0px",
          // It gives up width before the page goes below its minimum.
          maxWidth: `calc(100% - ${PAGE_MIN_WIDTH}px)`,
        } as CSSProperties
      }
    >
      {isOpen ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className="h-full min-h-0 w-full overflow-clip">
        <div
          className="flex h-full min-h-0 w-full min-w-0 flex-col"
          style={{ maxWidth: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - 1px)` }}
        >
          <RightPanelBody sheet={false} />
        </div>
      </div>
    </aside>
  );
}
