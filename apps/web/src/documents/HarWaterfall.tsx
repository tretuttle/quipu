import type {
  HarRequestRowSummary,
  HarTimelineSummary,
  HarTimeWindow,
} from "@quipu/contracts/table";
import { type HTMLAttributes, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export interface WaterfallSegment {
  readonly phase: "blocked" | "dns" | "connect" | "ssl" | "send" | "wait" | "receive" | "total";
  readonly label: string;
  readonly ms: number;
  readonly xPct: number;
  readonly widthPct: number;
  readonly colorVar: string;
}

export interface WaterfallGeometry {
  readonly startPct: number;
  readonly totalWidthPct: number;
  readonly effectiveMs: number;
  readonly segments: ReadonlyArray<WaterfallSegment>;
}

const PHASE_SPECS = [
  { key: "blocked", label: "Blocked", colorVar: "var(--muted-foreground)" },
  { key: "dns", label: "DNS", colorVar: "var(--info)" },
  { key: "connect", label: "Connect", colorVar: "var(--warning)" },
  { key: "ssl", label: "SSL", colorVar: "var(--syntax-literal-object)" },
  { key: "send", label: "Send", colorVar: "var(--success)" },
  { key: "wait", label: "Wait", colorVar: "var(--syntax-number)" },
  { key: "receive", label: "Receive", colorVar: "var(--syntax-escape)" },
] as const;

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBodySize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Computes normalized percentage positions for a HAR entry's waterfall timing bars. */
export function computeWaterfallGeometry(
  entry: HarRequestRowSummary,
  totalSpanMs: number,
): WaterfallGeometry {
  const t = entry.timings;
  // HAR 1.2 connect includes ssl when ssl > 0; subtract ssl so stacked bars match total time.
  const tcpConnect = t.ssl > 0 && t.connect >= t.ssl ? t.connect - t.ssl : t.connect;
  const phaseDurations: Record<(typeof PHASE_SPECS)[number]["key"], number> = {
    blocked: t.blocked,
    dns: t.dns,
    connect: tcpConnect,
    ssl: t.ssl,
    send: t.send,
    wait: t.wait,
    receive: t.receive,
  };

  let sumPhases = 0;
  for (const spec of PHASE_SPECS) sumPhases += phaseDurations[spec.key];
  const effectiveMs =
    entry.timeMs !== null && entry.timeMs > 0 ? Math.max(entry.timeMs, sumPhases) : sumPhases;
  const span = Math.max(1, totalSpanMs, entry.startOffsetMs + effectiveMs);

  const startPct = Math.max(0, Math.min(99, (entry.startOffsetMs / span) * 100));
  const rawTotalWidthPct = (effectiveMs / span) * 100;
  const totalWidthPct = Math.min(
    100 - startPct,
    Math.max(effectiveMs > 0 ? 1.2 : 0.8, rawTotalWidthPct),
  );

  const segments: WaterfallSegment[] = [];
  if (sumPhases <= 0) {
    if (effectiveMs > 0) {
      segments.push({
        phase: "total",
        label: "Total",
        ms: effectiveMs,
        xPct: startPct,
        widthPct: totalWidthPct,
        colorVar: statusColorVar(entry.statusClass),
      });
    }
    return { startPct, totalWidthPct, effectiveMs, segments };
  }

  let cursor = startPct;
  for (const spec of PHASE_SPECS) {
    const ms = phaseDurations[spec.key];
    if (ms <= 0) continue;
    const widthPct = Math.max(0.6, (ms / span) * 100);
    const clampedWidth = Math.min(100 - cursor, widthPct);
    if (clampedWidth <= 0) continue;
    segments.push({
      phase: spec.key,
      label: spec.label,
      ms,
      xPct: cursor,
      widthPct: clampedWidth,
      colorVar: spec.colorVar,
    });
    cursor += clampedWidth;
  }

  return { startPct, totalWidthPct, effectiveMs, segments };
}

export function statusColorVar(statusClass: HarRequestRowSummary["statusClass"]): string {
  switch (statusClass) {
    case "2xx":
      return "var(--success)";
    case "3xx":
      return "var(--info)";
    case "4xx":
      return "var(--warning)";
    case "5xx":
      return "var(--error)";
    default:
      return "var(--muted-foreground)";
  }
}

function WaterfallBarsRow({
  entry,
  geometry,
  className,
  ...props
}: {
  readonly entry: HarRequestRowSummary;
  readonly geometry: WaterfallGeometry;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      data-har-waterfall=""
      className={cn("flex w-full min-w-0 items-center gap-2", className)}
    >
      <div aria-hidden="true" className="relative h-3 min-w-0 flex-1">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {geometry.segments.map((seg) => (
          <span
            key={seg.phase}
            className="absolute top-0.5 h-2 rounded-xs"
            style={{
              left: `${seg.xPct}%`,
              width: `${seg.widthPct}%`,
              backgroundColor: seg.colorVar,
            }}
          />
        ))}
      </div>
      <span className="w-14 shrink-0 text-end font-mono text-2xs tabular-nums text-muted-foreground">
        {formatDurationMs(entry.timeMs)}
      </span>
    </div>
  );
}

export function HarWaterfallBar({
  entry,
  totalSpanMs,
}: {
  readonly entry: HarRequestRowSummary;
  readonly totalSpanMs: number;
}) {
  const [engaged, setEngaged] = useState(false);
  const geometry = computeWaterfallGeometry(entry, totalSpanMs);
  if (!engaged) {
    return (
      <div
        className="w-full min-w-0"
        onPointerEnter={() => setEngaged(true)}
        onFocus={() => setEngaged(true)}
      >
        <WaterfallBarsRow entry={entry} geometry={geometry} />
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<WaterfallBarsRow entry={entry} geometry={geometry} />} />
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 font-mono text-2xs">
          <span>Start: +{formatDurationMs(entry.startOffsetMs)}</span>
          <span>Total: {formatDurationMs(entry.timeMs)}</span>
          {geometry.segments.map((seg) => (
            <span key={seg.phase}>
              {seg.label}: {formatDurationMs(seg.ms)}
            </span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Toggleable HAR timeline scrubber:
 * renders requests-in-flight density over time colored by status class
 * (2xx/3xx/4xx/5xx) and supports drag-brush selection of a time window.
 */
export function HarTimelineScrubber({
  timeline,
  timeWindow,
  onTimeWindowChange,
}: {
  readonly timeline: HarTimelineSummary;
  readonly timeWindow: HarTimeWindow | null;
  readonly onTimeWindowChange: (window: HarTimeWindow | null) => void;
}) {
  const trackRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{
    readonly anchorMs: number;
    readonly currentMs: number;
    readonly moved: boolean;
    readonly startX: number;
  } | null>(null);

  const buckets = timeline.buckets;
  const maxInFlight = Math.max(
    1,
    buckets.reduce((peak, b) => Math.max(peak, b.total), 0),
  );
  const spanMs = Math.max(1, timeline.totalSpanMs);
  const bucketCount = Math.max(1, buckets.length);
  const barWidth = 100 / bucketCount;

  const clientXToMs = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * spanMs;
  };

  const activeWindow: HarTimeWindow | null =
    drag !== null && drag.moved
      ? {
          startMs: Math.min(drag.anchorMs, drag.currentMs),
          endMs: Math.max(drag.anchorMs, drag.currentMs),
        }
      : timeWindow;

  const selStartPct = activeWindow ? (Math.max(0, activeWindow.startMs) / spanMs) * 100 : 0;
  const selEndPct = activeWindow ? (Math.min(spanMs, activeWindow.endMs) / spanMs) * 100 : 0;

  return (
    <div
      data-har-timeline=""
      className="flex shrink-0 flex-col gap-1 border-b bg-muted/30 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="font-medium text-foreground">Timeline</span>
          <span>Span: {formatDurationMs(timeline.totalSpanMs)}</span>
          <span>Peak in flight: {maxInFlight.toLocaleString("en-US")}</span>
          {timeWindow !== null ? (
            <span className="font-mono text-foreground">
              Window: {formatDurationMs(timeWindow.startMs)} – {formatDurationMs(timeWindow.endMs)}
            </span>
          ) : (
            <span>Drag across bars to filter by time window</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-xs bg-success" />
            2xx
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-xs bg-info" />
            3xx
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-xs bg-warning" />
            4xx
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-xs bg-error" />
            5xx
          </span>
          {timeWindow !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onTimeWindowChange(null)}
              data-clear-timeline=""
            >
              Clear window
            </Button>
          ) : null}
        </div>
      </div>
      <svg
        ref={trackRef}
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        role="slider"
        aria-label="HAR timeline scrubber"
        aria-valuemin={0}
        aria-valuemax={Math.round(spanMs)}
        aria-valuenow={activeWindow ? Math.round(activeWindow.startMs) : 0}
        tabIndex={0}
        className={cn(
          "h-8 w-full cursor-crosshair select-none rounded-sm border bg-background outline-none",
          "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const ms = clientXToMs(event.clientX);
          setDrag({ anchorMs: ms, currentMs: ms, moved: false, startX: event.clientX });
        }}
        onPointerMove={(event) => {
          if (drag === null) return;
          const ms = clientXToMs(event.clientX);
          const moved = drag.moved || Math.abs(event.clientX - drag.startX) >= 4;
          setDrag({ ...drag, currentMs: ms, moved });
        }}
        onPointerUp={(event) => {
          if (drag === null) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (drag.moved) {
            const startMs = Math.min(drag.anchorMs, drag.currentMs);
            const endMs = Math.max(drag.anchorMs, drag.currentMs);
            if (endMs - startMs > 0) {
              onTimeWindowChange({ startMs, endMs });
            }
          } else if (timeWindow !== null) {
            onTimeWindowChange(null);
          }
          setDrag(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && timeWindow !== null) {
            event.preventDefault();
            onTimeWindowChange(null);
          }
        }}
      >
        {buckets.map((bucket) => {
          if (bucket.total === 0) return null;
          const x = (bucket.startMs / spanMs) * 100;
          const w = Math.max(0.2, barWidth - 0.15);
          const slices: Array<{
            readonly key: string;
            readonly count: number;
            readonly color: string;
          }> = [
            { key: "2xx", count: bucket.c2xx, color: "var(--success)" },
            { key: "3xx", count: bucket.c3xx, color: "var(--info)" },
            { key: "4xx", count: bucket.c4xx, color: "var(--warning)" },
            { key: "5xx", count: bucket.c5xx, color: "var(--error)" },
            { key: "other", count: bucket.c1xx + bucket.cOther, color: "var(--muted-foreground)" },
          ];
          let yBottom = 28;
          return slices.map((s) => {
            if (s.count <= 0) return null;
            const h = Math.max(0.8, (s.count / maxInFlight) * 26);
            yBottom = Math.max(0, yBottom - h);
            return (
              <rect
                key={`${bucket.startMs}:${s.key}`}
                x={x}
                y={yBottom}
                width={w}
                height={h}
                fill={s.color}
              />
            );
          });
        })}
        {activeWindow !== null ? (
          <rect
            x={selStartPct}
            y={0}
            width={Math.max(0.5, selEndPct - selStartPct)}
            height={28}
            fill="var(--info)"
            fillOpacity={0.18}
            stroke="var(--info)"
            strokeWidth={0.4}
          />
        ) : null}
      </svg>
    </div>
  );
}
