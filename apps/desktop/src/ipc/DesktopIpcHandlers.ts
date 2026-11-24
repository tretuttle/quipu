import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import {
  clearRecentDocuments,
  documentPath,
  documentStamp,
  documentsReady,
  getRecentDocuments,
  openDocumentDialog,
  openDocumentPath,
  openRecentDocument,
  recordOpenedPath,
  removeRecentDocument,
  saveDocument,
  saveDocumentDialog,
} from "./methods/documents.ts";
import {
  getClientSettings,
  getKeybindings,
  setClientSettings,
  setKeybindings,
} from "./methods/settings.ts";
import { journal } from "./methods/journal.ts";
import { openExternal, openKeybindingsFile, setTheme } from "./methods/shell.ts";
import { getAppBranding, getWindowFullscreenState } from "./methods/window.ts";

/** Registers every renderer-facing IPC method; each one decodes with its contract schema. */
export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getWindowFullscreenState);

  yield* ipc.handle(setTheme);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(openKeybindingsFile);
  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(getKeybindings);
  yield* ipc.handle(setKeybindings);
  yield* ipc.handle(openDocumentDialog);
  yield* ipc.handle(openRecentDocument);
  yield* ipc.handle(getRecentDocuments);
  yield* ipc.handle(removeRecentDocument);
  yield* ipc.handle(clearRecentDocuments);
  yield* ipc.handle(recordOpenedPath);
  yield* ipc.handle(documentsReady);
  yield* ipc.handle(documentPath);
  yield* ipc.handle(documentStamp);
  yield* ipc.handle(saveDocumentDialog);
  yield* ipc.handle(openDocumentPath);
  yield* ipc.handle(journal);
  yield* ipc.handleMessage(saveDocument);
});
