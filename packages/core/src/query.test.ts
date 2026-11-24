import {
  InvalidPathError,
  InvalidSearchPatternError,
  JqSubtreeTooLargeError,
  MAX_SLICE_BYTES,
  SearchNotFoundError,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost, type HostOptions, type HostPlatform } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { parsePath, type Selector } from "./pathParse.ts";
import { createPrng, type Prng } from "./testing/samples.ts";
import { readJson } from "./testing/readJson.ts";

const encoder = new TextEncoder();

const platformFor = (extra: Partial<HostPlatform> = {}): HostPlatform => ({
  workers: 3,
  crossOriginIsolated: true,
  createPool: createLocalPool,
  ...extra,
});

const openText = async (
  text: string,
  options: HostOptions = {},
  extra: Partial<HostPlatform> = {},
) => {
  const host = new EngineHost(platformFor(extra), options);
  const info = await host.handle({ _tag: "open", source: new Blob([text]), name: "doc.json" });
  return { host, documentId: info.documentId };
};

const run = async (host: EngineHost, documentId: number, path: string, limit = 10_000) => {
  const result = await host.handle({ _tag: "pathQuery", documentId, path, limit });
  const values: string[] = [];
  for (const match of result.results) {
    const bytes = await host.handle({
      _tag: "slice",
      documentId,
      tapeId: match.node.ref.tapeId,
      range: match.node.range,
    });
    values.push(JSON.stringify(readJson(bytes)));
  }
  return { ...result, values };
};

// RFC 9535's own bookstore, with the results its table gives.

const BOOKSTORE = JSON.stringify(
  {
    store: {
      book: [
        {
          category: "reference",
          author: "Nigel Rees",
          title: "Sayings of the Century",
          price: 8.95,
        },
        { category: "fiction", author: "Evelyn Waugh", title: "Sword of Honour", price: 12.99 },
        {
          category: "fiction",
          author: "Herman Melville",
          title: "Moby Dick",
          isbn: "0-553-21311-3",
          price: 8.99,
        },
        {
          category: "fiction",
          author: "J. R. R. Tolkien",
          title: "The Lord of the Rings",
          isbn: "0-395-19395-X",
          price: 22.99,
        },
      ],
      bicycle: { color: "red", price: 399 },
    },
  },
  null,
  2,
);

const book = (n: number) =>
  JSON.stringify(
    (readJson(encoder.encode(BOOKSTORE)) as { store: { book: unknown[] } }).store.book[n],
  );

const CONFORMANCE: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["$", [JSON.stringify(readJson(encoder.encode(BOOKSTORE)))]],
  [
    "$.store.book[*].author",
    ['"Nigel Rees"', '"Evelyn Waugh"', '"Herman Melville"', '"J. R. R. Tolkien"'],
  ],
  ["$..author", ['"Nigel Rees"', '"Evelyn Waugh"', '"Herman Melville"', '"J. R. R. Tolkien"']],
  ["$.store.bicycle.color", ['"red"']],
  ["$.store['bicycle'][\"price\"]", ["399"]],
  ["$.store..price", ["8.95", "12.99", "8.99", "22.99", "399"]],
  ["$..book[2]", [book(2)]],
  ["$..book[2].author", ['"Herman Melville"']],
  ["$..book[2].publisher", []],
  ["$..book[-1]", [book(3)]],
  ["$..book[0,1]", [book(0), book(1)]],
  ["$..book[:2]", [book(0), book(1)]],
  ["$.store.book[1:3]", [book(1), book(2)]],
  ["$.store.book[::2]", [book(0), book(2)]],
  ["$.store.book[::-1].price", ["22.99", "8.99", "12.99", "8.95"]],
  ["$.store.book[-2:]", [book(2), book(3)]],
  ["$.store.book[3:1]", []],
  ["$.store.book[0:4:0]", []],
  ["$.store.book[4]", []],
  ["$.store.book[-5]", []],
  ["$.store.book.author", []],
  ["$.store.book[0].price[0]", []],
  ["$.store.bicycle[0]", []],
  [
    "$.store['book','bicycle']",
    [JSON.stringify([0, 1, 2, 3].map((n) => JSON.parse(book(n)))), '{"color":"red","price":399}'],
  ],
  ["$..isbn", ['"0-553-21311-3"', '"0-395-19395-X"']],
  ["$.nothing.here", []],
  ["$..nothing", []],
];

