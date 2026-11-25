import { describe, expect, it, vi } from "@effect/vitest";
import type {
  TableQueryResult,
  TableRow,
  TableRowsPage,
  TableTarget,
  TableTargetsResult,
} from "@quipu/contracts/table";

import { TableModel, type TableSource } from "./tableModel.ts";

function makeFakeSource(opts?: { readonly withLateColumn?: boolean }): {
  readonly source: TableSource;
  readonly closeQuery: ReturnType<typeof vi.fn>;
  readonly rowsCall: ReturnType<typeof vi.fn>;
  mutatedValue: string;
  readonly setMutatedValue: (v: string) => void;
} {
  let nextQueryId = 1;
  let mutatedValue = "alpha";
  const target: TableTarget = {
    ref: { documentId: 1, tapeId: 0, token: 0 },
    path: "$",
    label: "Root array",
    kind: "root",
    rowCount: 3,
    isHarEntries: false,
  };
  const altTarget: TableTarget = {
    ref: { documentId: 1, tapeId: 0, token: 5 },
    path: "$.items",
    label: "$.items",
    kind: "array",
    rowCount: 1,
    isHarEntries: false,
  };

  const baseRows = (): TableRow[] => [
    {
      rowIndex: 0,
      displayIndex: 0,
      ref: { documentId: 1, tapeId: 0, token: 1 },
      span: { start: 1, end: 20 },
      cells: {
        name: {
          ref: { documentId: 1, tapeId: 0, token: 2 },
          kind: "string",
          text: mutatedValue,
          truncated: false,
          editable: true,
          numericValue: null,
        },
        score: {
          ref: { documentId: 1, tapeId: 0, token: 3 },
          kind: "number",
          text: "10",
          truncated: false,
          editable: true,
          numericValue: 10,
        },
      },
      har: null,
    },
    {
      rowIndex: 1,
      displayIndex: 1,
      ref: { documentId: 1, tapeId: 0, token: 4 },
      span: { start: 21, end: 40 },
      cells: {
        name: {
          ref: { documentId: 1, tapeId: 0, token: 5 },
          kind: "string",
          text: "beta",
          truncated: false,
          editable: true,
          numericValue: null,
        },
        score: {
          ref: { documentId: 1, tapeId: 0, token: 6 },
          kind: "number",
          text: "2",
          truncated: false,
          editable: true,
          numericValue: 2,
        },
      },
      har: null,
    },
    {
      rowIndex: 2,
      displayIndex: 2,
      ref: { documentId: 1, tapeId: 0, token: 7 },
      span: { start: 41, end: 60 },
      cells: {
        name: {
          ref: { documentId: 1, tapeId: 0, token: 8 },
          kind: "string",
          text: "gamma",
          truncated: false,
          editable: true,
          numericValue: null,
        },
        score: {
          ref: { documentId: 1, tapeId: 0, token: 9 },
          kind: "number",
          text: "30",
          truncated: false,
          editable: true,
          numericValue: 30,
        },
      },
      har: null,
    },
  ];

  const activeRows = new Map<number, TableRow[]>();
  const closeQuery = vi.fn(async () => null);
  const rowsCall = vi.fn(
    async (
      _docId: number,
      queryId: number,
      from: number,
      count: number,
    ): Promise<TableRowsPage> => {
      const list = activeRows.get(queryId) ?? [];
      const slice = list.slice(from, from + count);
      const cols = [
        { key: "name", label: "name", index: 0, kind: "string" as const, late: false },
        { key: "score", label: "score", index: 1, kind: "number" as const, late: false },
        ...(opts?.withLateColumn && from >= 128
          ? [{ key: "extra", label: "extra", index: 2, kind: "string" as const, late: true }]
          : []),
      ];
      return { queryId, from, total: list.length, columns: cols, rows: slice };
    },
  );

  const state = {
    mutatedValue,
    source: {
      targets: async (): Promise<TableTargetsResult> => ({
        targets: [target, altTarget],
        recommendedPath: "$",
      }),
      query: async (spec): Promise<TableQueryResult> => {
        const queryId = nextQueryId++;
        let list = baseRows();
        if (spec.filteredRowIndices !== null) {
          const allowed = new Set(spec.filteredRowIndices);
          list = list.filter((r) => allowed.has(r.rowIndex));
        }
        for (const f of spec.filters) {
          const needle = f.query.toLowerCase();
          list = list.filter((r) => (r.cells[f.column]?.text ?? "").toLowerCase().includes(needle));
        }
        if (spec.sort) {
          const { column, direction } = spec.sort;
          const sign = direction === "desc" ? -1 : 1;
          list = [...list].sort((a, b) => {
            const ca = a.cells[column];
            const cb = b.cells[column];
            if (ca?.numericValue != null && cb?.numericValue != null) {
              return (ca.numericValue - cb.numericValue) * sign;
            }
            return (ca?.text ?? "").localeCompare(cb?.text ?? "") * sign;
          });
        }
        list = list.map((r, i) => ({ ...r, displayIndex: i }));
        activeRows.set(queryId, list);
        return {
          target: spec.targetPath === "$.items" ? altTarget : target,
          columns: [
            { key: "name", label: "name", index: 0, kind: "string", late: false },
            { key: "score", label: "score", index: 1, kind: "number", late: false },
          ],
          totalRows: 3,
          matchedRows: list.length,
          queryId,
          harTimeline: null,
        };
      },
      rows: rowsCall,
      closeQuery,
    } satisfies TableSource,
    closeQuery,
    rowsCall,
    setMutatedValue(v: string) {
      mutatedValue = v;
      state.mutatedValue = v;
    },
  };
  return state;
}

describe("TableModel", () => {
  it("loads targets, toggles sort asc/desc/null, filters, and reloads after edit", async () => {
    const fake = makeFakeSource();
    const model = new TableModel(1, fake.source);
    await model.load();

    expect(model.view().phase).toBe("ready");
    expect(model.view().matchedRows).toBe(3);
    expect(model.rowAt(0)?.cells.name?.text).toBe("alpha");

    await model.toggleSort("score");
    expect(model.view().sort).toEqual({ column: "score", direction: "asc" });
    expect(model.rowAt(0)?.cells.score?.text).toBe("2");

    await model.toggleSort("score");
    expect(model.view().sort).toEqual({ column: "score", direction: "desc" });
    expect(model.rowAt(0)?.cells.score?.text).toBe("30");

    await model.toggleSort("score");
    expect(model.view().sort).toBeNull();
    expect(model.rowAt(0)?.cells.name?.text).toBe("alpha");

    await model.setFilter("name", "gam");
    expect(model.view().matchedRows).toBe(1);
    expect(model.rowAt(0)?.cells.name?.text).toBe("gamma");

    await model.clearAllFilters();
    expect(model.view().matchedRows).toBe(3);

    await model.setFilteredRowIndices([1, 2]);
    expect(model.view().matchedRows).toBe(2);
    expect(model.rowAt(0)?.cells.name?.text).toBe("beta");

    await model.setFilteredRowIndices(null);
    fake.setMutatedValue("alpha-edited");
    await model.reload();
    expect(model.rowAt(0)?.cells.name?.text).toBe("alpha-edited");

    await model.setTargetPath("$.items");
    expect(model.view().target?.path).toBe("$.items");

    model.dispose();
    expect(fake.closeQuery).toHaveBeenCalled();
  });
});
