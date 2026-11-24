/**
 * Framing and compositing: the scene (backdrop, shadow, rounded window), the
 * camera crop, motion blur and the cursor overlay. Pure functions of their
 * inputs; the pixels depend only on the frames and the crops they are given.
 */
import sharp, { type OutputInfo, type OverlayOptions } from "sharp";

import type { CameraConfig, Crop, Rect } from "./camera.ts";
import { RIPPLE_MS, type Point, type Ripple } from "./cursor.ts";

export interface FrameConfig {
  readonly output: { readonly width: number; readonly height: number };
  /** Corner radius of the recorded window, in scene pixels. */
  readonly cornerRadius: number;
  /** Shadow blur sigma and downward offset, in scene pixels. */
  readonly shadow: { readonly sigma: number; readonly offsetY: number; readonly opacity: number };
  /** Cursor height as a fraction of the output height at zoom 1. */
  readonly cursorHeight: number;
  /** Cursor size grows with zoom to this power. */
  readonly cursorZoomExponent: number;
  /** Ripple radius as a fraction of the output height. */
  readonly rippleRadius: number;
  /** Shutter length in output frames; the camera is averaged over it while it moves. */
  readonly shutterFrames: number;
  /** Upper bound on sub-samples per output frame while the camera moves. */
  readonly blurSamplesMax: number;
  /** One sub-sample per this many output pixels of camera travel, so copies blend into a smear. */
  readonly blurPixelsPerSample: number;
  /** Camera travel (as a fraction of the crop width) above which blur is applied. */
  readonly blurThreshold: number;
}

