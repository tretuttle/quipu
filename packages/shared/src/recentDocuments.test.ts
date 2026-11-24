import { MAX_RECENT_DOCUMENTS } from "@quipu/contracts";
import { describe, expect, it } from "@effect/vitest";

import { pushRecentDocument } from "./recentDocuments.ts";

const recent = (n: number, openedAt = n) => ({ id: `doc:${n}`, lastOpenedAt: openedAt });

describe("pushRecentDocument", () => {
  it("puts the newest file first and keeps one row per file", () => {
    const { list, evicted } = pushRecentDocument([recent(1), recent(2)], recent(1, 10));
    expect(list.map((entry) => entry.id)).toEqual(["doc:1", "doc:2"]);
    expect(list[0]?.lastOpenedAt).toBe(10);
    expect(evicted).toEqual([]);
  });

  it("drops the oldest rows past the cap and says which", () => {
    let list: ReadonlyArray<ReturnType<typeof recent>> = [];
    let evictedIds: string[] = [];
    for (let n = 1; n <= MAX_RECENT_DOCUMENTS + 2; n++) {
      const next = pushRecentDocument(list, recent(n));
      list = next.list;
      evictedIds = [...evictedIds, ...next.evicted.map((entry) => entry.id)];
    }
    expect(list).toHaveLength(MAX_RECENT_DOCUMENTS);
    expect(list[0]?.id).toBe(`doc:${MAX_RECENT_DOCUMENTS + 2}`);
    expect(evictedIds).toEqual(["doc:1", "doc:2"]);
  });
});
