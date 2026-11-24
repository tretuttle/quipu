import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { createJobRunner } from "./jobs.ts";
import { createLocalPool } from "./localPool.ts";
import { Pool, type WorkerLike } from "./pool.ts";
import type { Reply, Request } from "./protocol.ts";
import {
  type ChunkOptions,
  DEFAULT_CHUNK_OPTIONS,
  type SearchSpec,
  searchChunk,
  safeBoundary,
} from "./search.ts";
import { runSearch, type SearchOutcome } from "./searchRun.ts";
import { openSource } from "./source.ts";
import { createPrng, type Prng } from "./testing/samples.ts";

const encoder = new TextEncoder();

// A reference implementation: the text the user sees, built character by character
// from a JS string, searched with plain string code, mapped back to bytes.

interface Seen {
  readonly view: string;
  /** For each UTF-16 unit of `view`: the raw UTF-16 range it came from. */
  readonly from: ReadonlyArray<number>;
  readonly to: ReadonlyArray<number>;
}

const seen = (raw: string, decode: boolean): Seen => {
  let view = "";
  const from: number[] = [];
  const to: number[] = [];
  const simple: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  for (let i = 0; i < raw.length;) {
    const c = raw[i] as string;
    if (decode && c === "\\") {
      const e = raw[i + 1] as string;
      if (e === "u") {
        const unit = String.fromCharCode(Number.parseInt(raw.slice(i + 2, i + 6), 16));
        view += unit;
        from.push(i);
        to.push(i + 6);
        i += 6;
      } else {
        view += simple[e] ?? e;
        from.push(i);
        to.push(i + 2);
        i += 2;
      }
    } else {
      view += c;
      from.push(i);
      to.push(i + 1);
      i += 1;
    }
  }
  return { view, from, to };
};

const byteOffset = (raw: string, unit: number) => encoder.encode(raw.slice(0, unit)).length;

/** Sequential non-overlapping leftmost matches of `find` over the seen text, as byte ranges of the raw file. */
const referenceHits = (
  raw: string,
  decode: boolean,
  matches: (view: string) => Array<readonly [number, number]>,
) => {
  const s = seen(raw, decode);
  return matches(s.view).map(([a, b]) => ({
    start: byteOffset(raw, s.from[a] as number),
    end: byteOffset(raw, s.to[b - 1] as number),
  }));
};

const literalMatches =
  (needle: string, caseSensitive: boolean) =>
  (view: string): Array<readonly [number, number]> => {
    const fold = (text: string) =>
      caseSensitive ? text : text.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const hay = fold(view);
    const n = fold(needle);
    const out: Array<readonly [number, number]> = [];
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) {
      out.push([i, i + n.length]);
    }
    return out;
  };

const regexMatches =
  (source: string, flags: string) =>
  (view: string): Array<readonly [number, number]> =>
    [...view.matchAll(new RegExp(source, `${flags}gm`))]
      .filter((m) => m[0].length > 0)
      .map((m) => [m.index, m.index + m[0].length] as const);

// Documents: JSON text with every escape form, written by a different path than
// the engine reads it.

const ATOMS = ["a", "b", "c", "A", "é", "漢", "😀", '"', "\\", "\n", "/", " ", "ab", "needle", "x"];

const randomText = (prng: Prng, max = 6) => {
  let text = "";
  for (let i = prng.int(max + 1); i > 0; i--) text += prng.pick(ATOMS);
  return text;
};

/** A JSON string literal for `text`, escaping at random where the grammar allows. */
const jsonString = (prng: Prng, text: string) => {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const asUnits = () => {
      if (code > 0xffff) {
        const v = code - 0x10000;
        const unit = (n: number) =>
          `\\u${n.toString(16).padStart(4, prng.chance(0.5) ? "0" : "0")}`;
        return unit(0xd800 + (v >> 10)) + unit(0xdc00 + (v & 0x3ff));
      }
      return `\\u${code.toString(16).padStart(4, "0")}`;
    };
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += prng.chance(0.5) ? "\\n" : asUnits();
    else if (ch === "/") out += prng.chance(0.4) ? "\\/" : "/";
    else if (code >= 0x80 && prng.chance(0.5)) out += asUnits();
    else out += ch;
  }
  return `${out}"`;
};

