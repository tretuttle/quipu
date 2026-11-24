import {
  DOCUMENT_FORMAT_LABELS,
  EDITABLE_FORMATS,
  type DocumentFormat,
  STRUCTURED_FORMATS,
} from "@quipu/contracts/engine";

const namesOf = (formats: ReadonlyArray<DocumentFormat>) =>
  new Intl.ListFormat("en-US", { type: "conjunction" }).format(
    formats.map((format) => DOCUMENT_FORMAT_LABELS[format]),
  );

/** The formats that open with a structure, in words: "JSON, JSONC, HAR, … and TSV". */
export const structuredFormatNames = namesOf(STRUCTURED_FORMATS);

/** The formats the engine accepts edits for, in words: "JSON and HAR". */
export const editableFormatNames = namesOf(EDITABLE_FORMATS);
