/**
 * On the desktop the engine worker cannot reach the state directory, so the
 * renderer serves it: a JournalStore over `desktopBridge.journal` (one IPC
 * invoke per operation) is served on a MessagePort the worker gets as its
 * journal store (`createEngineClient(worker, { journalPort })`). The journal
 * files land in `<stateDir>/journals/<kind>/<id>/`, not in Electron's OPFS,
 * which lives in a Chromium profile that is treated as replaceable.
 */
import type { DesktopBridge } from "@quipu/contracts";
import { type JournalStore, serveJournalStore } from "@quipu/core/journalStore";

const desktopJournalStore = (journal: NonNullable<DesktopBridge["journal"]>): JournalStore => ({
  size: (path) => journal({ op: "size", path }) as Promise<number>,
  read: (path, start, end) => journal({ op: "read", path, start, end }) as Promise<Uint8Array>,
  append: (path, bytes) => journal({ op: "append", path, bytes }) as Promise<void>,
  truncate: (path, size) => journal({ op: "truncate", path, size }) as Promise<void>,
  replace: (path, bytes) => journal({ op: "replace", path, bytes }) as Promise<void>,
  remove: (path) => journal({ op: "remove", path }) as Promise<void>,
  list: (path) => journal({ op: "list", path }) as Promise<string[]>,
  close: (path) => journal({ op: "close", path }) as Promise<void>,
});

/** The port to hand the engine worker when the bridge has a journal; undefined on the web. */
export const desktopJournalPort = (bridge: DesktopBridge | undefined): MessagePort | undefined => {
  if (!bridge?.journal) return undefined;
  const channel = new MessageChannel();
  serveJournalStore(channel.port1, desktopJournalStore(bridge.journal));
  return channel.port2;
};
