import {
  type NodePath,
  SOURCE_MAX_ROWS,
  SOURCE_MAX_WRAP_BYTES,
  SOURCE_MIN_WRAP_BYTES,
  type SourceRow,
  type SourceRows,
  type TextValue,
} from "@quipu/contracts/engine";

/** What the source view asks of the engine; the app passes the typed client, tests pass a fake. */
export interface SourceRowsSource {
  readonly rows: (
    offset: number,
    before: number,
    rows: number,
    wrapBytes: number,
  ) => Promise<SourceRows>;
}

/** Everything the source view asks of the engine. */
export interface SourceClient extends SourceRowsSource {
  /** The nodes that hold a byte offset, root first. */
  readonly nodeAt: (offset: number) => Promise<NodePath>;
  /** The first `bytes` of the file as text; the source view reads a small file whole. */
  readonly text: (bytes: number) => Promise<TextValue>;
}

/** The snapshot a view draws: a window of rows and which of them are on screen. */
export interface SourceWindowView {
  readonly rows: ReadonlyArray<SourceRow>;
  /** Index in `rows` of the first row on screen. */
  readonly top: number;
  readonly size: number;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  /** The first window has not arrived yet. */
  readonly loading: boolean;
  readonly error: string | null;
}

/** Where `jumpTo` puts the row that holds the offset. */
export type RowPlacement = "top" | "third" | "bottom";

const MIN_VIEWPORT_ROWS = 4;

/**
 * The rows the source view shows, virtualized by byte offset. It keeps one
 * window of rows around the first visible one, asked of the engine as bounded
 * slices, and moves inside it for free: scrolling by rows only asks for a new
 * window when the view nears an edge, and a jump anywhere in the file is one
 * request. It never holds more than a screen and its margins.
 *
 * Like TreeModel it is a plain object with a version, read through
 * `useSyncExternalStore`.
 */