export interface Raw {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

const rawRgb = (data: Buffer, info: OutputInfo): Raw => {
  if (info.channels !== 3) throw new Error(`Expected 3 channels, got ${info.channels}.`);
  return { data, width: info.width, height: info.height };
};

const backdropSvg = (scene: CameraConfig["scene"], window: Rect, frame: FrameConfig) => {
  const { width, height } = scene;
  const { sigma, offsetY, opacity } = frame.shadow;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1640"/>
      <stop offset="0.55" stop-color="#0d1330"/>
      <stop offset="1" stop-color="#0b2a38"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.12" cy="0.1" r="0.6">
      <stop offset="0" stop-color="#7b4fd6" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#7b4fd6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.9" cy="0.95" r="0.55">
      <stop offset="0" stop-color="#1fa4a0" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#1fa4a0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowC" cx="0.85" cy="0.05" r="0.4">
      <stop offset="0" stop-color="#d4577a" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#d4577a" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${sigma}"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#base)"/>
  <rect width="${width}" height="${height}" fill="url(#glowA)"/>
  <rect width="${width}" height="${height}" fill="url(#glowB)"/>
  <rect width="${width}" height="${height}" fill="url(#glowC)"/>
  <rect x="${window.x}" y="${window.y + offsetY}" width="${window.width}" height="${window.height}"
    rx="${frame.cornerRadius}" fill="#000000" fill-opacity="${opacity}" filter="url(#blur)"/>
</svg>`;
};

/** The static layer under the window: gradient background and its shadow. */
export const buildBackdrop = async (
  scene: CameraConfig["scene"],
  window: Rect,
  frame: FrameConfig,
): Promise<Raw> => {
  const { data, info } = await sharp(Buffer.from(backdropSvg(scene, window, frame)))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return rawRgb(data, info);
};

/** One recorded frame placed in its rounded window over the backdrop. */
export const composeScene = async (
  backdrop: Raw,
  frameJpeg: Buffer,
  window: Rect,
  frame: FrameConfig,
): Promise<Raw> => {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${window.width}" height="${window.height}"><rect width="${window.width}" height="${window.height}" rx="${frame.cornerRadius}" fill="#fff"/></svg>`,
  );
  const content = await sharp(frameJpeg)
    .resize(window.width, window.height, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const { data, info } = await sharp(backdrop.data, {
    raw: { width: backdrop.width, height: backdrop.height, channels: 3 },
  })
    .composite([{ input: content, left: window.x, top: window.y }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return rawRgb(data, info);
};

/** The camera's view of a scene at the output size. */
export const cropScene = async (
  scene: Raw,
  crop: Crop,
  output: FrameConfig["output"],
): Promise<Buffer> => {
  const width = Math.max(1, Math.min(scene.width, Math.round(crop.width)));
  const height = Math.max(1, Math.min(scene.height, Math.round(crop.height)));
  const left = Math.max(0, Math.min(scene.width - width, Math.round(crop.x)));
  const top = Math.max(0, Math.min(scene.height - height, Math.round(crop.y)));
  return sharp(scene.data, { raw: { width: scene.width, height: scene.height, channels: 3 } })
    .extract({ left, top, width, height })
    .resize(output.width, output.height, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();
};

/** Mean of equally sized RGB buffers. */
export const averageFrames = (frames: ReadonlyArray<Buffer>): Buffer => {
  const first = frames[0];
  if (first === undefined) throw new Error("averageFrames needs at least one frame");
  if (frames.length === 1) return first;
  const sum = new Uint32Array(first.length);
  for (const frame of frames) {
    for (let i = 0; i < sum.length; i += 1) sum[i] = sum[i]! + frame[i]!;
  }
  const out = Buffer.alloc(first.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(sum[i]! / frames.length);
  return out;
};

const cursorSvg = (height: number) => {
  const width = Math.round((height * 14) / 21);
  const pad = 3;
  return {
    pad,
    svg: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 2 * pad}" height="${height + 2 * pad}" viewBox="-0.5 -0.5 ${14 + 1} ${21 + 1}">
  <g transform="translate(0.5 0.5)"><path d="M0 0 L0 17 L4.4 13.2 L7.2 19.6 L9.9 18.4 L7.1 12.3 L12.6 12.3 Z"
    fill="#111111" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></g>
</svg>`,
    ),
  };
};

/** The cursor and any ripples drawn over an averaged frame. */
export const overlayCursor = async (
  rgb: Buffer,
  output: FrameConfig["output"],
  frame: FrameConfig,
  input: {
    readonly cursor: Point | null;
    readonly zoom: number;
    readonly press: number;
    readonly ripples: ReadonlyArray<Ripple & { readonly at: Point }>;
  },
): Promise<Buffer> => {
  const layers: OverlayOptions[] = [];
  for (const ripple of input.ripples) {
    const eased = 1 - (1 - Math.min(1, ripple.progress * (RIPPLE_MS / 180))) ** 3;
    const radius = Math.max(
      2,
      Math.round(frame.rippleRadius * output.height * (0.55 + 0.45 * eased)),
    );
    const alpha = 0.62 * (1 - ripple.progress) ** 1.5;
    const size = radius * 2;
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${radius}" cy="${radius}" r="${radius}" fill="#d9d9de" fill-opacity="${alpha.toFixed(3)}"/></svg>`,
      ),
      left: Math.round(ripple.at.x - radius),
      top: Math.round(ripple.at.y - radius),
    });
  }
  if (input.cursor !== null) {
    const scale = input.zoom ** frame.cursorZoomExponent * (0.86 + 0.14 * input.press);
    const height = Math.max(8, Math.round(frame.cursorHeight * output.height * scale));
    const { svg, pad } = cursorSvg(height);
    layers.push({
      input: svg,
      left: Math.round(input.cursor.x) - pad,
      top: Math.round(input.cursor.y) - pad,
    });
  }
  if (layers.length === 0) return rgb;
  // Overlays partly outside the frame would make libvips fail; clip by dropping what is fully out.
  const visible = layers.filter(
    (layer) =>
      (layer.left ?? 0) < output.width &&
      (layer.top ?? 0) < output.height &&
      (layer.left ?? 0) > -output.width &&
      (layer.top ?? 0) > -output.height,
  );
  return sharp(rgb, { raw: { width: output.width, height: output.height, channels: 3 } })
    .composite(visible)
    .removeAlpha()
    .raw()
    .toBuffer();
};
