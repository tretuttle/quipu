/**
 * Byte sources. The original bytes are the source of truth:
 * a File/Blob in the browser, a port to the desktop's main-process file handle,
 * or an in-memory buffer (a SharedArrayBuffer every worker opens) for a child
 * document. Every read is a bounded slice.
 *
 * `readInto` fills a caller-owned buffer so a worker reuses one region buffer for
 * its whole life instead of leaving dead ArrayBuffers for the GC (16 workers ×
 * several dead 32 MiB regions each). The buffer identity may change
 * (BYOB readers transfer it), so callers keep the returned one.
 */
import {
  type DocumentReadReply,
  type DocumentReadRequest,
  MAX_DOCUMENT_READ_BYTES,
} from "@quipu/contracts";
import type { DocumentSource as DocumentSourceInput } from "@quipu/contracts/engine";

import { readBlobSlice } from "./boundedSlice.ts";

export interface ReadInto {
  readonly bytes: Uint8Array;
  readonly buffer: ArrayBuffer;
}

export interface ByteSource {
  readonly size: number;
  /** Bytes [start, end). Allocates; may alias an internal buffer only for memory sources. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** Bytes [start, end) into `buffer` (grown when too small). */
  readInto(start: number, end: number, buffer: ArrayBuffer): Promise<ReadInto>;
  close(): void;
}

export type SourceSpec =
  | { readonly kind: "blob"; readonly blob: Blob }
  /** A port answering bounded reads (`portSource`); each worker gets a port of its own. */
  | { readonly kind: "port"; readonly port: MessagePort; readonly size: number }
  | {
      readonly kind: "memory";
      readonly buffer: ArrayBufferLike;
      readonly byteOffset: number;
      readonly byteLength: number;
    }
  /** The append buffer's chunks (shared on an isolated page); `length` is the bytes written so far. */
  | {
      readonly kind: "append";
      readonly chunks: ReadonlyArray<ArrayBufferLike>;
      readonly chunkBytes: number;
      readonly length: number;
    }
  /**
   * A window of an edited document: packed pieces (pieceSource.ts) whose buffer
   * indices name other source ids already open in the same worker.
   */
  | {
      readonly kind: "pieces";
      readonly pieces: Float64Array;
      readonly buffers: ReadonlyArray<number>;
    };

export const memorySource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  read: (start, end) => Promise.resolve(bytes.subarray(start, end)),
  readInto: (start, end, buffer) => Promise.resolve({ bytes: bytes.subarray(start, end), buffer }),
  close: () => {},
});

/** Opens a self-contained spec; `append` and `pieces` need the worker's other sources (jobs.ts). */
export const openSource = (spec: SourceSpec): ByteSource => {
  switch (spec.kind) {
    case "blob":
      return blobSource(spec.blob);
    case "port":
      return portSource(spec.port, spec.size);
    case "memory":
      return memorySource(new Uint8Array(spec.buffer, spec.byteOffset, spec.byteLength));
    default:
      throw new Error(`a ${spec.kind} source needs the worker's open sources`);
  }
};

/** Reads a Blob through BYOB streams (a byte stream in Chromium), falling back to a copy. */
export const blobSource = (blob: Blob): ByteSource => {
  let byob: boolean | undefined;
  const readInto = async (start: number, end: number, buffer: ArrayBuffer): Promise<ReadInto> => {
    const length = end - start;
    if (byob === false) {
      const bytes = await readBlobSlice(blob, start, end);
      return { bytes, buffer: bytes.buffer as ArrayBuffer };
    }
    let target = buffer.byteLength >= length ? buffer : new ArrayBuffer(length);
    try {
      const reader = blob.slice(start, end).stream().getReader({ mode: "byob" });
      byob = true;
      let offset = 0;
      while (offset < length) {
        const { done, value } = await reader.read(new Uint8Array(target, offset, length - offset));
        if (value) target = value.buffer as ArrayBuffer;
        if (done || !value) break;
        offset += value.byteLength;
      }
      reader.releaseLock();
      return { bytes: new Uint8Array(target, 0, offset), buffer: target };
    } catch (error) {
      if (byob === true && !(error instanceof TypeError)) throw error;
      byob = false;
      return readInto(start, end, buffer);
    }
  };
  return {
    size: blob.size,
    read: (start, end) => readBlobSlice(blob, start, end),
    readInto,
    close: () => {},
  };
};

/** The end of a port a reader or a server needs; a MessagePort in the product, a fake in tests. */
export interface SourcePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  start?(): void;
  close(): void;
}

export interface PortSource extends ByteSource {
  /**
   * A new port answering reads of this source, for a worker: a port cannot be
   * shared, so each scan worker gets its own, relayed through this one.
   */
  fork(): MessagePort;
}