export class SourceWindowModel {
  private readonly source: SourceRowsSource;
  private size: number;
  private rows: ReadonlyArray<SourceRow> = [];
  private top = 0;
  private atStart = true;
  private atEnd = false;
  private loading = true;
  private failure: string | null = null;
  private viewportRows = 40;
  private wrapBytes = 120;
  private generation = 0;
  private pending = 0;
  private idle: Array<() => void> = [];
  private cache: SourceWindowView | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(source: SourceRowsSource, size: number) {
    this.source = source;
    this.size = size;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  view = (): SourceWindowView => {
    if (this.cache) return this.cache;
    this.cache = {
      rows: this.rows,
      top: this.top,
      size: this.size,
      atStart: this.atStart,
      atEnd: this.atEnd,
      loading: this.loading,
      error: this.failure,
    };
    return this.cache;
  };

  private changed() {
    this.cache = null;
    for (const listener of this.listeners) listener();
  }

  /** How many rows fit and how wide a row is; a new width lays the rows out again. */
  setViewport(rows: number, wrapBytes: number) {
    const nextRows = Math.max(MIN_VIEWPORT_ROWS, Math.min(rows, Math.floor(SOURCE_MAX_ROWS / 3)));
    const nextWrap = Math.max(SOURCE_MIN_WRAP_BYTES, Math.min(wrapBytes, SOURCE_MAX_WRAP_BYTES));
    const widthChanged = nextWrap !== this.wrapBytes;
    const first = this.rows[this.top];
    const rowsChanged = nextRows !== this.viewportRows;
    this.viewportRows = nextRows;
    this.wrapBytes = nextWrap;
    if (this.rows.length === 0) return;
    if (!widthChanged && !rowsChanged) return;
    // A view resting on the end of the file stays there when its rows are laid out again.
    const onEnd = this.atEnd && this.top >= this.rows.length - this.viewportRows;
    void (onEnd ? this.load(this.size, "bottom") : this.load(first?.start ?? 0, "top"));
  }

  /**
   * The document's bytes changed (an edit, an undo): the rows are read again
   * from where the view rests, at the new size, keeping the old rows on screen
   * until the new ones arrive.
   */
  reload(size: number) {
    this.size = size;
    const first = this.rows[this.top];
    return this.load(Math.min(first?.start ?? 0, size), "top");
  }

  /** Loads the first window. Called once the viewport is measured. */
  start(offset = 0, placement: RowPlacement = "top") {
    return this.load(offset, placement);
  }

  /** Shows the row that holds `offset` at the given place on screen. */
  jumpTo(offset: number, placement: RowPlacement = "third") {
    const index = this.indexOf(offset);
    if (index >= 0 && this.fits(index, placement)) {
      this.top = this.placed(index, placement);
      this.changed();
      this.loadIfNearEdge();
      return Promise.resolve();
    }
    return this.load(offset, placement);
  }

  /** The end of the file, with its last row at the bottom of the screen. */
  scrollToEnd() {
    return this.load(this.size, "bottom");
  }

  scrollToStart() {
    return this.load(0, "top");
  }

  /** Moves by whole rows, negative up. Asks the engine only near the window's edge. */
  scrollBy(delta: number) {
    if (this.rows.length === 0 || delta === 0) return;
    const last = this.atEnd
      ? Math.max(0, this.rows.length - this.viewportRows)
      : this.rows.length - 1;
    const next = Math.max(0, Math.min(last, this.top + Math.trunc(delta)));
    if (next === this.top) {
      this.loadIfNearEdge();
      return;
    }
    this.top = next;
    this.changed();
    this.loadIfNearEdge();
  }

  /** A fraction of the file, as the scrollbar's thumb reports. */
  scrollToFraction(fraction: number) {
    const clamped = Math.max(0, Math.min(1, fraction));
    return this.load(Math.floor(clamped * this.size), "top");
  }

  private margin() {
    return Math.max(this.viewportRows, 20);
  }

  private indexOf(offset: number): number {
    if (this.rows.length === 0) return -1;
    const first = this.rows[0] as SourceRow;
    const last = this.rows[this.rows.length - 1] as SourceRow;
    if (offset < first.start) return -1;
    if (offset > last.end) return -1;
    let found = -1;
    for (let i = 0; i < this.rows.length; i++) {
      if ((this.rows[i] as SourceRow).start <= offset) found = i;
      else break;
    }
    // Offsets past the file's end hold the last row only when the window reaches it.
    if (offset >= this.size && !this.atEnd) return -1;
    return found;
  }

  /** Whether the whole screen around `index` is already in the window. */
  private fits(index: number, placement: RowPlacement) {
    const top = this.placed(index, placement);
    if (top < 0) return false;
    const m = this.margin() / 2;
    const clear = this.rows.length - (top + this.viewportRows);
    return (top >= m || this.atStart) && (clear >= m || this.atEnd);
  }

  private placed(index: number, placement: RowPlacement): number {
    if (placement === "top") return index;
    if (placement === "third") return index - Math.floor(this.viewportRows / 3);
    return index - this.viewportRows + 1;
  }

  private loadIfNearEdge() {
    if (this.loading || this.rows.length === 0) return;
    const m = this.margin() / 2;
    const nearTop = this.top < m && !this.atStart;
    const nearBottom = this.rows.length - (this.top + this.viewportRows) < m && !this.atEnd;
    if (!nearTop && !nearBottom) return;
    void this.load((this.rows[this.top] as SourceRow).start, "top");
  }

  /** Resolves once no request to the engine is outstanding. */
  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private async load(offset: number, placement: RowPlacement) {
    this.pending += 1;
    try {
      await this.loadWindow(offset, placement);
    } finally {
      this.pending -= 1;
      if (this.pending === 0) {
        const waiting = this.idle;
        this.idle = [];
        for (const resolve of waiting) resolve();
      }
    }
  }

  private async loadWindow(offset: number, placement: RowPlacement) {
    const generation = ++this.generation;
    const topAtRequest = this.top;
    const margin = Math.min(this.margin(), SOURCE_MAX_ROWS);
    // Rows the placement wants above the anchor, then the screen and a margin below.
    const above =
      placement === "top" ? margin : placement === "third" ? margin : this.viewportRows + margin;
    const before = Math.min(above, SOURCE_MAX_ROWS);
    const rows = Math.max(1, Math.min(this.viewportRows + margin, SOURCE_MAX_ROWS));
    this.loading = this.rows.length === 0;
    try {
      const result = await this.source.rows(offset, before, rows, this.wrapBytes);
      if (generation !== this.generation) return;
      const list = result.rows;
      let anchor = -1;
      for (let i = 0; i < list.length; i++) {
        if ((list[i] as SourceRow).start <= offset) anchor = i;
        else break;
      }
      if (anchor < 0) anchor = 0;
      // Rows scrolled past while the request was out move the view with them.
      const drift = this.rows.length > 0 && placement === "top" ? this.top - topAtRequest : 0;
      this.rows = list;
      this.atStart = result.atStart;
      this.atEnd = result.atEnd;
      const wanted = this.placed(anchor, placement) + drift;
      const lastTop = result.atEnd
        ? Math.max(0, list.length - this.viewportRows)
        : Math.max(0, list.length - 1);
      this.top = Math.max(0, Math.min(lastTop, wanted));
      this.failure = null;
    } catch (error) {
      if (generation !== this.generation) return;
      this.failure = error instanceof Error ? error.message : "The file could not be read.";
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.changed();
      }
    }
  }
}

/** UTF-16 index in `text` of the character that begins `byte` bytes into its UTF-8 encoding. */
export function unitAtByte(text: string, byte: number): number {
  if (byte <= 0) return 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < byte) {
    const code = text.codePointAt(index) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}

