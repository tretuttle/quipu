// @effect-diagnostics nodeBuiltinImport:off - the render tests read and write real files in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";
import sharp from "sharp";

import { frameCrops, planCamera } from "./camera.ts";
import { encodeClip, ffmpegProblem } from "./encode.ts";
import { encodeEventLog, decodeEventLog } from "./eventLog.ts";
import {
  TEST_CAMERA,
  TEST_FPS,
  TEST_FRAME,
  TEST_LOG,
  writeFixtureRecording,
} from "./fixtureRecording.ts";
import { renderRecording } from "./render.ts";

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-demo-render-"));
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});
const tempDir = () => NodeFS.mkdtempSync(NodePath.join(scratch, "case-"));

const missingFfmpeg = ffmpegProblem();

const pixel = async (file: string, x: number, y: number) => {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return { r: data[at]!, g: data[at + 1]!, b: data[at + 2]! };
};

describe("the camera for a click", () => {
  const path = planCamera(TEST_LOG, TEST_CAMERA);
  const crops = frameCrops(path, TEST_FPS);
  const at = (tMs: number) => crops.find((frame) => frame.tMs === tMs)!.crop;

  it("shows the whole scene before anything happens", () => {
    expect(at(0)).toMatchObject({ x: 0, y: 0, width: 1000, height: 500, zoom: 1 });
  });

  it("settles on the click target at the click zoom, inside the window", () => {
    const settled = at(1900);
    expect(settled.zoom).toBeCloseTo(2, 2);
    expect(settled.width).toBeCloseTo(500, 0);
    expect(settled.height).toBeCloseTo(250, 0);
    // The target is the scene center (500, 250), so the crop is centered on it.
    expect(settled.x).toBeCloseTo(250, 0);
    expect(settled.y).toBeCloseTo(125, 0);
  });

  it("zooms out again after the hold and finishes at the whole scene", () => {
    expect(at(3500)).toMatchObject({ x: 0, y: 0, width: 1000, height: 500, zoom: 1 });
  });

  it("starts moving before the click lands, and moves fastest early", () => {
    // leadMs is 300, so the camera has left rest by the click itself.
    expect(at(1000).zoom).toBeGreaterThan(1.05);
    const early = at(800).zoom - at(700).zoom;
    const late = at(1500).zoom - at(1400).zoom;
    expect(early).toBeGreaterThan(late);
  });

  it("never leaves the scene", () => {
    for (const frame of crops) {
      expect(frame.crop.x).toBeGreaterThanOrEqual(0);
      expect(frame.crop.y).toBeGreaterThanOrEqual(0);
      expect(frame.crop.x + frame.crop.width).toBeLessThanOrEqual(1000.01);
      expect(frame.crop.y + frame.crop.height).toBeLessThanOrEqual(500.01);
    }
  });
});

