// @effect-diagnostics nodeBuiltinImport:off
// Reads are positional and run concurrently on one handle, which Node's
// FileHandle does and Effect's File (one shared position) does not.
/**
 * The desktop's document source: the main process owns one file handle per
 * open document and answers bounded positional reads on a MessagePort
 * (`DocumentReadRequest` in @quipu/contracts). The page hands the port to the
 * engine, whose coordinator relays it to each scan worker, so the file on disk
 * stays the source of truth and no read is larger than one window.
 */
import {
  type DocumentReadReply,
  DocumentReadRequest,
  MAX_DOCUMENT_READ_BYTES,
} from "@quipu/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";

export interface DocumentReader {
  readonly size: number;
  /** Milliseconds since the epoch, as a `File`'s `lastModified`. */
  readonly lastModified: number;
  /** Bytes `[start, end)` in a buffer of their own. */
  readonly read: (start: number, end: number) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
}

class DocumentChangedError extends Error {
  constructor() {
    super("the file is shorter than when it was opened");
  }
}

/**
 * A file's size and modification time, as an opened document reports them: what
 * the page builds the file's journal key from.
 */
export const documentStamp = async (path: string) => {
  const info = await NodeFSP.stat(path);
  return { size: info.size, lastModified: info.mtimeMs };
};

/** Opens `path` for reading; the size and time are the file's when it was opened. */
export const openDocumentReader = async (path: string): Promise<DocumentReader> => {
  const handle = await NodeFSP.open(path, "r");
  let info: Awaited<ReturnType<typeof handle.stat>>;
  try {
    info = await handle.stat();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    size: info.size,
    lastModified: info.mtimeMs,
    read: async (start, end) => {
      const bytes = new Uint8Array(end - start);
      let filled = 0;
      while (filled < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          filled,
          bytes.byteLength - filled,
          start + filled,
        );
        if (bytesRead === 0) throw new DocumentChangedError();
        filled += bytesRead;
      }
      return bytes;
    },
    close: () => handle.close(),
  };
};

/** The parts of Electron's `MessagePortMain` the server uses. */
export interface DocumentPortLike {
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
}

const decodeRequest = Schema.decodeUnknownOption(DocumentReadRequest);

/**
 * Answers reads on `port` from `reader` until the other end goes away (the
 * document closed, or the page reloaded or quit), then closes the file. A read
 * past the file's opened size or over `MAX_DOCUMENT_READ_BYTES` is refused.
 * `MessagePortMain` cannot transfer a buffer, so each reply is a copy.
 */
export const serveDocumentReads = (
  port: DocumentPortLike,
  reader: DocumentReader,
  maxRead: number = MAX_DOCUMENT_READ_BYTES,
) => {
  let open = true;
  const reply = (message: DocumentReadReply) => {
    if (open) port.postMessage(message);
  };
  port.on("message", (event) => {
    const decoded = decodeRequest(event.data);
    if (Option.isNone(decoded)) return;
    const { id, start, end } = decoded.value;
    if (end < start || end > reader.size) {
      reply({
        id,
        ok: false,
        error: `bytes [${start}, ${end}) are outside a ${reader.size}-byte document`,
      });
      return;
    }
    if (end - start > maxRead) {
      reply({
        id,
        ok: false,
        error: `a read of ${end - start} bytes is over the ${maxRead}-byte limit`,
      });
      return;
    }
    reader.read(start, end).then(
      (bytes) => reply({ id, ok: true, bytes }),
      (error: unknown) =>
        reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  port.on("close", () => {
    open = false;
    void reader.close().catch(() => undefined);
  });
  port.start();
};