const randomJson = (prng: Prng, depth: number): string => {
  const space = () => (prng.chance(0.2) ? prng.pick([" ", "\n", "\t"]) : "");
  const pick = prng.int(depth > 2 ? 4 : 6);
  switch (pick) {
    case 0:
      return "null";
    case 1:
      return String(prng.range(-5, 100));
    case 2:
      return prng.chance(0.5) ? "true" : "false";
    case 3:
      return jsonString(prng, randomText(prng));
    case 4: {
      const items = Array.from(
        { length: prng.int(4) },
        () => space() + randomJson(prng, depth + 1),
      );
      return `[${items.join(",")}${space()}]`;
    }
    default: {
      const members = Array.from(
        { length: prng.int(4) },
        () =>
          `${space()}${jsonString(prng, randomText(prng, 3))}${space()}:${space()}${randomJson(prng, depth + 1)}`,
      );
      return `{${members.join(",")}${space()}}`;
    }
  }
};

/** A document whose string values sometimes hold a whole stringified document. */
const randomDocument = (prng: Prng) => {
  const inner = randomJson(prng, 1);
  const wrapped = `{"body":${jsonString(prng, inner)},"rest":${randomJson(prng, 0)}}`;
  return prng.chance(0.5) ? wrapped : randomJson(prng, 0);
};

const openPool = async (bytes: Uint8Array, workers = 2) => {
  const pool = createLocalPool(workers);
  const copy = bytes.slice();
  await pool.broadcast({
    type: "open",
    sourceId: 1,
    spec: { kind: "memory", buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength },
  });
  return pool;
};

interface Setup {
  readonly chunkBytes: number;
  readonly chunk: Partial<ChunkOptions>;
}

const find = async (
  raw: string,
  decode: boolean,
  spec: SearchSpec,
  setup: Setup,
  workers = 2,
): Promise<{ outcome: SearchOutcome; ranges: Array<{ start: number; end: number }> }> => {
  const bytes = encoder.encode(raw);
  const pool = await openPool(bytes, workers);
  try {
    const outcome = await runSearch(pool, { sourceId: 1, size: bytes.length, decode }, spec, {
      chunkBytes: setup.chunkBytes,
      chunk: { ...DEFAULT_CHUNK_OPTIONS, ...setup.chunk },
      budgetMs: null,
      maxSkipped: 8,
      maxRetained: 1_000_000,
      isCancelled: () => false,
    });
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < outcome.hits.length; i += 2) {
      ranges.push({ start: outcome.hits[i] as number, end: outcome.hits[i + 1] as number });
    }
    return { outcome, ranges };
  } finally {
    await pool.terminate();
  }
};

const SeedInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const seeds = Arbitrary.schema(SeedInt);

const setupOf = (prng: Prng, lookView: number): Setup => ({
  chunkBytes: prng.range(1, 70),
  chunk: { blockBytes: prng.range(1, 45), lookView, maxHits: 100_000 },
});

const PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ["a+", ""],
  ['"[abc]+"', "i"],
  ["b.c", ""],
  ["^a", ""],
  ["x$", ""],
  ["\\b[abc]+\\b", ""],
  ["(ab|b)c?", ""],
  ["é+", "u"],
  ["[\\u4e00-\\u9fff]", "u"],
  ["\\n.", "u"],
  ["[😀a]+", "u"],
  ["\\\\.", ""],
];

