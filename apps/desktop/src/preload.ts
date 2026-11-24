import type {
  DesktopBridge,
  DesktopDocumentMessage,
  DesktopOpenedDocument,
  DesktopOpenFailure,
  DesktopSaveStream,
  JournalStoreRequest,
} from "@quipu/contracts";
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import { installWindowControlsInset } from "./windowControlsInset.ts";

// oxlint-disable-next-line quipu/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;

/**
 * A save goes over its own MessagePort so the chunks never pass through
 * `invoke`'s serialization of a reply per call. One message is in flight at a
 * time: the main process acknowledges each chunk after writing it, which is
 * the stream's backpressure, and answers `close` with the bytes written.
 */
const createSaveStream = (path: string): DesktopSaveStream => {
  const { port1, port2 } = new MessageChannel();
  ipcRenderer.postMessage(IpcChannels.SAVE_DOCUMENT_CHANNEL, { path }, [port2]);
  port1.start();
  // One exchange at a time: the reply to the message in flight settles the waiting promise.
  let waiting: { resolve: (bytes: number) => void; reject: (error: Error) => void } | null = null;
  // The main process answers a save it cannot start (the temp file cannot be created) before the
  // first chunk is sent, and closes the port; that error must fail every exchange after it.
  let failure: Error | null = null;
  port1.addEventListener("message", (event: MessageEvent<unknown>) => {
    const reply = event.data as { _tag?: string; bytes?: number; message?: string };
    const pending = waiting;
    waiting = null;
    if (reply._tag === "ok" && typeof reply.bytes === "number") {
      pending?.resolve(reply.bytes);
      return;
    }
    failure ??= new Error(reply.message ?? "the save failed");
    pending?.reject(failure);
  });
  let queue: Promise<unknown> = Promise.resolve();
  const exchange = (message: unknown) => {
    const turn = queue.then(
      () =>
        new Promise<number>((resolve, reject) => {
          if (failure !== null) {
            reject(failure);
            return;
          }
          waiting = { resolve, reject };
          port1.postMessage(message);
        }),
    );
    queue = turn.catch(() => {});
    return turn;
  };
  return {
    // Copied, not transferred: an ArrayBuffer in the transfer list does not arrive in the main
    // process's MessagePortMain as the Uint8Array the save port decodes.
    write: (chunk) => exchange({ _tag: "chunk", bytes: chunk }).then(() => {}),
    close: () => exchange({ _tag: "close" }).finally(() => port1.close()),
    abort: () =>
      exchange({ _tag: "abort" })
        .then(() => {})
        .finally(() => port1.close()),
  };
};

// A file the main process opened arrives with the port that reads it. A port
// cannot cross contextBridge, so it goes to the page by window.postMessage. The
// type is spelled out (and checked against the contract) so the preload bundle
// does not pull in the contracts' schemas.
ipcRenderer.on(IpcChannels.DOCUMENT_SOURCE_CHANNEL, (event, document: DesktopOpenedDocument) => {
  const message = { type: "quipu:desktop-document", document } satisfies DesktopDocumentMessage;
  window.postMessage(message, window.location.origin, [...event.ports]);
});

// Closing the window or quitting asks the page first (DesktopCloseGuard); a page with no
// handler, or one that fails, lets it close.
let closeHandler: (() => Promise<boolean>) | null = null;
ipcRenderer.on(IpcChannels.CLOSE_REQUEST_CHANNEL, (_event, id: unknown) => {
  if (typeof id !== "number") return;
  const answer = closeHandler === null ? Promise.resolve(true) : closeHandler();
  void answer
    .catch(() => true)
    .then((close) => ipcRenderer.send(IpcChannels.CLOSE_REPLY_CHANNEL, { id, close }));
});

if (clientPlatform === "darwin") {
  installWindowControlsInset({ webFrame, root: document.documentElement, events: window });
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getClientPlatform: () => clientPlatform,
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  getKeybindings: () => ipcRenderer.invoke(IpcChannels.GET_KEYBINDINGS_CHANNEL),
  setKeybindings: (keybindings) =>
    ipcRenderer.invoke(IpcChannels.SET_KEYBINDINGS_CHANNEL, keybindings),
  openKeybindingsFile: () => ipcRenderer.invoke(IpcChannels.OPEN_KEYBINDINGS_FILE_CHANNEL),
  openDocumentDialog: () => ipcRenderer.invoke(IpcChannels.OPEN_DOCUMENT_DIALOG_CHANNEL),
  openRecentDocument: (id: string) =>
    ipcRenderer.invoke(IpcChannels.OPEN_RECENT_DOCUMENT_CHANNEL, id),
  getRecentDocuments: () => ipcRenderer.invoke(IpcChannels.GET_RECENT_DOCUMENTS_CHANNEL),
  removeRecentDocument: (id: string) =>
    ipcRenderer.invoke(IpcChannels.REMOVE_RECENT_DOCUMENT_CHANNEL, id),
  clearRecentDocuments: () => ipcRenderer.invoke(IpcChannels.CLEAR_RECENT_DOCUMENTS_CHANNEL),
  onDocumentOpenFailed: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, failure: DesktopOpenFailure) =>
      listener(failure);
    ipcRenderer.on(IpcChannels.DOCUMENT_OPEN_FAILED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.DOCUMENT_OPEN_FAILED_CHANNEL, wrappedListener);
    };
  },
  onRecentDocumentsChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, documents: unknown) => {
      if (!Array.isArray(documents)) return;
      listener(documents as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.RECENT_DOCUMENTS_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.RECENT_DOCUMENTS_CHANNEL, wrappedListener);
    };
  },
  // The path is read from the File here, in the preload, and goes straight to the
  // main process: the page never gets to name a path to the main process. A
  // pasted file has none, so it is not remembered.
  recordOpenedFile: async (file: File) => {
    const path = webUtils.getPathForFile(file);
    if (path === "") return null;
    return ipcRenderer.invoke(IpcChannels.RECORD_OPENED_PATH_CHANNEL, path);
  },
  documentsReady: (reopen) => {
    void ipcRenderer.invoke(IpcChannels.DOCUMENTS_READY_CHANNEL, reopen);
  },
  onCloseRequest: (handler) => {
    closeHandler = handler;
    return () => {
      if (closeHandler === handler) closeHandler = null;
    };
  },
  createSaveStream,
  documentPath: (id) => ipcRenderer.invoke(IpcChannels.DOCUMENT_PATH_CHANNEL, id),
  documentStamp: (id) => ipcRenderer.invoke(IpcChannels.DOCUMENT_STAMP_CHANNEL, id),
  showSaveDialog: (request) =>
    ipcRenderer.invoke(IpcChannels.SAVE_DOCUMENT_DIALOG_CHANNEL, request),
  openDocumentPath: (path) => ipcRenderer.invoke(IpcChannels.OPEN_DOCUMENT_PATH_CHANNEL, path),
  journal: (request: JournalStoreRequest) =>
    ipcRenderer.invoke(IpcChannels.JOURNAL_CHANNEL, request),
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);
