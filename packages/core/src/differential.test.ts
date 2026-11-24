import { describe, expect, it } from "@effect/vitest";

import { indexBytes } from "./indexBuffer.ts";
import { indexDocument } from "./indexDocument.ts";
import { createLocalPool } from "./localPool.ts";
import { FULL_DEPTH } from "./scan.ts";
import { SegmentedTape } from "./segmentedTape.ts";
import { createPrng, deepSample, harSample, wideSample } from "./testing/samples.ts";
import { tapeDepth, walkAgainst } from "./testing/walk.ts";
import { readJson } from "./testing/readJson.ts";

const MiB = 1024 * 1024;

interface Case {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** [chunk size, eager depth] pairs. */
  readonly runs: ReadonlyArray<readonly [number, number]>;
}

/** Every tape-derived node equals the reference reader's value, with boundaries inside every kind of token. */
const differential = ({ name, bytes, runs }: Case) => {
  const expected = readJson(bytes);
  let nodes = 0;
  for (const [chunkBytes, maxDepth] of runs) {
    const { tape } = indexBytes(bytes, 0, { maxDepth, chunkBytes });
    const stats = walkAgainst(tape, bytes, expected, { maxDepth, chunkBytes, nested: true });
    expect(stats.nodes, `${name} chunk=${chunkBytes} depth=${maxDepth}`).toBeGreaterThan(0);
    nodes += stats.nodes;
  }
  return nodes;
};

const EVERY_DEPTH = [0, 1, 2, 4, FULL_DEPTH];
const matrix = (chunks: ReadonlyArray<number>, depths: ReadonlyArray<number>) =>
  chunks.flatMap((chunk) => depths.map((depth) => [chunk, depth] as const));

describe("differential against a reference JSON reader", () => {
  it("agrees on a 1 MiB HAR with nested stringified bodies, at tiny chunks and every eager depth", () => {
    const bytes = harSample(createPrng(1), {
      targetBytes: MiB,
      nestedBodyBytes: [16 * 1024, 64 * 1024],
      bigBodyChars: 128 * 1024,
    });
    expect(bytes.byteLength).toBeGreaterThanOrEqual(MiB);
    // Boundaries inside every token and escape at 1–13 bytes; the full depth matrix at larger chunks.
    const nodes = differential({
      name: "har-1m",
      bytes,
      runs: [
        [1, FULL_DEPTH],
        [2, 0],
        [3, 2],
        [5, 4],
        [7, FULL_DEPTH],
        [13, 1],
        ...matrix([64, 1000, 65_536], EVERY_DEPTH),
      ],
    });
    expect(nodes).toBeGreaterThan(100_000);
  }, 300_000);

  it("agrees on a wide array", () => {
    const bytes = wideSample(createPrng(2), 10_000);
    const nodes = differential({
      name: "wide",
      bytes,
      runs: [[1, 1], [3, FULL_DEPTH], ...matrix([17, 4096], [0, 1, 2, FULL_DEPTH])],
    });
    expect(nodes).toBeGreaterThan(100_000);
  }, 300_000);

  it("agrees on 100 k levels of nesting without recursing, down to 1-byte chunks", () => {
    const bytes = deepSample(100_000, 8);
    const expected = readJson(bytes);
    for (const chunkBytes of [1, 7, 65_536]) {
      const { tape } = indexBytes(bytes, 0, { maxDepth: FULL_DEPTH, chunkBytes });
      expect(tape.count).toBe(200_001);
      expect(tapeDepth(tape)).toBe(99_999);
      walkAgainst(tape, bytes, expected, { maxDepth: FULL_DEPTH, chunkBytes, nested: false });
    }
  }, 300_000);

  it("agrees on a 50 MiB HAR, single-threaded and through the region pipeline", async () => {
    const bytes = harSample(createPrng(3), {
      targetBytes: 50 * MiB,
      nestedBodyBytes: [256 * 1024, MiB, 2 * MiB],
      bigBodyChars: 4 * MiB,
    });
    expect(bytes.byteLength).toBeGreaterThanOrEqual(50 * MiB);
    const expected = readJson(bytes);
    for (const [chunkBytes, maxDepth] of [
      [4 * MiB, FULL_DEPTH],
      [777_777, 4],
    ] as const) {
      const { tape } = indexBytes(bytes, 0, { maxDepth, chunkBytes });
      const stats = walkAgainst(tape, bytes, expected, { maxDepth, chunkBytes, nested: true });
      expect(stats.nodes).toBeGreaterThan(1_000_000);
      expect(stats.nestedDocuments).toBeGreaterThanOrEqual(3);
    }
    const pool = createLocalPool(16);
    try {
      await pool.broadcast({
        type: "open",
        sourceId: 1,
        spec: {
          kind: "memory",
          buffer: bytes.buffer,
          byteOffset: bytes.byteOffset,
          byteLength: bytes.byteLength,
        },
      });
      const stats = await indexDocument(pool, 1, bytes.byteLength, {
        target: new SegmentedTape(),
        regionBytes: 8 * MiB,
      });
      expect(stats.regions).toBe(Math.ceil(bytes.byteLength / (8 * MiB)));
      expect(stats.maxDepth).toBe(FULL_DEPTH);
      expect(stats.tape.segmentCount).toBe(stats.regions);
      const walked = walkAgainst(stats.tape, bytes, expected, {
        maxDepth: FULL_DEPTH,
        chunkBytes: 8 * MiB,
        nested: true,
      });
      expect(walked.nodes).toBeGreaterThan(1_000_000);
      // The big strings the skip list found are the base64 body and the nested bodies.
      const big = stats.bigStrings;
      expect(big.length / 2).toBeGreaterThanOrEqual(4);
      const lengths = Array.from(
        { length: big.length / 2 },
        (_, i) => (big[2 * i + 1] as number) - (big[2 * i] as number),
      );
      expect(lengths).toContain(4 * MiB + 2);
    } finally {
      await pool.terminate();
    }
  }, 300_000);
});