describe("the renderer", () => {
  it("writes the crops it used to camera.json and the frames it drew", async () => {
    const dir = tempDir();
    await writeFixtureRecording(NodePath.join(dir, "rec"));
    const result = await renderRecording({
      recordingDir: NodePath.join(dir, "rec"),
      outDir: NodePath.join(dir, "out"),
      camera: TEST_CAMERA,
      frame: TEST_FRAME,
      fps: TEST_FPS,
    });

    const written = JSON.parse(NodeFS.readFileSync(result.cameraFile, "utf8")) as {
      frames: Array<{ index: number; tMs: number; crop: { x: number; y: number; zoom: number } }>;
    };
    // 3.0 s of recording plus the 0.5 s tail at 10 fps, both ends inclusive.
    expect(written.frames).toHaveLength(36);
    expect(NodeFS.readdirSync(result.framesDir)).toHaveLength(36);
    const settled = written.frames.find((frame) => frame.tMs === 1900)!;
    expect(settled.crop.zoom).toBeCloseTo(2, 2);
    expect(settled.crop.x).toBeCloseTo(250, 0);
  });

  it("shows the backdrop at rest and only the page once zoomed in", async () => {
    const dir = tempDir();
    await writeFixtureRecording(NodePath.join(dir, "rec"));
    const result = await renderRecording({
      recordingDir: NodePath.join(dir, "rec"),
      outDir: NodePath.join(dir, "out"),
      camera: TEST_CAMERA,
      frame: TEST_FRAME,
      fps: TEST_FPS,
    });
    const frameAt = (tMs: number) =>
      NodePath.join(result.framesDir, `${String((tMs / 1000) * TEST_FPS).padStart(5, "0")}.png`);

    // Rest: the top-left corner is the gradient, not the red page.
    const rest = await pixel(frameAt(0), 2, 2);
    expect(rest.r).toBeLessThan(120);
    // Zoomed after the page turned green: every corner is the green page.
    const zoomed = await pixel(frameAt(1900), 4, 4);
    expect(zoomed.g).toBeGreaterThan(150);
    expect(zoomed.r).toBeLessThan(80);
  });

  it("draws the same frames for the same log", async () => {
    const dir = tempDir();
    await writeFixtureRecording(NodePath.join(dir, "rec"));
    const render = (name: string) =>
      renderRecording({
        recordingDir: NodePath.join(dir, "rec"),
        outDir: NodePath.join(dir, name),
        camera: TEST_CAMERA,
        frame: TEST_FRAME,
        fps: TEST_FPS,
      });
    const a = await render("a");
    const b = await render("b");
    expect(NodeFS.readFileSync(b.cameraFile)).toEqual(NodeFS.readFileSync(a.cameraFile));
    for (const name of NodeFS.readdirSync(a.framesDir)) {
      const left = NodeFS.readFileSync(NodePath.join(a.framesDir, name));
      const right = NodeFS.readFileSync(NodePath.join(b.framesDir, name));
      expect(right.equals(left), name).toBe(true);
    }
  });

  it("encodes a WebP and an MP4 that decode with the rendered frame count and size", async (context) => {
    if (missingFfmpeg !== null) context.skip(missingFfmpeg);
    const dir = tempDir();
    await writeFixtureRecording(NodePath.join(dir, "rec"));
    const result = await renderRecording({
      recordingDir: NodePath.join(dir, "rec"),
      outDir: NodePath.join(dir, "out"),
      camera: TEST_CAMERA,
      frame: TEST_FRAME,
      fps: TEST_FPS,
    });
    const encoded = encodeClip({
      framesDir: result.framesDir,
      outDir: dir,
      name: "clip",
      fps: TEST_FPS,
      webpQuality: 70,
      crf: 23,
    });
    // libwebp folds a run of identical (or, once quantized, indistinguishable) frames into
    // one frame with a longer delay: pages never exceed the distinct runs, and the delays
    // still add up to the clip's duration.
    const names = NodeFS.readdirSync(result.framesDir).sort();
    let runs = 0;
    let previous: Buffer | null = null;
    for (const name of names) {
      const raw = await sharp(NodePath.join(result.framesDir, name)).removeAlpha().raw().toBuffer();
      if (previous === null || !raw.equals(previous)) runs += 1;
      previous = raw;
    }
    const meta = await sharp(encoded.webp, { animated: true }).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.pages).toBeLessThanOrEqual(runs);
    expect(meta.pages).toBeGreaterThan(1);
    expect((meta.delay ?? []).reduce((total, delay) => total + delay, 0)).toBe(
      (result.frameCount * 1000) / TEST_FPS,
    );
    expect(meta.width).toBe(200);
    expect(meta.pageHeight).toBe(100);
    expect(NodeFS.statSync(encoded.mp4).size).toBeGreaterThan(0);

    const again = encodeClip({
      framesDir: result.framesDir,
      outDir: NodeFS.mkdtempSync(NodePath.join(dir, "again-")),
      name: "clip",
      fps: TEST_FPS,
      webpQuality: 70,
      crf: 23,
    });
    expect(NodeFS.readFileSync(again.mp4).equals(NodeFS.readFileSync(encoded.mp4))).toBe(true);
  });
});

describe("the event log file", () => {
  it("reads back exactly what was written", () => {
    expect(decodeEventLog(encodeEventLog(TEST_LOG))).toStrictEqual(TEST_LOG);
  });
});
