/**
 * The virtual camera: a pure function of the event log.
 *
 * The camera rests slightly zoomed in and drifts with the pointer (the idle
 * pan). A click or key press starts a zoom toward its target a little before it
 * lands, holds while interactions keep arriving, then zooms back out and drifts
 * again. Every move is a critically damped spring: a fast start and an
 * exponential tail with no overshoot. Zoom springs in log space, so zooming in
 * and out feel equally fast.
 *
 * Nothing here reads a clock or a random source, so the same log always gives
 * the same crops.
 */
import { cursorSceneAt, type Point } from "./cursor.ts";
import type { Box, EventLog } from "./eventLog.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CameraConfig {
  /** The composed scene the camera crops from, in scene pixels. */
  readonly scene: { readonly width: number; readonly height: number };
  /** Where the recorded page sits inside the scene. */
  readonly window: Rect;
  /** A zoomed view stays this far inside the window, so its rounded corners never show backdrop. */
  readonly windowInset: number;
  /** Zoom while nothing is happening. 1 shows the whole scene. */
  readonly baseZoom: number;
  /** Zoom toward a click or key target. */
  readonly clickZoom: number;
  /** A target box may fill at most this fraction of the zoomed frame. */
  readonly fitMargin: number;
  /** The camera never zooms in less than this for a target, so a big box still reads as a move. */
  readonly minTargetZoom: number;
  /** Spring stiffness in rad/s. */
  readonly omega: number;
  /** The zoom starts this long before an interaction lands. */
  readonly leadMs: number;
  /** The zoom holds this long after the last interaction in a group. */
  readonly holdMs: number;
  /** Interactions closer than this share one zoom. */
  readonly mergeGapMs: number;
  /** How far the idle camera follows the pointer away from the scene center. */
  readonly parallax: number;
  /** Time past the last event the clip keeps running, so the un-zoom finishes on screen. */
  readonly tailMs: number;
}

export interface Crop extends Rect {
  readonly zoom: number;
}

export interface CameraPath {
  readonly durationMs: number;
  readonly at: (tMs: number) => Crop;
}

interface Segment {
  readonly fromMs: number;
  readonly toMs: number;
  readonly center: Point;
  readonly zoom: number;
}

const STEP_MS = 1000 / 240;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Maps a page CSS pixel point into scene pixels. */
const pageToScene = (
  point: Point,
  viewport: { readonly width: number; readonly height: number },
  window: Rect,
): Point => ({
  x: window.x + (point.x * window.width) / viewport.width,
  y: window.y + (point.y * window.height) / viewport.height,
});

