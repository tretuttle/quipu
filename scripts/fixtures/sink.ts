// @effect-diagnostics nodeBuiltinImport:off - streams gigabytes through one raw file descriptor; there is no Effect runtime around the generator.
/**
 * Streaming file sink. Text accumulates in a small part list and is flushed to
 * the file descriptor every few MiB, so a 2 GiB fixture never exists in memory.
 * `bytesWritten` is exact (UTF-8 bytes on disk), which is what the size targets
 * and the fixture size check use.
 */
import * as NodeFS from "node:fs";

const FLUSH_CHARS = 4 * 1024 * 1024;

export interface Sink {
  readonly write: (text: string) => void;
  readonly writeBytes: (bytes: Uint8Array) => void;
  /** Exact bytes on disk after the next flush, plus pending text as a lower bound. */
  readonly size: () => number;
  readonly flush: () => void;
  readonly close: () => number;
}

export const openSink = (path: string): Sink => {
  const fd = NodeFS.openSync(path, "w");
  let parts: string[] = [];
  let pendingChars = 0;
  let bytesWritten = 0;

  const flush = () => {
    if (parts.length === 0) return;
    const buffer = Buffer.from(parts.join(""), "utf8");
    parts = [];
    pendingChars = 0;
    writeAll(fd, buffer);
    bytesWritten += buffer.byteLength;
  };
  const write = (text: string) => {
    parts.push(text);
    pendingChars += text.length;
    if (pendingChars >= FLUSH_CHARS) flush();
  };
  const writeBytes = (bytes: Uint8Array) => {
    flush();
    writeAll(fd, bytes);
    bytesWritten += bytes.byteLength;
  };
  return {
    write,
    writeBytes,
    flush,
    size: () => bytesWritten + pendingChars,
    close: () => {
      flush();
      NodeFS.fsyncSync(fd);
      NodeFS.closeSync(fd);
      return bytesWritten;
    },
  };
};

const writeAll = (fd: number, bytes: Uint8Array) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += NodeFS.writeSync(fd, bytes, offset, bytes.byteLength - offset);
  }
};
