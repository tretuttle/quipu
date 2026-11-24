import {
  type NodeRef,
  type PathStep,
  SOURCE_LINE_BLOCK_BYTES,
  SOURCE_LINE_NUMBER_LIMIT_BYTES,
  type SourceRow,
} from "@quipu/contracts/engine";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { createLineCounts, layoutRows } from "./sourceRows.ts";
import { type Prng, createPrng, harSample } from "./testing/samples.ts";

const encoder = new TextEncoder();
const platform = (workers: number) => ({
  workers,
  crossOriginIsolated: true,
  createPool: createLocalPool,
});

// A naive model of the rows: one pass over the whole file, no windows.

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

interface NaiveRow {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly indent: number;
}

/** Rows the way the contract describes them, computed front to back. */
function naiveRows(bytes: Uint8Array, wrap: number, block: number): NaiveRow[] {
  const alignForward = (at: number) => {
    let moved = at;
    while (moved < bytes.length && isContinuation(bytes[moved] as number)) moved++;
    return moved;
  };
  // A wrapped row hangs under its line's text: the line's leading blanks plus two, at most half the width.
  const hangAt = (start: number) => {
    const half = Math.floor(wrap / 2);
    if (half <= 2 || (start > 0 && bytes[start - 1] !== 0x0a)) return 0;
    let blanks = 0;
    while (blanks < half && (bytes[start + blanks] === 0x20 || bytes[start + blanks] === 0x09)) {
      blanks++;
    }
    return Math.min(half, blanks + 2);
  };
  // A wrapped row may start up to an eighth of the width early, just after a space.
  const early = Math.floor(wrap / 8) >= 2 ? Math.floor(wrap / 8) : 0;
  const afterSpace = (grid: number) => {
    for (let i = grid - 1; i >= grid - early; i--) if (bytes[i] === 0x20) return i + 1;
    return grid;
  };
  const rows: NaiveRow[] = [];
  let line = 1;
  let p = 0;
  let lineStart = 0;
  let hang = hangAt(0);
  // The grid of the current line, walked one row at a time: the first row is `wrap` wide, then the
  // points are `wrap - hang - early` apart.
  let nextGrid = wrap;
  while (p < bytes.length) {
    const grid = Math.max(p + 1, alignForward(lineStart + nextGrid));
    const indent = p > lineStart ? hang : 0;
    const nextBlock = alignForward((Math.floor(p / block) + 1) * block);
    const limit = Math.min(grid, nextBlock, bytes.length);
    let newline = -1;
    for (let i = p; i <= limit && i < bytes.length; i++) {
      if (bytes[i] === 0x0a) {
        newline = i;
        break;
      }
    }
    if (newline >= 0) {
      rows.push({ start: p, end: newline, line, indent });
      p = newline + 1;
      lineStart = p;
      hang = hangAt(p);
      nextGrid = wrap;
      line += 1;
    } else {
      const end =
        limit === grid && grid < nextBlock && grid < bytes.length ? afterSpace(grid) : limit;
      rows.push({ start: p, end, line, indent });
      if (limit === nextBlock) {
        lineStart = limit;
        hang = hangAt(limit);
        nextGrid = wrap;
      } else nextGrid += wrap - hang - early;
      p = end;
    }
  }
  if (bytes.length === 0) rows.push({ start: 0, end: 0, line: 1, indent: 0 });
  return rows;
}

const memory = (bytes: Uint8Array) => ({
  size: bytes.length,
  read: (start: number, end: number) => Promise.resolve(bytes.subarray(start, end)),
});

const Pieces = Schema.Array(
  Schema.Literals([
    "a",
    "bb",
    "{",
    '"',
    "\\",
    "é",
    "𐍈",
    "漢",
    " ",
    "\n",
    "\r\n",
    "x".repeat(40),
    "lorem ipsum ",
  ]),
).check(Schema.isMaxLength(60));
const pieces = Arbitrary.schema(Pieces);
const WrapBytes = Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 40 }));
const wrapWidth = Arbitrary.schema(WrapBytes);
const BlockBytes = Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 300 }));
const blockWidth = Arbitrary.schema(BlockBytes);
const Anchor = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));
const anchor = Arbitrary.schema(Anchor);
const RowCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }));
const rowCount = Arbitrary.schema(RowCount);

