/**
 * The synthesized cursor. Playwright paints no OS cursor, so the renderer draws
 * one from the pointer samples in the event log: a cubic Hermite curve through
 * every logged position, a squash while the button is down, and a ripple at
 * each press.
 */
import type { EventLog } from "./eventLog.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface Sample extends Point {
  readonly t: number;
}

const samplesOf = (log: EventLog): Sample[] => {
  const out: Sample[] = [];
  for (const event of log.events) {
    if (event.kind === "key") continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.t === event.t) {
      out[out.length - 1] = { t: event.t, x: event.x, y: event.y };
    } else {
      out.push({ t: event.t, x: event.x, y: event.y });
    }
  }
  return out;
};

/** Pointer position in page CSS pixels, or null before the first pointer event. */
const cursorPageAt = (log: EventLog, tMs: number): Point | null => {
  const samples = samplesOf(log);
  const first = samples[0];
  if (first === undefined || tMs < first.t) return null;
  const last = samples[samples.length - 1]!;
  if (tMs >= last.t) return { x: last.x, y: last.y };

  let hi = 1;
  while (samples[hi]!.t <= tMs) hi += 1;
  const p1 = samples[hi - 1]!;
  const p2 = samples[hi]!;
  const p0 = samples[hi - 2] ?? p1;
  const p3 = samples[hi + 1] ?? p2;
  const span = p2.t - p1.t;
  const u = (tMs - p1.t) / span;
  const tangent = (before: Sample, after: Sample, axis: "x" | "y") => {
    const dt = after.t - before.t;
    return dt === 0 ? 0 : ((after[axis] - before[axis]) / dt) * span;
  };
  const hermite = (axis: "x" | "y") => {
    const m1 = tangent(p0, p2, axis);
    const m2 = tangent(p1, p3, axis);
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * p1[axis] +
      (u3 - 2 * u2 + u) * m1 +
      (-2 * u3 + 3 * u2) * p2[axis] +
      (u3 - u2) * m2
    );
  };
  return { x: hermite("x"), y: hermite("y") };
};

/** Pointer position in scene pixels, given where the page sits in the scene. */
export const cursorSceneAt = (
  log: EventLog,
  tMs: number,
  window: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): Point | null => {
  const page = cursorPageAt(log, tMs);
  if (page === null) return null;
  return {
    x: window.x + (page.x * window.width) / log.viewport.width,
    y: window.y + (page.y * window.height) / log.viewport.height,
  };
};

export interface Ripple extends Point {
  /** 0 at the press, 1 when the ripple has finished. */
  readonly progress: number;
}

export const RIPPLE_MS = 520;

/** Every ripple that is still visible at `tMs`, with its page position. */
export const ripplesAt = (log: EventLog, tMs: number): Ripple[] => {
  const out: Ripple[] = [];
  for (const event of log.events) {
    if (event.kind !== "down") continue;
    const age = tMs - event.t;
    if (age >= 0 && age < RIPPLE_MS) {
      out.push({ x: event.x, y: event.y, progress: age / RIPPLE_MS });
    }
  }
  return out;
};

const PRESS_MS = 90;

/** 1 when the button is up, easing down to 0 while it is held. */
export const pressAt = (log: EventLog, tMs: number): number => {
  let down: number | null = null;
  let amount = 0;
  for (const event of log.events) {
    if (event.t > tMs) break;
    if (event.kind === "down") down = event.t;
    if (event.kind === "up" && down !== null) {
      const release = Math.min(1, (tMs - event.t) / PRESS_MS);
      amount = 1 - release;
      down = null;
    }
  }
  if (down !== null) amount = Math.min(1, (tMs - down) / PRESS_MS);
  return 1 - amount;
};
