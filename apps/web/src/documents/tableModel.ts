import type {
  HarTimeWindow,
  HarTimelineSummary,
  TableColumn,
  TableFilterSpec,
  TableQueryResult,
  TableRow,
  TableRowsPage,
  TableSortSpec,
  TableTarget,
  TableTargetsResult,
} from "@quipu/contracts/table";

export interface TableSource {
  readonly targets: (documentId: number) => Promise<TableTargetsResult>;
  readonly query: (spec: {
    readonly documentId: number;
    readonly targetPath: string | null;
    readonly revision?: number;
    readonly sort: TableSortSpec | null;
    readonly filters: ReadonlyArray<TableFilterSpec>;
    readonly timeWindow: HarTimeWindow | null;
    readonly filteredRowIndices: ReadonlyArray<number> | null;
  }) => Promise<TableQueryResult>;
  readonly rows: (
    documentId: number,
    queryId: number,
    from: number,
    count: number,
  ) => Promise<TableRowsPage>;
  readonly closeQuery: (documentId: number, queryId: number) => Promise<null>;
}

export const TABLE_VIEW_PAGE_SIZE = 34;

export interface TableSnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly error: string | null;
  readonly targets: ReadonlyArray<TableTarget>;
  readonly target: TableTarget | null;
  readonly columns: ReadonlyArray<TableColumn>;
  readonly totalRows: number;
  readonly matchedRows: number;
  readonly slots: number[];
  readonly sort: TableSortSpec | null;
  readonly filters: Readonly<Record<string, string>>;
  readonly timeWindow: HarTimeWindow | null;
  readonly filteredRowIndices: ReadonlyArray<number> | null;
  readonly harTimeline: HarTimelineSummary | null;
  readonly revision: number;
}

/**
 * View model for the virtualized table view: manages target-array selection,
 * view-only sort/filter/timeWindow queries, on-demand page caching for LegendList,
 * and late-discovered column merging.
 */
export class TableModel {
  readonly documentId: number;
  private readonly source: TableSource;
  private readonly listeners = new Set<() => void>();
  private state: TableSnapshot = {
    phase: "idle",
    error: null,
    targets: [],
    target: null,
    columns: [],
    totalRows: 0,
    matchedRows: 0,
    slots: [],
    sort: null,
    filters: {},
    timeWindow: null,
    filteredRowIndices: null,
    harTimeline: null,
    revision: 0,
  };
  private targetPath: string | null = null;
  private activeQueryId: number | null = null;
  private queryEpoch = 0;
  private readonly rowCache = new Map<number, TableRow>();
  private readonly inflightPages = new Set<number>();

  constructor(documentId: number, source: TableSource) {
    this.documentId = documentId;
    this.source = source;
  }

  private docRevision = 0;

