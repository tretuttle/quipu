import type { HarDiffSummary, StructuralDiffResult } from "@quipu/contracts/diff";
import { describe, expect, it, vi } from "vite-plus/test";

import { type CompareClient, CompareModel, type CompareTargetDocument } from "./compareModel.ts";

const DOC_A: CompareTargetDocument = {
  documentId: 1,
  name: "a.json",
  size: 120,
  format: "json",
};

const DOC_B: CompareTargetDocument = {
  documentId: 2,
  name: "b.json",
  size: 140,
  format: "json",
};

const SAMPLE_STRUCTURAL: StructuralDiffResult = {
  changes: [
    { kind: "changed", aToken: 1, bToken: 1, pathA: "/name", pathB: "/name" },
    { kind: "added", aToken: null, bToken: 2, pathA: null, pathB: "/extra" },
  ],
  counts: { same: 1, added: 1, removed: 0, changed: 1, moved: 0 },
  rows: [
    {
      id: "b:0",
      aToken: 0,
      bToken: 0,
      depth: 0,
      mark: "inside",
      kind: "object",
      key: null,
      index: null,
      value: "{ 2 keys }",
      wasValue: null,
      pointer: "",
      expandable: true,
      childCount: 2,
    },
    {
      id: "b:1",
      aToken: 1,
      bToken: 1,
      depth: 1,
      mark: "changed",
      kind: "string",
      key: "name",
      index: null,
      value: '"Ada L."',
      wasValue: '"Ada"',
      pointer: "/name",
      expandable: false,
      childCount: 0,
    },
    {
      id: "b:2",
      aToken: null,
      bToken: 2,
      depth: 1,
      mark: "added",
      kind: "true",
      key: "extra",
      index: null,
      value: "true",
      wasValue: null,
      pointer: "/extra",
      expandable: false,
      childCount: 0,
    },
  ],
};

describe("CompareModel", () => {
  it("steps F7 / Shift+F7 across structural changes and reveals collapsed ancestors", async () => {
    const client: CompareClient = {
      compareStructural: vi.fn().mockResolvedValue(SAMPLE_STRUCTURAL),
      compareHar: vi.fn(),
    };
    const model = new CompareModel(DOC_A, client);
    await model.setTarget(DOC_B);

    expect(model.snapshot().status).toBe("ready");
    expect(model.snapshot().activeChangeIndex).toBe(0);
    expect(model.snapshot().focusedRowId).toBe("b:1");

    // Collapse root, then stepNext should expand root and jump to b:2.
    model.toggleRow("b:0");
    expect(model.snapshot().visibleRows).toHaveLength(1);

    model.stepNext();
    expect(model.snapshot().activeChangeIndex).toBe(1);
    expect(model.snapshot().focusedRowId).toBe("b:2");
    expect(model.snapshot().visibleRows).toHaveLength(3);

    // Wrap forward and backward.
    model.stepNext();
    expect(model.snapshot().activeChangeIndex).toBe(0);
    model.stepPrevious();
    expect(model.snapshot().activeChangeIndex).toBe(1);
  });

  it("swaps reference document and loads HAR entry body diff on demand", async () => {
    const harA: CompareTargetDocument = { documentId: 10, name: "a.har", size: 500, format: "har" };
    const harB: CompareTargetDocument = { documentId: 11, name: "b.har", size: 600, format: "har" };

    const harResult = (ref: "a" | "b"): HarDiffSummary => ({
      referenceIndex: ref === "a" ? 0 : 1,
      counts: { same: 1, added: 0, removed: 0, changed: 1 },
      entries: [
        {
          matchKey: "k1",
          groupId: 0,
          occurrence: 0,
          classification: "changed",
          method: "GET",
          url: "https://a.test/order",
          resourceType: "fetch",
          statusBefore: ref === "a" ? 200 : 404,
          statusAfter: ref === "a" ? 404 : 200,
          entryIndexBefore: 0,
          entryIndexAfter: 0,
          changedSections: ["status", "body"],
        },
        {
          matchKey: "k2",
          groupId: 1,
          occurrence: 0,
          classification: "same",
          method: "GET",
          url: "https://a.test/ok",
          resourceType: "fetch",
          statusBefore: 200,
          statusAfter: 200,
          entryIndexBefore: 1,
          entryIndexAfter: 1,
          changedSections: [],
        },
      ],
    });

    const compareHar = vi.fn(async (_a: number, _b: number, ref: "a" | "b") => harResult(ref));
    const compareHarEntryBody = vi.fn().mockResolvedValue(SAMPLE_STRUCTURAL);
    const model = new CompareModel(harA, {
      compareStructural: vi.fn(),
      compareHar,
      compareHarEntryBody,
    });

    await model.setTarget(harB);
    expect(model.snapshot().mode).toBe("har");
    expect(model.snapshot().har?.referenceIndex).toBe(0);

    await model.swapReference();
    expect(compareHar).toHaveBeenLastCalledWith(10, 11, "b");
    expect(model.snapshot().har?.referenceIndex).toBe(1);

    const entry = model.snapshot().filteredHarEntries[0]!;
    await model.toggleHarEntry(entry);
    expect(compareHarEntryBody).toHaveBeenCalledTimes(1);
    expect(model.snapshot().harEntryBodies.size).toBe(1);

    model.setHarFilter("differences");
    expect(model.snapshot().filteredHarEntries).toHaveLength(1);
  });
});