describe("rows by byte offset", () => {
  it.effect.prop(
    "match a front-to-back model from any anchor, with before and after rows",
    [pieces, wrapWidth, blockWidth, anchor, rowCount, rowCount],
    ([parts, wrap, block, at, before, rows]) =>
      Effect.promise(async () => {
        const bytes = encoder.encode(parts.join(""));
        const expected = naiveRows(bytes, wrap, block);
        const offset = bytes.length === 0 ? 0 : Math.min(at, bytes.length);
        const layout = await layoutRows(memory(bytes), createLineCounts(), {
          offset,
          before: before - 1,
          rows,
          wrapBytes: wrap,
          blockBytes: block,
        });
        // The row an offset belongs to: a newline byte belongs to the row it ends.
        const holder = expected.findIndex(
          (row) =>
            offset >= row.start &&
            (offset < row.end || (offset === row.end && bytes[offset] === 0x0a)),
        );
        const anchorIndex = holder >= 0 ? holder : expected.length - 1;
        const firstIndex = Math.max(0, anchorIndex - (before - 1));
        const wanted = expected.slice(firstIndex, anchorIndex + rows);
        expect(
          layout.rows.map((row) => ({
            start: row.start,
            end: row.end,
            line: row.line,
            indent: row.indent,
          })),
        ).toEqual(wanted);
        expect(layout.atStart).toBe(firstIndex === 0);
        expect(layout.atEnd).toBe(anchorIndex + rows >= expected.length);
      }),
    { arbitrary: { runs: 400 } },
  );

  it("cuts a 2 GiB single line into short rows and reads only what the screen needs", async () => {
    const size = 2 * 1024 ** 3;
    let bytesRead = 0;
    let reads = 0;
    // One line of 2 GiB: every byte is 'x' except a newline at the very end.
    const source = {
      size,
      read: (start: number, end: number) => {
        const length = Math.min(end, size) - start;
        bytesRead += length;
        reads += 1;
        return Promise.resolve(new Uint8Array(length).fill(0x78));
      },
    };
    const offset = 1_500_000_000;
    const layout = await layoutRows(source, createLineCounts(), {
      offset,
      before: 5,
      rows: 40,
      wrapBytes: 200,
    });
    expect(layout.rows).toHaveLength(45);
    const holder = layout.rows[5];
    expect(holder !== undefined && holder.start <= offset && offset < holder.end).toBe(true);
    for (const row of layout.rows) expect(row.end - row.start).toBeLessThanOrEqual(200);
    // Past the line-number limit, a row has no line number and no column.
    expect(layout.rows[0]?.line).toBeNull();
    expect(layout.rows[0]?.column).toBeNull();
    // Cutting at block multiples keeps the backward search to one block (read in growing steps).
    expect(bytesRead).toBeLessThan(SOURCE_LINE_BLOCK_BYTES * 3);
    expect(reads).toBeLessThan(100);
  });

  it("numbers lines within the limit and stops counting beyond it", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const bytes = encoder.encode(lines);
    const layout = await layoutRows(memory(bytes), createLineCounts(), {
      offset: lines.indexOf("line 4321"),
      before: 0,
      rows: 3,
      wrapBytes: 200,
    });
    expect(layout.rows.map((row) => [row.line, row.column])).toEqual([
      [4321, 0],
      [4322, 0],
      [4323, 0],
    ]);
    const farLine = SOURCE_LINE_NUMBER_LIMIT_BYTES + 10;
    const far = await layoutRows(
      { size: farLine + 1000, read: (a, b) => Promise.resolve(new Uint8Array(b - a).fill(0x0a)) },
      createLineCounts(),
      { offset: farLine, before: 0, rows: 2, wrapBytes: 200 },
    );
    expect(far.rows.map((row) => row.line)).toEqual([null, null]);
  });

  it("reports a column that restarts at each line and continues across a wrapped line", async () => {
    const text = `${"a".repeat(50)}\nshort\n${"é".repeat(30)}`;
    const bytes = encoder.encode(text);
    const layout = await layoutRows(memory(bytes), createLineCounts(), {
      offset: 0,
      before: 0,
      rows: 10,
      wrapBytes: 20,
    });
    const rows = layout.rows.map((row) => ({
      text: new TextDecoder().decode(bytes.subarray(row.start, row.textEnd)),
      line: row.line,
      column: row.column,
    }));
    expect(rows.map((row) => [row.line, row.column])).toEqual([
      // Wrapped rows hang 2, and their grid points are 20 - 2 - 2 = 16 bytes apart after the first 20.
      [1, 0],
      [1, 20],
      [1, 36],
      [2, 0],
      [3, 0],
      [3, 10],
      [3, 18],
      [3, 26],
    ]);
    expect(rows[3]?.text).toBe("short");
    expect(rows.map((row) => row.text).join("")).toBe(text.replace(/\n/g, ""));
  });

  it("hangs a wrapped row under its line's text", async () => {
    const text = `{\n      "email": "${"x".repeat(40)}",\n  "next": 1\n}`;
    const bytes = encoder.encode(text);
    const layout = await layoutRows(memory(bytes), createLineCounts(), {
      offset: 0,
      before: 0,
      rows: 10,
      wrapBytes: 24,
    });
    const rows = layout.rows.map((row) => ({
      text: new TextDecoder().decode(bytes.subarray(row.start, row.textEnd)),
      indent: row.indent,
    }));
    // The email line is indented 6: its wrapped rows hang 8, and their grid points are
    // 24 - 8 - 3 = 13 bytes apart (an eighth of the width is kept for breaking at a space).
    expect(rows).toEqual([
      { text: "{", indent: 0 },
      { text: '      "email": "xxxxxxxx', indent: 0 },
      { text: "xxxxxxxxxxxxx", indent: 8 },
      { text: "xxxxxxxxxxxxx", indent: 8 },
      { text: 'xxxxxx",', indent: 8 },
      { text: '  "next": 1', indent: 0 },
      { text: "}", indent: 0 },
    ]);
  });

  it("starts a wrapped row after a space near its grid point, never inside a word that has one", async () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh";
    const bytes = encoder.encode(text);
    const layout = await layoutRows(memory(bytes), createLineCounts(), {
      offset: 0,
      before: 0,
      rows: 10,
      wrapBytes: 16,
    });
    const rows = layout.rows.map((row) => text.slice(row.start, row.textEnd));
    // The first row's grid point (16) falls inside "dddd": the row ends after the space at 14.
    // The next point (28) has no space within two bytes before it, so that row ends on the grid.
    expect(rows).toEqual(["aaaa bbbb cccc ", "dddd eeee fff", "f gggg hhhh"]);
    expect(rows.join("")).toBe(text);
  });

  it("does not show the carriage return of a CRLF break", async () => {
    const bytes = encoder.encode("one\r\ntwo\r\n");
    const layout = await layoutRows(memory(bytes), createLineCounts(), {
      offset: 0,
      before: 0,
      rows: 5,
      wrapBytes: 100,
    });
    expect(layout.rows.map((row) => [row.start, row.end, row.textEnd])).toEqual([
      [0, 4, 3],
      [5, 9, 8],
    ]);
  });
});

