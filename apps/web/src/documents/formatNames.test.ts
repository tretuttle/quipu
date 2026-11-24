import { describe, expect, it } from "vite-plus/test";

import { editableFormatNames, structuredFormatNames } from "./formatNames.ts";

// The engine's own test (engineFormats.test.ts) checks that these lists are what it reports on open.
describe("format names in messages", () => {
  it("names every format that opens with a structure, JSONC and TSV included", () => {
    expect(structuredFormatNames).toBe("JSON, JSONC, HAR, NDJSON, YAML, TOML, XML, CSV, and TSV");
  });

  it("names the formats that can be edited", () => {
    expect(editableFormatNames).toBe("JSON and HAR");
  });
});
