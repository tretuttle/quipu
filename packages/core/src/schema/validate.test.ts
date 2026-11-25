import { describe, expect, it } from "vite-plus/test";

import {
  MAX_FAILURES,
  parseSchema,
  RemoteRefError,
  resolveUri,
  SchemaParseError,
  validateHarEntries,
  validateJsonSlice,
  validateValue,
} from "./index.ts";

const ORDER_SCHEMA_FIXTURE =
  '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "$id": "https://schemas.shop.test/order.schema.json",\n  "title": "Order",\n  "type": "object",\n  "required": ["order"],\n  "properties": {\n    "order": {\n      "type": "object",\n      "required": ["id", "price", "currency"],\n      "properties": {\n        "id": { "type": "integer", "minimum": 1 },\n        "price": { "$ref": "#/$defs/price" },\n        "currency": { "enum": ["USD", "EUR"] },\n        "items": { "type": "array", "items": { "type": "string" } }\n      }\n    }\n  },\n  "$defs": {\n    "price": { "type": "number", "minimum": 0, "maximum": 10 }\n  }\n}\n';
const REMOTE_SCHEMA_FIXTURE =
  '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "type": "object",\n  "properties": {\n    "order": { "$ref": "https://schemas.shop.test/order.schema.json#/properties/order" }\n  }\n}\n';

const ORDER_INLINE = `{
  "type": "object",
  "required": ["order"],
  "additionalProperties": false,
  "properties": {
    "order": {
      "type": "object",
      "required": ["id", "price", "currency"],
      "properties": {
        "id": {"type": "integer", "minimum": 1},
        "price": {"type": "number", "minimum": 0, "maximum": 10},
        "currency": {"enum": ["USD", "EUR"]},
        "items": {"type": "array", "items": {"type": "string", "minLength": 2}, "uniqueItems": true}
      }
    }
  }
}`;

function checkFailures(schemaText: string, jsonText: string) {
  const schema = parseSchema(schemaText);
  const res = validateJsonSlice(schema, new TextEncoder().encode(jsonText));
  return res.failures.map((f) => [f.pointer, f.keyword] as const);
}

