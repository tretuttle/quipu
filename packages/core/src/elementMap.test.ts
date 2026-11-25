import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";

import {
  elementBatchMap,
  elementMap,
  type ElementDescriptor,
  type ElementSource,
} from "./elementMap.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function yieldMicrotasks(turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function makeArraySource(
  items: ReadonlyArray<string>,
  extraBytesAt?: ReadonlyMap<number, number>,
): ElementSource {
  const spans: Array<{ start: number; end: number; byteLength: number }> = [];
  const chunks: Uint8Array[] = [];
  let offset = 1;
  chunks.push(encoder.encode("["));
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      chunks.push(encoder.encode(","));
      offset += 1;
    }
    const raw = encoder.encode(items[i] as string);
    const virtualLen = extraBytesAt?.get(i) ?? raw.byteLength;
    spans.push({ start: offset, end: offset + virtualLen, byteLength: virtualLen });
    chunks.push(raw);
    offset += virtualLen;
  }
  chunks.push(encoder.encode("]"));
  const full = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
  let pos = 0;
  for (const c of chunks) {
    full.set(c, pos);
    pos += c.byteLength;
  }

  return {
    containerRef: { documentId: 1, tapeId: 0, token: 0 },
    containerKind: "array",
    total: items.length,
    async list(from, count): Promise<ReadonlyArray<ElementDescriptor>> {
      const end = Math.min(items.length, from + count);
      const out: ElementDescriptor[] = [];
      for (let i = from; i < end; i++) {
        const s = spans[i]!;
        out.push({
          index: i,
          ref: { documentId: 1, tapeId: 1, token: i + 1 },
          kind: "object",
          key: null,
          start: s.start,
          end: s.end,
        });
      }
      return out;
    },
    async readLogical(start, end) {
      expect(end - start).toBeLessThanOrEqual(MAX_SLICE_BYTES);
      const out = new Uint8Array(end - start);
      let realAt = 1;
      for (let i = 0; i < items.length; i++) {
        const raw = encoder.encode(items[i] as string);
        if (i > 0) realAt += 1;
        const span = spans[i]!;
        if (!extraBytesAt?.has(i)) {
          const overlapStart = Math.max(start, span.start);
          const overlapEnd = Math.min(end, span.end);
          if (overlapEnd > overlapStart) {
            out.set(
              full.subarray(
                realAt + (overlapStart - span.start),
                realAt + (overlapEnd - span.start),
              ),
              overlapStart - start,
            );
          }
        }
        realAt += raw.byteLength;
      }
      return out;
    },
  };
}

describe("elementMap", () => {
  it("streams elements in bounded batches and reassembles results in deterministic order", async () => {
    const items = Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: i, v: `item-${i}` }));
    const source = makeArraySource(items);
    const seenOrder: number[] = [];
    const progressTotals: number[] = [];

    const result = await elementMap(
      source,
      async (el) => {
        // Invert completion timing so faster later elements finish before earlier ones.
        await yieldMicrotasks((20 - el.index) * 2);
        return `${el.index}:${decoder.decode(el.bytes)}`;
      },
      {
        batchBytes: 64,
        concurrency: 4,
        onOrderedResult: (outcome) => {
          seenOrder.push(outcome.index);
        },
        onProgress: (p) => progressTotals.push(p.processed),
      },
    );

    expect(result.summary).toEqual({ total: 20, processed: 20, errors: 0, cancelled: false });
    expect(seenOrder).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(progressTotals[progressTotals.length - 1]).toBe(20);
    expect(result.results.map((r) => (r.ok ? r.value : null))).toEqual(
      items.map((item, i) => `${i}:${item}`),
    );
  });

  it("isolates elements over MAX_SLICE_BYTES and per-element mapper errors without aborting", async () => {
    const items = ['{"ok":0}', '{"oversized":1}', '{"fail":2}', '{"ok":3}'];
    const source = makeArraySource(items, new Map([[1, MAX_SLICE_BYTES + 512]]));
    const readCalls: Array<readonly [number, number]> = [];
    const trackedSource: ElementSource = {
      ...source,
      readLogical(start, end) {
        readCalls.push([start, end]);
        return source.readLogical(start, end);
      },
    };

    const result = await elementMap(
      trackedSource,
      (el) => {
        if (el.index === 2) throw new Error("bad element 2");
        return decoder.decode(el.bytes);
      },
      { batchBytes: 1024, concurrency: 2 },
    );

    expect(result.summary).toEqual({ total: 4, processed: 4, errors: 2, cancelled: false });
    expect(result.results[0]).toMatchObject({ ok: true, index: 0, value: '{"ok":0}' });
    expect(result.results[1]).toMatchObject({ ok: false, index: 1 });
    expect(result.results[2]).toMatchObject({
      ok: false,
      index: 2,
      error: { index: 2, message: "bad element 2" },
    });
    expect(result.results[3]).toMatchObject({ ok: true, index: 3, value: '{"ok":3}' });
    expect(result.errors.map((e) => e.index)).toEqual([1, 2]);
    // Oversized element was never read via readLogical.
    for (const [start, end] of readCalls) {
      expect(end - start).toBeLessThanOrEqual(MAX_SLICE_BYTES);
    }
  });

  it("supports cancellation via AbortSignal and collectResults: false streaming", async () => {
    const items = Array.from({ length: 30 }, (_, i) => `{"id":${i}}`);
    const source = makeArraySource(items);
    const controller = new AbortController();
    const collected: number[] = [];

    const result = await elementMap(source, (el) => el.index, {
      batchBytes: 32,
      concurrency: 2,
      collectResults: false,
      signal: controller.signal,
      onOrderedResult: (outcome) => {
        collected.push(outcome.index);
        if (outcome.index >= 4) controller.abort();
      },
    });

    expect(result.summary.cancelled).toBe(true);
    expect(result.results).toEqual([]);
    expect(collected).toEqual([0, 1, 2, 3, 4]);
  });

  it("supports elementBatchMap for batch-oriented workers", async () => {
    const items = ['{"a":1}', '{"a":2}', '{"a":3}', '{"a":4}', '{"a":5}'];
    const source = makeArraySource(items);
    const batchSizes: number[] = [];

    const result = await elementBatchMap(
      source,
      (batch) => {
        batchSizes.push(batch.items.length);
        return batch.items.map((el) => `${el.index}:${decoder.decode(el.bytes)}`);
      },
      { batchBytes: 20, concurrency: 2 },
    );

    expect(batchSizes.length).toBeGreaterThan(1);
    expect(result.summary).toEqual({ total: 5, processed: 5, errors: 0, cancelled: false });
    expect(result.results.map((r) => (r.ok ? r.value : null))).toEqual(
      items.map((item, i) => `${i}:${item}`),
    );
  });
});