// An independent reader of JSON bytes: what the index must say about every byte.

type Style = Readonly<{ kind: string; depth: number; container: "object" | "array" | "root" }>;

interface Reading {
  readonly styles: Array<Style | null>;
  /** The JSON pointer (as a JSON array of segments) of the innermost value holding each byte. */
  readonly paths: Array<string | null>;
}

function readJsonBytes(bytes: Uint8Array): Reading {
  const styles: Array<Style | null> = Array.from({ length: bytes.length }, () => null);
  const paths: Array<string | null> = Array.from({ length: bytes.length }, () => null);
  let position = 0;
  const paint = (start: number, end: number, style: Style) => {
    for (let i = start; i < end; i++) styles[i] = style;
  };
  const skipWhitespace = (container: Style["container"]) => {
    while (position < bytes.length && " \t\r\n".includes(String.fromCharCode(bytes[position]!))) {
      styles[position] = { kind: "whitespace", depth: 0, container };
      position += 1;
    }
  };
  const readString = (
    body: string,
    quote: string,
    depth: number,
    container: Style["container"],
  ): string => {
    const style = (kind: string): Style => ({ kind, depth, container });
    const start = position;
    paint(position, position + 1, style(quote));
    position += 1;
    while (bytes[position] !== 0x22) {
      if (bytes[position] === 0x5c) {
        const length = bytes[position + 1] === 0x75 ? 6 : 2;
        paint(position, position + length, style("escape"));
        position += length;
      } else {
        paint(position, position + 1, style(body));
        position += 1;
      }
    }
    paint(position, position + 1, style(quote));
    position += 1;
    return JSON.parse(new TextDecoder().decode(bytes.subarray(start, position))) as string;
  };
  const readValue = (
    depth: number,
    container: Style["container"],
    path: ReadonlyArray<string | number>,
  ) => {
    skipWhitespace(container);
    const start = position;
    const here = bytes[position];
    if (here === 0x7b) {
      const objectDepth = depth + 1;
      paint(position, position + 1, { kind: "brace", depth: objectDepth, container });
      position += 1;
      skipWhitespace("object");
      while (bytes[position] !== 0x7d) {
        const key = readString("key", "keyQuote", objectDepth, "object");
        skipWhitespace("object");
        paint(position, position + 1, { kind: "colon", depth: objectDepth, container: "object" });
        position += 1;
        readValue(objectDepth, "object", [...path, key]);
        skipWhitespace("object");
        if (bytes[position] === 0x2c) {
          paint(position, position + 1, { kind: "comma", depth: objectDepth, container: "object" });
          position += 1;
          skipWhitespace("object");
        }
      }
      paint(position, position + 1, { kind: "brace", depth: objectDepth, container });
      position += 1;
    } else if (here === 0x5b) {
      paint(position, position + 1, { kind: "bracket", depth, container });
      position += 1;
      skipWhitespace("array");
      let index = 0;
      while (bytes[position] !== 0x5d) {
        readValue(depth, "array", [...path, index]);
        index += 1;
        skipWhitespace("array");
        if (bytes[position] === 0x2c) {
          paint(position, position + 1, { kind: "comma", depth, container: "array" });
          position += 1;
          skipWhitespace("array");
        }
      }
      paint(position, position + 1, { kind: "bracket", depth, container });
      position += 1;
    } else if (here === 0x22) {
      readString("string", "stringQuote", depth, container);
    } else {
      const text = new TextDecoder().decode(bytes.subarray(position, position + 64));
      const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text);
      if (!match) throw new Error(`unexpected byte at ${position}`);
      const kind = /^[-\d]/.test(match[0]) ? "number" : "literal";
      paint(position, position + match[0].length, { kind, depth, container });
      position += match[0].length;
    }
    const pointer = JSON.stringify(path);
    // Children were read first and own their bytes; the container takes what they left.
    for (let i = start; i < position; i++) paths[i] ??= pointer;
  };
  readValue(0, "root", []);
  skipWhitespace("root");
  return { styles, paths };
}

