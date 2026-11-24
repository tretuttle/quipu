import { firstChild, KIND_ARRAY, KIND_OBJECT } from "@quipu/core/tape";

import { textKeyAt, textScalarAt } from "../textDecode.ts";
import type { TextIndex } from "../yamlTape.ts";

/** The value of a YAML or TOML tape, rebuilt from byte ranges alone. */
export const textValueAt = (
  format: "yaml" | "toml",
  bytes: Uint8Array,
  index: TextIndex,
  i = 0,
): unknown => {
  const tape = index.tape;
  const kind = tape.kind(i);
  if (kind === KIND_OBJECT) {
    const out: Record<string, unknown> = {};
    for (let c = firstChild(tape, i); c >= 0; c = tape.next(c)) {
      // defineProperty: a member named __proto__ is data, not the prototype.
      Object.defineProperty(out, textKeyAt(format, bytes, index, c) as string, {
        value: textValueAt(format, bytes, index, c),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (kind === KIND_ARRAY) {
    const out: unknown[] = [];
    for (let c = firstChild(tape, i); c >= 0; c = tape.next(c))
      out.push(textValueAt(format, bytes, index, c));
    return out;
  }
  return textScalarAt(format, bytes, index, i);
};
