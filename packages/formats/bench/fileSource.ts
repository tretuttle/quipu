/** A ByteSource over a file path, for the Node benches (file-backed Blobs cannot be posted to threads). */
import * as NodeFS from "node:fs";

import type { ByteSource } from "@quipu/core/source";

export const openFileSource = (path: string): ByteSource => {
  const fd = NodeFS.openSync(path, "r");
  const size = NodeFS.fstatSync(fd).size;
  return {
    size,
    read: (start, end) => {
      const out = new Uint8Array(end - start);
      NodeFS.readSync(fd, out, 0, out.length, start);
      return Promise.resolve(out);
    },
    readInto: (start, end, buffer) => {
      const length = end - start;
      const target = buffer.byteLength >= length ? buffer : new ArrayBuffer(length);
      const bytes = new Uint8Array(target, 0, length);
      NodeFS.readSync(fd, bytes, 0, length, start);
      return Promise.resolve({ bytes, buffer: target });
    },
    close: () => NodeFS.closeSync(fd),
  };
};
