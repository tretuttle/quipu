import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { createHistory, MAX_HISTORY_ENTRIES } from "./history.ts";
import { rect } from "./testing.ts";
import type { Element } from "./elements.ts";

const OpSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("move"),
    which: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    dx: Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5 })),
  }),
  Schema.Struct({ kind: Schema.Literal("commit") }),
  Schema.Struct({ kind: Schema.Literal("undo") }),
  Schema.Struct({ kind: Schema.Literal("redo") }),
]);
type Op = typeof OpSchema.Type;
const op = Arbitrary.schema(OpSchema);

/** A naive model: a list of committed snapshots and a cursor. */
function naive(ops: ReadonlyArray<Op>, initial: Element[]): Element[] {
  const snapshots: Element[][] = [initial.map((e) => ({ ...e }))];
  let cursor = 0;
  let working = initial.map((e) => ({ ...e }));
  let dirty = false;
  for (const o of ops) {
    switch (o.kind) {
      case "move": {
        const e = working[o.which];
        if (e) working[o.which] = { ...e, x: e.x + o.dx, version: e.version + 1 };
        dirty = dirty || o.dx !== 0;
        break;
      }
      case "commit":
        if (dirty) {
          snapshots.length = cursor + 1;
          snapshots.push(working.map((e) => ({ ...e })));
          cursor += 1;
        }
        dirty = false;
        break;
      case "undo":
        if (dirty) break;
        if (cursor > 0) cursor -= 1;
        working = (snapshots[cursor] as Element[]).map((e) => ({ ...e }));
        break;
      case "redo":
        if (dirty) break;
        if (cursor < snapshots.length - 1) cursor += 1;
        working = (snapshots[cursor] as Element[]).map((e) => ({ ...e }));
        break;
    }
  }
  return working;
}

describe("history", () => {
  it.prop(
    "inverse deltas agree with a naive snapshot model over any op sequence",
    [Arbitrary.array(op, { maxLength: 60 })],
    ([ops]) => {
      const initial = [
        rect(0, 0, 10, 10),
        rect(20, 0, 10, 10),
        rect(40, 0, 10, 10),
        rect(60, 0, 10, 10),
      ];
      const history = createHistory();
      const live = new Map(initial.map((e) => [e.id, e]));
      const apply = (records: ReadonlyMap<string, Element | null>) => {
        for (const [id, record] of records) {
          if (record === null) live.delete(id);
          else live.set(id, record);
        }
      };
      for (const o of ops) {
        switch (o.kind) {
          case "move": {
            const e = initial[o.which] ? live.get((initial[o.which] as Element).id) : undefined;
            if (!e) break;
            if (o.dx === 0) break;
            const next = { ...e, x: e.x + o.dx, version: e.version + 1 };
            history.track(e.id, e, next);
            live.set(e.id, next);
            break;
          }
          case "commit":
            history.commit();
            break;
          case "undo": {
            if (history.isBatching()) break;
            const entry = history.undo();
            if (entry) apply(entry.before);
            break;
          }
          case "redo": {
            if (history.isBatching()) break;
            const entry = history.redo();
            if (entry) apply(entry.after);
            break;
          }
        }
      }
      const expected = naive(ops, initial);
      const actual = initial.map((e) => live.get(e.id) as Element);
      expect(actual.map((e) => e.x)).toEqual(expected.map((e) => e.x));
    },
    { arbitrary: { runs: 300 } },
  );

  it("keeps at most the newest entries", () => {
    const history = createHistory();
    const a = rect(0, 0, 1, 1);
    for (let i = 1; i <= MAX_HISTORY_ENTRIES + 25; i += 1) {
      history.track(a.id, { ...a, x: i - 1 }, { ...a, x: i });
      history.commit();
    }
    let undone = 0;
    while (history.undo()) undone += 1;
    expect(undone).toBe(MAX_HISTORY_ENTRIES);
  });

  it("an empty commit does not clear the redo stack", () => {
    const history = createHistory();
    const a = rect(0, 0, 1, 1);
    history.track(a.id, a, { ...a, x: 5 });
    history.commit();
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.commit();
    expect(history.canRedo()).toBe(true);
  });
});
