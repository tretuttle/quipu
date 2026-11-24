import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { fromLenientJson } from "./schemaJson.ts";

const decodeLenientJson = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

describe("fromLenientJson", () => {
  it("decodes JSON with comments and trailing commas", () => {
    expect(
      decodeLenientJson(`{
        // Comments are valid in settings files.
        "enabled": true,
        "values": [1, 2,],
      }`),
    ).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });

  it("rejects malformed JSON after lenient preprocessing", () => {
    expect(() => decodeLenientJson('{ "enabled": true,, }')).toThrow();
  });

  it("preserves commas before brackets inside string values", () => {
    // A comma inside a string value that happens to precede `}`/`]` must not
    // be stripped as if it were a trailing comma.
    expect(decodeLenientJson('{"note":"a,]"}')).toEqual({ note: "a,]" });
    expect(decodeLenientJson('{"list":["x,}"]}')).toEqual({ list: ["x,}"] });
    // Genuine trailing commas are still removed.
    expect(decodeLenientJson('{"values":[1, 2,],}')).toEqual({ values: [1, 2] });
  });

  it("keeps comment markers inside strings", () => {
    expect(decodeLenientJson('{"url":"https://example.com/a"}')).toEqual({
      url: "https://example.com/a",
    });
  });

  it("encodes to strict JSON", () => {
    const encode = Schema.encodeSync(fromLenientJson(Schema.Struct({ a: Schema.Number })));
    expect(encode({ a: 1 })).toBe('{"a":1}');
  });
});
