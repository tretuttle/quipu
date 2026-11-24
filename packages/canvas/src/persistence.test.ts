import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { Element } from "./elements.ts";
import {
  decodeDrawingJson,
  DRAWING_SCHEMA_VERSION,
  drawingJsonByteLength,
  encodeDrawingJson,
  makeDrawingDocument,
  NewerDrawingError,
} from "./persistence.ts";

const elements = Arbitrary.array(Arbitrary.schema(Element), { maxLength: 12 });

describe("drawing persistence", () => {
  it.prop(
    "any element list survives a JSON round trip unchanged",
    [elements],
    ([list]) => {
      const document = makeDrawingDocument(list);
      const json = encodeDrawingJson(document);
      const decoded = decodeDrawingJson(json);
      expect(decoded).toEqual(JSON.parse(json));
      expect(encodeDrawingJson(decoded)).toBe(json);
      expect(decoded.elements.map((element) => element.id)).toEqual(
        list.map((element) => element.id),
      );
      // Every percent-escape is one UTF-8 byte; everything encodeURIComponent leaves alone is ASCII.
      expect(drawingJsonByteLength(json)).toBe(
        encodeURIComponent(json).replaceAll(/%[0-9A-Fa-f]{2}/g, "x").length,
      );
    },
    { arbitrary: { runs: 150 } },
  );

  it("refuses a drawing from a newer schema and reports its version", () => {
    const json = JSON.stringify({
      type: "quipu-drawing",
      version: DRAWING_SCHEMA_VERSION + 3,
      elements: [],
    });
    expect(() => decodeDrawingJson(json)).toThrow(NewerDrawingError);
    try {
      decodeDrawingJson(json);
    } catch (error) {
      expect((error as NewerDrawingError).version).toBe(DRAWING_SCHEMA_VERSION + 3);
    }
  });

  it("rejects a corrupt document", () => {
    expect(() =>
      decodeDrawingJson('{"type":"quipu-drawing","version":1,"elements":[{"type":"blob"}]}'),
    ).toThrow();
    expect(() => decodeDrawingJson("not json")).toThrow();
  });

  it("rejects an element with a zero seed or an invalid z-order key", () => {
    const base = Schema.decodeSync(Element)({
      id: "a",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      angle: 0,
      index: "V",
      seed: 7,
      version: 0,
      isDeleted: false,
      locked: false,
      groupIds: [],
      frameId: null,
      style: {
        stroke: "default",
        fill: "none",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 1,
      },
    });
    expect(() => Schema.decodeSync(Element)({ ...base, seed: 0 })).toThrow();
    expect(() => Schema.decodeSync(Element)({ ...base, index: "a0" })).toThrow();
  });
});
