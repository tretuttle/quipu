/** Every number the recorder, camera and renderer use for a demo clip. */
import type { CameraConfig, Rect } from "./camera.ts";
import type { FrameConfig } from "./frame.ts";

/** The recorded page, in CSS pixels, filmed at twice that so zoomed text stays sharp. */
export const VIEWPORT = { width: 1280, height: 944, deviceScaleFactor: 2 } as const;

/** The composed scene is 2560x1440; the output is half that. */
const SCENE = { width: 2560, height: 1440 } as const;

/** The window fills 63.5% of the scene width, centered, with the backdrop around it. */
const windowRect = (): Rect => {
  const width = Math.round(0.635 * SCENE.width);
  const height = Math.round((width * VIEWPORT.height) / VIEWPORT.width);
  return {
    x: Math.round((SCENE.width - width) / 2),
    y: Math.round((SCENE.height - height) / 2),
    width,
    height,
  };
};

export const CAMERA: CameraConfig = {
  scene: SCENE,
  window: windowRect(),
  windowInset: 24,
  // Slightly pushed in at rest, so the idle camera has room to drift with the pointer.
  baseZoom: 1.06,
  clickZoom: 2.2,
  fitMargin: 0.7,
  minTargetZoom: 1.35,
  // A critically damped spring at 13 rad/s peaks in speed 77 ms (1/omega) into a
  // move and is within 1% of its target after 0.75 s.
  omega: 13,
  leadMs: 350,
  holdMs: 1100,
  mergeGapMs: 2400,
  parallax: 0.12,
  tailMs: 900,
};

export const FRAME: FrameConfig = {
  output: { width: 1280, height: 720 },
  cornerRadius: 32,
  shadow: { sigma: 36, offsetY: 36, opacity: 0.55 },
  // The cursor grows about 20% at 2.2x zoom, so it reads as part of the page.
  cursorHeight: 0.044,
  cursorZoomExponent: 0.23,
  rippleRadius: 0.048,
  shutterFrames: 0.9,
  blurSamplesMax: 16,
  blurPixelsPerSample: 8,
  blurThreshold: 0.004,
};

/** 25 fps gives every WebP frame a whole-millisecond delay (40 ms). */
export const FPS = 25;