describe("literal search over the text the user sees", () => {
  it.live.prop(
    "reports exactly the non-overlapping hits an independent reader of the text finds, wherever the chunk and block edges fall",
    [seeds, seeds],
    ([documentSeed, setupSeed]) =>
      Effect.promise(async () => {
        const prng = createPrng(documentSeed);
        const raw = randomDocument(prng);
        const decode = prng.chance(0.85);
        const text = raw;
        const view = seen(text, decode).view;
        const setupPrng = createPrng(setupSeed);
        // Needles come from the text itself, or from the atoms, so most of them hit.
        const needle =
          view.length > 0 && setupPrng.chance(0.7)
            ? Array.from(view)
                .slice(setupPrng.int(Array.from(view).length))
                .slice(0, setupPrng.range(1, 4))
                .join("")
            : setupPrng.pick(ATOMS) + setupPrng.pick(ATOMS);
        if (needle.length === 0) return;
        const caseSensitive = setupPrng.chance(0.5);
        const { outcome, ranges } = await find(
          text,
          decode,
          { kind: "literal", needle: encoder.encode(needle), caseSensitive },
          setupOf(setupPrng, 8),
          setupPrng.range(1, 3),
        );
        const expected = referenceHits(text, decode, literalMatches(needle, caseSensitive));
        expect(ranges).toEqual(expected);
        expect(outcome.count).toBe(expected.length);
      }),
    { arbitrary: { runs: 300 } },
  );

  it("finds a hit that straddles every chunk edge exactly once", async () => {
    const text = '{"k":"a needle here","j":"needle needle"}';
    const expected = referenceHits(text, true, literalMatches("needle", true));
    expect(expected).toHaveLength(3);
    for (let chunkBytes = 1; chunkBytes <= text.length; chunkBytes++) {
      const { ranges } = await find(
        text,
        true,
        { kind: "literal", needle: encoder.encode("needle"), caseSensitive: true },
        { chunkBytes, chunk: { blockBytes: 7 } },
      );
      expect(ranges, `chunk ${chunkBytes}`).toEqual(expected);
    }
  });

  it("matches an escape as the character it stands for, whatever cuts it", async () => {
    // é as é, the astral 😀 as a surrogate pair, a quote and a newline escaped.
    const text = '{"k":"caf\\u00e9 \\ud83d\\ude00 \\"q\\" l1\\nl2","caf\\u00e9":1}';
    const checks: Array<readonly [string, number]> = [
      ["café", 2],
      ["😀", 1],
      ['"q"', 1],
      ["l1\nl2", 1],
      ["\\", 0],
    ];
    for (const [needle, hits] of checks) {
      const expected = referenceHits(text, true, literalMatches(needle, true));
      expect(expected, needle).toHaveLength(hits);
      for (let chunkBytes = 1; chunkBytes <= text.length; chunkBytes += 1) {
        const { ranges } = await find(
          text,
          true,
          { kind: "literal", needle: encoder.encode(needle), caseSensitive: true },
          { chunkBytes, chunk: { blockBytes: 5 } },
        );
        expect(ranges, `${needle} @ ${chunkBytes}`).toEqual(expected);
      }
    }
    // A hit covers the whole escape sequence: the `é`, not one byte of it.
    const { ranges } = await find(
      '"caf\\u00e9"',
      true,
      { kind: "literal", needle: encoder.encode("é"), caseSensitive: true },
      { chunkBytes: 4, chunk: {} },
    );
    expect(ranges).toEqual([{ start: 4, end: 10 }]);
  });

  it("matches a stringified document as the text of the string that holds it", async () => {
    const inner = JSON.stringify({ error: "nope", n: 1 });
    const text = JSON.stringify({ body: inner, error: "outer" });
    // In the file the inner quotes are \" ; the user sees "error": in the string.
    expect(text).toContain('\\"error\\"');
    const { ranges } = await find(
      text,
      true,
      { kind: "literal", needle: encoder.encode('"error":'), caseSensitive: true },
      { chunkBytes: 1000, chunk: {} },
    );
    expect(ranges).toHaveLength(2);
    const raw = text.slice(ranges[0]?.start, ranges[0]?.end);
    expect(raw).toBe('\\"error\\":');
  });

  it("counts every hit but keeps only as many as it was told to", async () => {
    const text = "a,".repeat(500);
    const { outcome } = await find(
      text,
      false,
      { kind: "literal", needle: encoder.encode("a"), caseSensitive: true },
      { chunkBytes: 64, chunk: { maxHits: 10 } },
    );
    expect(outcome.count).toBe(500);
    expect(outcome.hits.length / 2).toBe(10);
    // Every retained hit starts before the point past which nothing is retained.
    expect(outcome.retainedUntil).toBe(outcome.hits[19]);
  });

  it("does not decode escapes in a text document", async () => {
    const { ranges } = await find(
      "line\\nbreak \\u00e9",
      false,
      { kind: "literal", needle: encoder.encode("\\n"), caseSensitive: true },
      { chunkBytes: 5, chunk: {} },
    );
    expect(ranges).toEqual([{ start: 4, end: 6 }]);
  });
});