const boxToScene = (
  box: Box,
  viewport: { readonly width: number; readonly height: number },
  window: Rect,
) => {
  const scaleX = window.width / viewport.width;
  const scaleY = window.height / viewport.height;
  return {
    center: pageToScene({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, viewport, window),
    width: box.width * scaleX,
    height: box.height * scaleY,
  };
};

interface Interaction {
  readonly t: number;
  readonly center: Point;
  readonly zoom: number;
}

/** Turns clicks and key presses into the points the camera should look at. */
const interactionsOf = (log: EventLog, config: CameraConfig): Interaction[] => {
  const { viewport } = log;
  const { scene, window } = config;
  const out: Interaction[] = [];
  let last: Interaction | null = null;
  for (const event of log.events) {
    if (event.kind !== "down" && event.kind !== "key") continue;
    let next: Interaction;
    if (event.target !== null) {
      const box = boxToScene(event.target, viewport, window);
      const fit = Math.min(
        (config.fitMargin * scene.width) / Math.max(1, box.width),
        (config.fitMargin * scene.height) / Math.max(1, box.height),
      );
      const zoom = clamp(Math.min(config.clickZoom, fit), config.minTargetZoom, config.clickZoom);
      next = { t: event.t, center: box.center, zoom };
    } else if (event.kind === "down") {
      next = {
        t: event.t,
        center: pageToScene({ x: event.x, y: event.y }, viewport, window),
        zoom: config.clickZoom,
      };
    } else if (last !== null) {
      next = { t: event.t, center: last.center, zoom: last.zoom };
    } else {
      continue;
    }
    out.push(next);
    last = next;
  }
  return out;
};

const segmentsOf = (interactions: ReadonlyArray<Interaction>, config: CameraConfig): Segment[] => {
  const segments: Segment[] = [];
  let index = 0;
  while (index < interactions.length) {
    let end = index;
    while (
      end + 1 < interactions.length &&
      interactions[end + 1]!.t - interactions[end]!.t <= config.mergeGapMs
    ) {
      end += 1;
    }
    for (let i = index; i <= end; i += 1) {
      const current = interactions[i]!;
      const next = i < end ? interactions[i + 1]! : null;
      segments.push({
        fromMs: current.t - config.leadMs,
        toMs: next === null ? current.t + config.holdMs : next.t - config.leadMs,
        center: current.center,
        zoom: current.zoom,
      });
    }
    index = end + 1;
  }
  return segments;
};

/**
 * The crop rectangle for a camera center and zoom. At low zoom the crop may
 * wander over the whole scene; as it tightens toward the window's own size the
 * allowed range closes onto the window, so a zoomed view never shows backdrop.
 */
const cropFor = (center: Point, zoom: number, config: CameraConfig): Crop => {
  const { scene, window, windowInset } = config;
  const width = scene.width / zoom;
  const height = scene.height / zoom;
  const windowZoom = scene.width / (window.width - 2 * windowInset);
  const s = clamp((zoom - 1.1) / (windowZoom - 1.1), 0, 1);
  const lerp = (a: number, b: number) => a + (b - a) * s;
  const left = lerp(0, window.x + windowInset);
  const top = lerp(0, window.y + windowInset);
  const right = lerp(scene.width, window.x + window.width - windowInset);
  const bottom = lerp(scene.height, window.y + window.height - windowInset);
  const x =
    right - left <= width
      ? (left + right - width) / 2
      : clamp(center.x - width / 2, left, right - width);
  const y =
    bottom - top <= height
      ? (top + bottom - height) / 2
      : clamp(center.y - height / 2, top, bottom - height);
  return { x, y, width, height, zoom };
};

/** One critically damped spring step; `v` is the velocity in value units per second. */
const springStep = (value: number, velocity: number, target: number, omega: number, dt: number) => {
  const error = value - target;
  const decay = Math.exp(-omega * dt);
  const slope = velocity + omega * error;
  return {
    value: target + (error + slope * dt) * decay,
    velocity: (velocity - omega * slope * dt) * decay,
  };
};

export const planCamera = (log: EventLog, config: CameraConfig): CameraPath => {
  const segments = segmentsOf(interactionsOf(log, config), config);
  const durationMs = log.durationMs + config.tailMs;
  const sceneCenter: Point = { x: config.scene.width / 2, y: config.scene.height / 2 };

  const targetAt = (tMs: number) => {
    const segment = segments.find((s) => tMs >= s.fromMs && tMs < s.toMs);
    if (segment !== undefined) {
      const crop = cropFor(segment.center, segment.zoom, config);
      return {
        cx: crop.x + crop.width / 2,
        cy: crop.y + crop.height / 2,
        logZoom: Math.log(segment.zoom),
      };
    }
    const cursor = cursorSceneAt(log, tMs, config.window) ?? sceneCenter;
    const center = {
      x: sceneCenter.x + config.parallax * (cursor.x - sceneCenter.x),
      y: sceneCenter.y + config.parallax * (cursor.y - sceneCenter.y),
    };
    const crop = cropFor(center, config.baseZoom, config);
    return {
      cx: crop.x + crop.width / 2,
      cy: crop.y + crop.height / 2,
      logZoom: Math.log(config.baseZoom),
    };
  };

  const start = targetAt(0);
  let cx = { value: start.cx, velocity: 0 };
  let cy = { value: start.cy, velocity: 0 };
  let lz = { value: start.logZoom, velocity: 0 };
  const dt = STEP_MS / 1000;
  const count = Math.ceil(durationMs / STEP_MS) + 2;
  const samples: Crop[] = [];
  for (let i = 0; i < count; i += 1) {
    samples.push(cropFor({ x: cx.value, y: cy.value }, Math.exp(lz.value), config));
    const target = targetAt(i * STEP_MS);
    cx = springStep(cx.value, cx.velocity, target.cx, config.omega, dt);
    cy = springStep(cy.value, cy.velocity, target.cy, config.omega, dt);
    lz = springStep(lz.value, lz.velocity, target.logZoom, config.omega, dt);
  }

  const at = (tMs: number): Crop => {
    const position = clamp(tMs / STEP_MS, 0, samples.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(samples.length - 1, lower + 1);
    const a = samples[lower]!;
    const b = samples[upper]!;
    const f = position - lower;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      width: a.width + (b.width - a.width) * f,
      height: a.height + (b.height - a.height) * f,
      zoom: a.zoom + (b.zoom - a.zoom) * f,
    };
  };

  return { durationMs, at };
};

export interface CameraFrame {
  readonly index: number;
  readonly tMs: number;
  readonly crop: Crop;
}

/** The camera sampled at the output frame rate; this is what `camera.json` holds. */
export const frameCrops = (path: CameraPath, fps: number): CameraFrame[] => {
  const count = Math.floor((path.durationMs * fps) / 1000) + 1;
  const round = (value: number) => Math.round(value * 100) / 100;
  return Array.from({ length: count }, (_, index) => {
    const tMs = (index * 1000) / fps;
    const crop = path.at(tMs);
    return {
      index,
      tMs: round(tMs),
      crop: {
        x: round(crop.x),
        y: round(crop.y),
        width: round(crop.width),
        height: round(crop.height),
        zoom: Math.round(crop.zoom * 1000) / 1000,
      },
    };
  });
};
