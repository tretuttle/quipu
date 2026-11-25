import type {
  DiffChange,
  DiffMark,
  DiffMergedRow,
  HarDiffClass,
  HarDiffEntry,
  HarDiffSummary,
  StructuralDiffResult,
} from "@quipu/contracts/diff";
import type { DocumentFormat } from "@quipu/contracts/engine";

export interface CompareTargetDocument {
  readonly documentId: number;
  readonly name: string;
  readonly size: number;
  readonly format: DocumentFormat;
}

export interface CompareClient {
  readonly openTarget?: (source: File | Blob, name: string) => Promise<CompareTargetDocument>;
  readonly closeTarget?: (documentId: number) => Promise<void>;
  readonly compareStructural: (
    aDocumentId: number,
    bDocumentId: number,
  ) => Promise<StructuralDiffResult>;
  readonly compareHar: (
    aDocumentId: number,
    bDocumentId: number,
    reference: "a" | "b",
  ) => Promise<HarDiffSummary>;
  readonly compareHarEntryBody?: (
    aDocumentId: number,
    aEntryIndex: number | null,
    bDocumentId: number,
    bEntryIndex: number | null,
  ) => Promise<StructuralDiffResult>;
}

export type CompareMode = "structural" | "har";
export type HarFilter = "all" | "differences" | HarDiffClass;

export interface HarEntryBodyState {
  readonly status: "loading" | "ready" | "error";
  readonly diff?: StructuralDiffResult;
  readonly error?: string;
}

export interface CompareSnapshot {
  readonly primary: CompareTargetDocument;
  readonly target: CompareTargetDocument | null;
  readonly reference: "a" | "b";
  readonly mode: CompareMode;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error: string | null;
  readonly structural: StructuralDiffResult | null;
  readonly visibleRows: ReadonlyArray<DiffMergedRow>;
  readonly collapsedIds: ReadonlySet<string>;
  readonly activeChangeIndex: number;
  readonly focusedRowId: string | null;
  readonly har: HarDiffSummary | null;
  readonly harFilter: HarFilter;
  readonly filteredHarEntries: ReadonlyArray<HarDiffEntry>;
  readonly activeHarIndex: number;
  readonly expandedHarKeys: ReadonlySet<string>;
  readonly harEntryBodies: ReadonlyMap<string, HarEntryBodyState>;
  readonly version: number;
}

export function harEntryKey(entry: HarDiffEntry): string {
  return `${entry.groupId}:${entry.matchKey}:${entry.occurrence}`;
}

export function markSymbol(mark: DiffMark): string {
  switch (mark) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "changed":
      return "~";
    case "moved":
      return "→";
    case "inside":
      return "•";
    default:
      return " ";
  }
}

export function harClassSymbol(cls: HarDiffClass): string {
  switch (cls) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "changed":
      return "~";
    default:
      return "=";
  }
}

function computeVisibleRows(
  rows: ReadonlyArray<DiffMergedRow>,
  collapsed: ReadonlySet<string>,
): DiffMergedRow[] {
  if (collapsed.size === 0) return [...rows];
  const out: DiffMergedRow[] = [];
  let hiddenDepth: number | null = null;
  for (const row of rows) {
    if (hiddenDepth !== null) {
      if (row.depth > hiddenDepth) continue;
      hiddenDepth = null;
    }
    out.push(row);
    if (row.expandable && collapsed.has(row.id)) {
      hiddenDepth = row.depth;
    }
  }
  return out;
}

function filterHarEntries(entries: ReadonlyArray<HarDiffEntry>, filter: HarFilter): HarDiffEntry[] {
  if (filter === "all") return [...entries];
  if (filter === "differences") return entries.filter((e) => e.classification !== "same");
  return entries.filter((e) => e.classification === filter);
}

/**
 * Stateful view model for comparing two documents (structural JSON or HAR captures).
 * Exposes `subscribe` / `snapshot` for React `useSyncExternalStore`.
 */
export class CompareModel {
  private primary: CompareTargetDocument;
  private target: CompareTargetDocument | null = null;
  private reference: "a" | "b" = "a";
  private mode: CompareMode;
  private status: "idle" | "loading" | "ready" | "error" = "idle";
  private error: string | null = null;
  private structural: StructuralDiffResult | null = null;
  private collapsedIds = new Set<string>();
  private visibleRows: DiffMergedRow[] = [];
  private activeChangeIndex = -1;
  private focusedRowId: string | null = null;
  private har: HarDiffSummary | null = null;
  private harFilter: HarFilter = "all";
  private filteredHarEntries: HarDiffEntry[] = [];
  private activeHarIndex = -1;
  private expandedHarKeys = new Set<string>();
  private harEntryBodies = new Map<string, HarEntryBodyState>();
  private version = 0;
  private cachedSnapshot: CompareSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly client: CompareClient | null;
  private runToken = 0;

