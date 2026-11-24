import * as Schema from "effect/Schema";

import { CONVERT_FORMATS } from "./formatIds.ts";

const ConvertFormatSchema = Schema.Literals(CONVERT_FORMATS);

/** Why a value cannot be written in the target format. Each reason names one rule of the mapping. */
export const UnrepresentableReason = Schema.Literals([
  "not-rows",
  "row-not-object",
  "nested-value",
  "duplicate-key",
  "unknown-column",
  "not-a-table",
  "null-value",
  "mixed-content",
  "invalid-name",
  "multiple-roots",
  "array-in-array",
  "too-deep",
  "key-too-long",
  "no-text",
  "invalid-json",
  "invalid-input",
  "token-too-large",
  "attribute-after-content",
  "empty-array",
  "no-root-element",
  "non-finite-number",
]);
export type UnrepresentableReason = typeof UnrepresentableReason.Type;

/**
 * The data has no faithful form in the target format. `pointer` is the JSON
 * Pointer (RFC 6901) of the first offending node in the source document, so every
 * view can mark it.
 */
export class UnrepresentableError extends Schema.TaggedError<UnrepresentableError>()(
  "UnrepresentableError",
  {
    from: ConvertFormatSchema,
    to: ConvertFormatSchema,
    reason: UnrepresentableReason,
    pointer: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.from} cannot be written as ${this.to} at ${this.pointer === "" ? "the root" : this.pointer}: ${this.detail}`;
  }
}

/** The input is bigger than the format's whole-text parser may hold. */
/** How a format is named in a sentence. */
const FORMAT_NAMES: Readonly<Record<(typeof ConvertFormatSchema)["Type"], string>> = {
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
  ndjson: "NDJSON",
};

const SIZE_UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB"] as const;

/** A size the way a person reads it: `256 MiB`, `256.1 MiB`, `900 bytes`. */
const sizeText = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${shown} ${SIZE_UNITS[unit]}`;
};

export class FormatTooLargeError extends Schema.TaggedError<FormatTooLargeError>()(
  "FormatTooLargeError",
  { format: ConvertFormatSchema, bytes: Schema.Number, limit: Schema.Number },
) {
  override get message(): string {
    const name = FORMAT_NAMES[this.format];
    return `This ${name} document is ${sizeText(this.bytes)}; ${name} documents up to ${sizeText(this.limit)} can be converted.`;
  }
}

/** The text is not valid in the format it was opened as. `offset` is a UTF-8 byte offset when known, else -1. */
export class FormatSyntaxError extends Schema.TaggedError<FormatSyntaxError>()(
  "FormatSyntaxError",
  { format: ConvertFormatSchema, offset: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid ${this.format}${this.offset >= 0 ? ` at byte ${this.offset}` : ""}: ${this.detail}`;
  }
}
