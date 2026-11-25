import {
  DiffCancelledError,
  DiffTooLargeError,
  MAX_STRUCTURAL_DIFF_BYTES,
} from "@quipu/contracts/diff";
import { describe, expect, it } from "vite-plus/test";

import { decodeUtf8, parseJsonSlice } from "../boundedSlice.ts";
import { decodeKey, isCleanIndex } from "../decode.ts";
import { indexBytes } from "../indexBuffer.ts";
import { firstChild, KIND_ARRAY, KIND_OBJECT, TapeBuilder, type Tape } from "../tape.ts";
import { createPrng, type Prng } from "../testing/samples.ts";
import {
  diffJsonBytes,
  diffTapes,
  formatChangeSummary,
  indexJsonForDiff,
  type StructuralDiff,
  type StructuralInput,
} from "./structural.ts";

const ENCODER = new TextEncoder();
const DECODER_JSON = (bytes: Uint8Array) => parseJsonSlice(bytes);

type JsonVal = null | boolean | number | string | JsonVal[] | { [key: string]: JsonVal };

function encodeJson(value: JsonVal): Uint8Array {
  return ENCODER.encode(JSON.stringify(value));
}

function nodeToJson(doc: StructuralInput, token: number): JsonVal {
  const kind = doc.tape.kind(token);
  if (kind === KIND_OBJECT) {
    const out: Record<string, JsonVal> = {};
    let c = firstChild(doc.tape, token);
    while (c >= 0) {
      const k = decodeKey(doc.tape, c, doc.bytes) ?? "";
      out[k] = nodeToJson(doc, c);
      c = doc.tape.next(c);
    }
    return out;
  }
  if (kind === KIND_ARRAY) {
    const out: JsonVal[] = [];
    let c = firstChild(doc.tape, token);
    while (c >= 0) {
      out.push(nodeToJson(doc, c));
      c = doc.tape.next(c);
    }
    return out;
  }
  const raw = decodeUtf8(doc.bytes.subarray(doc.tape.start(token), doc.tape.end(token)));
  return DECODER_JSON(ENCODER.encode(raw)) as JsonVal;
}

/** Rebuild `b` from `a` + diff: unchanged nodes pull from `a`, added/changed pull from `b`. */
function applyDiff(
  a: StructuralInput,
  b: StructuralInput,
  diff: StructuralDiff,
  bn: number,
): JsonVal {
  const mark = diff.markB(bn);
  if (mark === "added" || mark === "changed") return nodeToJson(b, bn);
  const an = diff.inA(bn);
  expect(an).not.toBeNull();
  const kind = b.tape.kind(bn);
  if (kind === KIND_OBJECT) {
    const out: Record<string, JsonVal> = {};
    let c = firstChild(b.tape, bn);
    while (c >= 0) {
      const k = decodeKey(b.tape, c, b.bytes) ?? "";
      out[k] = applyDiff(a, b, diff, c);
      c = b.tape.next(c);
    }
    return out;
  }
  if (kind === KIND_ARRAY) {
    const out: JsonVal[] = [];
    let c = firstChild(b.tape, bn);
    while (c >= 0) {
      out.push(applyDiff(a, b, diff, c));
      c = b.tape.next(c);
    }
    return out;
  }
  expect(mark === "same" || mark === "moved").toBe(true);
  return nodeToJson(a, an as number);
}

function checkInvariants(
  va: JsonVal,
  vb: JsonVal,
): {
  a: StructuralInput;
  b: StructuralInput;
  diff: StructuralDiff;
  summary: string[];
} {
  const a = indexJsonForDiff(encodeJson(va));
  const b = indexJsonForDiff(encodeJson(vb));
  const diff = diffTapes(a, b);
  expect(applyDiff(a, b, diff, 0)).toEqual(vb);

  for (let id = 0; id < a.tape.count; id++) {
    if (diff.inB(id) === null) {
      const m = diff.markA(id);
      expect(m === "removed" || m === "changed").toBe(true);
    }
  }
  for (const c of diff.changes) {
    if (c.kind === "added") expect(diff.markB(c.bToken as number)).toBe("added");
    if (c.kind === "removed") expect(diff.markA(c.aToken as number)).toBe("removed");
    if (c.kind === "changed") expect(diff.markB(c.bToken as number)).toBe("changed");
    if (c.kind === "moved") expect(diff.markB(c.bToken as number)).toBe("moved");
  }

  const rows = diff.merged(a, b);
  expect(rows.filter((r) => r.bToken !== null).length).toBe(b.tape.count);
  let removedCount = 0;
  for (let i = 0; i < a.tape.count; i++) {
    if (diff.markA(i) === "removed") removedCount++;
  }
  expect(rows.filter((r) => r.bToken === null).length).toBe(removedCount);

  return {
    a,
    b,
    diff,
    summary: diff.changes.map(formatChangeSummary),
  };
}

