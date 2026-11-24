/**
 * YAML and TOML sources: parse the whole text (at most TEXT_FORMAT_LIMIT) and
 * hand back a writer that streams the value as JSON bytes.
 */
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { FormatSyntaxError } from "./errors.ts";
import { writeJsonValue } from "./jsonValueWriter.ts";
import { ByteOffsets, decodeLargeText } from "./textDocument.ts";
import { tomlErrorDetail, tomlErrorOffset } from "./tomlTape.ts";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The byte offset of a YAML parse error (the `yaml` package reports a UTF-16 position), or -1. */
const yamlErrorOffset = (text: string, bytes: Uint8Array, error: unknown) => {
  const pos = (error as { pos?: unknown }).pos;
  const at = Array.isArray(pos) ? (pos[0] as unknown) : undefined;
  return typeof at === "number" ? new ByteOffsets(text, bytes.length).at(at) : -1;
};

export const jsonValueWriterFor =
  (format: "yaml" | "toml", bytes: Uint8Array) => (write: (chunk: Uint8Array) => void) => {
    const text = decodeLargeText(bytes);
    let value: unknown;
    try {
      if (format === "yaml") {
        // A stream of several documents is an array of them, as the tape reads it.
        value = parseYaml(text, { prettyErrors: false, uniqueKeys: false });
      } else value = parseToml(text, { integersAsBigInt: "asNeeded" });
    } catch (error) {
      throw new FormatSyntaxError({
        format,
        offset:
          format === "toml" ? tomlErrorOffset(bytes, error) : yamlErrorOffset(text, bytes, error),
        detail: format === "toml" ? tomlErrorDetail(error) : errorMessage(error),
      });
    }
    writeJsonValue(value, write, { from: format });
  };
