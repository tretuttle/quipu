import { describe, expect, it } from "@effect/vitest";
import type { HarRequestRowSummary } from "@quipu/contracts/table";

import {
  computeWaterfallGeometry,
  formatBodySize,
  formatDurationMs,
  statusColorVar,
} from "./HarWaterfall.tsx";

const baseEntry = (overrides: Partial<HarRequestRowSummary> = {}): HarRequestRowSummary => ({
  entryIndex: 0,
  ref: { documentId: 1, tapeId: 0, token: 1 },
  method: "GET",
  url: "https://example.com/api",
  host: "example.com",
  status: 200,
  statusClass: "2xx",
  mimeType: "application/json",
  bodySize: 1024,
  timeMs: 100,
  startedDateTime: "2026-01-01T00:00:00.000Z",
  startOffsetMs: 50,
  timings: {
    blocked: 10,
    dns: 10,
    connect: 30,
    ssl: 10,
    send: 5,
    wait: 40,
    receive: 5,
  },
  ...overrides,
});

describe("HarWaterfall math & formatting", () => {
  it("subtracts HAR 1.2 ssl overlap from connect and preserves segment order", () => {
    const geom = computeWaterfallGeometry(baseEntry(), 200);
    expect(geom.startPct).toBeCloseTo(25, 5);
    expect(geom.segments.map((s) => [s.phase, s.ms])).toEqual([
      ["blocked", 10],
      ["dns", 10],
      ["connect", 20],
      ["ssl", 10],
      ["send", 5],
      ["wait", 40],
      ["receive", 5],
    ]);
    const totalSegWidth = geom.segments.reduce((sum, s) => sum + s.widthPct, 0);
    expect(totalSegWidth).toBeCloseTo(50, 5);
  });

  it("renders a single status-colored bar when timing breakdown is absent", () => {
    const geom = computeWaterfallGeometry(
      baseEntry({
        status: 503,
        statusClass: "5xx",
        timeMs: 80,
        startOffsetMs: 0,
        timings: { blocked: 0, dns: 0, connect: 0, ssl: 0, send: 0, wait: 0, receive: 0 },
      }),
      160,
    );
    expect(geom.segments).toHaveLength(1);
    expect(geom.segments[0]?.phase).toBe("total");
    expect(geom.segments[0]?.colorVar).toBe("var(--error)");
    expect(geom.segments[0]?.widthPct).toBeCloseTo(50, 5);
  });

  it("formats durations, sizes, and Hark -1 / null values cleanly", () => {
    expect(formatBodySize(null)).toBe("—");
    expect(formatBodySize(-1)).toBe("—");
    expect(formatBodySize(512)).toBe("512 B");
    expect(formatBodySize(2048)).toBe("2.0 KB");
    expect(formatBodySize(2 * 1024 * 1024)).toBe("2.00 MB");

    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(0.45)).toBe("0.45 ms");
    expect(formatDurationMs(42)).toBe("42 ms");
    expect(formatDurationMs(1500)).toBe("1.50 s");

    expect(statusColorVar("2xx")).toBe("var(--success)");
    expect(statusColorVar("3xx")).toBe("var(--info)");
    expect(statusColorVar("4xx")).toBe("var(--warning)");
    expect(statusColorVar("5xx")).toBe("var(--error)");
  });
});
