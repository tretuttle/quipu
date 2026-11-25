import * as Schema from "effect/Schema";
/**
 * YAML and TOML sources: parse the whole text (at most TEXT_FORMAT_LIMIT) and
 * hand back a writer that streams the value as JSON bytes.
 */
import { parse as parseToml } from "smol-toml";
import { parseAllDocuments, type Document } from "yaml";

import { FormatSyntaxError } from "./errors.ts";

const isFormatSyntaxError = Schema.is(FormatSyntaxError);
import { writeJsonValue } from "./jsonValueWriter.ts";
import { ByteOffsets, decodeLargeText } from "./textDocument.ts";
import { tomlErrorDetail, tomlErrorOffset } from "./tomlTape.ts";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const yamlOffset = (text: string, bytes: Uint8Array, pos: unknown): number => {
  const at = Array.isArray(pos) ? (pos[0] as unknown) : undefined;
  return typeof at === "number" ? new ByteOffsets(text, bytes.length).at(at) : -1;
};

const parseYamlStream = (text: string, bytes: Uint8Array): unknown => {
  const docs = parseAllDocuments(text, {
    prettyErrors: false,
    uniqueKeys: false,
    merge: true,
  }) as Document.Parsed[];
  for (const doc of docs) {
    const error = doc.errors[0];
    if (error) {
      throw new FormatSyntaxError({
        format: "yaml",
        offset: yamlOffset(text, bytes, error.pos),
        detail: error.message,
      });
    }
  }
  if (docs.length === 0) return null;
  if (docs.length === 1) return (docs[0] as Document.Parsed).toJS({ mapAsMap: false });
  return docs.map((doc) => doc.toJS({ mapAsMap: false }));
};

export const jsonValueWriterFor =
  (format: "yaml" | "toml", bytes: Uint8Array) => (write: (chunk: Uint8Array) => void) => {
    const text = decodeLargeText(bytes);
    let value: unknown;
    try {
      if (format === "yaml") {
        value = parseYamlStream(text, bytes);
      } else value = parseToml(text, { integersAsBigInt: "asNeeded" });
    } catch (error) {
      if (isFormatSyntaxError(error)) throw error;
      throw new FormatSyntaxError({
        format,
        offset: tomlErrorOffset(bytes, error),
        detail: errorMessage(error),
      });
    }
    writeJsonValue(value, write, { from: format });
  };
