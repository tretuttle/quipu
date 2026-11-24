import { JournalStoreRequestSchema } from "@quipu/contracts";
import type { JournalStore } from "@quipu/core/journalStore";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { makeDesktopJournalStore } from "../../documents/DesktopJournalStore.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * The renderer's journal store calls arrive here one operation at a time; the
 * engine worker speaks the same protocol over a MessagePort the renderer serves
 * (apps/web/src/engine/desktopJournal.ts). Bytes travel as Uint8Arrays.
 */
export const journal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JOURNAL_CHANNEL,
  payload: JournalStoreRequestSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.journal")(function* (request) {
    const environment = yield* DesktopEnvironment;
    const store: JournalStore = yield* makeDesktopJournalStore(environment.stateDir);
    return yield* Effect.promise(() => dispatch(store, request));
  }),
});

const dispatch = (
  store: JournalStore,
  request: typeof JournalStoreRequestSchema.Type,
): Promise<unknown> => {
  switch (request.op) {
    case "size":
      return store.size(request.path);
    case "read":
      return store.read(request.path, request.start, request.end);
    case "append":
      return store.append(request.path, request.bytes);
    case "truncate":
      return store.truncate(request.path, request.size);
    case "replace":
      return store.replace(request.path, request.bytes);
    case "remove":
      return store.remove(request.path);
    case "list":
      return store.list(request.path);
    case "close":
      return store.close(request.path);
  }
};
