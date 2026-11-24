// @effect-diagnostics nodeBuiltinImport:off - an offline CLI renderer; its inputs and outputs are files on disk.
/**
 * Turns a recording (frames plus event log) into numbered PNG frames and the
 * camera path that produced them. The output is a pure function of the
 * recording and the config: same log, same crops, same pixels.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp from "sharp";

import { frameCrops, planCamera, type CameraConfig } from "./camera.ts";
import { cursorSceneAt, pressAt, ripplesAt } from "./cursor.ts";
import { decodeEventLog } from "./eventLog.ts";
import type { EventLog } from "./eventLog.ts";
import {
  averageFrames,
  buildBackdrop,
  composeScene,
  cropScene,
  overlayCursor,
  type FrameConfig,
  type Raw,
} from "./frame.ts";

export interface RenderOptions {
  readonly recordingDir: string;
  readonly outDir: string;
  readonly camera: CameraConfig;
  readonly frame: FrameConfig;
  readonly fps: number;
}

export interface RenderResult {
  readonly framesDir: string;
  readonly cameraFile: string;
  readonly frameCount: number;
}

/** The index of the last recorded frame at or before `tMs` (the first one before any exists). */
const sourceFrameIndex = (frames: EventLog["frames"], tMs: number): number => {
  let low = 0;
  let high = frames.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (frames[mid]!.t <= tMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};

export const renderRecording = async (options: RenderOptions): Promise<RenderResult> => {
  const { recordingDir, outDir, camera, frame, fps } = options;
  const log = decodeEventLog(
    NodeFS.readFileSync(NodePath.join(recordingDir, "recording.json"), "utf8"),
  );
  if (log.frames.length === 0) throw new Error(`${recordingDir} has no recorded frames.`);

  const path = planCamera(log, camera);
  const crops = frameCrops(path, fps);
  const framesDir = NodePath.join(outDir, "frames");
  NodeFS.rmSync(framesDir, { recursive: true, force: true });
  NodeFS.mkdirSync(framesDir, { recursive: true });
  const cameraFile = NodePath.join(outDir, "camera.json");
  NodeFS.writeFileSync(
    cameraFile,
    `${JSON.stringify({ fps, scene: camera.scene, output: frame.output, frames: crops }, null, 2)}\n`,
  );

  const backdrop = await buildBackdrop(camera.scene, camera.window, frame);
  const scenes = new Map<number, Raw>();
  const sceneFor = async (index: number): Promise<Raw> => {
    const cached = scenes.get(index);
    if (cached !== undefined) return cached;
    if (scenes.size >= 3) scenes.delete(scenes.keys().next().value as number);
    const file = NodePath.join(recordingDir, log.frames[index]!.file);
    const scene = await composeScene(backdrop, NodeFS.readFileSync(file), camera.window, frame);
    scenes.set(index, scene);
    return scene;
  };

  const toOutput = (point: { readonly x: number; readonly y: number }, tMs: number) => {
    const crop = path.at(tMs);
    return {
      x: ((point.x - crop.x) / crop.width) * frame.output.width,
      y: ((point.y - crop.y) / crop.height) * frame.output.height,
    };
  };
  const pageToScene = (point: { readonly x: number; readonly y: number }) => ({
    x: camera.window.x + (point.x * camera.window.width) / log.viewport.width,
    y: camera.window.y + (point.y * camera.window.height) / log.viewport.height,
  });

  const shutterMs = (frame.shutterFrames * 1000) / fps;
  for (const entry of crops) {
    const t = entry.tMs;
    const before = path.at(t - shutterMs / 2);
    const after = path.at(t + shutterMs / 2);
    const travel =
      Math.hypot(
        after.x + after.width / 2 - (before.x + before.width / 2),
        after.y + after.height / 2 - (before.y + before.height / 2),
      ) + Math.abs(after.width - before.width);
    const moving = travel > frame.blurThreshold * entry.crop.width;
    const travelPixels = (travel / entry.crop.width) * frame.output.width;
    const samples = moving
      ? Math.min(
          frame.blurSamplesMax,
          Math.max(3, Math.ceil(travelPixels / frame.blurPixelsPerSample)),
        )
      : 1;

    const layers: Buffer[] = [];
    for (let s = 0; s < samples; s += 1) {
      const offset = samples === 1 ? 0 : shutterMs * (s / (samples - 1) - 0.5);
      const sampleT = Math.max(0, t + offset);
      const scene = await sceneFor(sourceFrameIndex(log.frames, sampleT));
      layers.push(await cropScene(scene, path.at(sampleT), frame.output));
    }
    const averaged = averageFrames(layers);

    const cursorScene = cursorSceneAt(log, t, camera.window);
    const rgb = await overlayCursor(averaged, frame.output, frame, {
      cursor: cursorScene === null ? null : toOutput(cursorScene, t),
      zoom: entry.crop.zoom,
      press: pressAt(log, t),
      ripples: ripplesAt(log, t).map((ripple) => ({
        ...ripple,
        at: toOutput(pageToScene(ripple), t),
      })),
    });
    await sharp(rgb, {
      raw: { width: frame.output.width, height: frame.output.height, channels: 3 },
    })
      .png({ compressionLevel: 1 })
      .toFile(NodePath.join(framesDir, `${String(entry.index).padStart(5, "0")}.png`));
  }

  return { framesDir, cameraFile, frameCount: crops.length };
};
