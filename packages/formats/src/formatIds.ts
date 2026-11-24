/** The formats Quipu opens and converts between. */
export const FORMAT_IDS = [
  "json",
  "jsonc",
  "har",
  "ndjson",
  "yaml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "text",
] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

/** Formats a conversion can read or write (HAR and JSONC are JSON on the wire). */
export const CONVERT_FORMATS = ["json", "yaml", "toml", "xml", "csv", "tsv", "ndjson"] as const;

export type ConvertFormat = (typeof CONVERT_FORMATS)[number];