  constructor(primary: CompareTargetDocument, client: CompareClient | null = null) {
    this.primary = primary;
    this.client = client;
    this.mode = primary.format === "har" ? "har" : "structural";
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): CompareSnapshot => {
    if (this.cachedSnapshot === null) {
      this.cachedSnapshot = {
        primary: this.primary,
        target: this.target,
        reference: this.reference,
        mode: this.mode,
        status: this.status,
        error: this.error,
        structural: this.structural,
        visibleRows: this.visibleRows,
        collapsedIds: this.collapsedIds,
        activeChangeIndex: this.activeChangeIndex,
        focusedRowId: this.focusedRowId,
        har: this.har,
        harFilter: this.harFilter,
        filteredHarEntries: this.filteredHarEntries,
        activeHarIndex: this.activeHarIndex,
        expandedHarKeys: this.expandedHarKeys,
        harEntryBodies: this.harEntryBodies,
        version: this.version,
      };
    }
    return this.cachedSnapshot;
  };

  private emit(): void {
    this.version++;
    this.cachedSnapshot = null;
    for (const listener of this.listeners) listener();
  }

  setPrecomputedResult(
    target: CompareTargetDocument,
    result: { readonly structural?: StructuralDiffResult; readonly har?: HarDiffSummary },
  ): void {
    this.target = target;
    this.error = null;
    this.status = "ready";
    this.collapsedIds = new Set();
    this.expandedHarKeys = new Set();
    this.harEntryBodies = new Map();
    if (result.har) {
      this.mode = "har";
      this.har = result.har;
      this.filteredHarEntries = filterHarEntries(result.har.entries, this.harFilter);
      this.activeHarIndex = this.filteredHarEntries.findIndex((e) => e.classification !== "same");
    }
    if (result.structural) {
      if (!result.har) this.mode = "structural";
      this.structural = result.structural;
      this.visibleRows = computeVisibleRows(result.structural.rows, this.collapsedIds);
      this.activeChangeIndex = result.structural.changes.length > 0 ? 0 : -1;
      this.focusedRowId =
        this.activeChangeIndex >= 0
          ? this.rowIdForChange(result.structural.changes[0]!)
          : (this.visibleRows[0]?.id ?? null);
    }
    this.emit();
  }