describe("regular expression search", () => {
  it.live.prop(
    "reports what one sequential scan of the text reports, wherever chunk and block edges fall",
    [seeds, seeds],
    ([documentSeed, setupSeed]) =>
      Effect.promise(async () => {
        const prng = createPrng(documentSeed);
        const raw = randomDocument(prng);
        const setupPrng = createPrng(setupSeed);
        const [source, flags] = setupPrng.pick(PATTERNS);
        const decode = setupPrng.chance(0.85);
        const text = raw;
        const withU = flags.includes("u") ? flags : `${flags}u`;
        const { outcome, ranges } = await find(
          text,
          decode,
          { kind: "regex", source, flags: withU },
          setupOf(setupPrng, 600),
          setupPrng.range(1, 3),
        );
        const expected = referenceHits(text, decode, regexMatches(source, withU));
        expect(ranges).toEqual(expected);
        expect(outcome.count).toBe(expected.length);
        expect(outcome.limited).toBe(0);
      }),
    { arbitrary: { runs: 300 } },
  );

  it("repairs a chunk after a match that ran into it", async () => {
    // Five a's with an edge after every byte: the hits are [0,2), [2,4) and nothing for the last.
    const spec: SearchSpec = { kind: "regex", source: "aa", flags: "" };
    for (let chunkBytes = 1; chunkBytes <= 5; chunkBytes++) {
      const { ranges } = await find("aaaaa", false, spec, { chunkBytes, chunk: { blockBytes: 2 } });
      expect(ranges, `chunk ${chunkBytes}`).toEqual([
        { start: 0, end: 2 },
        { start: 2, end: 4 },
      ]);
    }
  });

  it("lets a match start in one chunk and end in another", async () => {
    const text = `${"x".repeat(30)}start...middle...end${"y".repeat(30)}`;
    const { ranges } = await find(
      text,
      false,
      { kind: "regex", source: "start.*end", flags: "" },
      { chunkBytes: 16, chunk: { blockBytes: 8 } },
    );
    expect(ranges).toEqual([{ start: 30, end: 30 + "start...middle...end".length }]);
  });

  it("sees line starts and word edges across a block edge", async () => {
    const text = "one\ntwo words\nthree";
    const spec: SearchSpec = { kind: "regex", source: "^t\\w+", flags: "" };
    for (let blockBytes = 1; blockBytes <= text.length; blockBytes++) {
      const { ranges } = await find(text, false, spec, { chunkBytes: 100, chunk: { blockBytes } });
      expect(ranges, `block ${blockBytes}`).toEqual([
        { start: 4, end: 7 },
        { start: 14, end: 19 },
      ]);
    }
  });

  it("never splits a multi-byte character at a chunk or block edge", async () => {
    const text = "漢字 and 😀😀 and é";
    const spec: SearchSpec = { kind: "regex", source: "[^ ]+", flags: "u" };
    const expected = referenceHits(text, false, regexMatches("[^ ]+", "u"));
    for (let chunkBytes = 1; chunkBytes <= 20; chunkBytes++) {
      const { ranges } = await find(text, false, spec, { chunkBytes, chunk: { blockBytes: 3 } });
      expect(ranges, `chunk ${chunkBytes}`).toEqual(expected);
    }
  });

  it("counts a match cut by a lookahead that is too short", async () => {
    const text = `${"a".repeat(40)}`;
    const { outcome, ranges } = await find(
      text,
      false,
      { kind: "regex", source: "a+", flags: "" },
      { chunkBytes: 100, chunk: { blockBytes: 10, lookView: 4 } },
    );
    expect(outcome.limited).toBeGreaterThan(0);
    expect(ranges.length).toBeGreaterThan(1);
  });

  it("skips a chunk that overruns its budget and carries on with a fresh worker", async () => {
    const bytes = encoder.encode("aaaa.bbbb.cccc.dddd.");
    const timers: Array<() => void> = [];
    const makeWorker = (): WorkerLike => {
      const run = createJobRunner({ openSource });
      let handler: ((reply: Reply) => void) | undefined;
      let queue = Promise.resolve();
      return {
        postMessage: (message: Request) => {
          queue = queue.then(async () => {
            const job = message.job;
            // The worker hangs on the chunk that holds "bbbb": the budget timer fires.
            if (job.type === "search" && job.start === 5) {
              for (const fire of timers.splice(0)) fire();
              return;
            }
            const outcome = await run(job);
            handler?.({ id: message.id, ok: true, result: outcome.result });
          });
        },
        onMessage: (h) => {
          handler = h;
        },
        terminate: () => {},
      };
    };
    const pool = new Pool([makeWorker()], {
      spawn: makeWorker,
      timer: (_ms, fire) => {
        timers.push(fire);
        return () => {
          const at = timers.indexOf(fire);
          if (at >= 0) timers.splice(at, 1);
        };
      },
    });
    const copy = bytes.slice();
    await pool.broadcast({
      type: "open",
      sourceId: 1,
      spec: { kind: "memory", buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength },
    });
    const outcome = await runSearch(
      pool,
      { sourceId: 1, size: bytes.length, decode: false },
      { kind: "regex", source: "[a-d]+", flags: "" },
      {
        chunkBytes: 5,
        chunk: { ...DEFAULT_CHUNK_OPTIONS, blockBytes: 5 },
        budgetMs: 50,
        maxSkipped: 4,
        maxRetained: 100,
        isCancelled: () => false,
      },
    );
    expect(outcome.status).toBe("complete");
    expect(outcome.skipped).toEqual([{ start: 5, end: 10 }]);
    // The chunks before and after the stuck one were searched by the replacement worker.
    expect([...outcome.hits]).toEqual([0, 4, 10, 14, 15, 19]);
  });

  it("gives up after too many chunks overran", async () => {
    const bytes = encoder.encode("x".repeat(40));
    const timers: Array<() => void> = [];
    const makeWorker = (): WorkerLike => ({
      postMessage: () => {
        for (const fire of timers.splice(0)) fire();
      },
      onMessage: () => {},
      terminate: () => {},
    });
    const pool = new Pool([makeWorker()], {
      spawn: makeWorker,
      timer: (_ms, fire) => {
        timers.push(fire);
        return () => {};
      },
    });
    const outcome = await runSearch(
      pool,
      { sourceId: 1, size: bytes.length, decode: false },
      { kind: "regex", source: "x", flags: "" },
      {
        chunkBytes: 4,
        chunk: DEFAULT_CHUNK_OPTIONS,
        budgetMs: 50,
        maxSkipped: 3,
        maxRetained: 100,
        isCancelled: () => false,
      },
    );
    expect(outcome.status).toBe("partial");
    expect(outcome.skipped).toHaveLength(3);
    expect(outcome.count).toBe(0);
  });
});

