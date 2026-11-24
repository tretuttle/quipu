import {
  CHILDREN_PAGE_LIMIT,
  EditRefusedError,
  InvalidEditError,
  MAX_SLICE_BYTES,
  NodeNotFoundError,
  type NodeSummary,
  NothingToUndoError,
} from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { formatBytes } from "./format.ts";
import { readJson } from "./testing/readJson.ts";

const utf8 = new TextEncoder();
const platform = (workers: number) => ({
  workers,
  crossOriginIsolated: true,
  createPool: createLocalPool,
});
const options = { arbitrary: { runs: 60 } };

/** JSON values whose `JSON.stringify` round-trips byte for byte (finite numbers, well-formed strings). */
const WellFormedString = Schema.String.check(
  Schema.makeFilter((s: string) => s.isWellFormed(), { expected: "a well-formed string" }),
);
const JsonValue: Schema.Codec<unknown> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  WellFormedString,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record(
    WellFormedString,
    Schema.suspend(() => JsonValue),
  ),
]);
/** A document with enough structure to pick members and elements from. */
const Document = Schema.Struct({
  a: JsonValue,
  list: Schema.Array(JsonValue),
  nested: Schema.Struct({ k: JsonValue, s: WellFormedString }),
});
const Step = Schema.Struct({
  /** Which node of the current tree, as a fraction of a pre-order walk. */
  pick: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  value: JsonValue,
  /** Rename the member instead of replacing its value. */
  key: Schema.NullOr(WellFormedString),
  undo: Schema.Boolean,
  redo: Schema.Boolean,
  layout: Schema.Literals([0, 1]),
});
const Script = Schema.Struct({
  document: Document,
  pretty: Schema.Boolean,
  steps: Schema.Array(Step).check(Schema.isMaxLength(10)),
});
const script = Arbitrary.schema(Script);

/** Strings of the characters JSON must escape, or may: control characters, quotes, backslashes, separators, surrogates. */
const EscapedChar = Schema.Literals([
  "\u0000",
  "\u0001",
  "\u000f",
  "\u001f",
  "\n",
  "\t",
  '"',
  "\\",
  "/",
  "\u2028",
  "é",
  "😀",
  "a",
  "]",
  "@",
]);
/** A string as the characters it is made of; `text` joins them. */
const Chars = Schema.Array(EscapedChar).check(Schema.isMaxLength(4));
type Raw =
  | null
  | boolean
  | number
  | { readonly str: ReadonlyArray<string> }
  | { readonly list: ReadonlyArray<Raw> }
  | { readonly obj: ReadonlyArray<readonly [ReadonlyArray<string>, Raw]> };
