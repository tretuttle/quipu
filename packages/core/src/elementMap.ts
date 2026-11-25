import type {
  ElementMapItemError,
  ElementMapProgress,
  ElementMapSummary,
} from "@quipu/contracts/elementMap";
import {
  CHILDREN_PAGE_LIMIT,
  MAX_SLICE_BYTES,
  type NodeKind,
  type NodeRef,
} from "@quipu/contracts/engine";

const ELEMENT_MAP_DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;
const ELEMENT_MAP_DEFAULT_MAX_BATCH_ITEMS = CHILDREN_PAGE_LIMIT;
const ELEMENT_MAP_DEFAULT_CONCURRENCY = 4;

export interface ElementDescriptor {
  readonly index: number;
  readonly ref: NodeRef;
  readonly kind: NodeKind;
  readonly key: string | null;
  /** Document-logical byte span [start, end) with edits applied. */
  readonly start: number;
  readonly end: number;
}

export interface ElementSlice {
  readonly index: number;
  readonly ref: NodeRef;
  readonly kind: NodeKind;
  readonly key: string | null;
  /** View into the batch's logical read buffer; copy before transferring its ArrayBuffer. */
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

export interface ElementBatch {
  readonly items: ReadonlyArray<ElementSlice>;
  readonly byteLength: number;
}

export interface ElementSource {
  readonly containerRef: NodeRef;
  readonly containerKind: NodeKind;
  readonly total: number;
  /** Lists descriptors in [from, from + count), triggering bucket indexing if cut. */
  list(
    from: number,
    count: number,
    includeKeys: boolean,
  ): Promise<ReadonlyArray<ElementDescriptor>>;
  /** Reads document-logical bytes [start, end), guaranteed <= MAX_SLICE_BYTES. */
  readLogical(start: number, end: number): Promise<Uint8Array>;
}

export type ElementMapOutcome<T> =
  | {
      readonly ok: true;
      readonly index: number;
      readonly key: string | null;
      readonly byteLength: number;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly index: number;
      readonly key: string | null;
      readonly byteLength: number;
      readonly error: ElementMapItemError;
    };

export interface ElementMapOptions<T> {
  readonly batchBytes?: number | undefined;
  readonly maxBatchItems?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly includeKeys?: boolean | undefined;
  readonly from?: number | undefined;
  readonly limit?: number | undefined;
  readonly collectResults?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: ElementMapProgress) => void) | undefined;
  readonly onElementError?: ((error: ElementMapItemError) => void) | undefined;
  readonly onOrderedResult?: ((outcome: ElementMapOutcome<T>) => void | Promise<void>) | undefined;
}

export interface ElementMapResult<T> {
  readonly summary: ElementMapSummary;
  readonly results: ReadonlyArray<ElementMapOutcome<T>>;
  readonly errors: ReadonlyArray<ElementMapItemError>;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function elementTooLargeError(desc: ElementDescriptor, bytes: number): ElementMapItemError {
  const mib = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  const maxMib = Math.round((MAX_SLICE_BYTES / (1024 * 1024)) * 10) / 10;
  return {
    index: desc.index,
    key: desc.key,
    bytes,
    message: `Element ${desc.index} is ${mib} MiB, over the ${maxMib} MiB slice limit.`,
  };
}

class OrderedAssembler<T> {
  private nextIndex: number;
  private readonly pending = new Map<number, ElementMapOutcome<T>>();
  private emitChain: Promise<void> = Promise.resolve();
  private readonly collect: boolean;
  private readonly total: number;
  private readonly onProgress: ElementMapOptions<T>["onProgress"];
  private readonly onElementError: ElementMapOptions<T>["onElementError"];
  private readonly onOrderedResult: ElementMapOptions<T>["onOrderedResult"];
  readonly results: ElementMapOutcome<T>[] = [];
  readonly errors: ElementMapItemError[] = [];
  processed = 0;
  bytesRead = 0;

  constructor(startIndex: number, total: number, options: ElementMapOptions<T>) {
    this.nextIndex = startIndex;
    this.total = total;
    this.collect = options.collectResults ?? true;
    this.onProgress = options.onProgress;
    this.onElementError = options.onElementError;
    this.onOrderedResult = options.onOrderedResult;
  }

