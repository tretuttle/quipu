import { describe, expect, it } from "vite-plus/test";

import {
  detectStringFormat,
  emptyShape,
  inferJsonSlice,
  inferJsonText,
  inferValue,
  mergeShape,
  observeValue,
  shapeToJsonSchema,
  stringShapeEnumValues,
  stringShapeFormat,
} from "./index.ts";

describe("string format detection", () => {
  it("matches string format detection vectors", () => {
    expect(detectStringFormat("2026-10-09T14:30:00.5+02:00")).toBe("date-time");
    expect(detectStringFormat("2026-10-09")).toBe("date");
    expect(detectStringFormat("2026-02-29")).toBeNull();
    expect(detectStringFormat("2024-02-29")).toBe("date");
    expect(detectStringFormat("ada@example.com")).toBe("email");
    expect(detectStringFormat("https://example.com/x")).toBe("uri");
    expect(detectStringFormat("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe("uuid");
    expect(detectStringFormat("2026-13-01")).toBeNull();
    expect(detectStringFormat("hello")).toBeNull();
    expect(detectStringFormat("a@b")).toBeNull();
  });
});

describe("monoid schema inference", () => {
  it("satisfies identity and associativity laws across mergeShape", () => {
    const samplesA = [
      { id: 1, status: "paid", tag: "a", meta: { k: "v" } },
      { id: 2, status: "open", note: null },
    ];
    const samplesB = [
      { id: 3, status: "paid", note: "hello", extra: true },
      { id: 4.5, status: "paid", tag: "b" },
    ];
    const samplesC = [
      { id: 5, status: "refunded", extra: false, tags: ["x", "y"] },
      { id: 6, status: "open", note: "world", tags: [] },
    ];

    const inferList = (items: ReadonlyArray<unknown>) => {
      let s = emptyShape();
      for (const item of items) s = observeValue(s, item);
      return s;
    };

    const a = inferList(samplesA);
    const b = inferList(samplesB);
    const c = inferList(samplesC);

    expect(mergeShape(emptyShape(), a)).toEqual(a);
    expect(mergeShape(a, emptyShape())).toEqual(a);

    const leftAssoc = mergeShape(mergeShape(a, b), c);
    const rightAssoc = mergeShape(a, mergeShape(b, c));
    const whole = inferList([...samplesA, ...samplesB, ...samplesC]);

    expect(leftAssoc).toEqual(rightAssoc);
    expect(leftAssoc).toEqual(whole);
  });

  it("matches element-wise monoid reduction over array elements", () => {
    const items = [
      { id: "0f8fad5b-d9cb-469f-a165-70867728950e", status: "paid", n: 1 },
      { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", status: "open", n: 2.5 },
      { id: "16fd2706-8baf-433b-82eb-8c7fada847da", status: "paid", n: 3 },
    ];
    const whole = inferValue(items);
    let reducedItems = emptyShape();
    for (const item of items) {
      reducedItems = mergeShape(reducedItems, inferValue(item));
    }
    expect(whole.array?.items).toEqual(reducedItems);
  });

  it("matches order fixture schema output", () => {
    const json = `[
      {"id": "0f8fad5b-d9cb-469f-a165-70867728950e", "status": "paid", "at": "2026-10-09T10:00:00Z", "n": 1, "note": null, "mixed": 1, "site": "https://a.example/x", "who": "ada@example.com"},
      {"id": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "status": "open", "at": "2026-10-08T09:00:00+02:00", "n": 2.5, "note": "x", "mixed": "one", "site": "https://b.example", "who": "bob@example.org"},
      {"id": "16fd2706-8baf-433b-82eb-8c7fada847da", "status": "paid", "at": "2026-01-01T00:00:00.123Z", "n": 3, "mixed": true, "site": "http://c.example/?q=1", "who": "c@d.io"}
    ]`;
    const shape = inferJsonText(json);
    const schema = shapeToJsonSchema(shape, "Order");
    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Order",
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["paid", "open"] },
          at: { type: "string", format: "date-time" },
          n: { type: "number" },
          note: { type: ["string", "null"] },
          mixed: { anyOf: [{ type: "boolean" }, { type: "integer" }, { type: "string" }] },
          site: { type: "string", format: "uri" },
          who: { type: "string", format: "email" },
        },
        required: ["id", "status", "at", "n", "mixed", "site", "who"],
      },
    });
  });

  it("never infers enums for strings directly inside arrays or past maxEnum", () => {
    const shape = inferJsonText(`{"tags": ["a", "b", "a"], "status": ["a", "b", "a"]}`);
    const tags = shape.object?.fields.find((f) => f.name === "tags")?.shape.array?.items.string;
    expect(tags).toBeTruthy();
    expect(stringShapeEnumValues(tags!)).toBeNull();

    const tooMany = inferJsonText(
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ kind: `k${i}` })).concat([{ kind: "k0" }]),
      ),
    );
    const kindStr = tooMany.array?.items.object?.fields[0]?.shape.string;
    expect(kindStr?.values).toBeNull();
    expect(stringShapeEnumValues(kindStr!)).toBeNull();
  });

  it("caps nesting at maxDepth = 128 and leaves deeper values as any", () => {
    let nested: unknown = { leaf: 42 };
    for (let i = 0; i < 132; i++) nested = { child: nested };
    const shape = inferValue(nested);
    let cur = shape;
    for (let i = 0; i <= 128; i++) {
      const next = cur.object?.fields[0]?.shape;
      if (!next) break;
      cur = next;
    }
    expect(cur.samples).toBe(1);
    expect(cur.object).toBeNull();
  });

  it("distinguishes 1.0 float from 1 integer in inferJsonSlice", () => {
    const bytes = new TextEncoder().encode(`{"int": 1, "flt": 1.0, "exp": 1e2}`);
    const shape = inferJsonSlice(bytes);
    const fields = shape.object!.fields;
    expect(fields[0]!.shape.integers).toBe(1);
    expect(fields[0]!.shape.floats).toBe(0);
    expect(fields[1]!.shape.floats).toBe(1);
    expect(fields[2]!.shape.floats).toBe(1);
    expect(stringShapeFormat({ count: 2, formats: [2, 0, 0, 0, 0], values: null })).toBe(
      "date-time",
    );
  });
});
