import {
  CHILDREN_PAGE_LIMIT,
  EditRefusedError,
  InvalidEditError,
  MAX_SLICE_BYTES,
  type NodeSummary,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost } from "./document.ts";
import { formatBytes } from "./format.ts";
import { type JournalStore, memoryJournalStore } from "./journalStore.ts";
import { createLocalPool } from "./localPool.ts";
import { readJson } from "./testing/readJson.ts";

const utf8 = new TextEncoder();
const isRefusal = Schema.is(EditRefusedError);
const decoder = new TextDecoder();
const options = { arbitrary: { runs: 60 } };
const KEY = "blob:transform";

const platform = (store?: JournalStore) => ({
  workers: 2,
  crossOriginIsolated: true,
  createPool: createLocalPool,
  journalStore: store,
});

const WellFormedString = Schema.String.check(
  Schema.makeFilter((s: string) => s.isWellFormed(), { expected: "a well-formed string" }),
);
const Scalar = Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, WellFormedString]);
const JsonValue: Schema.Codec<unknown> = Schema.Union([
  Scalar,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record(
    WellFormedString,
    Schema.suspend(() => JsonValue),
  ),
]);
const Document = Schema.Struct({
  obj: Schema.Record(WellFormedString, JsonValue),
  scalars: Schema.Array(Scalar),
  rows: Schema.Array(
    Schema.Union([
      Schema.Struct({ id: Scalar, name: WellFormedString }),
      Schema.Struct({ name: WellFormedString }),
    ]),
  ),
  tail: JsonValue,
});
const Step = Schema.Struct({
  op: Schema.Literals(["sortKeys", "sortArray", "format", "minify", "edit", "undo"]),
  /** Which node of the current tree, as a fraction of a pre-order walk. */
  pick: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  value: JsonValue,
  indent: Schema.Literals([1, 2, 4]),
  descending: Schema.Boolean,
});
const Mixed = Schema.Struct({
  document: Document,
  pretty: Schema.Boolean,
  steps: Schema.Array(Step).check(Schema.isMaxLength(8)),
});
const Case = Schema.Struct({
  document: Document,
  pretty: Schema.Boolean,
  descending: Schema.Boolean,
  indent: Schema.Literals([1, 2, 4]),
  journal: Schema.Boolean,
});

const open = async (host: EngineHost, bytes: Uint8Array, journalKey?: string) => {
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    name: "doc.json",
    ...(journalKey === undefined ? {} : { journalKey }),
  });
  const root = await host.handle({ _tag: "root", documentId: info.documentId });
  return {
    documentId: info.documentId,
    root: await host.handle({ _tag: "node", ref: root.ref }),
    recovered: info.recovered,
  };
};
const children = async (host: EngineHost, node: NodeSummary) =>
  (await host.handle({ _tag: "children", ref: node.ref, from: 0, count: CHILDREN_PAGE_LIMIT }))
    .nodes;
const member = async (host: EngineHost, node: NodeSummary, key: string) => {
  for (const child of await children(host, node)) {
    if ((await host.handle({ _tag: "keyText", ref: child.ref })) === key) return child;
  }
  throw new Error(`no member ${key}`);
};
const bytesOf = async (host: EngineHost, documentId: number) => {
  const root = await host.handle({ _tag: "node", ref: { documentId, tapeId: 0, token: 0 } });
  return host.handle({
    _tag: "logicalSlice",
    documentId,
    tapeId: 0,
    range: { start: 0, end: root.span.end },
  });
};
const textOf = async (host: EngineHost, node: NodeSummary) =>
  decoder.decode(
    await host.handle({
      _tag: "logicalSlice",
      documentId: node.ref.documentId,
      tapeId: node.ref.tapeId,
      range: node.span,
    }),
  );

