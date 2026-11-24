/**
 * Bounded gzip inflation. A compressed body is read whole (it is already within
 * the slice limit) and its output is capped: the stream is cancelled the moment
 * it would pass `limit`, so a decompression bomb costs at most `limit` bytes.
 */
import { MAX_SLICE_BYTES, SliceTooLargeError } from "@quipu/contracts/engine";

export const inflateGzip = async (
  compressed: Uint8Array,
  limit = MAX_SLICE_BYTES,
): Promise<Uint8Array> => {
  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SliceTooLargeError({ bytes: total, limit });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const chunk of chunks) {
    out.set(chunk, o);
    o += chunk.byteLength;
  }
  return out;
};
