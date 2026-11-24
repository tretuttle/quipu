import type { SourceRow, SourceRows } from "@quipu/contracts/engine";
import { describe, expect, it } from "vite-plus/test";

import {
  byteAtUnit,
  runsOf,
  type SourceRowsSource,
  SourceWindowModel,
  unitAtByte,
} from "./sourceWindow.ts";

const encoder = new TextEncoder();

/** An in-memory engine over lines of text: one row per line, rows found by byte offset. */
function fakeSource(lines: ReadonlyArray<string>) {
  const rows: SourceRow[] = [];
  let at = 0;
  lines.forEach((text, index) => {
    const length = encoder.encode(text).length;
    rows.push({
      start: at,
      end: at + length,
      text,
      line: index + 1,
      column: 0,
      indent: 0,
      spans: [],
    });
    at += length + 1;
  });
  const size = at - 1;
  const requests: Array<{ offset: number; before: number; rows: number }> = [];
  const source: SourceRowsSource = {
    rows: (offset, before, count): Promise<SourceRows> => {
      requests.push({ offset, before, rows: count });
      let holder = rows.findLastIndex((row) => row.start <= offset);
      if (holder < 0) holder = 0;
      const from = Math.max(0, holder - before);
      const to = Math.min(rows.length, holder + count);
      return Promise.resolve({
        rows: rows.slice(from, to),
        size,
        atStart: from === 0,
        atEnd: to === rows.length,
      });
    },
  };
  return { source, size, rows, requests };
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

/** The lines on screen, as the view would draw them. */
const onScreen = (model: SourceWindowModel, viewport: number) => {
  const view = model.view();
  return view.rows.slice(view.top, view.top + viewport).map((row) => row.text);
};

describe("the rows the source view shows", () => {
  it("starts at the top of the file and fills the screen", async () => {
    const { source, size } = fakeSource(numbered(500));
    const model = new SourceWindowModel(source, size);
    model.setViewport(10, 80);
    await model.start(0, "top");
    const view = model.view();
    expect(view.loading).toBe(false);
    expect(view.atStart).toBe(true);
    expect(onScreen(model, 10)).toEqual(numbered(10));
  });

  it("scrolls by rows inside the window without asking the engine again", async () => {
    const { source, size, requests } = fakeSource(numbered(500));
    const model = new SourceWindowModel(source, size);
    model.setViewport(10, 80);
    await model.start(0, "top");
    const asked = requests.length;
    model.scrollBy(3);
    expect(onScreen(model, 10)[0]).toBe("line 4");
    model.scrollBy(-2);
    expect(onScreen(model, 10)[0]).toBe("line 2");
    expect(requests.length).toBe(asked);
  });

  it("keeps scrolling past its window by loading the next one", async () => {
    const { source, size } = fakeSource(numbered(500));
    const model = new SourceWindowModel(source, size);
    model.setViewport(10, 80);
    await model.start(0, "top");
    for (let step = 0; step < 40; step++) {
      model.scrollBy(10);
      await model.whenIdle();
    }
    expect(onScreen(model, 10)[0]).toBe("line 401");
    expect(model.view().rows.length).toBeLessThan(200);
  });

  it("jumps to the row that holds a byte offset and shows it a third down the screen", async () => {
    const { source, size, rows } = fakeSource(numbered(5000));
    const model = new SourceWindowModel(source, size);
    model.setViewport(30, 80);
    await model.start(0, "top");
    const target = rows[3210] as SourceRow;
    await model.jumpTo(target.start + 2, "third");
    const shown = onScreen(model, 30);
    expect(shown).toContain("line 3211");
    expect(shown.indexOf("line 3211")).toBe(10);
  });

  it("shows the last row at the bottom when told to scroll to the end", async () => {
    const { source, size } = fakeSource(numbered(5000));
    const model = new SourceWindowModel(source, size);
    model.setViewport(20, 80);
    await model.start(0, "top");
    await model.scrollToEnd();
    const shown = onScreen(model, 20);
    expect(shown[shown.length - 1]).toBe("line 5000");
    expect(model.view().atEnd).toBe(true);
    // Scrolling further down goes nowhere.
    model.scrollBy(50);
    expect(onScreen(model, 20)).toEqual(shown);
  });

  it("goes to a fraction of the file the way the scrollbar's thumb reports it", async () => {
    const { source, size } = fakeSource(numbered(10_000));
    const model = new SourceWindowModel(source, size);
    model.setViewport(20, 80);
    await model.start(0, "top");
    await model.scrollToFraction(0.5);
    const first = model.view().rows[model.view().top] as SourceRow;
    expect(first.start).toBeGreaterThan(size * 0.49);
    expect(first.start).toBeLessThan(size * 0.51);
  });

  it("lays rows out again when the width changes, keeping the first visible row", async () => {
    const { source, size, requests } = fakeSource(numbered(300));
    const model = new SourceWindowModel(source, size);
    model.setViewport(10, 80);
    await model.start(0, "top");
    model.scrollBy(25);
    const first = model.view().rows[model.view().top] as SourceRow;
    model.setViewport(10, 60);
    await model.whenIdle();
    const after = model.view().rows[model.view().top] as SourceRow;
    expect(after.start).toBe(first.start);
    expect(requests.length).toBeGreaterThan(1);
  });

  it("stays on the end of the file when its rows are laid out again at another width", async () => {
    const { source, size } = fakeSource(numbered(5000));
    const model = new SourceWindowModel(source, size);
    model.setViewport(20, 80);
    await model.start(0, "top");
    await model.scrollToEnd();
    model.setViewport(20, 40);
    await model.whenIdle();
    const shown = onScreen(model, 20);
    expect(shown[shown.length - 1]).toBe("line 5000");
  });

  it("reports an engine failure instead of showing stale rows as current", async () => {
    const model = new SourceWindowModel(
      { rows: () => Promise.reject(new Error("the engine was terminated")) },
      100,
    );
    model.setViewport(10, 80);
    await model.start(0, "top");
    expect(model.view().error).toBe("the engine was terminated");
    expect(model.view().loading).toBe(false);
  });
});

describe("a row's characters and bytes", () => {
  it("maps between UTF-16 units and UTF-8 bytes across multi-byte characters", () => {
    const text = "a é 漢 𐍈 z";
    expect(byteAtUnit(text, 0)).toBe(0);
    expect(byteAtUnit(text, 4)).toBe(5); // "a é " is 1+1+2+1 bytes
    expect(unitAtByte(text, 5)).toBe(4);
    const whole = encoder.encode(text).length;
    expect(byteAtUnit(text, text.length)).toBe(whole);
    expect(unitAtByte(text, whole)).toBe(text.length);
    // A surrogate pair is two units and four bytes.
    expect(byteAtUnit("𐍈", 2)).toBe(4);
    expect(unitAtByte("𐍈x", 4)).toBe(2);
  });
});

describe("a row cut into colored runs", () => {
  const row: SourceRow = {
    start: 100,
    end: 112,
    text: '  "a": true,',
    line: 5,
    column: 0,
    indent: 0,
    spans: [],
  };
  const colors = [
    { from: 0, to: 2, color: "#111111" },
    { from: 2, to: 5, color: "#aa0000" },
    { from: 5, to: 7, color: "#222222" },
    { from: 7, to: 11, color: "#0000aa" },
    { from: 11, to: 12, color: "#222222" },
  ];

  it("splits at every color change", () => {
    expect(runsOf(row, colors, null).map((run) => [run.text, run.color])).toEqual([
      ["  ", "#111111"],
      ['"a"', "#aa0000"],
      [": ", "#222222"],
      ["true", "#0000aa"],
      [",", "#222222"],
    ]);
  });

  it("marks the selected node's bytes, cutting a run where the selection begins", () => {
    // The member `"a": true` is bytes 102 to 111 of the file, inside this row.
    const runs = runsOf(row, colors, { start: 102, end: 111 });
    expect(runs.filter((run) => run.selected).map((run) => run.text)).toEqual([
      '"a"',
      ": ",
      "true",
    ]);
    expect(runs.filter((run) => !run.selected).map((run) => run.text)).toEqual(["  ", ","]);
  });

  it("leaves a row alone when the selection is elsewhere", () => {
    const runs = runsOf(row, colors, { start: 0, end: 50 });
    expect(runs.every((run) => !run.selected)).toBe(true);
  });

  it("paints uncolored text with no color rather than guessing one", () => {
    expect(runsOf(row, [], null)).toEqual([
      {
        from: 0,
        text: row.text,
        color: null,
        selected: false,
        hit: false,
        current: false,
        problem: false,
      },
    ]);
  });

  it("marks the byte where the document stops being JSON, and only that byte", () => {
    const runs = runsOf(row, [], null, null, { start: 103, end: 104 });
    expect(runs.filter((run) => run.problem).map((run) => [run.from, run.text])).toEqual([
      [3, row.text.slice(3, 4)],
    ]);
    expect(runs.map((run) => run.text).join("")).toBe(row.text);
    expect(runsOf(row, [], null, null, { start: 0, end: 1 }).some((run) => run.problem)).toBe(
      false,
    );
  });
});

describe("a row with search hits", () => {
  const row: SourceRow = {
    start: 100,
    end: 124,
    text: '  "name": "café item 3",',
    line: 3,
    column: 0,
    indent: 0,
    spans: [],
  };

  it("cuts the row at the hit edges, in bytes, past a multi-byte character", () => {
    // "item 3" starts after the é (two bytes): byte offset 14 + 2 of the row.
    const at = encoder.encode(row.text.slice(0, row.text.indexOf("item 3"))).length;
    const runs = runsOf(row, [], null, {
      ranges: [{ start: row.start + at, end: row.start + at + 6 }],
      current: { start: row.start + at, end: row.start + at + 6 },
    });
    expect(runs.filter((run) => run.hit).map((run) => run.text)).toEqual(["item 3"]);
    expect(runs.filter((run) => run.current).map((run) => run.text)).toEqual(["item 3"]);
    expect(runs.map((run) => run.text).join("")).toBe(row.text);
  });

  it("lights only the part of a hit that is in this row", () => {
    const runs = runsOf(row, [], null, {
      ranges: [{ start: row.start - 5, end: row.start + 4 }],
      current: null,
    });
    expect(runs.filter((run) => run.hit).map((run) => run.text)).toEqual(['  "n']);
  });
});