/**
 * What the theme's syntax table distinguishes: a key's depth (up to nine), a
 * literal's or comma's container, and the kind. Two tokens with the same
 * signature get the same color in every theme, so equal signatures mean equal colors.
 */
const colorOf = (style: { kind: string; depth: number; container: Style["container"] }) => {
  const slot = style.kind === "key" ? Math.min(Math.max(style.depth, 1), 9) : 0;
  const where = style.kind === "literal" || style.kind === "comma" ? style.container : "";
  return `${style.kind}:${slot}:${where}`;
};

// Random JSON, serialized by hand so escapes the standard serializer would not
// write (é, \/) appear, and so layout varies (minified, indented, tabbed).

const KEY_CHARS = ["a", "b", "key", "é", "𐍈", "漢", "true", "1", "{", "[", ",", ":", " ", ""];
const STRING_PARTS = [
  "plain",
  "with space",
  'quote"s',
  "back\\slash",
  "new\nline",
  "tab\t",
  "é",
  "𐍈",
  "漢字",
  '{"a":true}',
  "[1,2]",
  "true",
  "null",
  "\u0007",
  "/",
  "",
];

function escapeString(prng: Prng, text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (ch === "/" && prng.chance(0.5)) out += "\\/";
    else if (code > 0x7f && prng.chance(0.3)) {
      if (code > 0xffff) {
        const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
        const low = ((code - 0x10000) % 0x400) + 0xdc00;
        out += `\\u${high.toString(16)}\\u${low.toString(16)}`;
      } else out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

function randomString(prng: Prng): string {
  const parts = Array.from({ length: prng.range(0, 4) }, () => prng.pick(STRING_PARTS));
  return parts.join(prng.chance(0.3) ? " " : "");
}

function randomNumber(prng: Prng): string {
  return prng.pick([
    "0",
    "-1",
    "42",
    "3.25",
    "-0.5",
    "1e9",
    "2.5E-3",
    "123456789012",
    String(prng.int(1000)),
  ]);
}

function randomDocument(prng: Prng, indent: string | null): string {
  const newline = (level: number) => (indent === null ? "" : `\n${indent.repeat(level)}`);
  const space = indent === null ? "" : " ";
  const value = (level: number, depth: number): string => {
    const choice = prng.int(depth >= 5 ? 5 : 8);
    if (choice === 0) return randomNumber(prng);
    if (choice === 1) return prng.pick(["true", "false", "null"]);
    if (choice === 2 || choice === 3 || choice === 4) return escapeString(prng, randomString(prng));
    const count = prng.range(0, 5);
    if (choice === 5 || choice === 7) {
      if (count === 0) return "{}";
      const members = Array.from({ length: count }, () => {
        const key = Array.from({ length: prng.range(0, 3) }, () => prng.pick(KEY_CHARS)).join("");
        return `${newline(level + 1)}${escapeString(prng, key)}${space}:${space}${value(level + 1, depth + 1)}`;
      });
      return `{${members.join(",")}${newline(level)}}`;
    }
    if (count === 0) return "[]";
    const elements = Array.from(
      { length: count },
      () => `${newline(level + 1)}${value(level + 1, depth + 1)}`,
    );
    return `[${elements.join(",")}${newline(level)}]`;
  };
  // Containers at the top make the structure worth reading.
  const top = prng.chance(0.5)
    ? `{${newline(1)}${escapeString(prng, "list")}${space}:${space}${value(1, 1)}${newline(0)}}`
    : `[${newline(1)}${value(1, 1)},${newline(1)}${value(1, 1)}${newline(0)}]`;
  return top;
}

interface Opened {
  readonly host: EngineHost;
  readonly documentId: number;
}

async function openDocument(
  bytes: Uint8Array<ArrayBuffer>,
  options: { regionBytes: number; tokenBudget?: number; sourceBlockBytes?: number },
): Promise<Opened> {
  const host = new EngineHost(platform(3), {
    regionBytes: options.regionBytes,
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.sourceBlockBytes === undefined
      ? {}
      : { sourceBlockBytes: options.sourceBlockBytes }),
  });
  const info = await host.handle({ _tag: "open", source: new Blob([bytes]), name: "doc.json" });
  return { host, documentId: info.documentId };
}

/** Per UTF-16 unit of a row: the color its spans give it, or null where none covers it. */
function unitColors(row: SourceRow): Array<string | null> {
  const colors: Array<string | null> = Array.from({ length: row.text.length }, () => null);
  for (const span of row.spans) {
    for (let i = span.from; i < span.to; i++) colors[i] = colorOf(span);
  }
  return colors;
}

/** Compares a row's spans with the reader, unit by unit; returns what differed. */
function differences(row: SourceRow, reading: Reading): string[] {
  const found: string[] = [];
  const colors = unitColors(row);
  let unit = 0;
  let byte = row.start;
  for (const ch of row.text) {
    const style = reading.styles[byte];
    const want = style ? colorOf(style) : null;
    for (let u = 0; u < ch.length; u++) {
      if (colors[unit + u] !== want) {
        found.push(
          `${JSON.stringify(ch)} at byte ${byte}: spans ${colors[unit + u]}, reader ${want} (${JSON.stringify(style)})`,
        );
      }
    }
    unit += ch.length;
    byte += encoder.encode(ch).length;
  }
  return found;
}

const SeedInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const seeds = Arbitrary.schema(SeedInt);

describe("rows colored from the structural index", () => {
  it.effect.prop(
    "give every character the style an independent reader of the bytes gives it",
    [seeds, seeds],
    ([seed, layoutSeed]) =>
      Effect.promise(async () => {
        const prng = createPrng(seed);
        const indent = prng.pick([null, "  ", "\t", " "]);
        const text = randomDocument(prng, indent);
        const bytes = encoder.encode(text);
        const reading = readJsonBytes(bytes);
        const layoutPrng = createPrng(layoutSeed);
        const { host, documentId } = await openDocument(bytes, {
          regionBytes: layoutPrng.pick([16, 64, 4096]),
          tokenBudget: 1_000_000,
        });
        try {
          const wrap = layoutPrng.range(16, 90);
          const problems: string[] = [];
          let compared = 0;
          // Windows start at arbitrary offsets, so rows begin inside strings, escapes and keys.
          for (let n = 0; n < 6; n++) {
            const offset = layoutPrng.int(bytes.length + 1);
            const result = await host.handle({
              _tag: "sourceRows",
              documentId,
              offset,
              before: layoutPrng.range(0, 2),
              rows: layoutPrng.range(1, 8),
              wrapBytes: wrap,
            });
            for (const row of result.rows) {
              compared += row.text.length;
              problems.push(...differences(row, reading));
            }
          }
          expect(problems).toEqual([]);
          expect(compared).toBeGreaterThan(0);
        } finally {
          await host.handle({ _tag: "close", documentId });
        }
      }),
    { arbitrary: { runs: 60 } },
  );

  it("joins to the original text whatever the wrap width", async () => {
    const prng = createPrng(77);
    const bytes = encoder.encode(randomDocument(prng, "  "));
    const { host, documentId } = await openDocument(bytes, { regionBytes: 64 });
    try {
      for (const wrap of [16, 23, 64, 4096]) {
        const rows: SourceRow[] = [];
        let offset = 0;
        for (;;) {
          const page = await host.handle({
            _tag: "sourceRows",
            documentId,
            offset,
            before: 0,
            rows: 7,
            wrapBytes: wrap,
          });
          rows.push(...page.rows);
          const last = page.rows[page.rows.length - 1];
          if (page.atEnd || last === undefined) break;
          offset = bytes[last.end] === 0x0a ? last.end + 1 : last.end;
        }
        const text = new TextDecoder().decode(bytes);
        let rebuilt = "";
        let previousEnd = 0;
        for (const row of rows) {
          rebuilt += new TextDecoder().decode(bytes.subarray(previousEnd, row.start));
          rebuilt += row.text;
          previousEnd = row.end;
        }
        rebuilt += new TextDecoder().decode(bytes.subarray(previousEnd));
        expect(rebuilt).toBe(text);
        expect(rows[0]?.line).toBe(1);
      }
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("colors a capture the index cut at depth 1, through the buckets of its containers", async () => {
    const prng = createPrng(5);
    const wide = `[${Array.from(
      { length: 400 },
      (_, i) => `{"id":${i},"tags":["a","b",true,null],"name":"item \\u00e9 ${i}"}`,
    ).join(",\n")}]`;
    const bytes = encoder.encode(wide);
    void prng;
    const reading = readJsonBytes(bytes);
    const { host, documentId } = await openDocument(bytes, {
      regionBytes: 4096,
      tokenBudget: 1,
    });
    try {
      const root = await host.handle({ _tag: "root", documentId });
      await host.handle({ _tag: "node", ref: root.ref });
      expect(root.childrenIndexed).toBe(false);
      const problems: string[] = [];
      for (const offset of [0, 777, 5000, 12_345, bytes.length - 3]) {
        const page = await host.handle({
          _tag: "sourceRows",
          documentId,
          offset,
          before: 2,
          rows: 12,
          wrapBytes: 60,
        });
        for (const row of page.rows) problems.push(...differences(row, reading));
      }
      expect(problems).toEqual([]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("colors a HAR with nested stringified bodies like the reader does", async () => {
    const bytes = harSample(createPrng(21), {
      targetBytes: 120 * 1024,
      nestedBodyBytes: [20 * 1024],
      bigBodyChars: 4096,
    });
    const reading = readJsonBytes(bytes);
    const { host, documentId } = await openDocument(bytes, { regionBytes: 32 * 1024 });
    try {
      const problems: string[] = [];
      for (const offset of [0, 1000, 40_000, 70_001, bytes.length - 10]) {
        const page = await host.handle({
          _tag: "sourceRows",
          documentId,
          offset,
          before: 3,
          rows: 20,
          wrapBytes: 120,
        });
        for (const row of page.rows) problems.push(...differences(row, reading));
      }
      expect(problems).toEqual([]);
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("pairs escapes right when a row begins in the middle of a run of backslashes", async () => {
    // 51 escaped backslashes then a literal n: a pairing that starts one byte off
    // would swallow the n into an escape.
    const bytes = encoder.encode(` ["${"\\".repeat(102)}n"]`);
    const reading = readJsonBytes(bytes);
    const { host, documentId } = await openDocument(bytes, { regionBytes: 4096 });
    try {
      const page = await host.handle({
        _tag: "sourceRows",
        documentId,
        offset: 104,
        before: 0,
        rows: 1,
        wrapBytes: 16,
      });
      const row = page.rows[0] as SourceRow;
      // The line hangs 3 (its one leading space, plus two): wrapped rows start at 16, then every
      // 16 - 3 - 2 = 11 bytes, and the one at 104 begins on the second backslash of a pair.
      expect(row.start).toBe(104);
      expect(row.text).toContain("n");
      expect(differences(row, reading)).toEqual([]);
      const letter = row.spans.find((span) => row.text.slice(span.from, span.to) === "n");
      expect(letter?.kind).toBe("string");
    } finally {
      await host.handle({ _tag: "close", documentId });
    }
  });

  it("leaves a document that is not JSON as plain rows", async () => {
    const bytes = encoder.encode("name,size\nquipu,2\nkhipu,3\n");
    const host = new EngineHost(platform(2));
    const info = await host.handle({ _tag: "open", source: new Blob([bytes]), name: "a.csv" });
    expect(info.format).toBe("text");
    const page = await host.handle({
      _tag: "sourceRows",
      documentId: info.documentId,
      offset: 0,
      before: 0,
      rows: 10,
      wrapBytes: 100,
    });
    expect(page.rows.map((row) => [row.text, row.spans.length, row.line])).toEqual([
      ["name,size", 0, 1],
      ["quipu,2", 0, 2],
      ["khipu,3", 0, 3],
    ]);
    expect(page.atStart && page.atEnd).toBe(true);
    await host.handle({ _tag: "close", documentId: info.documentId });
  });
});

describe("the node that holds a byte", () => {
  const open: Opened[] = [];
  afterAll(async () => {
    for (const { host, documentId } of open) {
      await host.handle({ _tag: "close", documentId }).catch(() => null);
    }
  });

  it("finds a node inside a bucket of a container the index cut", async () => {
    const wide = `[${Array.from(
      { length: 3000 },
      (_, i) => `{"id":${i},"tags":["a","b"],"name":"item ${i}"}`,
    ).join(",\n")}]`;
    const bytes = encoder.encode(wide);
    const { host, documentId } = await openDocument(bytes, { regionBytes: 4096, tokenBudget: 1 });
    open.push({ host, documentId });
    const root = await host.handle({ _tag: "root", documentId });
    await host.handle({ _tag: "node", ref: root.ref });
    expect(root.childrenIndexed).toBe(false);
    for (const item of [0, 1, 1023, 1024, 2047, 2999]) {
      const needle = `"id":${item},`;
      const offset = wide.indexOf(needle) + needle.length - 2;
      const { path } = await host.handle({ _tag: "nodeAt", documentId, offset });
      expect(path.map((step) => step.node.kind)).toEqual(["array", "object", "number"]);
      expect(path[1]?.index).toBe(item);
      const element = path[1]?.node as { ref: NodeRef };
      // The element is the very node the listing of the root serves at that position.
      const page = await host.handle({ _tag: "children", ref: root.ref, from: item, count: 1 });
      expect(page.nodes[0]?.ref).toEqual(element.ref);
      expect(await host.handle({ _tag: "keyText", ref: (path[2] as PathStep).node.ref })).toBe(
        "id",
      );
    }
  });

  it.effect.prop(
    "is the innermost value the reader says contains it, with its path of keys and indexes",
    [seeds, seeds],
    ([seed, offsetSeed]) =>
      Effect.promise(async () => {
        const prng = createPrng(seed);
        const text = randomDocument(prng, prng.pick([null, "  "]));
        const bytes = encoder.encode(text);
        const reading = readJsonBytes(bytes);
        const sizing = createPrng(offsetSeed);
        const opened = await openDocument(bytes, {
          regionBytes: sizing.pick([16, 4096]),
          tokenBudget: 1_000_000,
        });
        open.push(opened);
        const { host, documentId } = opened;
        for (let n = 0; n < 8; n++) {
          const offset = sizing.int(bytes.length);
          const { path } = await host.handle({ _tag: "nodeAt", documentId, offset });
          const segments: Array<string | number> = [];
          for (const [position, step] of path.entries()) {
            if (position === 0) continue;
            if (step.node.key !== null) {
              segments.push(await host.handle({ _tag: "keyText", ref: step.node.ref }));
            } else if (step.index !== null) segments.push(step.index);
          }
          const wanted = reading.paths[offset];
          // Bytes outside every value (separators, whitespace) belong to the container they sit in.
          const expected = wanted === null || wanted === undefined ? null : wanted;
          if (expected !== null) expect(JSON.stringify(segments)).toBe(expected);
          else expect(path.length).toBeGreaterThanOrEqual(0);
          // Every step contains the next, and the first is the root.
          expect(path[0]?.node.ref.token).toBe(0);
          for (let i = 1; i < path.length; i++) {
            const outer = path[i - 1]?.node.range as { start: number; end: number };
            const inner = path[i]?.node.range as { start: number; end: number };
            expect(outer.start <= inner.start && inner.end <= Math.max(outer.end, inner.end)).toBe(
              true,
            );
          }
        }
      }),
    { arbitrary: { runs: 40 } },
  );
});