describe("structural JSON diff", () => {
  it("identical documents have no changes", () => {
    const v = { a: [1, { b: null }], c: "x" };
    const { diff } = checkInvariants(v, v);
    expect(diff.isEmpty()).toBe(true);
    expect(diff.marksB.every((m) => m === "same")).toBe(true);
  });

  it("ignores object key order and number formatting", () => {
    const a = indexJsonForDiff(ENCODER.encode('{"a":1,"b":{"x":1.0,"y":[2]}}'));
    const b = indexJsonForDiff(ENCODER.encode('{"b":{"y":[2],"x":1},"a":1e0}'));
    const diff = diffTapes(a, b);
    expect(diff.isEmpty()).toBe(true);
    // Token index of /b/y/0 in a and b should pair cleanly.
    const findTokenByKey = (tape: Tape, bytes: Uint8Array, target: string) => {
      for (let i = 0; i < tape.count; i++) {
        if (decodeKey(tape, i, bytes) === target) return i;
      }
      return -1;
    };
    const ay = firstChild(a.tape, findTokenByKey(a.tape, a.bytes, "y"));
    const by = firstChild(b.tape, findTokenByKey(b.tape, b.bytes, "y"));
    expect(diff.inB(ay)).toBe(by);
  });

  it("matches object members by key", () => {
    const { a, b, diff, summary } = checkInvariants(
      { age: 36, gone: [1, 2], langs: { en: true }, name: "Ada" },
      { age: 36, langs: { en: true, fr: false }, name: "Ada Lovelace", new: null },
    );
    expect(summary).toEqual(["added /langs/fr", "changed /name", "added /new", "removed /gone"]);
    const rows = diff.merged(a, b).map((r) => ({
      mark: r.mark,
      depth: r.depth,
      key: r.key,
      kind: r.kind,
      wasValue: r.wasValue,
    }));
    expect(rows).toEqual([
      { mark: "inside", depth: 0, key: null, kind: "object", wasValue: null },
      { mark: "same", depth: 1, key: "age", kind: "number", wasValue: null },
      { mark: "removed", depth: 1, key: "gone", kind: "array", wasValue: null },
      { mark: "removed", depth: 2, key: null, kind: "number", wasValue: null },
      { mark: "removed", depth: 2, key: null, kind: "number", wasValue: null },
      { mark: "inside", depth: 1, key: "langs", kind: "object", wasValue: null },
      { mark: "same", depth: 2, key: "en", kind: "true", wasValue: null },
      { mark: "added", depth: 2, key: "fr", kind: "false", wasValue: null },
      { mark: "changed", depth: 1, key: "name", kind: "string", wasValue: '"Ada"' },
      { mark: "added", depth: 1, key: "new", kind: "null", wasValue: null },
    ]);
  });

  it("matches arrays by identity key", () => {
    const { a, b, diff, summary } = checkInvariants(
      {
        users: [
          { id: 1, n: "a" },
          { id: 2, n: "b" },
          { id: 3, n: "c" },
          { id: 4, n: "d" },
        ],
      },
      {
        users: [
          { id: 3, n: "c" },
          { id: 1, n: "A" },
          { id: 2, n: "b" },
          { id: 5, n: "e" },
        ],
      },
    );
    expect(summary).toEqual([
      "moved /users/2 to /users/0",
      "changed /users/1/n (was /users/0/n)",
      "added /users/3",
      "removed /users/3",
    ]);
    const rows = diff.merged(a, b);
    expect(rows.map((r) => [r.mark, r.depth, r.key ?? r.index])).toEqual([
      ["inside", 0, null],
      ["inside", 1, "users"],
      ["moved", 2, 0],
      ["same", 3, "id"],
      ["same", 3, "n"],
      ["removed", 2, 3],
      ["removed", 3, "id"],
      ["removed", 3, "n"],
      ["inside", 2, 1],
      ["same", 3, "id"],
      ["changed", 3, "n"],
      ["same", 2, 2],
      ["same", 3, "id"],
      ["same", 3, "n"],
      ["added", 2, 3],
      ["added", 3, "id"],
      ["added", 3, "n"],
    ]);
  });

  it("matches arrays without identity key via Myers LCS and move detection", () => {
    const { a, b, diff, summary } = checkInvariants(
      ["a", "b", "c", "d", "e", { k: 1 }],
      ["a", "c", "x", "d", "b", { k: 2 }, "f"],
    );
    expect(summary).toEqual([
      "added /2",
      "moved /1 to /4",
      "changed /5/k",
      "added /6",
      "removed /4",
    ]);
    const rows = diff.merged(a, b);
    expect(rows.map((r) => [r.mark, r.depth, r.pointer])).toEqual([
      ["inside", 0, ""],
      ["same", 1, "/0"],
      ["same", 1, "/1"],
      ["added", 1, "/2"],
      ["same", 1, "/3"],
      ["removed", 1, "/4"],
      ["moved", 1, "/4"],
      ["inside", 1, "/5"],
      ["changed", 2, "/5/k"],
      ["added", 1, "/6"],
    ]);
  });

  it("replaces entire subtree when node kind changes", () => {
    const { a, b, diff, summary } = checkInvariants(
      { v: [1, 2], w: { x: 1 } },
      { v: { "0": 1 }, w: "x" },
    );
    expect(summary).toEqual(["changed /v", "changed /w"]);
    expect(diff.merged(a, b).map((r) => [r.mark, r.pointer])).toEqual([
      ["inside", ""],
      ["changed", "/v"],
      ["changed", "/v/0"],
      ["changed", "/w"],
    ]);
  });

  it("falls back to LCS when identity key is non-unique or missing on an element", () => {
    const dup = checkInvariants(
      [
        { id: 1, v: 1 },
        { id: 1, v: 2 },
      ],
      [
        { id: 1, v: 2 },
        { id: 1, v: 3 },
      ],
    );
    expect(dup.summary).toEqual(["added /1", "removed /0"]);

    const partial = checkInvariants(
      [{ name: "x", v: 1 }, { v: 2 }],
      [{ v: 2 }, { name: "x", v: 1 }],
    );
    expect(partial.summary).toEqual(["moved /0 to /1"]);
  });

  it("supports uuid, _id, and key identity matching", () => {
    const res = diffJsonBytes(
      encodeJson([
        { uuid: "u1", val: 1 },
        { uuid: "u2", val: 2 },
      ]),
      encodeJson([
        { uuid: "u2", val: 20 },
        { uuid: "u1", val: 1 },
      ]),
    );
    expect(res.changes.map(formatChangeSummary)).toEqual([
      "moved /1 to /0",
      "changed /0/val (was /1/val)",
    ]);
  });

  it("navigates nextChange and previousChange with wrap-around", () => {
    const a = indexJsonForDiff(encodeJson({ x: 1, y: [1], z: 3 }));
    const b = indexJsonForDiff(encodeJson({ x: 2, y: [], z: 4 }));
    const diff = diffTapes(a, b);
    expect(diff.changes.map(formatChangeSummary)).toEqual([
      "changed /x",
      "removed /y/0",
      "changed /z",
    ]);
    const tokenOf = (ptr: string) => {
      const row = diff.merged(a, b).find((r) => r.pointer === ptr && r.bToken !== null);
      return row?.bToken ?? 0;
    };
    const nextFromRoot = diff.nextChange(a.tape, 0);
    expect(formatChangeSummary(nextFromRoot!)).toBe("changed /x");
    const nextFromX = diff.nextChange(a.tape, tokenOf("/x"));
    expect(formatChangeSummary(nextFromX!)).toBe("removed /y/0");
    const wrapFromZ = diff.nextChange(a.tape, tokenOf("/z"));
    expect(formatChangeSummary(wrapFromZ!)).toBe("changed /x");
    const prevFromZ = diff.previousChange(a.tape, tokenOf("/z"));
    expect(formatChangeSummary(prevFromZ!)).toBe("removed /y/0");
    const wrapPrevFromRoot = diff.previousChange(a.tape, 0);
    expect(formatChangeSummary(wrapPrevFromRoot!)).toBe("changed /z");
  });

  it("reports monotonic progress and supports cancellation", () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({ id: i, v: `item_${i}` }));
    const bytes = encodeJson(items);
    const a = indexJsonForDiff(bytes);
    const seen: number[] = [];
    diffTapes(a, a, {
      onProgress: (f) => {
        seen.push(f);
        return true;
      },
    });
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] as number).toBeGreaterThanOrEqual(seen[i - 1] as number);
    }
    expect(seen[seen.length - 1]).toBe(1);

    expect(() =>
      diffTapes(a, a, {
        onProgress: () => false,
      }),
    ).toThrow(DiffCancelledError);
  });

  it("refuses unexpanded tapes or documents over 256 MiB with a clear HAR guidance error", () => {
    const bytes = encodeJson({ items: [1, 2, 3] });
    const { tape } = indexBytes(bytes, 0, { maxDepth: 1, chunkBytes: 1024 });
    expect(isCleanIndex(tape, bytes)).toBe(true);
    expect(() => diffTapes({ tape, bytes }, { tape, bytes })).toThrow(DiffTooLargeError);
    try {
      diffTapes({ tape, bytes }, { tape, bytes });
    } catch (err) {
      expect((err as Error).message).toContain("HAR entry diff");
    }

    const oversized = {
      tape: new TapeBuilder(1),
      bytes: { byteLength: MAX_STRUCTURAL_DIFF_BYTES + 1 } as Uint8Array,
    };
    expect(() => diffTapes(oversized, { tape, bytes })).toThrow(DiffTooLargeError);
  });

  it("satisfies apply round-trip invariants over 50 random document mutations", () => {
    const prng = createPrng(2026);
    const genVal = (rng: Prng, depth: number): JsonVal => {
      if (depth <= 0 || rng.chance(0.45)) {
        const pick = rng.int(4);
        if (pick === 0) return null;
        if (pick === 1) return rng.chance(0.5);
        if (pick === 2) return rng.range(-5, 5);
        return rng.chance(0.5) ? "aa" : "bb";
      }
      const branch = rng.int(3);
      if (branch === 0) {
        const len = rng.int(5);
        return Array.from({ length: len }, () => genVal(rng, depth - 1));
      }
      if (branch === 1) {
        const obj: Record<string, JsonVal> = {};
        for (const k of ["a", "b", "c", "d"]) {
          if (rng.chance(0.6)) obj[k] = genVal(rng, depth - 1);
        }
        return obj;
      }
      const len = rng.int(5);
      const used = new Set<number>();
      const out: JsonVal[] = [];
      for (let i = 0; i < len; i++) {
        const id = rng.int(10);
        if (used.has(id)) continue;
        used.add(id);
        out.push({ id, v: genVal(rng, depth - 1) });
      }
      return out;
    };

    const mutateVal = (val: JsonVal, rng: Prng): JsonVal => {
      const clone = JSON.parse(JSON.stringify(val)) as JsonVal;
      const walk = (node: JsonVal): JsonVal => {
        if (Array.isArray(node) && node.length > 0) {
          const op = rng.int(4);
          if (op === 0) {
            node.splice(rng.int(node.length), 1);
          } else if (op === 1) {
            const [item] = node.splice(rng.int(node.length), 1);
            node.splice(rng.int(node.length + 1), 0, item as JsonVal);
          } else if (op === 2) {
            node.push("new");
          } else {
            const idx = rng.int(node.length);
            node[idx] = walk(node[idx] as JsonVal);
          }
          return node;
        }
        if (node !== null && typeof node === "object" && !Array.isArray(node)) {
          const keys = Object.keys(node);
          if (keys.length > 0) {
            const k = keys[rng.int(keys.length)] as string;
            const op = rng.int(3);
            if (op === 0) delete node[k];
            else if (op === 1) node.z = 7;
            else node[k] = walk(node[k] as JsonVal);
            return node;
          }
        }
        return ["changed"];
      };
      return walk(clone);
    };

    for (let i = 0; i < 50; i++) {
      const va = genVal(prng, 3);
      const vb = mutateVal(va, prng);
      checkInvariants(va, vb);
      checkInvariants(vb, va);
    }
  });
});