describe("chunk edges", () => {
  const read = (bytes: Uint8Array) => (start: number, end: number) =>
    Promise.resolve(bytes.subarray(start, end));

  it("moves an edge out of an escape, a surrogate pair's digits and a code point", async () => {
    const text = encoder.encode('"a\\u00e9\\\\ \\ud83d\\ude00 é😀"');
    const edges: number[] = [];
    for (let at = 0; at <= text.length; at++) {
      edges.push(await safeBoundary(read(text), text.length, at, true));
    }
    // Never inside \uXXXX, never right after a backslash, never inside a code point.
    for (const edge of edges) {
      const before = new TextDecoder().decode(text.subarray(0, edge));
      expect(before.endsWith("\\")).toBe(false);
      expect(/\\u[0-9a-fA-F]{0,3}$/.test(before)).toBe(false);
      if (edge < text.length) expect((text[edge] as number) & 0xc0).not.toBe(0x80);
    }
    expect(edges).toEqual([...edges].sort((a, b) => a - b));
  });

  it("gives the rest of the file to the chunk before when no edge exists", async () => {
    // Nothing but hex digits: no byte in it follows a byte that makes an edge safe.
    const text = new Uint8Array(100).fill(0x61);
    expect(await safeBoundary(read(text), text.length, 10, true)).toBe(text.length);
  });

  it("finds the same chunks whichever worker runs them", async () => {
    const bytes = encoder.encode('{"a":"\\u00e9","b":"é"}');
    const a = await searchChunk(read(bytes), bytes.length, 0, 11, true, {
      kind: "literal",
      needle: encoder.encode("é"),
      caseSensitive: true,
    });
    const b = await searchChunk(read(bytes), bytes.length, 11, bytes.length, true, {
      kind: "literal",
      needle: encoder.encode("é"),
      caseSensitive: true,
    });
    expect(a.end).toBe(b.start);
    expect(a.count + b.count).toBe(2);
  });
});