/** Every node in pre-order, as the views would walk it. */
const walk = async (host: EngineHost, node: NodeSummary, out: NodeSummary[] = []) => {
  out.push(node);
  if (node.kind === "object" || node.kind === "array") {
    for (const child of await children(host, node)) await walk(host, child, out);
  }
  return out;
};
/** The tree under `node` from the engine's answers alone. */
const materialize = async (host: EngineHost, node: NodeSummary): Promise<unknown> => {
  if (node.kind === "object") {
    const out: Record<string, unknown> = {};
    for (const child of await children(host, node)) {
      Object.defineProperty(out, await host.handle({ _tag: "keyText", ref: child.ref }), {
        value: await materialize(host, child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (node.kind === "array")
    return Promise.all((await children(host, node)).map((c) => materialize(host, c)));
  const text = await host.handle({ _tag: "text", ref: node.ref, limit: MAX_SLICE_BYTES });
  return node.kind === "string" ? text.text : readJson(utf8.encode(text.text));
};
/** Every node of a value in pre-order as its path; mirrors `walk`. */
const pathsOf = (
  value: unknown,
  path: ReadonlyArray<string | number> = [],
  out: Array<ReadonlyArray<string | number>> = [],
) => {
  out.push(path);
  if (Array.isArray(value)) value.forEach((v, i) => pathsOf(v, [...path, i], out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      pathsOf(v, [...path, k], out);
  }
  return out;
};
const getAt = (value: unknown, path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>((v, key) => (v as Record<string | number, unknown>)[key], value);
/** `value` with the node at `path` replaced, every other node keeping its place. */
const setAt = (value: unknown, path: ReadonlyArray<string | number>, next: unknown): unknown => {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((v, i) => (i === head ? setAt(v, rest, next) : v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(out, k, {
      value: k === head ? setAt(v, rest, next) : v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
};

/** The documented order: null, booleans, numbers, strings; containers and missing fields last, in place. */
const rank = (v: unknown) =>
  v === null
    ? 0
    : typeof v === "boolean"
      ? 1
      : typeof v === "number"
        ? 2
        : typeof v === "string"
          ? 3
          : 4;
const compareValues = (a: unknown, b: unknown) => {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra >= 4) return 0;
  const x = typeof a === "boolean" ? Number(a) : (a as number | string);
  const y = typeof b === "boolean" ? Number(b) : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
};
const sortedBy = <T>(items: ReadonlyArray<T>, key: (item: T) => unknown, descending: boolean) =>
  items
    .map((item, index) => ({ item, index, key: key(item) }))
    .sort((a, b) => {
      const c = compareValues(a.key, b.key);
      const sortable = rank(a.key) < 4 && rank(b.key) < 4;
      return (sortable && descending ? -c : c) || a.index - b.index;
    })
    .map((entry) => entry.item);

describe("sort, format and minify as undoable edits", () => {
  it.live.prop(
    "each transform's bytes parse to the documented result, undo restores the exact bytes, and a journaled session recovers them",
    [Arbitrary.schema(Case)],
    ([{ document: generated, pretty, descending, indent, journal }]) =>
      Effect.promise(async () => {
        // The bytes are the model: `-0` is written as `0`, so the value is what its JSON parses to.
        const document = readJson(JSON.stringify(generated)) as typeof generated;
        const store = journal ? memoryJournalStore() : undefined;
        const original = utf8.encode(
          pretty ? JSON.stringify(document, null, 2) : JSON.stringify(document),
        );
        const host = new EngineHost(platform(store), { regionBytes: 64, appendChunkBytes: 16 });
        const { documentId, root } = await open(host, original, journal ? KEY : undefined);
        const expectBytes = async (expected: Uint8Array) =>
          expect(decoder.decode(await bytesOf(host, documentId))).toBe(decoder.decode(expected));

        // sortKeys on `obj`: same members, key order by code units, the rest of the document untouched.
        const obj = await member(host, root, "obj");
        const sortedKeys = await host.handle({
          _tag: "transform",
          ref: obj.ref,
          transform: { _tag: "sortKeys", descending },
        });
        expect(sortedKeys.node.kind).toBe("object");
        const keysNow = await Promise.all(
          (await children(host, sortedKeys.node)).map((c) =>
            host.handle({ _tag: "keyText", ref: c.ref }),
          ),
        );
        const expectedKeys = sortedBy(Object.keys(document.obj), (k) => k, descending);
        expect(keysNow).toEqual(expectedKeys);
        expect(readJson(await bytesOf(host, documentId))).toEqual(document);
        await host.handle({ _tag: "undo", documentId });
        await expectBytes(original);
        await host.handle({ _tag: "redo", documentId });

        // sortArray by value on `scalars`, then by field `id` on `rows`.
        const scalars = await member(host, root, "scalars");
        const sortedScalars = await host.handle({
          _tag: "transform",
          ref: scalars.ref,
          transform: { _tag: "sortArray", field: null, descending },
        });
        expect(readJson(utf8.encode(await textOf(host, sortedScalars.node)))).toEqual(
          sortedBy(document.scalars, (v) => v, descending),
        );
        const rows = await member(host, root, "rows");
        const byId = {
          _tag: "transform",
          ref: rows.ref,
          transform: { _tag: "sortArray", field: "id", descending },
        } as const;
        // The transforms that change the document, sortKeys included.
        let applied = 6;
        if (document.rows.length > 0 && !document.rows.some((row) => "id" in row)) {
          // Sorting by a field no element has would change nothing, silently: it is refused.
          await expect(host.handle(byId)).rejects.toThrow('No element has a field named "id".');
          applied--;
        } else {
          const sortedRows = await host.handle(byId);
          expect(readJson(utf8.encode(await textOf(host, sortedRows.node)))).toEqual(
            sortedBy(document.rows, (row) => ("id" in row ? row.id : {}), descending),
          );
        }

        // format a subtree: its lines after the first are indented for its depth.
        const tail = await member(host, root, "tail");
        const tailFormatted = await host.handle({
          _tag: "transform",
          ref: tail.ref,
          transform: { _tag: "format", indent },
        });
        const standalone = decoder.decode(
          formatBytes(utf8.encode(JSON.stringify(document.tail)), { indent }),
        );
        const indented = standalone
          .split("\n")
          .map((line, i) => (i === 0 ? line : " ".repeat(indent) + line))
          .join("\n");
        expect(await textOf(host, tailFormatted.node)).toBe(indented);
        // format the whole document: the single-pass formatter's bytes; minify likewise.
        const before = await bytesOf(host, documentId);
        const formatted = await host.handle({
          _tag: "transform",
          ref: root.ref,
          transform: { _tag: "format", indent },
        });
        expect(formatted.node.kind).toBe("object");
        await expectBytes(formatBytes(before, { indent }));
        const minified = await host.handle({
          _tag: "transform",
          ref: root.ref,
          transform: { _tag: "minify" },
        });
        expect(minified.node.ref.tapeId).toBeGreaterThan(0);
        await expectBytes(formatBytes(before, { indent: 0 }));
        expect(readJson(await bytesOf(host, documentId))).toEqual({
          ...document,
          scalars: sortedBy(document.scalars, (v) => v, descending),
          rows: sortedBy(document.rows, (row) => ("id" in row ? row.id : {}), descending),
        });
        const final = await bytesOf(host, documentId);

        // One undo per transform walks back to the original bytes; as many redos return.
        for (let i = 0; i < applied; i++) await host.handle({ _tag: "undo", documentId });
        await expectBytes(original);
        for (let i = 0; i < applied; i++) await host.handle({ _tag: "redo", documentId });
        await expectBytes(final);

        if (store) {
          // The transforms' outputs live in spill files; a new session replays them from there.
          const again = new EngineHost(platform(store), { regionBytes: 64, appendChunkBytes: 16 });
          const recovered = await open(again, original, KEY);
          // sortKeys, undo, redo, the other transforms, then the undos and the redos.
          expect(recovered.recovered).toBe(3 + (applied - 1) + 2 * applied);
          expect(decoder.decode(await bytesOf(again, recovered.documentId))).toBe(
            decoder.decode(final),
          );
          await again.handle({ _tag: "close", documentId: recovered.documentId });
        }
        await host.handle({ _tag: "close", documentId });
      }),
    options,
  );

  /**
   * Transforms and edits in any order, against a model of the bytes and the
   * value: a transform replaces the node's span (the rest of the bytes stay),
   * the value's children come out in the documented order, and an edit after a
   * transform splices the node's span like any edit. After every step the tape
   * materializes the same tree a fresh index of the bytes does, so an edit under
   * a transformed root is answered from the right nested region.
   */
  const runMixedScript = async ({ document: generated, pretty, steps }: typeof Mixed.Type) => {
    const document = readJson(JSON.stringify(generated)) as unknown;
    const host = new EngineHost(platform(), { regionBytes: 64, appendChunkBytes: 16 });
    let bytes: Uint8Array<ArrayBuffer> = utf8.encode(
      pretty ? JSON.stringify(document, null, 2) : JSON.stringify(document),
    );
    let value: unknown = document;
    const { documentId, root } = await open(host, bytes);
    const history: Array<{ bytes: Uint8Array<ArrayBuffer>; value: unknown }> = [{ bytes, value }];
    const check = async () => {
      const now = await bytesOf(host, documentId);
      expect(decoder.decode(now)).toBe(decoder.decode(bytes));
      expect(readJson(now)).toEqual(value);
      const current = await host.handle({ _tag: "node", ref: root.ref });
      expect(await materialize(host, current)).toEqual(value);
      // Detection opens only an object or an array as structure, so a root edited into a
      // scalar reopens as text, with no tape to compare.
      if (typeof value !== "object" || value === null) return;
      const fresh = new EngineHost(platform(), { regionBytes: 64 });
      const other = await open(fresh, bytes);
      expect(await materialize(host, current)).toEqual(await materialize(fresh, other.root));
      await fresh.handle({ _tag: "close", documentId: other.documentId });
    };
    const splice = (span: { start: number; end: number }, middle: Uint8Array) => {
      // A fresh ArrayBuffer: the model is handed to `Blob` for the fresh index.
      const out = new Uint8Array(span.start + middle.byteLength + (bytes.byteLength - span.end));
      out.set(bytes.subarray(0, span.start), 0);
      out.set(middle, span.start);
      out.set(bytes.subarray(span.end), span.start + middle.byteLength);
      return out;
    };
    try {
      for (const step of steps) {
        if (step.op === "undo") {
          if (history.length > 1) {
            await host.handle({ _tag: "undo", documentId });
            history.pop();
            ({ bytes, value } = history[history.length - 1] as {
              bytes: Uint8Array<ArrayBuffer>;
              value: unknown;
            });
            await check();
          }
          continue;
        }
        const current = await host.handle({ _tag: "node", ref: root.ref });
        const nodes = await walk(host, current);
        const paths = pathsOf(value);
        expect(nodes.length).toBe(paths.length);
        const index = Math.min(nodes.length - 1, Math.floor(step.pick * nodes.length));
        const target = nodes[index] as NodeSummary;
        const path = paths[index] as ReadonlyArray<string | number>;
        const targetValue = getAt(value, path);
        if (step.op === "edit") {
          const json = utf8.encode(JSON.stringify(step.value));
          const result = await host.handle({
            _tag: "setValue",
            ref: target.ref,
            json: decoder.decode(json),
          });
          bytes = splice(target.span, json);
          // What the written bytes hold: `-0` is written as `0`.
          value = setAt(value, path, readJson(JSON.stringify(step.value)));
          // The reply is the edited node itself, answered from its own region.
          expect(result.node.span).toEqual({
            start: target.span.start,
            end: target.span.start + json.byteLength,
          });
          if (result.node.kind !== "object" && result.node.kind !== "array") {
            const text = await host.handle({ _tag: "text", ref: result.node.ref, limit: 1 << 16 });
            expect(text.text).toBe(
              typeof step.value === "string" ? step.value : JSON.stringify(step.value),
            );
          }
        } else {
          const transform =
            step.op === "sortKeys"
              ? ({ _tag: "sortKeys", descending: step.descending } as const)
              : step.op === "sortArray"
                ? ({ _tag: "sortArray", field: null, descending: step.descending } as const)
                : step.op === "format"
                  ? ({ _tag: "format", indent: step.indent } as const)
                  : ({ _tag: "minify" } as const);
          const wrongKind =
            (step.op === "sortKeys" && target.kind !== "object") ||
            (step.op === "sortArray" && target.kind !== "array");
          if (wrongKind) {
            await expect(
              host.handle({ _tag: "transform", ref: target.ref, transform }),
            ).rejects.toBeInstanceOf(InvalidEditError);
            await check();
            continue;
          }
          // Elements that are all objects or arrays have no value to sort by: refused, unchanged.
          if (
            step.op === "sortArray" &&
            (targetValue as unknown[]).length > 0 &&
            (targetValue as unknown[]).every((v) => typeof v === "object" && v !== null)
          ) {
            await expect(
              host.handle({ _tag: "transform", ref: target.ref, transform }),
            ).rejects.toBeInstanceOf(EditRefusedError);
            await check();
            continue;
          }
          const result = await host.handle({ _tag: "transform", ref: target.ref, transform });
          const output = await host.handle({
            _tag: "logicalSlice",
            documentId,
            tapeId: 0,
            range: result.node.span,
          });
          expect(result.node.span.start).toBe(target.span.start);
          const expectedValue =
            step.op === "sortKeys"
              ? Object.fromEntries(
                  sortedBy(
                    Object.entries(targetValue as Record<string, unknown>),
                    ([k]) => k,
                    step.descending,
                  ),
                )
              : step.op === "sortArray"
                ? sortedBy(targetValue as unknown[], (v) => v, step.descending)
                : targetValue;
          expect(readJson(output)).toEqual(expectedValue);
          if (step.op === "minify") {
            expect(decoder.decode(output)).toBe(
              decoder.decode(
                formatBytes(bytes.subarray(target.span.start, target.span.end), { indent: 0 }),
              ),
            );
          }
          bytes = splice(target.span, output);
          value = setAt(value, path, expectedValue);
        }
        history.push({ bytes, value });
        await check();
      }
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  };

  it.live.prop(
    "transforms and edits in any order match a byte-splice model, and the tape matches a fresh index after each",
    [Arbitrary.schema(Mixed)],
    ([input]) => Effect.promise(() => runMixedScript(input)),
    options,
  );

  it("an edit after sorting the root re-indexes only the edited member, and the reply's text reads back", async () => {
    const host = new EngineHost(platform(), { regionBytes: 64 });
    const original = utf8.encode(
      JSON.stringify(
        { log: { version: "1.2", entries: [{ a: 1 }, { a: 2 }], creator: "x" } },
        null,
        2,
      ),
    );
    const { documentId, root } = await open(host, original);
    const sorted = await host.handle({
      _tag: "transform",
      ref: root.ref,
      transform: { _tag: "sortKeys", descending: false },
    });
    const log = await member(host, sorted.node, "log");
    const version = await member(host, log, "version");
    const edited = await host.handle({ _tag: "setValue", ref: version.ref, json: '"1.3"' });
    expect(edited.node.kind).toBe("string");
    expect(edited.node.ref.tapeId).not.toBe(sorted.node.ref.tapeId);
    expect((await host.handle({ _tag: "text", ref: edited.node.ref, limit: 100 })).text).toBe(
      "1.3",
    );
    // The sorted root's node still answers, and the edited member sits in it with the new bytes.
    const rootNow = await host.handle({ _tag: "node", ref: root.ref });
    expect(readJson(await bytesOf(host, documentId))).toEqual({
      log: { creator: "x", entries: [{ a: 1 }, { a: 2 }], version: "1.3" },
    });
    expect(rootNow.span.end).toBe((await bytesOf(host, documentId)).byteLength);
    // An old ref under the sorted root (the entries array) still resolves; a ref whose member was edited resolves to the new bytes.
    const entries = await member(host, log, "entries");
    expect((await host.handle({ _tag: "node", ref: entries.ref })).childCount).toBe(2);
    expect((await host.handle({ _tag: "text", ref: version.ref, limit: 100 })).text).toBe("1.3");
    await host.handle({ _tag: "close", documentId });
  });

  it("refuses to sort the wrong kind of node and leaves the bytes alone", async () => {
    const host = new EngineHost(platform(), { regionBytes: 64 });
    const original = utf8.encode('{"a": [3, 1, 2], "b": {"y": 1, "x": 2}}');
    const { documentId, root } = await open(host, original);
    const a = await member(host, root, "a");
    const b = await member(host, root, "b");
    await expect(
      host.handle({
        _tag: "transform",
        ref: a.ref,
        transform: { _tag: "sortKeys", descending: false },
      }),
    ).rejects.toBeInstanceOf(InvalidEditError);
    await expect(
      host.handle({
        _tag: "transform",
        ref: b.ref,
        transform: { _tag: "sortArray", field: null, descending: false },
      }),
    ).rejects.toBeInstanceOf(InvalidEditError);
    expect(decoder.decode(await bytesOf(host, documentId))).toBe(decoder.decode(original));
    const sortedA = await host.handle({
      _tag: "transform",
      ref: a.ref,
      transform: { _tag: "sortArray", field: null, descending: false },
    });
    expect(await textOf(host, sortedA.node)).toBe("[1,2,3]");
    const sortedB = await host.handle({
      _tag: "transform",
      ref: b.ref,
      transform: { _tag: "sortKeys", descending: false },
    });
    expect(await textOf(host, sortedB.node)).toBe('{"x": 2,"y": 1}');
    await host.handle({ _tag: "close", documentId });
  });

  it("refuses to sort objects by a value no one can see, or by a field no element has, and says so", async () => {
    const host = new EngineHost(platform(undefined), { regionBytes: 64 });
    const text =
      '{"items": [{"sku": "C-300"}, {"sku": "B-200"}], "grid": [[2], {"a": 1}], "mixed": [3, {"a": 1}, 1]}';
    const { documentId, root } = await open(host, utf8.encode(text));
    const sort = async (name: string, field: string | null) =>
      host
        .handle({
          _tag: "transform",
          ref: (await member(host, root, name)).ref,
          transform: { _tag: "sortArray", field, descending: false },
        })
        .then(
          () => "sorted",
          (error: unknown) => (isRefusal(error) ? error.message : String(error)),
        );
    expect(await sort("items", null)).toBe(
      "Its elements are objects. Sort it by one of their fields instead.",
    );
    expect(await sort("grid", null)).toBe(
      "Its elements are arrays and objects, which have no value to sort by.",
    );
    expect(await sort("items", "nope")).toBe('No element has a field named "nope".');
    expect(decoder.decode(await bytesOf(host, documentId))).toBe(text);
    // Values beside the objects still sort; the objects keep their order at the end.
    expect(await sort("mixed", null)).toBe("sorted");
    expect(await sort("items", "sku")).toBe("sorted");
    expect(decoder.decode(await bytesOf(host, documentId))).toBe(
      '{"items": [{"sku": "B-200"},{"sku": "C-300"}], "grid": [[2], {"a": 1}], "mixed": [1,3,{"a": 1}]}',
    );
    await host.handle({ _tag: "close", documentId });
  });

  it("a spill a killed session never committed is removed when the journal opens", async () => {
    const store = memoryJournalStore();
    const original = utf8.encode('{"a": [3, 1, 2]}');
    const host = new EngineHost(platform(store), { regionBytes: 64 });
    const { documentId, root } = await open(host, original, KEY);
    const a = await member(host, root, "a");
    await host.handle({
      _tag: "transform",
      ref: a.ref,
      transform: { _tag: "sortArray", field: null, descending: false },
    });
    await store.append("journals/blob/transform/spill-7.bin", utf8.encode("[9]"));
    const again = new EngineHost(platform(store), { regionBytes: 64 });
    const recovered = await open(again, original, KEY);
    expect(recovered.recovered).toBe(1);
    expect(decoder.decode(await bytesOf(again, recovered.documentId))).toBe('{"a": [1,2,3]}');
    expect((await store.list("journals/blob/transform")).includes("spill-7.bin")).toBe(false);
    expect((await store.list("journals/blob/transform")).includes("spill-0.bin")).toBe(true);
    await host.handle({ _tag: "close", documentId });
    await again.handle({ _tag: "close", documentId: recovered.documentId });
  });
});
