import { describe, expect, it } from "@effect/vitest";

import {
  chooseMapDetail,
  MAP_FULL_NODE_CAP,
  MAP_MARK_CAP,
  MAP_ROW_CAP,
  MAP_TEXT_MIN_ZOOM,
  MAP_TITLE_MIN_ZOOM,
  visibleRowRange,
} from "./mapLod.ts";

describe("map level of detail", () => {
  it("mounts full nodes only when the text is readable and the window is small enough", () => {
    expect(chooseMapDetail({ zoom: 1, visibleNodes: 40, visibleRows: 300 })).toBe("full");
    expect(chooseMapDetail({ zoom: MAP_TEXT_MIN_ZOOM, visibleNodes: 40, visibleRows: 300 })).toBe(
      "full",
    );
    expect(
      chooseMapDetail({ zoom: 1, visibleNodes: MAP_FULL_NODE_CAP + 1, visibleRows: 300 }),
    ).toBe("titles");
  });

  it("keeps the titles one level longer than the rows", () => {
    // Too far out for rows, or too many rows: each node still shows its title.
    expect(chooseMapDetail({ zoom: 0.4, visibleNodes: 40, visibleRows: 300 })).toBe("titles");
    expect(chooseMapDetail({ zoom: 1, visibleNodes: 40, visibleRows: MAP_ROW_CAP + 1 })).toBe(
      "titles",
    );
    expect(
      chooseMapDetail({
        zoom: MAP_TITLE_MIN_ZOOM,
        visibleNodes: MAP_FULL_NODE_CAP,
        visibleRows: 0,
      }),
    ).toBe("titles");
    // Further out, or too many titles to read: plain marks.
    expect(
      chooseMapDetail({ zoom: MAP_TITLE_MIN_ZOOM * 0.9, visibleNodes: 40, visibleRows: 0 }),
    ).toBe("marks");
    // Titles are drawn wherever marks would be: a node is never blank at a zoom it can be read.
    expect(
      chooseMapDetail({ zoom: 0.4, visibleNodes: MAP_FULL_NODE_CAP + 1, visibleRows: 0 }),
    ).toBe("titles");
    expect(chooseMapDetail({ zoom: 0.4, visibleNodes: MAP_MARK_CAP + 1, visibleRows: 0 })).toBe(
      "bitmap",
    );
  });

  it("paints one canvas when even the marks would miss the frame", () => {
    expect(chooseMapDetail({ zoom: 0.1, visibleNodes: MAP_MARK_CAP, visibleRows: 0 })).toBe(
      "marks",
    );
    expect(chooseMapDetail({ zoom: 0.1, visibleNodes: MAP_MARK_CAP + 1, visibleRows: 0 })).toBe(
      "bitmap",
    );
  });

  it("culls a node's rows to the window", () => {
    // 100 rows of 20 under a 28 px header, node at y = 1000.
    expect(visibleRowRange(1000, 28, 20, 100, 0, 500)).toEqual([0, 0]);
    expect(visibleRowRange(1000, 28, 20, 100, 1028 + 200, 1028 + 260)).toEqual([10, 13]);
    expect(visibleRowRange(1000, 28, 20, 100, 500, 1100)).toEqual([0, 4]);
    expect(visibleRowRange(1000, 28, 20, 100, 2900, 5000)).toEqual([93, 100]);
    expect(visibleRowRange(1000, 28, 20, 0, 0, 5000)).toEqual([0, 0]);
  });
});
