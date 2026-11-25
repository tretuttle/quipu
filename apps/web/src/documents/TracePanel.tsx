import type {
  TraceEntryGroup,
  TraceOccurrence,
  TraceResult,
  TraceSectionKind,
} from "@quipu/contracts/deepSearch";
import type { ByteRange } from "@quipu/contracts/engine";
import { create } from "zustand";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";

interface TraceState {
  readonly result: TraceResult | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly originRange: ByteRange | null;
  readonly setLoading: (originRange?: ByteRange | null) => void;
  readonly setResult: (result: TraceResult, originRange?: ByteRange | null) => void;
  readonly setError: (message: string) => void;
  readonly clear: () => void;
}

export const useTraceStore = create<TraceState>((set) => ({
  result: null,
  loading: false,
  error: null,
  originRange: null,
  setLoading: (originRange = null) => set({ loading: true, error: null, originRange }),
  setResult: (result, originRange) =>
    set((state) => ({
      result,
      loading: false,
      error: null,
      originRange: originRange !== undefined ? originRange : state.originRange,
    })),
  setError: (message) => set({ loading: false, error: message }),
  clear: () => set({ result: null, loading: false, error: null, originRange: null }),
}));

const SECTION_LABELS: Readonly<Record<TraceSectionKind, string>> = {
  "request.headers": "Request headers",
  "request.queryString": "Query string",
  "request.postData": "Request body",
  "response.headers": "Response headers",
  "response.content": "Response body",
  cookies: "Cookies",
  other: "Other",
};

const groupBySection = (occurrences: ReadonlyArray<TraceOccurrence>) => {
  const bySection = new Map<TraceSectionKind, TraceOccurrence[]>();
  for (const occ of occurrences) {
    const key = occ.section ?? "other";
    let list = bySection.get(key);
    if (!list) {
      list = [];
      bySection.set(key, list);
    }
    list.push(occ);
  }
  return [...bySection.entries()];
};

export interface TracePanelProps {
  readonly result?: TraceResult | null | undefined;
  readonly loading?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly onSelectOccurrence?: ((occurrence: TraceOccurrence) => void) | undefined;
  readonly onClear?: (() => void) | undefined;
}

export function TracePanel(props: TracePanelProps) {
  const storeResult = useTraceStore((s) => s.result);
  const storeLoading = useTraceStore((s) => s.loading);
  const storeError = useTraceStore((s) => s.error);
  const storeClear = useTraceStore((s) => s.clear);

  const result = props.result !== undefined ? props.result : storeResult;
  const loading = props.loading !== undefined ? props.loading : storeLoading;
  const error = props.error !== undefined ? props.error : storeError;
  const handleClear = props.onClear ?? storeClear;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-trace-panel=""
      role="region"
      aria-label="Exact value trace"
    >
      <header className="flex shrink-0 flex-col gap-1 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-foreground text-sm">Value trace</h3>
          {result !== null ? (
            <Button size="xs" variant="ghost" onClick={handleClear}>
              Clear
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">Every place this exact value appears</p>
        {result !== null ? (
          <div className="flex items-center gap-1.5 pt-0.5 text-xs">
            <Badge variant="outline" size="sm">
              <span className="max-w-44 truncate font-mono">{result.value}</span>
            </Badge>
            <span className="text-muted-foreground">
              {result.total} {result.total === 1 ? "occurrence" : "occurrences"}
              {result.truncated ? "+" : ""}
            </span>
          </div>
        ) : null}
      </header>

      {loading ? (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-3 text-muted-foreground text-xs"
        >
          <Spinner size="xs" />
          Tracing exact occurrences…
        </div>
      ) : error !== null ? (
        <p role="alert" className="px-3 py-3 text-destructive-foreground text-xs">
          {error}
        </p>
      ) : result === null ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">
          Select a scalar value and run Trace Value to list every exact occurrence across the
          document.
        </p>
      ) : result.total === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">
          No exact occurrences found for this value.
        </p>
      ) : result.isHar ? (
        <div className="flex flex-col divide-y">
          {result.harGroups.map((group) => (
            <HarTraceGroup
              key={group.entryIndex}
              group={group}
              onSelectOccurrence={props.onSelectOccurrence}
            />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-1 p-2">
          {result.occurrences.map((occ) => (
            <li key={`${occ.range.start}:${occ.pointer}`}>
              <OccurrenceRow occurrence={occ} onSelect={props.onSelectOccurrence} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HarTraceGroup({
  group,
  onSelectOccurrence,
}: {
  readonly group: TraceEntryGroup;
  readonly onSelectOccurrence?: ((occurrence: TraceOccurrence) => void) | undefined;
}) {
  const sections = groupBySection(group.occurrences);
  return (
    <section className="flex flex-col gap-1.5 px-3 py-2" data-trace-entry={group.entryIndex}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="shrink-0 font-mono text-muted-foreground">#{group.entryIndex}</span>
        {group.method ? (
          <Badge variant="outline" size="sm" className="shrink-0">
            {group.method}
          </Badge>
        ) : null}
        {group.status !== null ? (
          <span className="shrink-0 font-mono text-muted-foreground">{group.status}</span>
        ) : null}
        <span className="min-w-0 truncate text-foreground">{group.url ?? "Entry"}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {sections.map(([section, items]) => (
          <div key={section} className="flex flex-col gap-0.5">
            <span className="font-medium text-muted-foreground text-2xs">
              {SECTION_LABELS[section]}
            </span>
            <ul className="flex flex-col gap-1">
              {items.map((occ) => (
                <li key={`${occ.range.start}:${occ.pointer}`}>
                  <OccurrenceRow occurrence={occ} onSelect={onSelectOccurrence} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function OccurrenceRow({
  occurrence,
  onSelect,
}: {
  readonly occurrence: TraceOccurrence;
  readonly onSelect?: ((occurrence: TraceOccurrence) => void) | undefined;
}) {
  const chainLabel = occurrence.decodeChain.length > 0 ? occurrence.decodeChain.join(" › ") : null;
  return (
    <button
      type="button"
      data-trace-occurrence=""
      onClick={() => onSelect?.(occurrence)}
      className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md bg-muted/50 px-2 py-1 text-left text-xs transition-colors hover:bg-accent"
    >
      <span className="w-full truncate font-mono text-foreground">{occurrence.pointer || "/"}</span>
      {chainLabel !== null ? (
        <Badge variant="outline" size="sm">
          <span className="max-w-full truncate font-mono">{chainLabel}</span>
        </Badge>
      ) : null}
    </button>
  );
}
