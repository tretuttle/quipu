import {
  DesktopDocumentStamp,
  DesktopRecentDocument,
  SaveDialogRequestSchema,
  SaveDocumentRequestSchema,
} from "@quipu/contracts";
import * as HostProcess from "@quipu/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { openSaveStream, serveSavePort } from "../../documents/DesktopDocumentSave.ts";
import * as DesktopDocuments from "../../documents/DesktopDocuments.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const openDocumentDialog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_DOCUMENT_DIALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Number,
  handler: Effect.fn("desktop.ipc.documents.openDialog")(function* () {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return yield* documents.openDialog;
  }),
});

export const openRecentDocument = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_RECENT_DOCUMENT_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.documents.openRecent")(function* (id) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return yield* documents.openRecent(id);
  }),
});

export const getRecentDocuments = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_RECENT_DOCUMENTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopRecentDocument),
  handler: Effect.fn("desktop.ipc.documents.getRecents")(function* () {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return yield* documents.recents;
  }),
});

export const removeRecentDocument = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOVE_RECENT_DOCUMENT_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.documents.removeRecent")(function* (id) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    yield* documents.removeRecent(id);
  }),
});

export const clearRecentDocuments = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_RECENT_DOCUMENTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.documents.clearRecents")(function* () {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    yield* documents.clearRecents;
  }),
});

export const recordOpenedPath = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_OPENED_PATH_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.documents.recordOpenedPath")(function* (path) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return Option.getOrNull(yield* documents.recordFile(path));
  }),
});

export const documentsReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DOCUMENTS_READY_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.documents.ready")(function* (reopen) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    yield* documents.rendererReady(Option.fromNullishOr(reopen));
  }),
});

export const documentPath = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DOCUMENT_PATH_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.documents.path")(function* (id) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return Option.getOrNull(yield* documents.pathOf(id));
  }),
});

export const documentStamp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DOCUMENT_STAMP_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(DesktopDocumentStamp),
  handler: Effect.fn("desktop.ipc.documents.stamp")(function* (id) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return Option.getOrNull(yield* documents.stampOf(id));
  }),
});

export const saveDocumentDialog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SAVE_DOCUMENT_DIALOG_CHANNEL,
  payload: SaveDialogRequestSchema,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.documents.saveDialog")(function* (request) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    return Option.getOrNull(yield* documents.saveDialog(request));
  }),
});

export const openDocumentPath = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_DOCUMENT_PATH_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.documents.openPath")(function* (path) {
    const documents = yield* DesktopDocuments.DesktopDocuments;
    yield* documents.openPath(path);
  }),
});

const decodeRequest = Schema.decodeUnknownEffect(SaveDocumentRequestSchema);

/**
 * A save arrives as `{ path }` with one MessagePort. The temp file is opened
 * here, and the port is served until the renderer closes or aborts the save;
 * the rename over `path` is the commit.
 */
export const saveDocument: DesktopIpc.DesktopMessageIpcMethod<
  never,
  FileSystem.FileSystem | Path.Path
> = {
  channel: IpcChannels.SAVE_DOCUMENT_CHANNEL,
  handler: (raw, event) =>
    Effect.gen(function* () {
      const [port] = event.ports;
      if (!port) return;
      const request = yield* decodeRequest(raw).pipe(Effect.option);
      if (request._tag === "None") {
        port.postMessage({ _tag: "error", message: "malformed save request" });
        port.close();
        return;
      }
      const suffix = (yield* Random.nextInt).toString(36);
      const stream = yield* openSaveStream({
        path: request.value.path,
        pid: process.pid,
        suffix,
        platform: yield* HostProcess.Platform,
      }).pipe(Effect.result);
      if (stream._tag === "Failure") {
        port.postMessage({ _tag: "error", message: stream.failure.message });
        port.close();
        return;
      }
      serveSavePort(port, stream.success);
    }),
};
