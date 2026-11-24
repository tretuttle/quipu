/**
 * Iterative comparison of a tape against the expected value (the reference reader's output).
 * No recursion: json-deep's 100 k levels must not touch the call stack.
 * Containers at the eager depth are expanded on demand, and strings that hold
 * JSON are indexed as child documents over their unescaped bytes, compared
 * against the reference reader's value of the decoded string (`readJson.ts`).
 */
import { decodeKey, isCleanIndex, looksLikeJson, scalarValue, stringBytes } from "../decode.ts";
import { indexBytes } from "../indexBuffer.ts";
import {
  firstChild,
  isContainer,
  KIND_ARRAY,
  KIND_OBJECT,
  KIND_STRING,
  NO_KEY,
  needsExpand,
  type Tape,
} from "../tape.ts";
import { readJson } from "./readJson.ts";

export interface WalkOptions {
  readonly maxDepth: number;
  readonly chunkBytes: number;
  /** Also index strings that look like JSON as child documents. */
  readonly nested: boolean;
}

export interface WalkStats {
  nodes: number;
  expands: number;
  nestedDocuments: number;
  nestedBytes: number;
}

interface Frame {
  readonly tape: Tape;
  readonly bytes: Uint8Array;
  readonly token: number;
  readonly expected: unknown;
  readonly path: string;
}

export const walkAgainst = (
  tape: Tape,
  bytes: Uint8Array,
  expected: unknown,
  options: WalkOptions,
): WalkStats => {
  const stats: WalkStats = { nodes: 0, expands: 0, nestedDocuments: 0, nestedBytes: 0 };
  const stack: Frame[] = [{ tape, bytes, token: 0, expected, path: "$" }];
  const fail = (frame: Frame, message: string): never => {
    throw new Error(
      `${frame.path}: ${message} (token ${frame.token}, bytes ${frame.tape.start(frame.token)}..${frame.tape.end(frame.token)})`,
    );
  };
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const { token } = frame;
    let { tape: t } = frame;
    const kind = t.kind(token);
    stats.nodes++;
    if (isContainer(kind)) {
      const o = frame.expected;
      if (
        kind === KIND_OBJECT
          ? typeof o !== "object" || o === null || Array.isArray(o)
          : !Array.isArray(o)
      ) {
        fail(frame, `kind mismatch: tape says ${kind === KIND_OBJECT ? "object" : "array"}`);
      }
      const expectedCount =
        kind === KIND_ARRAY ? (o as unknown[]).length : Object.keys(o as object).length;
      if (t.childCount(token) !== expectedCount)
        fail(frame, `childCount ${t.childCount(token)} != ${expectedCount}`);
      let child = firstChild(t, token);
      if (child < 0 && needsExpand(t, token)) {
        const start = t.start(token);
        const end = t.end(token);
        const sub = indexBytes(frame.bytes.subarray(start, end), start, {
          maxDepth: Math.max(1, options.maxDepth),
          chunkBytes: options.chunkBytes,
        }).tape;
        stats.expands++;
        if (sub.count === 0 || sub.start(0) !== start || sub.end(0) !== end) {
          fail(
            frame,
            `expand produced a different root (${sub.count} tokens, ${sub.start(0)}..${sub.end(0)})`,
          );
        }
        if (sub.childCount(0) !== expectedCount)
          fail(frame, `expanded childCount ${sub.childCount(0)} != ${expectedCount}`);
        t = sub;
        child = firstChild(t, 0);
      }
      const children: number[] = [];
      while (child >= 0) {
        children.push(child);
        child = t.next(child);
      }
      if (children.length !== expectedCount)
        fail(frame, `linked children ${children.length} != ${expectedCount}`);
      for (let n = children.length - 1; n >= 0; n--) {
        const c = children[n] as number;
        const parentToken = t === frame.tape ? token : 0;
        if (t.parent(c) !== parentToken) fail(frame, `child ${c} parent ${t.parent(c)} wrong`);
        if (t.start(c) <= t.start(parentToken) || t.end(c) >= t.end(parentToken))
          fail(frame, `child ${c} not inside its parent`);
        let childExpected: unknown;
        let path: string;
        if (kind === KIND_ARRAY) {
          childExpected = (o as unknown[])[n];
          path = `${frame.path}[${n}]`;
          if (t.keyStart(c) !== NO_KEY) fail(frame, `array element ${n} carries a key`);
        } else {
          const key = decodeKey(t, c, frame.bytes);
          if (key === undefined) return fail(frame, `object member ${n} has no key`);
          if (!Object.hasOwn(o as object, key))
            fail(frame, `key ${JSON.stringify(key)} not in the expected value`);
          childExpected = (o as Record<string, unknown>)[key];
          path = `${frame.path}.${key}`;
        }
        stack.push({ tape: t, bytes: frame.bytes, token: c, expected: childExpected, path });
      }
      continue;
    }
    const value = scalarValue(t, token, frame.bytes);
    if (
      !Object.is(value, frame.expected) &&
      !(typeof value === "number" && value === frame.expected)
    ) {
      fail(
        frame,
        `value ${JSON.stringify(value)?.slice(0, 80)} != ${JSON.stringify(frame.expected)?.slice(0, 80)}`,
      );
    }
    if (options.nested && kind === KIND_STRING) {
      const raw = stringBytes(frame.bytes, t.start(token), t.end(token));
      if (looksLikeJson(raw)) {
        let parsed: unknown;
        let parses = true;
        try {
          parsed = readJson(raw);
        } catch {
          parses = false;
        }
        const sub = indexBytes(raw, 0, {
          maxDepth: options.maxDepth,
          chunkBytes: options.chunkBytes,
        }).tape;
        const clean = isCleanIndex(sub, raw);
        // The structural pass is not a validator: it may index text a JSON reader rejects. Only the reverse is a bug.
        if (parses && !clean) fail(frame, "nested JSON indexes unclean although it is valid JSON");
        if (parses && clean) {
          stats.nestedDocuments++;
          stats.nestedBytes += raw.length;
          stack.push({
            tape: sub,
            bytes: raw,
            token: 0,
            expected: parsed,
            path: `${frame.path}→json`,
          });
        }
      }
    }
  }
  return stats;
};

/** Depth of the deepest container, following container children iteratively (no recursion). */
export const tapeDepth = (tape: Tape) => {
  let token = 0;
  let depth = 0;
  for (;;) {
    let child = firstChild(tape, token);
    while (child >= 0 && !isContainer(tape.kind(child))) child = tape.next(child);
    if (child < 0) return depth;
    token = child;
    depth++;
  }
};
