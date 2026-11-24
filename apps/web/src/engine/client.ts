/**
 * The typed engine client: the only module UI code imports to reach a document.
 * Every call crosses postMessage to the coordinator worker and is decoded with
 * the contracts, so the UI thread never parses, searches or transforms a
 * document; it asks for nodes, pages of children, decoded values and slices.
 *
 * `createEngineClient` is the promise surface; `EngineClient` wraps it as an
 * Effect service for the app's layers.
 */
import {
  type EditState,
  type EngineError,
  type EngineEvent,
  EngineEventEnvelope,
  EngineReplyEnvelope,
  type EngineRequest,
  type EngineRequestEnvelope,
  type EngineRequestTag,
  EngineResult,
  type IndexProgress,
} from "@quipu/contracts/engine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { desktopJournalPort } from "./desktopJournal.ts";

type RequestPayload<Tag extends EngineRequestTag> = Omit<
  Extract<EngineRequest, { _tag: Tag }>,
  "_tag"
>;

export interface EngineTransport {
  readonly request: <Tag extends EngineRequestTag>(
    tag: Tag,
    payload: RequestPayload<Tag>,
  ) => Promise<EngineResult[Tag]>;
  readonly onProgress: (listener: (progress: IndexProgress) => void) => () => void;
  /** Pushed after every edit, undo, redo, save and journal replay. */
  readonly onEditState: (listener: (state: EditState) => void) => () => void;
  readonly terminate: () => void;
}

const decodeReply = Schema.decodeUnknownSync(EngineReplyEnvelope);
const decodeEvent = Schema.decodeUnknownSync(EngineEventEnvelope);
const resultDecoders = Object.fromEntries(
  Object.entries(EngineResult).map(([tag, schema]) => [tag, Schema.decodeUnknownSync(schema)]),
) as { readonly [Tag in EngineRequestTag]: (input: unknown) => EngineResult[Tag] };

const spawnCoordinator = () =>
  new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });

/** A save's or an export's writable stream and a document's read port move to the worker; they cannot be cloned. */
const transferables = (request: EngineRequest): Transferable[] => {
  if ((request._tag === "save" || request._tag === "convert") && request.sink._tag === "writable") {
    return [request.sink.stream];
  }
  if (request._tag === "open" && !(request.source instanceof Blob)) return [request.source.port];
  return [];
};

export interface EngineClientOptions {
  /**
   * Where journals go instead of OPFS: the desktop renderer serves its state
   * directory on this port (`serveJournalStore` over `desktopBridge.journal`).
   */
  readonly journalPort?: MessagePort;
}

/** Talks to one coordinator worker; one client per window is enough. */
export const createEngineClient = (
  worker: Worker = spawnCoordinator(),
  options: EngineClientOptions = {},
): EngineTransport => {
  if (options.journalPort) {
    worker.postMessage({ journalPort: options.journalPort }, { transfer: [options.journalPort] });
  }
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: EngineError) => void }
  >();
  const progressListeners = new Set<(progress: IndexProgress) => void>();
  const editStateListeners = new Set<(state: EditState) => void>();
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === "object" && data !== null && "event" in data) {
      const { event: engineEvent } = decodeEvent(data);
      dispatchEvent(engineEvent);
      return;
    }
    const reply = decodeReply(data);
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(reply.error);
  });
  const dispatchEvent = (engineEvent: EngineEvent) => {
    switch (engineEvent._tag) {
      case "indexProgress":
        for (const listener of progressListeners) listener(engineEvent.progress);
        return;
      case "editState":
        for (const listener of editStateListeners) listener(engineEvent.state);
    }
  };
  const subscribe =
    <T>(listeners: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
  return {
    request: (tag, payload) => {
      const id = nextId++;
      const envelope: EngineRequestEnvelope = {
        id,
        request: { _tag: tag, ...payload } as EngineRequest,
      };
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(resultDecoders[tag](value)),
          reject,
        });
        worker.postMessage(envelope, { transfer: transferables(envelope.request) });
      });
    },
    onProgress: subscribe(progressListeners),
    onEditState: subscribe(editStateListeners),
    terminate: () => {
      worker.terminate();
      for (const entry of pending.values()) {
        entry.reject({
          _tag: "EngineWorkerError",
          detail: "the engine was terminated",
        } as EngineError);
      }
      pending.clear();
    },
  };
};

export class EngineClient extends Context.Service<
  EngineClient,
  {
    readonly request: <Tag extends EngineRequestTag>(
      tag: Tag,
      payload: RequestPayload<Tag>,
    ) => Effect.Effect<EngineResult[Tag], EngineError>;
    readonly onProgress: EngineTransport["onProgress"];
  }
>()("@quipu/web/engine/client/EngineClient") {}

export const makeEngineClient = (transport: EngineTransport) =>
  EngineClient.of({
    request: (tag, payload) =>
      Effect.tryPromise({
        try: () => transport.request(tag, payload),
        catch: (error) => error as EngineError,
      }),
    onProgress: transport.onProgress,
  });

/** The window's engine; on the desktop its journals go to the state directory (`desktopJournal.ts`). */
export const createWindowEngine = (): EngineTransport => {
  const journalPort = desktopJournalPort(window.desktopBridge);
  return createEngineClient(spawnCoordinator(), journalPort ? { journalPort } : {});
};

export const layer = Layer.sync(EngineClient, () => makeEngineClient(createWindowEngine()));