  async openFile(file: File): Promise<void> {
    if (!this.client?.openTarget) {
      this.status = "error";
      this.error = "Comparison engine is not connected.";
      this.emit();
      return;
    }
    this.status = "loading";
    this.error = null;
    this.emit();
    try {
      const opened = await this.client.openTarget(file, file.name);
      await this.setTarget(opened);
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  async openClipboardText(text: string, name = "clipboard.json"): Promise<void> {
    if (!this.client?.openTarget) {
      this.status = "error";
      this.error = "Comparison engine is not connected.";
      this.emit();
      return;
    }
    this.status = "loading";
    this.error = null;
    this.emit();
    try {
      const blob = new Blob([text], { type: "application/json" });
      const opened = await this.client.openTarget(blob, name);
      await this.setTarget(opened);
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  async setTarget(target: CompareTargetDocument): Promise<void> {
    const previous = this.target;
    if (previous && previous.documentId !== target.documentId && this.client?.closeTarget) {
      void this.client.closeTarget(previous.documentId).catch(() => {});
    }
    this.target = target;
    this.mode = this.primary.format === "har" && target.format === "har" ? "har" : "structural";
    await this.runComparison();
  }

  async setMode(mode: CompareMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.target) await this.runComparison();
    else this.emit();
  }

  async swapReference(): Promise<void> {
    this.reference = this.reference === "a" ? "b" : "a";
    if (this.target) await this.runComparison();
    else this.emit();
  }

  setHarFilter(filter: HarFilter): void {
    this.harFilter = filter;
    this.filteredHarEntries = this.har ? filterHarEntries(this.har.entries, filter) : [];
    this.activeHarIndex = this.filteredHarEntries.findIndex((e) => e.classification !== "same");
    this.emit();
  }

  async runComparison(): Promise<void> {
    if (!this.target || !this.client) return;
    const token = ++this.runToken;
    this.status = "loading";
    this.error = null;
    this.expandedHarKeys = new Set();
    this.harEntryBodies = new Map();
    this.emit();

    const aId = this.reference === "a" ? this.primary.documentId : this.target.documentId;
    const bId = this.reference === "a" ? this.target.documentId : this.primary.documentId;

    try {
      if (this.mode === "har") {
        const res = await this.client.compareHar(
          this.primary.documentId,
          this.target.documentId,
          this.reference,
        );
        if (token !== this.runToken) return;
        this.har = res;
        this.filteredHarEntries = filterHarEntries(res.entries, this.harFilter);
        this.activeHarIndex = this.filteredHarEntries.findIndex((e) => e.classification !== "same");
        this.status = "ready";
      } else {
        const res = await this.client.compareStructural(aId, bId);
        if (token !== this.runToken) return;
        this.structural = res;
        this.collapsedIds = new Set();
        this.visibleRows = computeVisibleRows(res.rows, this.collapsedIds);
        this.activeChangeIndex = res.changes.length > 0 ? 0 : -1;
        this.focusedRowId =
          this.activeChangeIndex >= 0
            ? this.rowIdForChange(res.changes[0]!)
            : (this.visibleRows[0]?.id ?? null);
        this.status = "ready";
      }
      this.emit();
    } catch (err) {
      if (token !== this.runToken) return;
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  toggleRow(rowId: string): void {
    if (!this.structural) return;
    const next = new Set(this.collapsedIds);
    if (next.has(rowId)) next.delete(rowId);
    else next.add(rowId);
    this.collapsedIds = next;
    this.visibleRows = computeVisibleRows(this.structural.rows, next);
    this.emit();
  }

  focusRow(rowId: string): void {
    if (this.focusedRowId === rowId) return;
    this.focusedRowId = rowId;
    this.emit();
  }

  private rowIdForChange(change: DiffChange): string | null {
    if (change.bToken !== null) return `b:${change.bToken}`;
    if (change.aToken !== null) return `a:${change.aToken}`;
    return null;
  }

  private revealRow(rowId: string): void {
    if (!this.structural || this.collapsedIds.size === 0) return;
    const rows = this.structural.rows;
    const targetIdx = rows.findIndex((r) => r.id === rowId);
    if (targetIdx < 0) return;
    const next = new Set(this.collapsedIds);
    let depthNeeded = rows[targetIdx]!.depth;
    let changed = false;
    for (let i = targetIdx - 1; i >= 0 && depthNeeded > 0; i--) {
      const r = rows[i]!;
      if (r.depth < depthNeeded) {
        if (next.delete(r.id)) changed = true;
        depthNeeded = r.depth;
      }
    }
    if (changed) {
      this.collapsedIds = next;
      this.visibleRows = computeVisibleRows(rows, next);
    }
  }

  selectChange(index: number): void {
    if (!this.structural || index < 0 || index >= this.structural.changes.length) return;
    this.activeChangeIndex = index;
    const rowId = this.rowIdForChange(this.structural.changes[index]!);
    if (rowId) {
      this.revealRow(rowId);
      this.focusedRowId = rowId;
    }
    this.emit();
  }

  stepNext(): void {
    if (this.mode === "har") {
      this.stepHar(1);
      return;
    }
    if (!this.structural || this.structural.changes.length === 0) return;
    const next = (this.activeChangeIndex + 1) % this.structural.changes.length;
    this.selectChange(next);
  }

  stepPrevious(): void {
    if (this.mode === "har") {
      this.stepHar(-1);
      return;
    }
    if (!this.structural || this.structural.changes.length === 0) return;
    const len = this.structural.changes.length;
    const prev = this.activeChangeIndex <= 0 ? len - 1 : this.activeChangeIndex - 1;
    this.selectChange(prev);
  }

  private stepHar(delta: 1 | -1): void {
    const entries = this.filteredHarEntries;
    if (entries.length === 0) return;
    const changedIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.classification !== "same") changedIndices.push(i);
    }
    if (changedIndices.length === 0) return;
    const curPos = changedIndices.indexOf(this.activeHarIndex);
    const nextPos =
      curPos < 0
        ? delta > 0
          ? 0
          : changedIndices.length - 1
        : (curPos + delta + changedIndices.length) % changedIndices.length;
    this.activeHarIndex = changedIndices[nextPos]!;
    this.emit();
  }

  selectHarEntry(index: number): void {
    if (index < 0 || index >= this.filteredHarEntries.length) return;
    this.activeHarIndex = index;
    this.emit();
  }

  async toggleHarEntry(entry: HarDiffEntry): Promise<void> {
    const key = harEntryKey(entry);
    const next = new Set(this.expandedHarKeys);
    if (next.has(key)) {
      next.delete(key);
      this.expandedHarKeys = next;
      this.emit();
      return;
    }
    next.add(key);
    this.expandedHarKeys = next;
    if (this.harEntryBodies.has(key) || !this.client?.compareHarEntryBody || !this.target) {
      this.emit();
      return;
    }

    const bodies = new Map(this.harEntryBodies);
    bodies.set(key, { status: "loading" });
    this.harEntryBodies = bodies;
    this.emit();

    const aDocId = this.reference === "a" ? this.primary.documentId : this.target.documentId;
    const bDocId = this.reference === "a" ? this.target.documentId : this.primary.documentId;
    try {
      const diff = await this.client.compareHarEntryBody(
        aDocId,
        entry.entryIndexBefore,
        bDocId,
        entry.entryIndexAfter,
      );
      const updated = new Map(this.harEntryBodies);
      updated.set(key, { status: "ready", diff });
      this.harEntryBodies = updated;
      this.emit();
    } catch (err) {
      const updated = new Map(this.harEntryBodies);
      updated.set(key, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      this.harEntryBodies = updated;
      this.emit();
    }
  }

  dispose(): void {
    if (this.target && this.client?.closeTarget) {
      void this.client.closeTarget(this.target.documentId).catch(() => {});
    }
    this.listeners.clear();
  }
}
