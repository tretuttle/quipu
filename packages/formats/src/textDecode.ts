/**
 * Decoding of YAML and TOML tape tokens. The tape holds ranges; a scalar's value
 * is read by handing its own bytes to the format's parser, so nothing larger than
 * one token is ever parsed to answer "what is this node".
 */
import { decodeUtf8 } from "@quipu/core/boundedSlice";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import type { TextIndex } from "./yamlTape.ts";

/** The key of token `i` as the format's parser reads it, or undefined for roots and array elements. */
export const textKeyAt = (
  format: "yaml" | "toml",
  bytes: Uint8Array,
  index: TextIndex,
  i: number,
): string | undefined => {
  const start = index.tape.keyStart(i);
  if (start === 0xffffffff) return undefined;
  const slice = decodeUtf8(bytes.subarray(start, index.keyEnds[i] as number));
  // Let the library name the key the way it does for its own parse (complex keys included).
  if (format === "yaml") return Object.keys(parseYaml(`? ${slice}\n: 1`) as object)[0];
  return Object.keys(parseToml(`${slice} = 1`))[0];
};

/** The value of a scalar token. Containers have no value of their own: walk their children. */
export const textScalarAt = (
  format: "yaml" | "toml",
  bytes: Uint8Array,
  index: TextIndex,
  i: number,
): unknown => {
  const start = index.tape.start(i);
  const end = index.tape.end(i);
  const slice = decodeUtf8(bytes.subarray(start, end));
  if (format === "yaml") return parseYaml(slice);
  const parsed = parseToml(`v = ${slice}`).v;
  return parsed instanceof Date ? parsed.toISOString() : parsed;
};
