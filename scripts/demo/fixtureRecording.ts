// @effect-diagnostics nodeBuiltinImport:off - test helper that writes a synthetic recording to a temp dir.
/**
 * A tiny synthetic recording for the renderer's tests: a solid red page that
 * turns solid green at 1.5 s, one click in the middle of it at 1 s.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp from "sharp";

import type { CameraConfig } from "./camera.ts";
import { encodeEventLog, type EventLog } from "./eventLog.ts";
import type { FrameConfig } from "./frame.ts";

export const TEST_CAMERA: CameraConfig = {
  scene: { width: 1000, height: 500 },
  window: { x: 100, y: 50, width: 800, height: 400 },
  windowInset: 0,
  baseZoom: 1,
  clickZoom: 2,
  fitMargin: 0.7,
  minTargetZoom: 1.2,
  omega: 13,
  leadMs: 300,
  holdMs: 1000,
  mergeGapMs: 1500,
  parallax: 0,
  tailMs: 500,
};

export const TEST_FRAME: FrameConfig = {
  output: { width: 200, height: 100 },
  cornerRadius: 8,
  shadow: { sigma: 6, offsetY: 6, opacity: 0.5 },
  cursorHeight: 0.1,
  cursorZoomExponent: 0.23,
  rippleRadius: 0.1,
  shutterFrames: 0.9,
  blurSamplesMax: 4,
  blurPixelsPerSample: 20,
  blurThreshold: 0.004,
};

export const TEST_FPS = 10;

export const TEST_LOG: EventLog = {
  version: 1,
  flow: "fixture",
  viewport: { width: 400, height: 200, deviceScaleFactor: 1 },
  durationMs: 3000,
  frames: [
    { t: 0, file: "frames/000000.jpg" },
    { t: 1500, file: "frames/000001.jpg" },
  ],
  events: [
    { kind: "move", t: 200, x: 20, y: 20 },
    { kind: "move", t: 600, x: 120, y: 70 },
    { kind: "move", t: 1000, x: 200, y: 100 },
    { kind: "down", t: 1000, x: 200, y: 100, target: { x: 180, y: 80, width: 40, height: 40 } },
    { kind: "up", t: 1070, x: 200, y: 100 },
  ],
};

export const writeFixtureRecording = async (dir: string, log: EventLog = TEST_LOG) => {
  NodeFS.mkdirSync(NodePath.join(dir, "frames"), { recursive: true });
  const solid = (r: number, g: number, b: number) =>
    sharp({ create: { width: 400, height: 200, channels: 3, background: { r, g, b } } })
      .jpeg({ quality: 100 })
      .toBuffer();
  NodeFS.writeFileSync(NodePath.join(dir, "frames", "000000.jpg"), await solid(220, 30, 30));
  NodeFS.writeFileSync(NodePath.join(dir, "frames", "000001.jpg"), await solid(30, 200, 60));
  NodeFS.writeFileSync(NodePath.join(dir, "recording.json"), encodeEventLog(log));
};
