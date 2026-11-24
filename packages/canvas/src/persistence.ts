/**
 * The saved form of a drawing: a versioned envelope around the element list,
 * tombstones included. Image bytes live in the host's asset store keyed by
 * the element's `fileId`; they are never inside this document.
 *
 * A document whose version is newer than this build is refused rather than
 * decoded partially, so a save never overwrites what a newer Quipu wrote.
 */
import * as Schema from "effect/Schema";

import { Element, ELEMENT_SCHEMA_VERSION } from "./elements.ts";

export const DRAWING_SCHEMA_VERSION = ELEMENT_SCHEMA_VERSION;

export const DrawingDocument = Schema.Struct({
  type: Schema.Literal("quipu-drawing"),
  version: Schema.Literal(DRAWING_SCHEMA_VERSION),
  elements: Schema.Array(Element),
});
export type DrawingDocument = typeof DrawingDocument.Type;

const DrawingDocumentJson = Schema.fromJsonString(DrawingDocument);
const EnvelopeVersion = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Number }).annotate({
    parseOptions: { onExcessProperty: "ignore" },
  }),
);

export class NewerDrawingError extends Error {
  override readonly name = "NewerDrawingError";
  readonly version: number;
  constructor(version: number) {
    super(`This drawing was saved by a newer Quipu (schema version ${version}).`);
    this.version = version;
  }
}

export function makeDrawingDocument(elements: ReadonlyArray<Element>): DrawingDocument {
  return { type: "quipu-drawing", version: DRAWING_SCHEMA_VERSION, elements };
}

export const encodeDrawingJson: (document: DrawingDocument) => string =
  Schema.encodeSync(DrawingDocumentJson);

const decodeVersion = Schema.decodeUnknownSync(EnvelopeVersion);
const decodeDocument = Schema.decodeUnknownSync(DrawingDocumentJson);

/** Throws `NewerDrawingError` for a future version, or a schema error for a corrupt document. */
export function decodeDrawingJson(json: string): DrawingDocument {
  const { version } = decodeVersion(json);
  if (version > DRAWING_SCHEMA_VERSION) throw new NewerDrawingError(version);
  return decodeDocument(json);
}

/** UTF-8 length of the encoded document, for the storage cap. */
export function drawingJsonByteLength(json: string): number {
  let bytes = 0;
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
