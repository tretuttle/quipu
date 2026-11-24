import * as Schema from "effect/Schema";

import type { DesktopOpenFailure } from "./documentSource.ts";
import type { KeybindingsConfig } from "./keybindings.ts";
import type { ClientSettings } from "./settings.ts";

export type DesktopTheme = "light" | "dark" | "system";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export const DesktopAppBrandingSchema = Schema.Struct({
  baseName: Schema.String,
  stageLabel: DesktopAppStageLabelSchema,
  displayName: Schema.String,
});

/** The renderer's save request on the save channel; the bytes follow on the MessagePort it sends along. */
export const SaveDocumentRequestSchema = Schema.Struct({ path: Schema.String });
export type SaveDocumentRequest = typeof SaveDocumentRequestSchema.Type;

/**
 * The native save dialog's options: the name it suggests, the document whose
 * folder it starts in (a desktop document's id; null for one with no path), and
 * one filter for the target format.
 */
export const SaveDialogRequestSchema = Schema.Struct({
  suggestedName: Schema.String,
  documentId: Schema.NullOr(Schema.String),
  filter: Schema.Struct({ name: Schema.String, extensions: Schema.Array(Schema.String) }),
});
export type SaveDialogRequest = typeof SaveDialogRequestSchema.Type;

/** One operation on the desktop's journal store (the state directory); the same ops the engine's JournalStore has. */
export const JournalStoreRequestSchema = Schema.Union([
  Schema.Struct({ op: Schema.Literal("size"), path: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("read"),
    path: Schema.String,
    start: Schema.Int,
    end: Schema.Int,
  }),
  Schema.Struct({ op: Schema.Literal("append"), path: Schema.String, bytes: Schema.Uint8Array }),
  Schema.Struct({ op: Schema.Literal("truncate"), path: Schema.String, size: Schema.Int }),
  Schema.Struct({ op: Schema.Literal("replace"), path: Schema.String, bytes: Schema.Uint8Array }),
  Schema.Struct({ op: Schema.Literal("remove"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("list"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("close"), path: Schema.String }),
]);
export type JournalStoreRequest = typeof JournalStoreRequestSchema.Type;

/**
 * A desktop save in flight: chunks go to the main process, which writes a
 * sibling temp file and renames it over `path` on `close`. `abort` leaves the
 * original untouched. The web app wraps this in a WritableStream for the engine.
 */
export interface DesktopSaveStream {
  write: (chunk: Uint8Array) => Promise<void>;
  /** Commits; resolves to the bytes written. */
  close: () => Promise<number>;
  abort: () => Promise<void>;
}

/**
 * What a native menu item asks the renderer to do. All but the last three are
 * keybinding commands, so the menu and a shortcut run the same code; the rest
 * navigate to a settings page.
 */
export const DESKTOP_MENU_ACTIONS = [
  "sidebar.toggle",
  "rightPanel.toggle",
  "commandPalette.toggle",
  "document.open",
  "document.save",
  "document.saveAs",
  "document.export",
  "navigation.back",
  "navigation.forward",
  "board.new",
  "edit.undo",
  "edit.redo",
  "map.fit",
  "map.zoomIn",
  "map.zoomOut",
  "map.zoomReset",
  "map.expandAll",
  "map.collapseAll",
  "map.expandUnder",
  "map.collapseUnder",
  "view.map",
  "view.tree",
  "view.source",
  "document.close",
  "keybindings.show",
  "open-settings",
  "open-about",
] as const;
export type DesktopMenuAction = (typeof DESKTOP_MENU_ACTIONS)[number];

/**
 * A document the desktop app opened before, remembered by path: the path is the capability, so there is no
 * handle to persist and no permission to ask for again.
 */
export const DesktopRecentDocument = Schema.Struct({
  /** `path:<sha256 of the canonical path, hex>`. */
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  lastModified: Schema.Number,
  lastOpenedAt: Schema.Number,
});
export type DesktopRecentDocument = typeof DesktopRecentDocument.Type;

/** A file's size and modification time (milliseconds, as a `File`'s `lastModified`) as the desktop app reads them. */
export const DesktopDocumentStamp = Schema.Struct({
  size: Schema.Number,
  lastModified: Schema.Number,
});
export type DesktopDocumentStamp = typeof DesktopDocumentStamp.Type;

/** The recent list is at most this long; the oldest entry leaves first. */
export const MAX_RECENT_DOCUMENTS = 50;

/**
 * What the Electron preload exposes to the renderer as `window.desktopBridge`.
 * The web app treats every member as the desktop's contract; a browser has no
 * bridge at all (see `apps/web/src/env.ts`).
 */
export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  /** The desktop client's OS platform, read from Electron's preload process. */
  getClientPlatform?: () => string;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
  /** A DesktopMenuAction when the main process sent it; the renderer checks before acting. */
  onMenuAction: (listener: (action: string) => void) => () => void;
  /** `client-settings.json` in the app's data folder; null until something is saved. */
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  /** `keybindings.json` in the app's data folder; null until something is saved. */
  getKeybindings: () => Promise<KeybindingsConfig | null>;
  setKeybindings: (keybindings: KeybindingsConfig) => Promise<void>;
  /**
   * Opens `keybindings.json`, the file the app reads, in the operating system's
   * editor for it. Creates it (as an empty list) when nothing has been saved yet.
   * Resolves false when the system could not open it.
   */
  openKeybindingsFile: () => Promise<boolean>;
  /**
   * Shows the native open dialog. The main process opens the chosen file and
   * posts it to the window as a `DesktopDocumentMessage` with a port that reads
   * it in bounded slices (`documentSource.ts`); resolves to how many were chosen.
   */
  openDocumentDialog: () => Promise<number>;
  /**
   * Opens a recent document's file by its id, the same way; false when it could
   * not be opened, which the page also hears through `onDocumentOpenFailed`.
   */
  openRecentDocument: (id: string) => Promise<boolean>;
  getRecentDocuments: () => Promise<ReadonlyArray<DesktopRecentDocument>>;
  /** Takes one document off the recent list. */
  removeRecentDocument: (id: string) => Promise<void>;
  clearRecentDocuments: () => Promise<void>;
  /**
   * A file the main process was asked to open (dialog, command line, a second
   * launch, a recent) could not be. It stays in the recents.
   */
  onDocumentOpenFailed: (listener: (failure: DesktopOpenFailure) => void) => () => void;
  onRecentDocumentsChange: (
    listener: (documents: ReadonlyArray<DesktopRecentDocument>) => void,
  ) => () => void;
  /**
   * Adds a file the page received by drop to the recents, by its path, and
   * resolves to its recent id. A file with no path on disk (one made by a
   * paste) is not a recent: it resolves to null.
   */
  recordOpenedFile: (file: File) => Promise<string | null>;
  /**
   * The page is listening for `DesktopDocumentMessage`s and open failures: post
   * the files the app was launched with (argv, an association, "Open with") and
   * any that arrived before this call. `reopen` is the recent id of the document
   * the page had open before it reloaded; it opens again unless a newer file is
   * waiting.
   */
  documentsReady: (reopen: string | null) => void;
  /**
   * Called when the window is about to close or the app to quit; the window
   * closes when the promise resolves true. One handler at a time; without one
   * the window closes.
   */
  onCloseRequest?: (handler: () => Promise<boolean>) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => () => void;
  /** Streams a document save to `path` through the main process. */
  createSaveStream?: (path: string) => DesktopSaveStream;
  /** The path of a document the desktop app opened, by its id; null when it is no longer known. */
  documentPath?: (id: string) => Promise<string | null>;
  /** The size and modification time a document's file would open with now; null when it cannot be read. */
  documentStamp?: (id: string) => Promise<DesktopDocumentStamp | null>;
  /** Shows the native save dialog; resolves to the chosen path, or null when cancelled. */
  showSaveDialog?: (request: SaveDialogRequest) => Promise<string | null>;
  /** Opens the file at `path` the way the open dialog does: it arrives as a `DesktopDocumentMessage`. */
  openDocumentPath?: (path: string) => Promise<void>;
  /** One journal store operation against the state directory; the web app serves these to the engine worker. */
  journal?: (request: JournalStoreRequest) => Promise<unknown>;
}
