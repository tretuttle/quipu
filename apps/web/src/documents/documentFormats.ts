import type { ConvertFormat, DocumentFormat } from "@quipu/contracts/engine";

/**
 * What the app says and does per format: the label the header shows, the
 * grammar the Source view highlights a small file with, and the extensions
 * and media type the open and save pickers offer.
 */
interface FormatEntry {
  readonly label: string;
  /** Shiki's grammar for the file's text; null for plain text. */
  readonly grammar: string | null;
  readonly extensions: ReadonlyArray<`.${string}`>;
  readonly mimeType: string;
}

export const DOCUMENT_FORMATS: Readonly<Record<DocumentFormat, FormatEntry>> = {
  json: { label: "JSON", grammar: "json", extensions: [".json"], mimeType: "application/json" },
  jsonc: { label: "JSONC", grammar: "jsonc", extensions: [".jsonc"], mimeType: "application/json" },
  har: { label: "HAR", grammar: "json", extensions: [".har"], mimeType: "application/json" },
  ndjson: {
    label: "NDJSON",
    grammar: "jsonl",
    extensions: [".ndjson", ".jsonl"],
    mimeType: "application/x-ndjson",
  },
  yaml: {
    label: "YAML",
    grammar: "yaml",
    extensions: [".yaml", ".yml"],
    mimeType: "application/yaml",
  },
  toml: { label: "TOML", grammar: "toml", extensions: [".toml"], mimeType: "application/toml" },
  xml: { label: "XML", grammar: "xml", extensions: [".xml"], mimeType: "application/xml" },
  csv: { label: "CSV", grammar: "csv", extensions: [".csv"], mimeType: "text/csv" },
  tsv: {
    label: "TSV",
    grammar: "tsv",
    extensions: [".tsv"],
    mimeType: "text/tab-separated-values",
  },
  text: { label: "Text", grammar: null, extensions: [".txt"], mimeType: "text/plain" },
};

/** The formats an export can write, in the order the dialog lists them. */
export const EXPORT_FORMATS: ReadonlyArray<ConvertFormat> = [
  "json",
  "yaml",
  "toml",
  "xml",
  "csv",
  "tsv",
  "ndjson",
];

/** A picker filter: every format Quipu reads with structure, under one entry; "All files" stays offered. */
export const OPEN_PICKER_TYPES = [
  {
    description: "Data files",
    accept: Object.fromEntries(
      Object.entries(
        Object.values(DOCUMENT_FORMATS)
          .filter((entry) => entry.grammar !== null)
          .reduce<Record<string, string[]>>((byType, entry) => {
            (byType[entry.mimeType] ??= []).push(...entry.extensions);
            return byType;
          }, {}),
      ),
    ),
  },
];

/** The save picker's one filter for a format. */
export const savePickerTypes = (format: DocumentFormat) => {
  const entry = DOCUMENT_FORMATS[format];
  return [
    { description: `${entry.label} file`, accept: { [entry.mimeType]: [...entry.extensions] } },
  ];
};

/** `name` with the extension of `format`, replacing the extension of a known format. */
export const nameWithExtension = (name: string, format: DocumentFormat): string => {
  const extension = DOCUMENT_FORMATS[format].extensions[0] as string;
  const known = Object.values(DOCUMENT_FORMATS).flatMap((entry) => entry.extensions);
  const dot = name.lastIndexOf(".");
  const stem =
    dot > 0 && known.includes(name.slice(dot).toLowerCase() as `.${string}`)
      ? name.slice(0, dot)
      : name;
  return `${stem}${extension}`;
};