describe("local JSON Schema validator", () => {
  it("passes valid bodies and boolean/empty schemas", () => {
    const body = `{"order": {"id": 7, "price": 10, "currency": "USD", "items": ["lamp", "kettle"]}}`;
    expect(checkFailures(ORDER_INLINE, body)).toEqual([]);
    expect(checkFailures("true", body)).toEqual([]);
    expect(checkFailures("{}", body)).toEqual([]);
  });

  it("names each failing value by JSON Pointer and reason", () => {
    const json = `{"order": {"id": "7", "price": 12, "currency": "GBP", "items": ["lamp", "k", "lamp"]}, "extra": 1}`;
    const schema = parseSchema(ORDER_INLINE);
    const result = validateJsonSlice(schema, new TextEncoder().encode(json));
    expect(result.valid).toBe(false);
    expect(result.failures.map((f) => [f.pointer, f.keyword])).toEqual([
      ["/order/id", "type"],
      ["/order/price", "maximum"],
      ["/order/currency", "enum"],
      ["/order/items", "uniqueItems"],
      ["/order/items/1", "minLength"],
      ["/extra", "additionalProperties"],
    ]);

    const byPointer = new Map(result.failures.map((f) => [f.pointer, f.message]));
    expect(byPointer.get("/order/price")).toBe("12 is above the maximum 10");
    expect(byPointer.get("/order/id")).toBe("expected integer, found string");
    expect(byPointer.get("/extra")).toBe('property "extra" is not allowed');
    expect(byPointer.get("/order/items")).toBe("items 0 and 2 are equal");

    expect(checkFailures(ORDER_INLINE, `{"order": {"id": 7, "price": 1}}`)).toEqual([
      ["/order", "required"],
    ]);
    expect(checkFailures(ORDER_INLINE, "[]")).toEqual([["", "type"]]);
  });

  it("validates against order.schema.json fixture and refuses remote.schema.json", () => {
    const orderSchema = parseSchema(ORDER_SCHEMA_FIXTURE);
    expect(
      validateValue(orderSchema, {
        order: { id: 1, price: 9.5, currency: "EUR", items: ["book"] },
      }).valid,
    ).toBe(true);

    const bad = validateValue(orderSchema, {
      order: { id: 0, price: 11, currency: "JPY", items: [123] },
    });
    expect(bad.failures.map((f) => [f.pointer, f.keyword])).toEqual([
      ["/order/id", "minimum"],
      ["/order/price", "maximum"],
      ["/order/currency", "enum"],
      ["/order/items/0", "type"],
    ]);

    expect(() => parseSchema(REMOTE_SCHEMA_FIXTURE)).toThrow(RemoteRefError);
    try {
      parseSchema(REMOTE_SCHEMA_FIXTURE);
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteRefError);
      expect((err as Error).message).toContain("never fetched");
    }
  });

  it("resolves local $ref, $anchor, embedded $id, and self-recursive schemas", () => {
    const schema = `{
      "$id": "https://schemas.example/order.json",
      "$defs": {
        "price": {"type": "number", "maximum": 10},
        "money": {"$anchor": "money", "type": "object", "properties": {"amount": {"$ref": "#/$defs/price"}}},
        "tag": {"$id": "tag.json", "type": "string", "pattern": "^[a-z]+$"}
      },
      "definitions": {"ids": {"type": "array", "items": {"type": "integer"}}},
      "properties": {
        "price": {"$ref": "#/$defs/price"},
        "total": {"$ref": "#money"},
        "tags": {"items": {"$ref": "tag.json"}},
        "ids": {"$ref": "https://schemas.example/order.json#/definitions/ids"},
        "self": {"$ref": "#"},
        "keys": {"propertyNames": {"$ref": "#/$defs/tag"}}
      }
    }`;
    const ok = `{"price": 9, "total": {"amount": 2}, "tags": ["a"], "ids": [1], "self": {"price": 1}, "keys": {"ab": 1}}`;
    expect(checkFailures(schema, ok)).toEqual([]);

    const bad = `{"price": 11, "total": {"amount": 20}, "tags": ["A"], "ids": [1.5], "self": {"price": 12}, "keys": {"Ab": 1}}`;
    expect(checkFailures(schema, bad)).toEqual([
      ["/price", "maximum"],
      ["/total/amount", "maximum"],
      ["/tags/0", "pattern"],
      ["/ids/0", "type"],
      ["/self/price", "maximum"],
      ["/keys/Ab", "propertyNames"],
    ]);

    const tree = `{"type": "object", "properties": {"kids": {"type": "array", "items": {"$ref": "#"}}, "n": {"type": "integer"}}}`;
    expect(checkFailures(tree, `{"kids": [{"kids": [{"n": "x"}]}]}`)).toEqual([
      ["/kids/0/kids/0/n", "type"],
    ]);

    expect(() => parseSchema(`{"$ref": "#/$defs/missing"}`)).toThrow(SchemaParseError);
  });

  it("refuses remote $ref and $dynamicRef without making network calls", () => {
    for (const s of [
      `{"$ref": "https://json-schema.org/draft/2020-12/schema"}`,
      `{"properties": {"a": {"$ref": "defs.json#/a"}}}`,
      `{"$id": "https://x.example/a/s.json", "items": {"$ref": "../b/t.json"}}`,
      `{"allOf": [{"$dynamicRef": "urn:other#meta"}]}`,
    ]) {
      expect(() => parseSchema(s)).toThrow(RemoteRefError);
    }
    expect(() => parseSchema(`{"const": {"$ref": "https://a.example/s"}}`)).not.toThrow();
  });

  it("supports combinators, conditions, draft-07 spellings, and dependent keywords", () => {
    const s = `{
      "properties": {
        "a": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
        "b": {"oneOf": [{"minimum": 0}, {"maximum": 10}]},
        "c": {"not": {"type": "null"}},
        "d": {"if": {"properties": {"kind": {"const": "box"}}}, "then": {"required": ["size"]}, "else": {"required": ["name"]}},
        "e": {"allOf": [{"minLength": 2}, {"maxLength": 3}]},
        "f": {"type": ["string", "null"]},
        "g": {"contains": {"const": 3}, "maxContains": 1, "minItems": 2},
        "h": {"dependentRequired": {"x": ["y"]}, "maxProperties": 2},
        "i": {"prefixItems": [{"type": "string"}], "items": false},
        "j": {"multipleOf": 0.5, "exclusiveMinimum": 0}
      }
    }`;
    const ok = `{"a": 1, "b": -5, "c": 0, "d": {"kind": "box", "size": 1}, "e": "ab", "f": null, "g": [3, 4], "h": {"x": 1, "y": 2}, "i": ["a"], "j": 1.5}`;
    expect(checkFailures(s, ok)).toEqual([]);

    const bad = `{"a": 1.5, "b": 5, "c": null, "d": {"kind": "bag"}, "e": "abcd", "f": 1, "g": [3, 3], "h": {"x": 1, "z": 2, "w": 3}, "i": ["a", 2], "j": 0}`;
    expect(checkFailures(s, bad)).toEqual([
      ["/a", "anyOf"],
      ["/b", "oneOf"],
      ["/c", "not"],
      ["/d", "required"],
      ["/e", "maxLength"],
      ["/f", "type"],
      ["/g", "maxContains"],
      ["/h", "dependentRequired"],
      ["/h", "maxProperties"],
      ["/i/1", "false"],
      ["/j", "exclusiveMinimum"],
    ]);
  });

  it("refuses invalid schemas, unevaluatedProperties, and invalid regex patterns", () => {
    expect(() => parseSchema("{")).toThrow(SchemaParseError);
    expect(() => parseSchema("[1]")).toThrow(SchemaParseError);
    expect(() => parseSchema(`{"unevaluatedProperties": false}`)).toThrow(SchemaParseError);
    expect(() => parseSchema(`{"unevaluatedItems": false}`)).toThrow(SchemaParseError);
    expect(() => parseSchema(`{"pattern": "[unclosed"}`)).toThrow(SchemaParseError);
  });

  it("resolves RFC 3986 URIs accurately", () => {
    expect(resolveUri("https://a.example/x/y.json", "z.json")).toBe("https://a.example/x/z.json");
    expect(resolveUri("https://a.example/x/y.json", "/z.json")).toBe("https://a.example/z.json");
    expect(resolveUri("https://a.example/x/y.json", "../z.json#/a")).toBe(
      "https://a.example/z.json",
    );
    expect(resolveUri("https://a.example/x/y.json", "#/a")).toBe("https://a.example/x/y.json");
    expect(resolveUri("", "#/a")).toBe("");
    expect(resolveUri("urn:a", "urn:b")).toBe("urn:b");
  });

  it("validates matching HAR entries by URL pattern and caps at MAX_FAILURES", () => {
    const schema = parseSchema(ORDER_SCHEMA_FIXTURE);
    const entries = [
      {
        entryIndex: 0,
        url: "https://shop.test/api/orders/1",
        bodyText: JSON.stringify({ order: { id: 1, price: 5, currency: "USD" } }),
      },
      {
        entryIndex: 1,
        url: "https://shop.test/api/health",
        bodyText: JSON.stringify({ ok: true }),
      },
      {
        entryIndex: 2,
        url: "https://shop.test/api/orders/2",
        encoding: "base64",
        bodyText: btoa(JSON.stringify({ order: { id: 0, price: 25, currency: "USD" } })),
      },
    ];

    const res = validateHarEntries(schema, entries, {
      urlPattern: "/api/orders",
      section: "response",
    });
    expect(res.checkedEntries).toBe(2);
    expect(res.valid).toBe(false);
    expect(res.failures).toEqual([
      {
        pointer: "/order/id",
        keyword: "minimum",
        message: "0 is below the minimum 1",
        entryIndex: 2,
      },
      {
        pointer: "/order/price",
        keyword: "maximum",
        message: "25 is above the maximum 10",
        entryIndex: 2,
      },
    ]);

    const capSchema = parseSchema(`{"type": "array", "items": {"type": "string"}}`);
    const bigArray = Array.from({ length: 1200 }, (_, i) => i);
    const capped = validateValue(capSchema, bigArray);
    expect(capped.failures).toHaveLength(MAX_FAILURES);
    expect(capped.truncated).toBe(true);
  });
});
