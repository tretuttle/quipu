import { InvalidPathError } from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";

import { EngineHost, type HostOptions, type HostPlatform } from "./document.ts";
import { createLocalPool } from "./localPool.ts";

const platformFor = (extra: Partial<HostPlatform> = {}): HostPlatform => ({
  workers: 3,
  crossOriginIsolated: true,
  createPool: createLocalPool,
  ...extra,
});

const openText = async (
  text: string,
  name = "doc.json",
  options: HostOptions = {},
  extra: Partial<HostPlatform> = {},
) => {
  const host = new EngineHost(platformFor(extra), options);
  const info = await host.handle({ _tag: "open", source: new Blob([text]), name });
  return { host, documentId: info.documentId };
};

const queryPaths = async (host: EngineHost, documentId: number, path: string) => {
  const result = await host.handle({ _tag: "pathQuery", documentId, path, limit: 10_000 });
  return result.results.map((r) => r.path);
};

const STORE_DOC =
  '{"store":{"book":[{"author":"N","price":8.95,"isbn":"x"},{"author":"E","price":12.99},{"author":"M","price":8.99,"isbn":"y"}],"bicycle":{"color":"red","price":19.95}},"o":{"a b":1}}';

const BOOKSTORE_DOC = '{"store":{"book":[{"t":"A","price":8},{"t":"B","price":12}]}}';

