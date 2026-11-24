import { decodeUtf8 } from "@quipu/core/boundedSlice";

import { convert, type ConvertOptions } from "../convert.ts";
import type { ConvertFormat } from "../formatIds.ts";
import { createLocalFormatPool } from "../localPool.ts";

const encoder = new TextEncoder();

/** Converts text through the real pipeline (region pool for JSON sources) and returns the output text. */
export const convertText = async (
  from: ConvertFormat,
  to: ConvertFormat,
  text: string,
  options: Partial<Pick<ConvertOptions, "regionBytes" | "columns" | "nested" | "firstRows">> = {},
) => {
  const bytes = encoder.encode(text);
  const pool = createLocalFormatPool(3);
  const chunks: Uint8Array[] = [];
  try {
    await convert(
      from,
      to,
      {
        spec: {
          kind: "memory",
          buffer: bytes.buffer,
          byteOffset: bytes.byteOffset,
          byteLength: bytes.byteLength,
        },
        size: bytes.byteLength,
      },
      { pool, sink: { write: (c) => void chunks.push(c.slice()) }, ...options },
    );
  } finally {
    await pool.terminate();
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return decodeUtf8(out);
};
