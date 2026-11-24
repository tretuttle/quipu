import { describe, expect, it } from "vite-plus/test";

import { DOCUMENT_FORMATS, nameWithExtension, OPEN_PICKER_TYPES } from "./documentFormats.ts";

describe("document formats", () => {
  it("names an export after the document, replacing a known extension only", () => {
    expect(nameWithExtension("records.json", "yaml")).toBe("records.yaml");
    expect(nameWithExtension("service.YML", "toml")).toBe("service.toml");
    expect(nameWithExtension("Pasted text", "json")).toBe("Pasted text.json");
    expect(nameWithExtension("release.v2", "csv")).toBe("release.v2.csv");
    expect(nameWithExtension(".env", "json")).toBe(".env.json");
  });

  it("offers every structured format's extensions in the open dialog, and not plain text", () => {
    const offered = Object.values(OPEN_PICKER_TYPES[0]?.accept ?? {}).flat();
    const structured = Object.entries(DOCUMENT_FORMATS)
      .filter(([format]) => format !== "text")
      .flatMap(([, entry]) => entry.extensions);
    expect([...offered].sort()).toEqual([...new Set(structured)].sort());
    expect(offered).not.toContain(".txt");
  });
});