describe("JSONPath filter predicates (pathFilter)", () => {
  it("matches JSONPath filter and slice test vectors", async () => {
    const configs: ReadonlyArray<readonly [string, HostOptions]> = [
      ["default", {}],
      ["cut containers", { regionBytes: 64, tokenBudget: 6 }],
    ];

    for (const [label, options] of configs) {
      const { host: bHost, documentId: bDoc } = await openText(BOOKSTORE_DOC, "book.json", options);
      try {
        const res = await bHost.handle({
          _tag: "pathQuery",
          documentId: bDoc,
          path: "$.store.book[?@.price < 10].t",
          limit: 100,
        });
        expect(
          res.results.map((r) => r.preview),
          label,
        ).toEqual(["A"]);
        expect(
          res.results.map((r) => r.path),
          label,
        ).toEqual(["$.store.book[0].t"]);
      } finally {
        await bHost.handle({ _tag: "close", documentId: bDoc });
      }

      const { host, documentId } = await openText(STORE_DOC, "store.json", options);
      try {
        expect((await queryPaths(host, documentId, "$.store.book[*].author")).length, label).toBe(
          3,
        );
        expect((await queryPaths(host, documentId, "$..author")).length, label).toBe(3);
        expect((await queryPaths(host, documentId, "$..price")).length, label).toBe(4);
        expect(await queryPaths(host, documentId, "$.store.book[?@.isbn]"), label).toEqual([
          "$.store.book[0]",
          "$.store.book[2]",
        ]);
        expect(
          await queryPaths(
            host,
            documentId,
            "$.store.book[?@.price < 10 && @.author != 'N'].author",
          ),
          label,
        ).toEqual(["$.store.book[2].author"]);
        expect(
          (await queryPaths(host, documentId, "$.store.book[?!(@.price > 9)]")).length,
          label,
        ).toBe(2);
        expect(await queryPaths(host, documentId, "$.store.book[-1:]"), label).toEqual([
          "$.store.book[2]",
        ]);
        expect((await queryPaths(host, documentId, "$.store.book[::-1]"))[0], label).toBe(
          "$.store.book[2]",
        );
        expect(await queryPaths(host, documentId, "$.store.book[0,2].isbn"), label).toEqual([
          "$.store.book[0].isbn",
          "$.store.book[2].isbn",
        ]);
        expect(await queryPaths(host, documentId, "$['o']['a b']"), label).toEqual(["$.o['a b']"]);
        expect(
          await queryPaths(host, documentId, "$.store.book[?@.price == $.store.book[0].price]"),
          label,
        ).toEqual(["$.store.book[0]"]);
        expect(await queryPaths(host, documentId, "$.nothing"), label).toEqual([]);
      } finally {
        await host.handle({ _tag: "close", documentId });
      }
    }
  });

  it("rejects syntax errors and unsupported function extensions at the expected positions", async () => {
    const { host, documentId } = await openText(STORE_DOC);
    try {
      const bad: ReadonlyArray<readonly [string, number | undefined]> = [
        ["store", 0],
        ["$.", 2],
        ["$.store[", 8],
        ["$.store[?length(@) > 1]", 9],
        ["$['x", 4],
        ["$.a]", 3],
        ["$.store[?@.price <]", 18],
      ];
      for (const [path, expectedAt] of bad) {
        const err = await host
          .handle({ _tag: "pathQuery", documentId, path, limit: 10 })
          .catch((e: unknown) => e);
        expect(err, path).toBeInstanceOf(InvalidPathError);
        if (expectedAt !== undefined) {
          expect((err as InvalidPathError).at, path).toBe(expectedAt);
        }
      }
      const fnErr = await host
        .handle({ _tag: "pathQuery", documentId, path: "$.store[?length(@) > 1]", limit: 10 })
        .catch((e: unknown) => e);
      expect((fnErr as InvalidPathError).detail).toContain("length()");
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("handles RFC 9535 comparisons, boolean logic, deep equality, and missing operands", async () => {
    const doc = JSON.stringify({
      refMeta: { a: 1, b: 2 },
      items: [
        { id: 1, flag: true, tag: null, score: 10, meta: { b: 2, a: 1 }, name: "alpha" },
        { id: 2, flag: false, tag: "x", score: "10", meta: { a: 1, b: 3 }, name: "beta" },
        { id: 3, flag: true, score: 20, meta: [1, 2], name: "gamma" },
      ],
    });
    const { host, documentId } = await openText(doc);
    try {
      // Deep object equality regardless of key order
      expect(await queryPaths(host, documentId, "$.items[?@.meta == $.refMeta].id")).toEqual([
        "$.items[0].id",
      ]);
      // Boolean equality and non-ordering of booleans/null/mixed types
      expect(await queryPaths(host, documentId, "$.items[?@.flag == true].id")).toEqual([
        "$.items[0].id",
        "$.items[2].id",
      ]);
      expect(await queryPaths(host, documentId, "$.items[?@.flag < true].id")).toEqual([]);
      expect(await queryPaths(host, documentId, "$.items[?@.tag == null].id")).toEqual([
        "$.items[0].id",
      ]);
      expect(await queryPaths(host, documentId, "$.items[?@.score >= 10].id")).toEqual([
        "$.items[0].id",
        "$.items[2].id",
      ]);
      // Missing == missing is true; missing != 1 is true
      expect(await queryPaths(host, documentId, "$.items[?@.missingA == @.missingB].id")).toEqual([
        "$.items[0].id",
        "$.items[1].id",
        "$.items[2].id",
      ]);
      expect(
        await queryPaths(
          host,
          documentId,
          "$.items[?(@.tag == null || @.score > 15) && @.flag != false].id",
        ),
      ).toEqual(["$.items[0].id", "$.items[2].id"]);
      // String ordering
      expect(await queryPaths(host, documentId, "$.items[?@.name >= 'beta'].id")).toEqual([
        "$.items[1].id",
        "$.items[2].id",
      ]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("filters HAR entries by status >= 400 and stays consistent across edits and undo", async () => {
    const har = JSON.stringify({
      log: {
        version: "1.2",
        entries: [
          { request: { method: "GET", url: "https://a.test/ok" }, response: { status: 200 } },
          { request: { method: "GET", url: "https://b.test/nf" }, response: { status: 404 } },
          { request: { method: "POST", url: "https://c.test/err" }, response: { status: 500 } },
          { request: { method: "GET", url: "https://d.test/ok2" }, response: { status: 204 } },
        ],
      },
    });
    const { host, documentId } = await openText(har, "capture.har", {
      regionBytes: 128,
      tokenBudget: 8,
    });
    try {
      const before = await queryPaths(
        host,
        documentId,
        "$.log.entries[?(@.response.status >= 400)]",
      );
      expect(before).toEqual(["$.log.entries[1]", "$.log.entries[2]"]);

      // Edit entry 0's status from 200 -> 503
      const status0 = await host.handle({
        _tag: "pathQuery",
        documentId,
        path: "$.log.entries[0].response.status",
        limit: 1,
      });
      const statusRef = status0.results[0]!.node.ref;
      await host.handle({ _tag: "setValue", ref: statusRef, json: "503" });

      const afterEdit = await queryPaths(
        host,
        documentId,
        "$.log.entries[?(@.response.status >= 400)]",
      );
      expect(afterEdit).toEqual(["$.log.entries[0]", "$.log.entries[1]", "$.log.entries[2]"]);

      await host.handle({ _tag: "undo", documentId });
      const afterUndo = await queryPaths(
        host,
        documentId,
        "$.log.entries[?(@.response.status >= 400)]",
      );
      expect(afterUndo).toEqual(["$.log.entries[1]", "$.log.entries[2]"]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });
});
