import { type StreamOptions, type StreamTarget, convertJsonSource } from "../convertSource.ts";
import { createLocalFormatPool } from "../localPool.ts";

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** Converts in-memory JSON bytes through the real region pipeline over an in-process pool. */
export const convertBytes = async (
  bytes: Uint8Array,
  target: StreamTarget,
  options: StreamOptions & { workers?: number } = {},
) => {
  const pool = createLocalFormatPool(options.workers ?? 3);
  const chunks: Uint8Array[] = [];
  try {
    await convertJsonSource(
      pool,
      {
        spec: {
          kind: "memory",
          buffer: bytes.buffer,
          byteOffset: bytes.byteOffset,
          byteLength: bytes.byteLength,
        },
        size: bytes.byteLength,
      },
      target,
      { write: (c) => void chunks.push(c) },
      options,
    );
  } finally {
    await pool.terminate();
  }
  return concat(chunks);
};