  push(outcome: ElementMapOutcome<T>, signal?: AbortSignal): void {
    this.pending.set(outcome.index, outcome);
    this.emitChain = this.emitChain.then(async () => {
      while (this.pending.has(this.nextIndex)) {
        if (signal?.aborted) break;
        const item = this.pending.get(this.nextIndex) as ElementMapOutcome<T>;
        this.pending.delete(this.nextIndex);
        this.nextIndex++;
        this.processed++;
        if (item.ok) {
          this.bytesRead += item.byteLength;
        } else {
          this.errors.push(item.error);
          this.onElementError?.(item.error);
        }
        if (this.collect) this.results.push(item);
        if (this.onOrderedResult !== undefined) await this.onOrderedResult(item);
        this.onProgress?.({
          processed: this.processed,
          total: this.total,
          errors: this.errors.length,
          bytesRead: this.bytesRead,
        });
      }
    });
  }

  async flush(): Promise<void> {
    await this.emitChain;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

async function runStream<T>(
  source: ElementSource,
  options: ElementMapOptions<T>,
  maxConcurrentBatches: number,
  dispatchBatch: (
    batch: ReadonlyArray<ElementDescriptor>,
    batchStart: number,
    batchEnd: number,
    signal: AbortSignal,
    assembler: OrderedAssembler<T>,
  ) => Promise<void>,
): Promise<ElementMapResult<T>> {
  if (source.containerKind !== "object" && source.containerKind !== "array") {
    throw new Error(
      `elementMap requires an object or array container, got ${source.containerKind}`,
    );
  }
  const startIndex = Math.max(0, Math.floor(options.from ?? 0));
  const maxItems =
    options.limit === undefined ? source.total : Math.max(0, Math.floor(options.limit));
  const endIndex = Math.min(source.total, startIndex + maxItems);
  const total = Math.max(0, endIndex - startIndex);
  if (total === 0) {
    return {
      summary: { total: 0, processed: 0, errors: 0, cancelled: Boolean(options.signal?.aborted) },
      results: [],
      errors: [],
    };
  }

  const batchBytes = clampPositiveInt(
    options.batchBytes,
    ELEMENT_MAP_DEFAULT_BATCH_BYTES,
    MAX_SLICE_BYTES,
  );
  const maxBatchItems = clampPositiveInt(
    options.maxBatchItems,
    ELEMENT_MAP_DEFAULT_MAX_BATCH_ITEMS,
    CHILDREN_PAGE_LIMIT,
  );
  const includeKeys = options.includeKeys ?? source.containerKind === "object";

  const controller = new AbortController();
  const externalSignal = options.signal;
  const onAbort = () => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  const assembler = new OrderedAssembler<T>(startIndex, total, options);
  const inFlightBatches = new Set<Promise<void>>();

  let pendingBatch: ElementDescriptor[] = [];
  let batchStart = 0;
  let batchEnd = 0;

  const flushBatch = async () => {
    if (pendingBatch.length === 0) return;
    const items = pendingBatch;
    const start = batchStart;
    const end = batchEnd;
    pendingBatch = [];
    batchStart = 0;
    batchEnd = 0;
    while (inFlightBatches.size >= maxConcurrentBatches && !controller.signal.aborted) {
      await Promise.race(inFlightBatches);
    }
    if (controller.signal.aborted) return;
    const task = dispatchBatch(items, start, end, controller.signal, assembler).finally(() => {
      inFlightBatches.delete(task);
    });
    inFlightBatches.add(task);
  };

  try {
    for (let cursor = startIndex; cursor < endIndex && !controller.signal.aborted;) {
      const pageCount = Math.min(CHILDREN_PAGE_LIMIT, endIndex - cursor);
      const descriptors = await source.list(cursor, pageCount, includeKeys);
      if (descriptors.length === 0) break;
      for (const desc of descriptors) {
        if (controller.signal.aborted) break;
        const size = Math.max(0, desc.end - desc.start);
        if (size > MAX_SLICE_BYTES) {
          await flushBatch();
          assembler.push(
            {
              ok: false,
              index: desc.index,
              key: desc.key,
              byteLength: size,
              error: elementTooLargeError(desc, size),
            },
            controller.signal,
          );
          continue;
        }
        if (pendingBatch.length > 0) {
          const nextStart = Math.min(batchStart, desc.start);
          const nextEnd = Math.max(batchEnd, desc.end);
          if (
            pendingBatch.length >= maxBatchItems ||
            desc.start < batchStart ||
            nextEnd - nextStart > batchBytes
          ) {
            await flushBatch();
          }
        }
        if (pendingBatch.length === 0) {
          batchStart = desc.start;
          batchEnd = desc.end;
        } else {
          batchStart = Math.min(batchStart, desc.start);
          batchEnd = Math.max(batchEnd, desc.end);
        }
        pendingBatch.push(desc);
      }
      cursor += descriptors.length;
    }
    if (!controller.signal.aborted) await flushBatch();
    await Promise.all(inFlightBatches);
    await assembler.flush();
  } finally {
    externalSignal?.removeEventListener("abort", onAbort);
  }

  return {
    summary: {
      total,
      processed: assembler.processed,
      errors: assembler.errors.length,
      cancelled: controller.signal.aborted,
    },
    results: assembler.results,
    errors: assembler.errors,
  };
}

/**
 * Streams a container's children in <= 64 MiB logical-read batches and fans out
 * element work across up to `concurrency` workers with deterministic in-order assembly.
 */
export function elementMap<T>(
  source: ElementSource,
  mapper: (element: ElementSlice, signal: AbortSignal) => Promise<T> | T,
  options: ElementMapOptions<T> = {},
): Promise<ElementMapResult<T>> {
  const concurrency = clampPositiveInt(options.concurrency, ELEMENT_MAP_DEFAULT_CONCURRENCY, 32);
  const semaphore = new Semaphore(concurrency);

  return runStream<T>(
    source,
    options,
    2,
    async (items, batchStart, batchEnd, signal, assembler) => {
      if (signal.aborted) return;
      const buffer =
        batchEnd > batchStart ? await source.readLogical(batchStart, batchEnd) : new Uint8Array(0);
      const tasks: Promise<void>[] = [];
      for (const desc of items) {
        if (signal.aborted) break;
        await semaphore.acquire();
        if (signal.aborted) {
          semaphore.release();
          break;
        }
        const bytes = buffer.subarray(desc.start - batchStart, desc.end - batchStart);
        const slice: ElementSlice = {
          index: desc.index,
          ref: desc.ref,
          kind: desc.kind,
          key: desc.key,
          bytes,
          byteLength: bytes.byteLength,
        };
        const task = Promise.resolve()
          .then(() => mapper(slice, signal))
          .then(
            (value) => {
              assembler.push(
                { ok: true, index: desc.index, key: desc.key, byteLength: slice.byteLength, value },
                signal,
              );
            },
            (error: unknown) => {
              assembler.push(
                {
                  ok: false,
                  index: desc.index,
                  key: desc.key,
                  byteLength: slice.byteLength,
                  error: {
                    index: desc.index,
                    key: desc.key,
                    bytes: slice.byteLength,
                    message: formatError(error),
                  },
                },
                signal,
              );
            },
          )
          .finally(() => semaphore.release());
        tasks.push(task);
      }
      await Promise.all(tasks);
    },
  );
}

/**
 * Streams a container's children in <= 64 MiB logical-read batches, passing each
 * batch to `mapper` and reassembling per-element results in deterministic order.
 */
export function elementBatchMap<T>(
  source: ElementSource,
  mapper: (
    batch: ElementBatch,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<T>> | ReadonlyArray<T>,
  options: ElementMapOptions<T> = {},
): Promise<ElementMapResult<T>> {
  const concurrency = clampPositiveInt(options.concurrency, ELEMENT_MAP_DEFAULT_CONCURRENCY, 32);
  const semaphore = new Semaphore(concurrency);

  return runStream<T>(
    source,
    options,
    concurrency,
    async (items, batchStart, batchEnd, signal, assembler) => {
      if (signal.aborted) return;
      await semaphore.acquire();
      try {
        if (signal.aborted) return;
        const buffer =
          batchEnd > batchStart
            ? await source.readLogical(batchStart, batchEnd)
            : new Uint8Array(0);
        const slices: ElementSlice[] = items.map((desc) => {
          const bytes = buffer.subarray(desc.start - batchStart, desc.end - batchStart);
          return {
            index: desc.index,
            ref: desc.ref,
            kind: desc.kind,
            key: desc.key,
            bytes,
            byteLength: bytes.byteLength,
          };
        });
        const batch: ElementBatch = { items: slices, byteLength: buffer.byteLength };
        try {
          const values = await mapper(batch, signal);
          if (values.length !== slices.length) {
            throw new Error(
              `Batch mapper returned ${values.length} results for ${slices.length} elements.`,
            );
          }
          for (let i = 0; i < slices.length; i++) {
            const slice = slices[i] as ElementSlice;
            assembler.push(
              {
                ok: true,
                index: slice.index,
                key: slice.key,
                byteLength: slice.byteLength,
                value: values[i] as T,
              },
              signal,
            );
          }
        } catch (error) {
          const message = formatError(error);
          for (const slice of slices) {
            assembler.push(
              {
                ok: false,
                index: slice.index,
                key: slice.key,
                byteLength: slice.byteLength,
                error: { index: slice.index, key: slice.key, bytes: slice.byteLength, message },
              },
              signal,
            );
          }
        }
      } finally {
        semaphore.release();
      }
    },
  );
}
