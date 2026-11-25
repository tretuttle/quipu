/**
 * Right-panel state: whether the panel shows, and which tab it is on.
 *
 * The tabs are fixed (Inspector and Source), so there is nothing to add or
 * close. The width is its own persisted value, see `useResizableWidth`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RIGHT_PANEL_TABS = ["inspector", "source", "trace", "schema", "problems"] as const;
export type RightPanelTab = (typeof RIGHT_PANEL_TABS)[number];
const DEFAULT_RIGHT_PANEL_TAB: RightPanelTab = "inspector";

export const RIGHT_PANEL_TAB_LABELS: Readonly<Record<RightPanelTab, string>> = {
  inspector: "Inspector",
  source: "Source",
  trace: "Trace",
  schema: "Schema",
  problems: "Problems",
};

const RIGHT_PANEL_STORAGE_KEY = "quipu:right-panel-state:v1";
const RIGHT_PANEL_STORAGE_VERSION = 1;

interface RightPanelState {
  readonly isOpen: boolean;
  readonly activeTab: RightPanelTab;
}

interface RightPanelStoreState extends RightPanelState {
  readonly toggle: () => void;
  /** Shows the tab, opening the panel when it was closed. */
  readonly showTab: (tab: RightPanelTab) => void;
  /** Moves the selection without opening the panel (keyboard tab traversal). */
  readonly selectTab: (tab: RightPanelTab) => void;
}

export function isRightPanelTab(value: unknown): value is RightPanelTab {
  return typeof value === "string" && (RIGHT_PANEL_TABS as readonly string[]).includes(value);
}

/** Reads what an earlier build or a hand-edited file left; anything unusable falls back. */
export function migratePersistedRightPanelState(persistedState: unknown): RightPanelState {
  const record =
    typeof persistedState === "object" && persistedState !== null
      ? (persistedState as Record<string, unknown>)
      : {};
  return {
    isOpen: record.isOpen === true,
    activeTab: isRightPanelTab(record.activeTab) ? record.activeTab : DEFAULT_RIGHT_PANEL_TAB,
  };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      isOpen: false,
      activeTab: DEFAULT_RIGHT_PANEL_TAB,
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
      showTab: (tab) => set({ isOpen: true, activeTab: tab }),
      selectTab: (tab) => set({ activeTab: tab }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): RightPanelState => ({
        isOpen: state.isOpen,
        activeTab: state.activeTab,
      }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);