const RawValue: Schema.Codec<Raw> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.Struct({ str: Chars }),
  Schema.Struct({
    list: Schema.Array(Schema.suspend(() => RawValue)).check(Schema.isMaxLength(3)),
  }),
  Schema.Struct({
    obj: Schema.Array(Schema.Tuple([Chars, Schema.suspend(() => RawValue)])).check(
      Schema.isMaxLength(3),
    ),
  }),
]);
const text = (chars: ReadonlyArray<string>) => chars.join("");
const valueOf = (raw: Raw): unknown => {
  if (raw === null || typeof raw !== "object") return raw;
  if ("str" in raw) return text(raw.str);
  if ("list" in raw) return raw.list.map(valueOf);
  const out: Record<string, unknown> = {};
  for (const [key, value] of raw.obj) {
    Object.defineProperty(out, text(key), {
      value: valueOf(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
};
/** Edit scripts over documents whose keys and values are written with escapes, renamed to more of them. */
const escapedScript = Arbitrary.schema(
  Schema.Struct({
    a: RawValue,
    list: Schema.Array(RawValue).check(Schema.isMaxLength(3)),
    k: RawValue,
    s: Chars,
    pretty: Schema.Boolean,
    steps: Schema.Array(
      Schema.Struct({
        pick: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
        value: RawValue,
        key: Schema.NullOr(Chars),
        undo: Schema.Boolean,
        redo: Schema.Boolean,
        layout: Schema.Literals([0, 1]),
      }),
    ).check(Schema.isMaxLength(10)),
  }),
);
const escapedInput = (
  raw: typeof escapedScript extends Arbitrary.Arbitrary<infer A> ? A : never,
) => ({
  document: {
    a: valueOf(raw.a),
    list: raw.list.map(valueOf),
    nested: { k: valueOf(raw.k), s: text(raw.s) },
  },
  pretty: raw.pretty,
  steps: raw.steps.map((step) => ({
    ...step,
    value: valueOf(step.value),
    key: step.key === null ? null : text(step.key),
  })),
});

/** A parent whose `body` is a stringified document; steps edit the parent or inside the child. */
const NestedStep = Schema.Struct({
  where: Schema.Literals(["parent", "child"]),
  pick: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  value: JsonValue,
  /** Where in the saved text the needle is taken from, and how long it is. */
  needleAt: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  needleLength: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  undo: Schema.Boolean,
});
const NestedScript = Schema.Struct({
  inner: Schema.Struct({ note: WellFormedString, k: JsonValue }),
  after: JsonValue,
  steps: Schema.Array(NestedStep).check(Schema.isMaxLength(8)),
});
const nestedScript = Arbitrary.schema(NestedScript);

/** Every node of a JSON value in pre-order, as the path to it; the same order as `walk` over the engine's tree. */
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

/** `value` with the node at `path` replaced, leaving every other node's order alone. */
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

/** The object or array a string holds when its layout is `JSON.stringify`'s (so child edits keep the model's bytes), else null. */
const compactJsonOrNull = (text: string): unknown => {
  try {
    const value: unknown = readJson(utf8.encode(text));
    return typeof value === "object" && value !== null && JSON.stringify(value) === text
      ? value
      : null;
  } catch {
    return null;
  }
};

/**
 * A literal search of a document: the exact count and every hit's byte range. Search matches
 * the text the user sees (escapes decoded once); `search.test.ts` checks it against an independent
 * reference on unedited files, so here an edited document is compared with a fresh open of its saved bytes.
 */
const searchAll = async (host: EngineHost, documentId: number, text: string, size: number) => {
  const summary = await host.handle({
    _tag: "search",
    documentId,
    query: { mode: "literal", text, caseSensitive: true },
  });
  const hits = await host.handle({
    _tag: "searchHits",
    documentId,
    searchId: summary.searchId,
    from: 0,
    to: size,
    limit: 4096,
  });
  await host.handle({ _tag: "searchClose", documentId, searchId: summary.searchId });
  return { count: summary.count, ranges: hits.ranges };
};

const open = async (host: EngineHost, bytes: Uint8Array<ArrayBufferLike>, name = "doc.json") => {
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    name,
  });
  const root = await host.handle({ _tag: "root", documentId: info.documentId });
  await host.handle({ _tag: "node", ref: root.ref });
  return { documentId: info.documentId, root: await host.handle({ _tag: "node", ref: root.ref }) };
};

const children = async (host: EngineHost, node: NodeSummary) => {
  const out: NodeSummary[] = [];
  for (let from = 0; from < node.childCount; from += CHILDREN_PAGE_LIMIT) {
    const page = await host.handle({
      _tag: "children",
      ref: node.ref,
      from,
      count: CHILDREN_PAGE_LIMIT,
    });
    out.push(...page.nodes);
  }
  return out;
};

/** The tree under `node` as the views would show it, built from the engine's answers alone. */
const materialize = async (host: EngineHost, node: NodeSummary): Promise<unknown> => {
  if (node.kind === "object") {
    const out: Record<string, unknown> = {};
    for (const child of await children(host, node)) {
      // An own property even for a key like `__proto__`, which `out[key] =` would treat as the prototype.
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
  if (node.kind === "string") return text.text;
  return readJson(utf8.encode(text.text));
};

/** Every node in pre-order with its logical offset, for picking edit targets. */
const walk = async (host: EngineHost, node: NodeSummary, out: NodeSummary[] = []) => {
  out.push(node);
  if (node.kind === "object" || node.kind === "array") {
    for (const child of await children(host, node)) await walk(host, child, out);
  }
  return out;
};

/** Where a member's key starts in the edited bytes: its value's span, moved back by the key's place before the value. */
const keyOffsetOf = (member: NodeSummary) =>
  member.span.start - (member.range.start - (member.key as number));

/** The key whose opening quote is at `at` in `model`, read by the reference reader from its own bytes. */
const keyInModel = (model: Uint8Array, at: number) => {
  let end = at + 1;
  while (model[end] !== 0x22) end += model[end] === 0x5c ? 2 : 1;
  return readJson(model.subarray(at, end + 1)) as string;
};

const logical = async (host: EngineHost, documentId: number, size: number) =>
  host.handle({ _tag: "logicalSlice", documentId, tapeId: 0, range: { start: 0, end: size } });

const bytesOf = (value: unknown, layout: number) =>
  utf8.encode(layout === 0 ? JSON.stringify(value) : JSON.stringify(value, null, 2));

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};

describe("edits through the engine host", () => {
  // `it.prop` does not await a promise-returning property; the Effect form does.
  /** Drives one edit script against the byte-splice model; the property and the replays share it. */
  const runScript = async (
    { document, pretty, steps }: typeof Script.Type,
    hostOptions: { readonly tokenBudget?: number } = {},
  ) => {
    const host = new EngineHost(platform(2), {
      regionBytes: 64,
      appendChunkBytes: 5,
      ...hostOptions,
    });
    let model: Uint8Array<ArrayBufferLike> = bytesOf(document, pretty ? 1 : 0);
    const { documentId, root } = await open(host, model);
    const history: Uint8Array<ArrayBufferLike>[] = [model];
    let undone: Uint8Array<ArrayBufferLike>[] = [];
    let size = model.byteLength;
    const check = async () => {
      const bytes = await logical(host, documentId, size);
      expect(Array.from(bytes)).toEqual(Array.from(model));
      // The edited tape answers the tree the edited bytes hold.
      const expected = readJson(model);
      const current = await host.handle({ _tag: "node", ref: root.ref });
      expect(await materialize(host, current)).toEqual(expected);
      // And the same tree a fresh index of them would. Detection opens only an object or an
      // array as structure, so a root edited into a scalar reopens as text, with no tape.
      if (typeof expected !== "object" || expected === null) return;
      const fresh = new EngineHost(platform(1), { regionBytes: 64 });
      const other = await open(fresh, model);
      expect(await materialize(host, current)).toEqual(await materialize(fresh, other.root));
      expect(await materialize(fresh, other.root)).toEqual(expected);
      await fresh.handle({ _tag: "close", documentId: other.documentId });
    };
    try {
      for (const step of steps) {
        const current = await host.handle({ _tag: "node", ref: root.ref });
        const nodes = await walk(host, current);
        const target = nodes[
          Math.min(nodes.length - 1, Math.floor(step.pick * nodes.length))
        ] as NodeSummary;
        let result;
        if (step.key !== null && target.key !== null) {
          // Rename: the key's bytes run from its quote to its closing quote; find them in the model.
          const keyText = await host.handle({ _tag: "keyText", ref: target.ref });
          const oldKey = utf8.encode(JSON.stringify(keyText));
          const keyOffset = keyOffsetOf(target);
          expect(Array.from(model.subarray(keyOffset, keyOffset + oldKey.byteLength))).toEqual(
            Array.from(oldKey),
          );
          // A key a sibling already has, as the model's own bytes say, is refused and changes nothing.
          const parent = nodes.findLast(
            (node) =>
              node.kind === "object" && node.span.start < keyOffset && keyOffset < node.span.end,
          ) as NodeSummary;
          const siblings = (await children(host, parent)).filter(
            (sibling) => keyOffsetOf(sibling) !== keyOffset,
          );
          if (siblings.some((sibling) => keyInModel(model, keyOffsetOf(sibling)) === step.key)) {
            await expect(
              host.handle({ _tag: "setKey", ref: target.ref, key: step.key }),
            ).rejects.toBeInstanceOf(EditRefusedError);
            await check();
            continue;
          }
          const newKey = utf8.encode(JSON.stringify(step.key));
          model = concat(
            model.subarray(0, keyOffset),
            newKey,
            model.subarray(keyOffset + oldKey.byteLength),
          );
          result = await host.handle({ _tag: "setKey", ref: target.ref, key: step.key });
        } else {
          const json = utf8.encode(
            step.layout === 0 ? JSON.stringify(step.value) : JSON.stringify(step.value, null, 2),
          );
          model = concat(
            model.subarray(0, target.span.start),
            json,
            model.subarray(target.span.end),
          );
          result = await host.handle({
            _tag: "setValue",
            ref: target.ref,
            json: new TextDecoder().decode(json),
          });
        }
        size = result.size;
        expect(size).toBe(model.byteLength);
        history.push(model);
        undone = [];
        await check();
        if (step.undo) {
          const r = await host.handle({ _tag: "undo", documentId });
          undone.push(history.pop() as Uint8Array);
          model = history[history.length - 1] as Uint8Array;
          size = r.size;
          await check();
        }
        if (step.redo && undone.length > 0) {
          const r = await host.handle({ _tag: "redo", documentId });
          model = undone.pop() as Uint8Array;
          history.push(model);
          size = r.size;
          await check();
        }
      }
      // Save as-is reproduces the edited bytes. The pretty save runs the formatter chunked through the
      // pool; it must equal the single-pass formatter over the same bytes (format.test.ts proves that
      // one against JSON.stringify) and parse to the same value. JSON.stringify itself is not the
      // expected value here: it reorders integer-like keys a rename can produce, and the save keeps source order.
      const asIs = await save(host, documentId, null);
      expect(Array.from(asIs)).toEqual(Array.from(model));
      const prettySaved = await save(host, documentId, 2);
      expect(Array.from(prettySaved)).toEqual(Array.from(formatBytes(model, { indent: 2 })));
      expect(readJson(prettySaved)).toEqual(readJson(model));
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  };

  it.live.prop(
    "a sequence of value and key edits with undo and redo matches a byte-splice model, and the tape matches a fresh index",
    [script],
    ([input]) => Effect.promise(() => runScript(input)),
    options,
  );

  it.live.prop(
    "the same holds for keys and values written with escapes, renamed to more of them",
    [escapedScript],
    ([raw]) => Effect.promise(() => runScript(escapedInput(raw) as typeof Script.Type)),
    { arbitrary: { runs: 200 } },
  );

  // A token budget of 4 makes the index cut every container below the root: edits land on bucket tapes.
  it.live.prop(
    "the same holds when containers are cut and their children live on bucket tapes",
    [script],
    ([input]) => Effect.promise(() => runScript(input, { tokenBudget: 4 })),
    options,
  );

  it("an edit inside an array the eager index cut re-indexes the element, not the array", async () => {
    const host = new EngineHost(platform(2), { regionBytes: 256, tokenBudget: 4 });
    const items = Array.from({ length: 3000 }, (_, id) => ({ id, name: `item ${id}` }));
    const bytes = utf8.encode(JSON.stringify(items));
    const { documentId, root } = await open(host, bytes);
    expect(root.childrenIndexed).toBe(false);
    const found = await host.handle({
      _tag: "pathQuery",
      documentId,
      path: "$[2500].name",
      limit: 1,
    });
    const name = (found.results[0] as { node: NodeSummary }).node;
    const result = await host.handle({ _tag: "setValue", ref: name.ref, json: '"edited"' });
    // The reply is the edited value itself, re-indexed on its own; the root keeps its children.
    expect(result.node.kind).toBe("string");
    expect(result.node.span.end - result.node.span.start).toBe('"edited"'.length);
    expect((await host.handle({ _tag: "node", ref: root.ref })).childCount).toBe(3000);
    const page = await host.handle({ _tag: "children", ref: root.ref, from: 2500, count: 1 });
    const element = page.nodes[0] as NodeSummary;
    const members = await children(host, element);
    expect(
      await host.handle({ _tag: "text", ref: (members[1] as NodeSummary).ref, limit: 64 }),
    ).toMatchObject({
      text: "edited",
    });
    // The view of the element from a byte offset names it by its index, as before the edit.
    const path = await host.handle({ _tag: "nodeAt", documentId, offset: result.node.span.start });
    expect(path.path.map((step) => step.index)).toEqual([null, 2500, 1]);
    items[2500] = { id: 2500, name: "edited" };
    expect(readJson(await save(host, documentId, null))).toEqual(items);
    await host.handle({ _tag: "undo", documentId });
    expect(readJson(await save(host, documentId, null))).toEqual(
      items.map((item, id) => (id === 2500 ? { id, name: `item ${id}` } : item)),
    );
    await host.handle({ _tag: "close", documentId });
  });

  /**
   * Search counts and first offsets after parent and nested edits match a naive scan of the saved
   * bytes. The model keeps the parent as a value whose `body` is the child's compact JSON, and a
   * history that follows the engine's undo stack: a parent edit over a dirty child first commits
   * the child's bytes as an entry of its own and purges the child's entries.
   */
  const runNestedSearchScript = async ({ inner, after, steps }: typeof NestedScript.Type) => {
    const host = new EngineHost(platform(2), { regionBytes: 64, appendChunkBytes: 5 });
    type Model = { body: unknown; after: unknown };
    type Entry = { model: Model; child: unknown; kind: "initial" | "parent" | "child" | "commit" };
    let model: Model = { body: JSON.stringify(inner), after };
    let child: unknown = inner;
    const { documentId, root } = await open(host, utf8.encode(JSON.stringify(model)));
    let history: Entry[] = [{ model, child, kind: "initial" }];
    const check = async (needles: ReadonlyArray<string>) => {
      const saved = await save(host, documentId, null);
      expect(Array.from(saved)).toEqual(Array.from(utf8.encode(JSON.stringify(model))));
      const fresh = await open(host, saved, "saved.json");
      try {
        for (const needle of needles) {
          if (needle.length === 0) continue;
          expect(await searchAll(host, documentId, needle, saved.byteLength)).toEqual(
            await searchAll(host, fresh.documentId, needle, saved.byteLength),
          );
        }
      } finally {
        await host.handle({ _tag: "close", documentId: fresh.documentId });
      }
    };
    try {
      for (const step of steps) {
        const [bodyNode, afterNode] = await children(
          host,
          await host.handle({ _tag: "node", ref: root.ref }),
        );
        const json = JSON.stringify(step.value);
        const expandable = typeof child === "object" && child !== null;
        if (step.where === "child" && expandable) {
          const expanded = await host.handle({
            _tag: "expandNested",
            ref: (bodyNode as NodeSummary).ref,
          });
          const nodes = await walk(host, expanded.root);
          const paths = pathsOf(child);
          expect(nodes.length).toBe(paths.length);
          const index = Math.min(nodes.length - 1, Math.floor(step.pick * nodes.length));
          await host.handle({ _tag: "setValue", ref: (nodes[index] as NodeSummary).ref, json });
          child = setAt(child, paths[index] as ReadonlyArray<string | number>, step.value);
          model = { body: JSON.stringify(child), after: model.after };
          history.push({ model, child, kind: "child" });
        } else {
          // A parent edit: the body string itself (which commits and drops the child) or `after`.
          const onBody = step.where === "parent" && step.pick < 0.5;
          const target = onBody ? bodyNode : afterNode;
          await host.handle({ _tag: "setValue", ref: (target as NodeSummary).ref, json });
          if (onBody) {
            if (history.some((entry) => entry.kind === "child")) {
              history = history.filter((entry) => entry.kind !== "child");
              history.push({ model, child, kind: "commit" });
            }
            model = { body: step.value, after: model.after };
            child = typeof step.value === "string" ? compactJsonOrNull(step.value) : null;
          } else model = { body: model.body, after: step.value };
          history.push({ model, child, kind: "parent" });
        }
        const text = JSON.stringify(model);
        const at = Math.floor(step.needleAt * text.length);
        await check([text.slice(at, at + step.needleLength), json.slice(0, 3), '\\"', "\\\\"]);
        if (step.undo && history.length > 1) {
          await host.handle({ _tag: "undo", documentId });
          history.pop();
          ({ model, child } = history[history.length - 1] as Entry);
          await check([text.slice(at, at + step.needleLength), '\\"']);
        }
      }
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  };

  it.live.prop(
    "search after parent and nested edits counts exactly the hits a scan of the saved bytes finds, at the same offsets",
    [nestedScript],
    ([input]) => Effect.promise(() => runNestedSearchScript(input)),
    options,
  );

  it("replays a nested edit followed by a search for the old text", () =>
    runNestedSearchScript({
      inner: { note: "old-note", k: null },
      after: "",
      steps: [
        { where: "child", pick: 0.5, value: "new-note", needleAt: 0, needleLength: 0, undo: false },
      ],
    }));

  it("replays a key rename followed by a pretty save (a shrunk counterexample)", () =>
    runScript({
      document: { a: 0, list: [], nested: { k: [], s: "" } },
      pretty: false,
      steps: [{ pick: 1 / 3, value: false, key: "6", undo: false, redo: true, layout: 1 }],
    }));

  it("keeps a key written with a control-character escape through renames, undo and redo (a shrunk counterexample)", () =>
    runScript({
      document: { a: false, list: [], nested: { k: null, s: "" } },
      pretty: false,
      steps: [
        {
          pick: 0,
          value: { "]@": { "": "", "\u0000": null, "\u000f": false } },
          key: "",
          undo: false,
          redo: false,
          layout: 0,
        },
        {
          pick: 2.301828463900887e-230,
          value: null,
          key: "B.|p\\1)jU",
          undo: false,
          redo: false,
          layout: 1,
        },
        {
          pick: 1.4642458284103138e-277,
          value: -1.1527204832130779e-138,
          key: null,
          undo: true,
          redo: true,
          layout: 0,
        },
        {
          pick: 8.05574979532266e-17,
          value: "?]Wsh)",
          key: "]f6;t%3",
          undo: true,
          redo: true,
          layout: 0,
        },
        {
          pick: 2.274159890621427e-153,
          value: null,
          key: null,
          undo: false,
          redo: true,
          layout: 0,
        },
        {
          pick: 1.0376420415415969e-302,
          value: false,
          key: null,
          undo: true,
          redo: false,
          layout: 1,
        },
        { pick: 0, value: "", key: "'", undo: false, redo: false, layout: 0 },
      ],
    }));

  it("refuses an edit that leaves no valid value up to the root, and leaves the bytes alone", async () => {
    const host = new EngineHost(platform(2), { regionBytes: 32 });
    const bytes = utf8.encode('{"a": [1, 2, 3], "b": "x"}');
    const { documentId, root } = await open(host, bytes);
    const a = (await children(host, root))[0] as NodeSummary;
    await expect(
      host.handle({ _tag: "setValue", ref: a.ref, json: "[1, 2" }),
    ).rejects.toBeInstanceOf(InvalidEditError);
    // An unbalanced bracket is not a value anywhere up to the root.
    await expect(
      host.handle({
        _tag: "replaceBytes",
        documentId,
        tapeId: 0,
        range: { start: 0, end: 1 },
        bytes: utf8.encode("{{"),
      }),
    ).rejects.toBeInstanceOf(InvalidEditError);
    expect(Array.from(await logical(host, documentId, bytes.byteLength))).toEqual(
      Array.from(bytes),
    );
    expect(await materialize(host, root)).toEqual({ a: [1, 2, 3], b: "x" });
    await expect(host.handle({ _tag: "undo", documentId })).rejects.toBeInstanceOf(
      NothingToUndoError,
    );
    await host.handle({ _tag: "close", documentId });
  });

  it("a source edit across members re-indexes the parent, and refs under the old members are stale", async () => {
    const host = new EngineHost(platform(2), { regionBytes: 32 });
    const bytes = utf8.encode('{"a": 1, "b": 2, "c": {"d": 3}}');
    const { documentId, root } = await open(host, bytes);
    const [a, b, c] = await children(host, root);
    const d = (await children(host, c as NodeSummary))[0] as NodeSummary;
    // Delete `"a": 1, ` — the enclosing value is the root object.
    const result = await host.handle({
      _tag: "replaceBytes",
      documentId,
      tapeId: 0,
      range: { start: 1, end: 9 },
      bytes: new Uint8Array(0),
    });
    expect(result.node.kind).toBe("object");
    expect(result.node.childCount).toBe(2);
    expect(await materialize(host, result.node)).toEqual({ b: 2, c: { d: 3 } });
    // The root ref keeps working (it is answered from the side tape); the dead members do not.
    expect(await materialize(host, root)).toEqual({ b: 2, c: { d: 3 } });
    for (const stale of [a, b, d] as NodeSummary[]) {
      await expect(host.handle({ _tag: "node", ref: stale.ref })).rejects.toBeInstanceOf(
        NodeNotFoundError,
      );
    }
    // Inserting a member after `b` through the source view: the enclosing object re-indexes again.
    const text = new TextDecoder().decode(await logical(host, documentId, result.size));
    const at = text.indexOf(", ");
    const insert = utf8.encode(', "e": [true]');
    const grown = await host.handle({
      _tag: "replaceBytes",
      documentId,
      tapeId: 0,
      range: { start: at, end: at },
      bytes: insert,
    });
    expect(await materialize(host, grown.node)).toEqual({ b: 2, e: [true], c: { d: 3 } });
    expect(grown.undoDepth).toBe(2);
    const undone = await host.handle({ _tag: "undo", documentId });
    expect(await materialize(host, undone.node)).toEqual({ b: 2, c: { d: 3 } });
    await host.handle({ _tag: "close", documentId });
  });

  it("re-indexes a big value through the worker pool and still answers children in buckets", async () => {
    const host = new EngineHost(platform(3), {
      regionBytes: 4096,
      inProcessRegionBytes: 0,
      tokenBudget: 200,
    });
    const items = Array.from({ length: 3000 }, (_, i) => ({ i, name: `item ${i}` }));
    const bytes = utf8.encode(JSON.stringify({ items, tail: "end" }));
    const { documentId, root } = await open(host, bytes);
    const [itemsNode] = await children(host, root);
    expect((itemsNode as NodeSummary).childrenIndexed).toBe(false);
    const result = await host.handle({
      _tag: "setValue",
      ref: (itemsNode as NodeSummary).ref,
      json: JSON.stringify(items.slice(0, 2500)),
    });
    expect(result.node.childCount).toBe(2500);
    const page = await host.handle({
      _tag: "children",
      ref: result.node.ref,
      from: 2000,
      count: 10,
    });
    expect(page.nodes.length).toBe(10);
    expect(await materialize(host, page.nodes[3] as NodeSummary)).toEqual({
      i: 2003,
      name: "item 2003",
    });
    expect(
      await materialize(
        host,
        (
          await children(host, await host.handle({ _tag: "node", ref: root.ref }))
        )[1] as NodeSummary,
      ),
    ).toBe("end");
    const saved = await save(host, documentId, null);
    expect(readJson(saved)).toEqual({ items: items.slice(0, 2500), tail: "end" });
    await host.handle({ _tag: "close", documentId });
  });

  it("edits inside a nested stringified document re-escape into the parent on read and on save", async () => {
    const host = new EngineHost(platform(2), { regionBytes: 64 });
    const leaf = { kind: "leaf", note: 'knots "é" 🧵', n: [1, 2] };
    const inner = JSON.stringify({ kind: "inner", leaf: JSON.stringify(leaf) });
    const parent = { log: { body: inner, after: "z" } };
    const bytes = utf8.encode(JSON.stringify(parent, null, 2));
    const { documentId, root } = await open(host, bytes);
    const log = (await children(host, root))[0] as NodeSummary;
    const [body, after] = await children(host, log);
    const level1 = await host.handle({ _tag: "expandNested", ref: (body as NodeSummary).ref });
    const [, leafString] = await children(host, level1.root);
    const level2 = await host.handle({
      _tag: "expandNested",
      ref: (leafString as NodeSummary).ref,
    });
    const [, note] = await children(host, level2.root);
    // Edit two levels down.
    const edited = await host.handle({
      _tag: "setValue",
      ref: (note as NodeSummary).ref,
      json: JSON.stringify('new "note"\n'),
    });
    expect(edited.node.kind).toBe("string");
    expect((await host.handle({ _tag: "text", ref: edited.node.ref, limit: 1000 })).text).toBe(
      'new "note"\n',
    );
    // The parent's string now reads as the re-escaped child, and the whole document still parses to the edit.
    const expectedLeaf = { ...leaf, note: 'new "note"\n' };
    const expectedInner = JSON.stringify({ kind: "inner", leaf: JSON.stringify(expectedLeaf) });
    expect(
      (await host.handle({ _tag: "text", ref: (body as NodeSummary).ref, limit: MAX_SLICE_BYTES }))
        .text,
    ).toBe(expectedInner);
    const rootNow = await host.handle({ _tag: "node", ref: root.ref });
    const whole = await host.handle({
      _tag: "logicalSlice",
      documentId,
      tapeId: 0,
      range: { start: 0, end: 1 << 20 },
    });
    expect(rootNow.span).toEqual({ start: 0, end: whole.byteLength });
    expect(readJson(whole)).toEqual({ log: { body: expectedInner, after: "z" } });
    // Byte-exact: the parent's layout is untouched outside the string.
    const expectedBytes = utf8.encode(
      JSON.stringify({ log: { body: expectedInner, after: "z" } }, null, 2),
    );
    expect(Array.from(whole)).toEqual(Array.from(expectedBytes));
    expect(Array.from(await save(host, documentId, null))).toEqual(Array.from(expectedBytes));
    expect(Array.from(await save(host, documentId, 2))).toEqual(Array.from(expectedBytes));
    // Search sees the re-escaped child, two levels down, at the offsets the saved bytes have.
    const expectedText = new TextDecoder().decode(expectedBytes);
    const find = (text: string) => searchAll(host, documentId, text, expectedBytes.byteLength);
    expect(await find("knots")).toEqual({ count: 0, ranges: [] });
    // The edited text as the file spells it: the quote is escaped once per level, seven backslashes deep.
    const escapedTwice = JSON.stringify(expectedInner);
    const newAt = escapedTwice.indexOf("new ");
    const needle = escapedTwice.slice(newAt, escapedTwice.indexOf("note", newAt) + 4);
    expect(needle).toBe(`new ${"\\".repeat(7)}"note`);
    // Search matches the text with one level of escapes decoded, and the hit covers the escapes.
    const at = expectedText.indexOf(needle);
    expect(await find(`new ${"\\".repeat(3)}"note`)).toEqual({
      count: 1,
      ranges: [{ start: at, end: at + needle.length }],
    });
    // A sibling after the string moved by the escaped growth.
    const afterNow = await host.handle({ _tag: "node", ref: (after as NodeSummary).ref });
    const shift = expectedBytes.byteLength - bytes.byteLength;
    expect(afterNow.span).toEqual({
      start: (after as NodeSummary).span.start + shift,
      end: (after as NodeSummary).span.end + shift,
    });
    // Undo restores the original bytes exactly.
    await host.handle({ _tag: "undo", documentId });
    expect(Array.from(await logical(host, documentId, bytes.byteLength))).toEqual(
      Array.from(bytes),
    );
    // A parent edit over the string drops the child: its refs are gone, the parent's bytes win.
    await host.handle({ _tag: "redo", documentId });
    const replaced = await host.handle({
      _tag: "setValue",
      ref: (body as NodeSummary).ref,
      json: '"plain"',
    });
    expect(await materialize(host, replaced.node)).toBe("plain");
    await expect(host.handle({ _tag: "node", ref: level1.root.ref })).rejects.toBeInstanceOf(
      NodeNotFoundError,
    );
    expect(readJson(await save(host, documentId, null))).toEqual({
      log: { body: "plain", after: "z" },
    });
    await host.handle({ _tag: "close", documentId });
  });

  it("pretty and minified saves of an unedited document are the formatter's bytes, streamed through the pool", async () => {
    const host = new EngineHost(platform(4), { regionBytes: 1024 });
    const value = {
      entries: Array.from({ length: 500 }, (_, i) => ({
        id: i,
        tags: ["a", "b"],
        ok: i % 2 === 0,
        body: `line\n${i}`,
      })),
    };
    const bytes = utf8.encode(JSON.stringify(value, null, 4));
    const { documentId } = await open(host, bytes);
    expect(Array.from(await save(host, documentId, 2))).toEqual(
      Array.from(utf8.encode(JSON.stringify(value, null, 2))),
    );
    expect(Array.from(await save(host, documentId, 0))).toEqual(
      Array.from(utf8.encode(JSON.stringify(value))),
    );
    expect(Array.from(await save(host, documentId, null))).toEqual(Array.from(bytes));
    expect(Array.from(await save(host, documentId, 2))).toEqual(
      Array.from(formatBytes(bytes, { indent: 2 })),
    );
    await host.handle({ _tag: "close", documentId });
  });
});

/** Saves through a writable stream and returns every byte the sink received, in order. */
const save = async (host: EngineHost, documentId: number, indent: number | null) => {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk);
    },
  });
  const result = await host.handle({
    _tag: "save",
    documentId,
    sink: { _tag: "writable", stream },
    indent,
  });
  const out = concat(...chunks);
  expect(result.bytes).toBe(out.byteLength);
  return out;
};