  setDocumentRevision(rev: number): void {
    this.docRevision = rev;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  view = (): TableSnapshot => this.state;

  rowAt(displayIndex: number): TableRow | undefined {
    return this.rowCache.get(displayIndex);
  }

  private emit(patch: Partial<TableSnapshot>) {
    this.state = {
      ...this.state,
      ...patch,
      revision: this.state.revision + 1,
    };
    for (const listener of this.listeners) listener();
  }

  async load(): Promise<void> {
    const epoch = ++this.queryEpoch;
    this.emit({ phase: "loading", error: null });
    try {
      const targetsPromise = this.source.targets(this.documentId).then((discovered) => {
        if (epoch !== this.queryEpoch) return;
        this.targetPath ??= discovered.recommendedPath;
        this.emit({ targets: discovered.targets });
      });
      await Promise.all([targetsPromise, this.executeQuery(epoch)]);
    } catch (err) {
      if (epoch !== this.queryEpoch) return;
      this.emit({
        phase: "error",
        error: err instanceof Error ? err.message : "Could not load table view.",
      });
    }
  }

  async reload(): Promise<void> {
    const epoch = ++this.queryEpoch;
    try {
      const discovered = await this.source.targets(this.documentId);
      if (epoch !== this.queryEpoch) return;
      this.emit({ targets: discovered.targets });
      await this.executeQuery(epoch);
    } catch (err) {
      if (epoch !== this.queryEpoch) return;
      this.emit({
        phase: "error",
        error: err instanceof Error ? err.message : "Could not refresh table view.",
      });
    }
  }

  async setTargetPath(path: string): Promise<void> {
    if (this.targetPath === path) return;
    this.targetPath = path;
    const epoch = ++this.queryEpoch;
    this.emit({
      phase: "loading",
      error: null,
      sort: null,
      filters: {},
      timeWindow: null,
    });
    await this.executeQuery(epoch);
  }

  async toggleSort(column: string): Promise<void> {
    const cur = this.state.sort;
    let next: TableSortSpec | null;
    if (cur === null || cur.column !== column) {
      next = { column, direction: "asc" };
    } else if (cur.direction === "asc") {
      next = { column, direction: "desc" };
    } else {
      next = null;
    }
    const epoch = ++this.queryEpoch;
    this.emit({ sort: next });
    await this.executeQuery(epoch);
  }

  async setFilter(column: string, query: string): Promise<void> {
    const prev = this.state.filters[column] ?? "";
    if (prev === query) return;
    const nextFilters: Record<string, string> = { ...this.state.filters };
    if (query === "") delete nextFilters[column];
    else nextFilters[column] = query;
    const epoch = ++this.queryEpoch;
    this.emit({ filters: nextFilters });
    await this.executeQuery(epoch);
  }

  async clearAllFilters(): Promise<void> {
    if (
      Object.keys(this.state.filters).length === 0 &&
      this.state.timeWindow === null &&
      this.state.sort === null
    ) {
      return;
    }
    const epoch = ++this.queryEpoch;
    this.emit({ filters: {}, timeWindow: null, sort: null });
    await this.executeQuery(epoch);
  }

  async setTimeWindow(timeWindow: HarTimeWindow | null): Promise<void> {
    const epoch = ++this.queryEpoch;
    this.emit({ timeWindow });
    await this.executeQuery(epoch);
  }

  async setFilteredRowIndices(indices: ReadonlyArray<number> | null): Promise<void> {
    if (sameIndices(this.state.filteredRowIndices, indices)) return;
    const epoch = ++this.queryEpoch;
    this.emit({ filteredRowIndices: indices });
    if (this.state.phase !== "idle") {
      await this.executeQuery(epoch);
    }
  }

  requestRow(displayIndex: number): void {
    if (displayIndex < 0 || displayIndex >= this.state.matchedRows) return;
    if (this.rowCache.has(displayIndex)) return;
    const pageStart = Math.floor(displayIndex / TABLE_VIEW_PAGE_SIZE) * TABLE_VIEW_PAGE_SIZE;
    if (this.inflightPages.has(pageStart)) return;
    const queryId = this.activeQueryId;
    if (queryId === null) return;
    const epoch = this.queryEpoch;
    this.inflightPages.add(pageStart);
    const count = Math.min(TABLE_VIEW_PAGE_SIZE, this.state.matchedRows - pageStart);
    if (count <= 0) {
      this.inflightPages.delete(pageStart);
      return;
    }
    void this.source
      .rows(this.documentId, queryId, pageStart, count)
      .then((page) => {
        this.inflightPages.delete(pageStart);
        if (epoch !== this.queryEpoch || this.activeQueryId !== queryId) return;
        for (const row of page.rows) {
          this.rowCache.set(row.displayIndex, row);
        }
        const mergedColumns = mergeColumns(this.state.columns, page.columns);
        this.emit({ columns: mergedColumns });
      })
      .catch(() => {
        this.inflightPages.delete(pageStart);
      });
  }

  dispose(): void {
    this.queryEpoch++;
    if (this.activeQueryId !== null) {
      const id = this.activeQueryId;
      this.activeQueryId = null;
      void this.source.closeQuery(this.documentId, id).catch(() => null);
    }
    this.rowCache.clear();
    this.inflightPages.clear();
  }

  private async executeQuery(epoch: number): Promise<void> {
    const prevId = this.activeQueryId;
    const filterList: TableFilterSpec[] = Object.entries(this.state.filters)
      .filter(([, query]) => query.trim().length > 0)
      .map(([column, query]) => ({ column, query }));

    try {
      const result = await this.source.query({
        documentId: this.documentId,
        targetPath: this.targetPath,
        revision: this.docRevision,
        sort: this.state.sort,
        filters: filterList,
        timeWindow: this.state.timeWindow,
        filteredRowIndices: this.state.filteredRowIndices,
      });
      if (epoch !== this.queryEpoch) {
        void this.source.closeQuery(this.documentId, result.queryId).catch(() => null);
        return;
      }
      if (prevId !== null && prevId !== result.queryId) {
        void this.source.closeQuery(this.documentId, prevId).catch(() => null);
      }
      this.activeQueryId = result.queryId;
      this.rowCache.clear();
      this.inflightPages.clear();

      const slots = Array.from({ length: result.matchedRows }, (_, i) => i);

      // Eagerly prefetch the first viewport page so initial rows appear immediately.
      let initialColumns = result.columns;
      if (result.matchedRows > 0) {
        const firstCount = Math.min(TABLE_VIEW_PAGE_SIZE, result.matchedRows);
        const page = await this.source.rows(this.documentId, result.queryId, 0, firstCount);
        if (epoch !== this.queryEpoch) return;
        for (const row of page.rows) this.rowCache.set(row.displayIndex, row);
        initialColumns = mergeColumns(result.columns, page.columns);
      }

      this.emit({
        phase: "ready",
        error: null,
        target: result.target,
        columns: initialColumns,
        totalRows: result.totalRows,
        matchedRows: result.matchedRows,
        slots,
        harTimeline: result.harTimeline,
      });
    } catch (err) {
      if (epoch !== this.queryEpoch) return;
      this.emit({
        phase: "error",
        error: err instanceof Error ? err.message : "Table query failed.",
      });
    }
  }
}

function mergeColumns(
  current: ReadonlyArray<TableColumn>,
  incoming: ReadonlyArray<TableColumn>,
): ReadonlyArray<TableColumn> {
  if (incoming.length <= current.length) return current;
  const known = new Set(current.map((c) => c.key));
  const next = [...current];
  for (const col of incoming) {
    if (!known.has(col.key)) {
      known.add(col.key);
      next.push(col);
    }
  }
  return next;
}

function sameIndices(a: ReadonlyArray<number> | null, b: ReadonlyArray<number> | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