const ownsBuffer = (bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer &&
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength;

/**
 * Reads a document through a port that answers `DocumentReadRequest`s. Ranges
 * longer than `maxRead` go as several requests, so no reply is larger than one
 * read window. Every reply is a fresh buffer the reader owns.
 */
export const portSource = (
  port: SourcePort,
  size: number,
  maxRead: number = MAX_DOCUMENT_READ_BYTES,
): PortSource => {
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { readonly resolve: (bytes: Uint8Array) => void; readonly reject: (error: Error) => void }
  >();
  const forks: MessagePort[] = [];
  port.addEventListener("message", (event) => {
    const reply = event.data as DocumentReadReply;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.bytes);
    else entry.reject(new Error(reply.error));
  });
  port.start?.();
  const request = (start: number, end: number) =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (closed) {
        reject(new Error("the document's source is closed"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, start, end } satisfies DocumentReadRequest);
    });
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    if (start < 0 || end < start || end > size) {
      throw new RangeError(`bytes [${start}, ${end}) are outside a ${size}-byte document`);
    }
    if (end - start <= maxRead) return request(start, end);
    const bytes = new Uint8Array(end - start);
    for (let at = start; at < end; at += maxRead) {
      bytes.set(await request(at, Math.min(end, at + maxRead)), at - start);
    }
    return bytes;
  };
  return {
    size,
    read,
    readInto: async (start, end, buffer) => {
      const bytes = await read(start, end);
      if (ownsBuffer(bytes)) return { bytes, buffer: bytes.buffer };
      const target = buffer.byteLength >= bytes.byteLength ? buffer : new ArrayBuffer(end - start);
      const view = new Uint8Array(target, 0, bytes.byteLength);
      view.set(bytes);
      return { bytes: view, buffer: target };
    },
    fork: () => {
      const channel = new MessageChannel();
      servePortSource(channel.port1, { size, read }, { maxRead, handsOver: true });
      forks.push(channel.port1);
      return channel.port2;
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error("the document's source closed"));
      pending.clear();
      for (const fork of forks) fork.close();
      port.close();
    },
  };
};

export interface ServeOptions {
  readonly maxRead?: number;
  /**
   * `source.read` returns buffers nobody else keeps (a port source does), so
   * they are transferred as they are. Otherwise each reply is a copy.
   */
  readonly handsOver?: boolean;
}

/**
 * Answers `DocumentReadRequest`s on `port` from `source`. A request past the
 * source's end or longer than the read limit is refused.
 */
export const servePortSource = (
  port: SourcePort,
  source: Pick<ByteSource, "size" | "read">,
  { maxRead = MAX_DOCUMENT_READ_BYTES, handsOver = false }: ServeOptions = {},
) => {
  const fail = (id: number, error: string) =>
    port.postMessage({ id, ok: false, error } satisfies DocumentReadReply);
  port.addEventListener("message", (event) => {
    const { id, start, end } = event.data as DocumentReadRequest;
    if (!(start >= 0 && end >= start && end <= source.size)) {
      fail(id, `bytes [${start}, ${end}) are outside a ${source.size}-byte document`);
      return;
    }
    if (end - start > maxRead) {
      fail(id, `a read of ${end - start} bytes is over the ${maxRead}-byte limit`);
      return;
    }
    source.read(start, end).then(
      (bytes) => {
        const owned = handsOver && ownsBuffer(bytes) ? bytes : bytes.slice();
        port.postMessage({ id, ok: true, bytes: owned } satisfies DocumentReadReply, [
          owned.buffer,
        ]);
      },
      (error: unknown) => fail(id, error instanceof Error ? error.message : String(error)),
    );
  });
  port.start?.();
};

/** What the coordinator holds for an opened file: its own reader, and how a scan worker opens it. */
export interface DocumentBytes {
  readonly source: ByteSource;
  /** The bytes as a Blob, when they came as one; absent over a port. */
  readonly blob?: Blob;
  /** The spec one worker opens and what must be transferred with it; called once per worker. */
  readonly workerSpec: () => { readonly spec: SourceSpec; readonly transfer: Transferable[] };
}

export const documentBytes = (input: DocumentSourceInput): DocumentBytes => {
  if (input instanceof Blob) {
    return {
      source: blobSource(input),
      blob: input,
      workerSpec: () => ({ spec: { kind: "blob", blob: input }, transfer: [] }),
    };
  }
  const source = portSource(input.port, input.size);
  return {
    source,
    workerSpec: () => {
      const port = source.fork();
      return { spec: { kind: "port", port, size: input.size }, transfer: [port] };
    },
  };
};
