import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { boxesIntersect, type Box } from "./geometry.ts";
import { createSpatialIndex } from "./spatialIndex.ts";

const coordinate = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: -500, maximum: 500 })),
);
const extent = Arbitrary.schema(
  Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
);
const box = Arbitrary.all([coordinate, coordinate, extent, extent]).pipe(
  Arbitrary.map(([x, y, width, height]): Box => ({ x, y, width, height })),
);
const boxes = Arbitrary.array(box, { maxLength: 80 });

describe("spatial index", () => {
  it.prop(
    "a search returns exactly the boxes a brute-force scan finds, after inserts and removals",
    [boxes, box, Arbitrary.array(Arbitrary.schema(Schema.Boolean), { maxLength: 80 })],
    ([items, query, removals]) => {
      const index = createSpatialIndex();
      items.forEach((item, i) => index.upsert(`b${i}`, item));
      const removed = new Set<string>();
      removals.forEach((remove, i) => {
        if (remove && i < items.length) {
          index.remove(`b${i}`);
          removed.add(`b${i}`);
        }
      });
      const expected = items
        .map((item, i) => ({ id: `b${i}`, item }))
        .filter(({ id, item }) => !removed.has(id) && boxesIntersect(item, query))
        .map(({ id }) => id)
        .sort();
      expect([...index.search(query)].sort()).toEqual(expected);
      expect(index.size()).toBe(items.length - removed.size);
    },
    { arbitrary: { runs: 200 } },
  );

  it("replaces a box on upsert", () => {
    const index = createSpatialIndex();
    index.upsert("a", { x: 0, y: 0, width: 10, height: 10 });
    index.upsert("a", { x: 100, y: 100, width: 10, height: 10 });
    expect(index.search({ x: 0, y: 0, width: 20, height: 20 })).toEqual([]);
    expect(index.search({ x: 90, y: 90, width: 20, height: 20 })).toEqual(["a"]);
  });
});

describe("bulk loading", () => {
  it("replaces the contents in one load and answers box queries over them", () => {
    const index = createSpatialIndex();
    index.upsert("old", { x: 0, y: 0, width: 10, height: 10 });
    index.load(
      Array.from({ length: 1000 }, (_, i): readonly [string, Box] => [
        `n${i}`,
        { x: (i % 50) * 20, y: Math.floor(i / 50) * 20, width: 10, height: 10 },
      ]),
    );
    expect(index.has("old")).toBe(false);
    expect(index.size()).toBe(1000);
    expect(index.search({ x: 0, y: 0, width: 25, height: 25 }).toSorted()).toEqual([
      "n0",
      "n1",
      "n50",
      "n51",
    ]);
  });
});