/** Bytes the first `unit` UTF-16 units of `text` take in UTF-8. */
export function byteAtUnit(text: string, unit: number): number {
  let bytes = 0;
  let index = 0;
  const end = Math.min(unit, text.length);
  while (index < end) {
    const code = text.codePointAt(index) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code > 0xffff ? 2 : 1;
  }
  return bytes;
}

export interface ColorSpan {
  readonly from: number;
  readonly to: number;
  readonly color: string;
}

export interface TextRun {
  /** UTF-16 index of the run's first character in the row; unique within a row. */
  readonly from: number;
  readonly text: string;
  readonly color: string | null;
  /** Inside the selected node's bytes. */
  readonly selected: boolean;
  /** Inside a search hit; `current` is the hit the user stepped to. */
  readonly hit: boolean;
  readonly current: boolean;
  /** At the byte where the document stops being valid JSON. */
  readonly problem: boolean;
}

/** Search hits to light in a row, as byte ranges of the file. */
export interface RowMarks {
  readonly ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  readonly current: { readonly start: number; readonly end: number } | null;
}

/**
 * Cuts a row's text into runs at every color change and at the edges of the
 * selected byte range, so the view draws one element per run.
 */
export function runsOf(
  row: SourceRow,
  colors: ReadonlyArray<ColorSpan>,
  selection: { readonly start: number; readonly end: number } | null,
  marks: RowMarks | null = null,
  problem: { readonly start: number; readonly end: number } | null = null,
): TextRun[] {
  const text = row.text;
  if (text.length === 0) return [];
  let selectFrom = 0;
  let selectTo = 0;
  if (selection !== null && selection.start < row.end && selection.end > row.start) {
    selectFrom = unitAtByte(text, Math.max(0, selection.start - row.start));
    selectTo = unitAtByte(text, selection.end - row.start);
  }
  // Hit ranges in units of this row's text, sorted and clipped to the row.
  const hitUnits: Array<readonly [number, number]> = [];
  const currentUnits: Array<readonly [number, number]> = [];
  if (marks !== null) {
    const clip = (range: { readonly start: number; readonly end: number }) => {
      if (range.end <= row.start || range.start >= row.end) return null;
      return [
        unitAtByte(text, Math.max(0, range.start - row.start)),
        unitAtByte(text, range.end - row.start),
      ] as const;
    };
    for (const range of marks.ranges) {
      const units = clip(range);
      if (units !== null && units[1] > units[0]) hitUnits.push(units);
    }
    if (marks.current !== null) {
      const units = clip(marks.current);
      if (units !== null && units[1] > units[0]) currentUnits.push(units);
    }
  }
  const inside = (units: ReadonlyArray<readonly [number, number]>, from: number, to: number) =>
    units.some(([a, b]) => from >= a && to <= b);
  const cuts = new Set<number>([0, text.length]);
  for (const [a, b] of [...hitUnits, ...currentUnits]) {
    cuts.add(a);
    cuts.add(Math.min(b, text.length));
  }
  for (const span of colors) {
    cuts.add(Math.min(span.from, text.length));
    cuts.add(Math.min(span.to, text.length));
  }
  if (selectTo > selectFrom) {
    cuts.add(selectFrom);
    cuts.add(Math.min(selectTo, text.length));
  }
  let problemFrom = 0;
  let problemTo = 0;
  if (problem !== null && problem.start < row.end && problem.end > row.start) {
    problemFrom = unitAtByte(text, Math.max(0, problem.start - row.start));
    problemTo = Math.min(text.length, unitAtByte(text, problem.end - row.start));
    cuts.add(problemFrom);
    cuts.add(problemTo);
  }
  const points = [...cuts].toSorted((a, b) => a - b);
  const runs: TextRun[] = [];
  let spanIndex = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] as number;
    const to = points[i + 1] as number;
    while (spanIndex < colors.length && (colors[spanIndex] as ColorSpan).to <= from) spanIndex++;
    const span = colors[spanIndex];
    const color = span !== undefined && span.from <= from && from < span.to ? span.color : null;
    const selected = selectTo > selectFrom && from >= selectFrom && to <= selectTo;
    const hit = inside(hitUnits, from, to);
    const current = inside(currentUnits, from, to);
    const atProblem = problemTo > problemFrom && from >= problemFrom && to <= problemTo;
    const previous = runs[runs.length - 1];
    if (
      previous !== undefined &&
      previous.color === color &&
      previous.selected === selected &&
      previous.hit === hit &&
      previous.current === current &&
      previous.problem === atProblem
    ) {
      runs[runs.length - 1] = { ...previous, text: previous.text + text.slice(from, to) };
    } else {
      runs.push({
        from,
        text: text.slice(from, to),
        color,
        selected,
        hit,
        current,
        problem: atProblem,
      });
    }
  }
  return runs;
}
