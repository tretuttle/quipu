import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * A document read through a port: on the desktop the main process owns one file
 * handle per open document and answers bounded positional reads on a
 * MessagePort, so the original file stays the source of truth and the engine
 * never holds more of it than one read. The engine's coordinator relays the
 * same protocol to each scan worker on a port of its own.
 */

/** The most one read may ask for. A longer range is split by the reader. */
export const MAX_DOCUMENT_READ_BYTES = 64 * 1024 * 1024;

/** Bytes `[start, end)` of the document, answered by the reply with the same `id`. */
export const DocumentReadRequest = Schema.Struct({
  id: NonNegativeInt,
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type DocumentReadRequest = typeof DocumentReadRequest.Type;

export const DocumentReadReply = Schema.Union([
  Schema.Struct({ id: NonNegativeInt, ok: Schema.Literal(true), bytes: Schema.Uint8Array }),
  Schema.Struct({ id: NonNegativeInt, ok: Schema.Literal(false), error: Schema.String }),
]);
export type DocumentReadReply = typeof DocumentReadReply.Type;

/**
 * What the desktop app says about a file it opened, sent beside the port that
 * reads it. The page gets no path: `id` is the recent document's id.
 */
export const DesktopOpenedDocument = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: NonNegativeInt,
  lastModified: Schema.Number,
});
export type DesktopOpenedDocument = typeof DesktopOpenedDocument.Type;

/**
 * The preload hands a file the main process opened to the page with
 * `window.postMessage` of this message and the read port, because a port cannot
 * cross `contextBridge`.
 */
const DESKTOP_DOCUMENT_MESSAGE = "quipu:desktop-document";

export const DesktopDocumentMessage = Schema.Struct({
  type: Schema.Literal(DESKTOP_DOCUMENT_MESSAGE),
  document: DesktopOpenedDocument,
});
export type DesktopDocumentMessage = typeof DesktopDocumentMessage.Type;

/**
 * Why the desktop app could not open a file it was asked to: it is not there,
 * the system refused access, or it could not be read for another reason.
 */
export const DesktopOpenFailureReason = Schema.Literals(["missing", "denied", "unreadable"]);
export type DesktopOpenFailureReason = typeof DesktopOpenFailureReason.Type;

/** A file the desktop app could not open, told to the page so it can say so. */
export const DesktopOpenFailure = Schema.Struct({
  name: Schema.String,
  reason: DesktopOpenFailureReason,
  /** The recent document it was opened from, which the page can offer to remove. */
  id: Schema.optionalKey(Schema.String),
});
export type DesktopOpenFailure = typeof DesktopOpenFailure.Type;