describe("path queries", () => {
  const configs: ReadonlyArray<readonly [string, HostOptions]> = [
    ["default index", {}],
    ["small regions", { regionBytes: 64 }],
    // A token budget this small cuts the eager index near the root, so every step goes through buckets.
    ["cut containers", { regionBytes: 128, tokenBudget: 6 }],
  ];

  it("answers the RFC 9535 bookstore queries, whatever the index looks like", async () => {
    for (const [label, options] of configs) {
      const { host, documentId } = await openText(BOOKSTORE, options);
      try {
        for (const [path, expected] of CONFORMANCE) {
          const result = await run(host, documentId, path);
          expect(result.values, `${label}: ${path}`).toEqual(expected);
          expect(result.total).toBe(expected.length);
          expect(result.complete).toBe(true);
        }
        // $..* is every descendant: 1 + 2 + 4 + (4 + 4 + 5 + 5) + 2.
        const all = await run(host, documentId, "$..*");
        expect(all.total, label).toBe(27);
      } finally {
        await host.handle({ _tag: "close", documentId });
      }
    }
  });

  it("labels each result with the key or index it sits under", async () => {
    const { host, documentId } = await openText(BOOKSTORE);
    try {
      const prices = await host.handle({
        _tag: "pathQuery",
        documentId,
        path: "$.store.book[1:3]",
        limit: 10,
      });
      expect(prices.results.map((match) => match.label)).toEqual(["[1]", "[2]"]);
      const named = await host.handle({
        _tag: "pathQuery",
        documentId,
        path: "$.store.bicycle.*",
        limit: 10,
      });
      expect(named.results.map((match) => match.label)).toEqual(["color", "price"]);
      const root = await host.handle({ _tag: "pathQuery", documentId, path: "$", limit: 1 });
      expect(root.results.map((match) => match.label)).toEqual([""]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("gives each result its path, which finds that node again", async () => {
    const text = JSON.stringify({ ...JSON.parse(BOOKSTORE), "odd key's": [{ "a b": 1 }] });
    const { host, documentId } = await openText(text);
    try {
      const authors = await host.handle({
        _tag: "pathQuery",
        documentId,
        path: "$..author",
        limit: 10,
      });
      expect(authors.results.map((match) => match.path)).toEqual([
        "$.store.book[0].author",
        "$.store.book[1].author",
        "$.store.book[2].author",
        "$.store.book[3].author",
      ]);
      const all = await host.handle({ _tag: "pathQuery", documentId, path: "$..*", limit: 1000 });
      expect(all.results.map((match) => match.path)).toContain("$['odd key\\'s'][0]['a b']");
      for (const match of all.results) {
        const again = await host.handle({
          _tag: "pathQuery",
          documentId,
          path: match.path,
          limit: 2,
        });
        expect(
          again.results.map((found) => found.node.ref),
          match.path,
        ).toEqual([match.node.ref]);
      }
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("returns the first `limit` results and the exact total", async () => {
    const { host, documentId } = await openText(BOOKSTORE);
    try {
      const result = await run(host, documentId, "$..*", 5);
      expect(result.results).toHaveLength(5);
      expect(result.total).toBe(27);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("refuses a path it cannot read with the place it stopped at", async () => {
    const { host, documentId } = await openText("{}");
    try {
      const error = await host
        .handle({ _tag: "pathQuery", documentId, path: "$.a[?(@.b)]", limit: 10 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidPathError);
      expect((error as InvalidPathError).at).toBe(4);
      expect((error as InvalidPathError).detail).toContain("jq bar");
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("matches a key written with escapes", async () => {
    const { host, documentId } = await openText('{"caf\\u00e9":1,"a\\"b":2,"x":{"caf\\u00e9":3}}');
    try {
      expect((await run(host, documentId, "$['café']")).values).toEqual(["1"]);
      expect((await run(host, documentId, "$..café")).values).toEqual(["1", "3"]);
      expect((await run(host, documentId, "$['a\"b']")).values).toEqual(["2"]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("does not take a key that only appears inside a string", async () => {
    const { host, documentId } = await openText(
      JSON.stringify({ body: JSON.stringify({ name: "inner" }), other: '"name"', name: "real" }),
    );
    try {
      expect((await run(host, documentId, "$..name")).values).toEqual(['"real"']);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });
});

// Against an independent evaluator over JSON.parse's values.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const KEYS = ["a", "b", "c", "name", "x y", "é"];

const randomValue = (prng: Prng, depth: number): Json => {
  const pick = depth === 0 ? 4 + prng.int(3) : prng.int(depth >= 4 ? 4 : 7);
  switch (pick) {
    case 0:
      return null;
    case 1:
      return prng.range(-3, 40);
    case 2:
      return prng.chance(0.5);
    case 3:
      return prng.pick(["s", "t", "needle", 'a"b', "café"]);
    case 4:
    case 5:
      return Array.from({ length: prng.int(6) }, () => randomValue(prng, depth + 1));
    default: {
      const object: { [key: string]: Json } = {};
      for (const key of KEYS) if (prng.chance(0.5)) object[key] = randomValue(prng, depth + 1);
      return object;
    }
  }
};

/** Writes a value with random whitespace and, for keys, random \u escapes. */
const write = (prng: Prng, value: Json): string => {
  const space = () => (prng.chance(0.25) ? prng.pick([" ", "\n", "  "]) : "");
  const string = (text: string) => {
    if (!prng.chance(0.3)) return JSON.stringify(text);
    let out = '"';
    for (const ch of text) {
      const code = ch.codePointAt(0) as number;
      out +=
        code < 0x10000 && code >= 0x20 && ch !== '"' && ch !== "\\"
          ? `\\u${code.toString(16).padStart(4, "0")}`
          : JSON.stringify(ch).slice(1, -1);
    }
    return `${out}"`;
  };
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? string(value) : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => space() + write(prng, item)).join(",")}${space()}]`;
  }
  const members = Object.entries(value).map(
    ([key, item]) => `${space()}${string(key)}${space()}:${space()}${write(prng, item)}`,
  );
  return `{${members.join(",")}${space()}}`;
};

const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const childrenOf = (value: Json): Json[] =>
  Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [];

const descendantsOrSelf = (value: Json): Json[] => [
  value,
  ...childrenOf(value).flatMap((child) => descendantsOrSelf(child)),
];

const selectOne = (value: Json, selector: Selector): Json[] => {
  switch (selector.kind) {
    case "name":
      return isObject(value) && Object.hasOwn(value, selector.name)
        ? [value[selector.name] as Json]
        : [];
    case "wildcard":
      return childrenOf(value);
    case "index": {
      if (!Array.isArray(value)) return [];
      const at = selector.index < 0 ? value.length + selector.index : selector.index;
      return at >= 0 && at < value.length ? [value[at] as Json] : [];
    }
    case "slice": {
      if (!Array.isArray(value)) return [];
      const len = value.length;
      const step = selector.step ?? 1;
      if (step === 0) return [];
      const norm = (i: number) => (i >= 0 ? i : len + i);
      const start = selector.start ?? (step > 0 ? 0 : len - 1);
      const end = selector.end ?? (step > 0 ? len : -len - 1);
      const nStart = norm(start);
      const nEnd = norm(end);
      const out: Json[] = [];
      if (step > 0) {
        const lower = Math.min(Math.max(nStart, 0), len);
        const upper = Math.min(Math.max(nEnd, 0), len);
        for (let i = lower; i < upper; i += step) out.push(value[i] as Json);
      } else {
        const upper = Math.min(Math.max(nStart, -1), len - 1);
        const lower = Math.min(Math.max(nEnd, -1), len - 1);
        for (let i = upper; lower < i; i += step) out.push(value[i] as Json);
      }
      return out;
    }
  }
};

const evaluate = (root: Json, path: string): Json[] => {
  let nodes: Json[] = [root];
  for (const segment of parsePath(path)) {
    const inputs = segment.descendant ? nodes.flatMap(descendantsOrSelf) : nodes;
    nodes = inputs.flatMap((node) =>
      segment.selectors.flatMap((selector) => selectOne(node, selector)),
    );
  }
  return nodes;
};

const randomPath = (prng: Prng) => {
  const parts: string[] = ["$"];
  const name = () => prng.pick(KEYS);
  const quote = (key: string) => `['${key}']`;
  for (let i = prng.range(1, 4); i > 0; i--) {
    switch (prng.int(11)) {
      case 0:
        parts.push(`.${prng.pick(["a", "b", "c", "name"])}`);
        break;
      case 1:
        parts.push(quote(name()));
        break;
      case 2:
        parts.push(`[${prng.range(-3, 4)}]`);
        break;
      case 3:
        parts.push("[*]");
        break;
      case 4:
        parts.push(".*");
        break;
      case 5:
        parts.push(`..${prng.pick(["a", "b", "c", "name"])}`);
        break;
      case 6:
        parts.push(`..${quote(name())}`);
        break;
      case 7:
        parts.push(`..[${prng.range(0, 2)}]`);
        break;
      case 8:
        parts.push(
          `[${prng.chance(0.5) ? prng.range(-3, 3) : ""}:${prng.chance(0.5) ? prng.range(-3, 5) : ""}${prng.chance(0.4) ? `:${prng.pick([-2, -1, 1, 2, 3])}` : ""}]`,
        );
        break;
      case 9:
        parts.push(`[${prng.range(0, 3)},${prng.range(-2, 1)}]`);
        break;
      default:
        parts.push(`..*`);
    }
  }
  return parts.join("");
};

const SeedInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const seeds = Arbitrary.schema(SeedInt);

describe("path queries against an independent evaluator", () => {
  it.live.prop(
    "select the values, in the order, that evaluating the parsed document gives",
    [seeds, seeds],
    ([documentSeed, pathSeed]) =>
      Effect.promise(async () => {
        const prng = createPrng(documentSeed);
        const value = randomValue(prng, 0);
        const text = write(prng, value);
        const pathPrng = createPrng(pathSeed);
        const options: HostOptions = pathPrng.pick([
          {},
          { regionBytes: 32 },
          // One region, cut near the root: every step goes through buckets. (Regions cut inside
          // an object between a key and its value are an index limit this test does not probe.)
          { tokenBudget: 4 },
        ]);
        const { host, documentId } = await openText(text, options);
        try {
          for (let n = 0; n < 4; n++) {
            const path = randomPath(pathPrng);
            const got = await run(host, documentId, path);
            const expected = evaluate(value, path).map((v) => JSON.stringify(v));
            expect(got.values, `${path} with ${JSON.stringify(options)} over ${text}`).toEqual(
              expected,
            );
          }
        } finally {
          await host.handle({ _tag: "close", documentId });
        }
      }),
    { arbitrary: { runs: 200 } },
  );
});

describe("search through the host", () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    url: `https://quipu.example/item/${i}`,
    body: JSON.stringify({ error: i % 3 === 0 ? "caf\u00e9" : "ok", n: i }),
  }));
  const text = JSON.stringify({ entries }, null, 1);
  const small = {
    regexChunkBytes: 200,
    literalChunkBytes: 150,
    regexWorkers: 2,
    chunk: { blockBytes: 64 },
  };

  const rangesOf = async (host: EngineHost, documentId: number, searchId: number, size: number) =>
    (
      await host.handle({
        _tag: "searchHits",
        documentId,
        searchId,
        from: 0,
        to: size,
        limit: 4096,
      })
    ).ranges;

  it("finds the same hits for a literal and the regex that spells it, in any chunking", async () => {
    const { host, documentId } = await openText(text, { search: small });
    try {
      const literal = await host.handle({
        _tag: "search",
        documentId,
        query: { mode: "literal", text: "quipu.example/item/1", caseSensitive: true },
      });
      const regex = await host.handle({
        _tag: "search",
        documentId,
        query: { mode: "regex", text: "quipu\\.example/item/1", caseSensitive: true },
      });
      expect(literal.count).toBe(11);
      expect(regex.count).toBe(11);
      expect(literal.status).toBe("complete");
      const size = encoder.encode(text).length;
      expect(await rangesOf(host, documentId, regex.searchId, size)).toEqual(
        await rangesOf(host, documentId, literal.searchId, size),
      );
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("matches the unescaped text inside a stringified body, and covers the escapes in the hit", async () => {
    const { host, documentId } = await openText(text, { search: small });
    try {
      // The bodies hold {"error":"café"}, so the file has \"error\":\"café\" in it.
      const summary = await host.handle({
        _tag: "search",
        documentId,
        query: { mode: "literal", text: '"error":"café"', caseSensitive: true },
      });
      expect(summary.count).toBe(20);
      const [first] = await rangesOf(
        host,
        documentId,
        summary.searchId,
        encoder.encode(text).length,
      );
      const raw = encoder.encode(text).slice(first?.start, first?.end);
      expect(new TextDecoder().decode(raw)).toBe('\\"error\\":\\"café\\"');
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("folds case when asked and not when it is not", async () => {
    const { host, documentId } = await openText(text, { search: small });
    try {
      const find = (needle: string, caseSensitive: boolean) =>
        host.handle({
          _tag: "search",
          documentId,
          query: { mode: "literal", text: needle, caseSensitive },
        });
      expect((await find("HTTPS://QUIPU", true)).count).toBe(0);
      expect((await find("HTTPS://QUIPU", false)).count).toBe(60);
      // Unicode folding for non-ASCII text.
      expect((await find("CAFÉ", false)).count).toBe(20);
      expect((await find("CAFÉ", true)).count).toBe(0);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("refuses a pattern that is not a regular expression", async () => {
    const { host, documentId } = await openText(text);
    try {
      const error = await host
        .handle({
          _tag: "search",
          documentId,
          query: { mode: "regex", text: "(", caseSensitive: true },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidSearchPatternError);
      expect((error as InvalidSearchPatternError).pattern).toBe("(");
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("serves next, previous and the first hit after a place, wrapping at both ends", async () => {
    const { host, documentId } = await openText(text, { search: small });
    try {
      const summary = await host.handle({
        _tag: "search",
        documentId,
        query: { mode: "literal", text: "item/5", caseSensitive: true },
      });
      expect(summary.count).toBe(11);
      const at = (index: number) =>
        host.handle({ _tag: "searchHit", documentId, searchId: summary.searchId, index });
      const first = await at(0);
      const last = await at(10);
      expect(first?.index).toBe(0);
      expect((await at(-1))?.index).toBe(10);
      expect((await at(11))?.index).toBe(0);
      expect((await at(-1))?.range).toEqual(last?.range);
      const seek = (offset: number) =>
        host.handle({ _tag: "searchSeek", documentId, searchId: summary.searchId, offset });
      expect(await seek(0)).toBe(0);
      expect(await seek((first?.range.end ?? 0) - 1)).toBe(0);
      expect(await seek(first?.range.end ?? 0)).toBe(1);
      expect(await seek(encoder.encode(text).length)).toBe(0);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("lights hits past the retained ones by looking at just that window", async () => {
    const { host, documentId } = await openText(text, {
      search: { ...small, literalChunkBytes: 2000, chunk: { blockBytes: 64, maxHits: 5 } },
    });
    try {
      const needle = "quipu.example";
      const summary = await host.handle({
        _tag: "search",
        documentId,
        query: { mode: "literal", text: needle, caseSensitive: true },
      });
      expect(summary.count).toBe(60);
      expect(summary.retained).toBeLessThan(60);
      const all: Array<{ start: number; end: number }> = [];
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
        const start = encoder.encode(text.slice(0, at)).length;
        all.push({ start, end: start + needle.length });
      }
      const from = all[40]?.start ?? 0;
      const window = await host.handle({
        _tag: "searchHits",
        documentId,
        searchId: summary.searchId,
        from,
        to: from + 400,
        limit: 4096,
      });
      expect(window.ranges).toEqual(all.filter((r) => r.end > from && r.start < from + 400));
      const lit = await host.handle({
        _tag: "searchLit",
        documentId,
        searchId: summary.searchId,
        ranges: [
          { start: all[50]?.start ?? 0, end: (all[50]?.start ?? 0) + 3 },
          { start: (all[50]?.end ?? 0) + 1, end: (all[50]?.end ?? 0) + 4 },
        ],
      });
      expect(lit).toEqual([true, false]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("forgets a closed search", async () => {
    const { host, documentId } = await openText(text);
    try {
      const summary = await host.handle({
        _tag: "search",
        documentId,
        query: { mode: "literal", text: "id", caseSensitive: true },
      });
      await host.handle({ _tag: "searchClose", documentId, searchId: summary.searchId });
      const error = await host
        .handle({ _tag: "searchHit", documentId, searchId: summary.searchId, index: 0 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SearchNotFoundError);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });
});

describe("the jq bar", () => {
  it("hands the subtree's bytes and the program to the platform and returns what it says", async () => {
    const seen: Array<{ input: string; program: string; timeoutMs: number }> = [];
    const { host, documentId } = await openText(
      BOOKSTORE,
      {},
      {
        runJq: (input, program, timeoutMs) => {
          seen.push({ input: new TextDecoder().decode(input), program, timeoutMs });
          return Promise.resolve({ status: "ok", output: "8.99\n", truncated: false, message: "" });
        },
      },
    );
    try {
      const bicycle = await host.handle({
        _tag: "pathQuery",
        documentId,
        path: "$.store.bicycle",
        limit: 1,
      });
      const ref = bicycle.results[0]?.node.ref;
      expect(ref).toBeDefined();
      const result = await host.handle({
        _tag: "jq",
        ref: ref as NonNullable<typeof ref>,
        program: ".price",
        timeoutMs: 2000,
      });
      expect(result).toEqual({
        status: "ok",
        output: "8.99\n",
        truncated: false,
        message: "",
        inputBytes: seen[0]?.input.length,
      });
      expect(JSON.parse(seen[0]?.input ?? "")).toEqual({ color: "red", price: 399 });
      expect(seen[0]?.program).toBe(".price");
      expect(seen[0]?.timeoutMs).toBe(2000);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("refuses a subtree over 64 MiB and never reads it", async () => {
    const big = new Uint8Array(MAX_SLICE_BYTES + 1024);
    big.fill(0x78);
    big[0] = 0x5b;
    big[1] = 0x22;
    big[big.length - 2] = 0x22;
    big[big.length - 1] = 0x5d;
    let called = false;
    const host = new EngineHost(
      platformFor({
        runJq: () => {
          called = true;
          return Promise.resolve({ status: "ok", output: "", truncated: false, message: "" });
        },
      }),
    );
    const info = await host.handle({ _tag: "open", source: new Blob([big]), name: "big.json" });
    try {
      const root = await host.handle({ _tag: "root", documentId: info.documentId });
      const error = await host
        .handle({ _tag: "jq", ref: root.ref, program: ".", timeoutMs: 1000 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JqSubtreeTooLargeError);
      expect((error as Error).message).toContain("up to 64 MiB");
      expect(called).toBe(false);
    } finally {
      await host.handle({ _tag: "close", documentId: info.documentId });
    }
  }, 60_000);
});
