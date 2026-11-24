// @effect-diagnostics nodeBuiltinImport:off - runs the ffmpeg found on PATH.
/**
 * Encodes the rendered PNG frames with ffmpeg: an animated WebP, small enough
 * for a README, and an H.264 MP4 for web pages.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const ENCODERS = ["libwebp_anim", "libx264"] as const;

const ffmpeg = (args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("ffmpeg", ["-hide_banner", ...args], { encoding: "utf8" });

/** Why clips cannot be encoded here, or null when ffmpeg is on PATH with both encoders. */
export const ffmpegProblem = (): string | null => {
  const result = ffmpeg(["-encoders"]);
  if (result.error !== undefined || result.status !== 0) {
    return "ffmpeg is not on PATH. Install ffmpeg (built with libwebp and libx264) to encode demo clips.";
  }
  const missing = ENCODERS.filter((encoder) => !new RegExp(`\\s${encoder}\\s`).test(result.stdout));
  return missing.length === 0
    ? null
    : `The ffmpeg on PATH has no ${missing.join(" or ")} encoder; demo clips need both.`;
};

const run = (args: ReadonlyArray<string>) => {
  const result = ffmpeg(["-loglevel", "error", "-y", ...args]);
  if (result.error !== undefined) {
    throw new Error(`Could not run ffmpeg from PATH: ${result.error.message}`);
  }
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status}): ${result.stderr}`);
};

export interface EncodeOptions {
  readonly framesDir: string;
  readonly outDir: string;
  readonly name: string;
  readonly fps: number;
  /** libwebp quality, 0-100. */
  readonly webpQuality: number;
  /** x264 constant rate factor. */
  readonly crf: number;
}

export interface EncodeResult {
  readonly webp: string;
  readonly mp4: string;
}

export const encodeClip = (options: EncodeOptions): EncodeResult => {
  const input = [
    "-framerate",
    String(options.fps),
    "-i",
    NodePath.join(options.framesDir, "%05d.png"),
  ];
  const webp = NodePath.join(options.outDir, `${options.name}.webp`);
  run([
    ...input,
    "-an",
    "-c:v",
    "libwebp_anim",
    "-lossless",
    "0",
    "-quality",
    String(options.webpQuality),
    "-compression_level",
    "6",
    "-loop",
    "0",
    webp,
  ]);
  const mp4 = NodePath.join(options.outDir, `${options.name}.mp4`);
  // The bitexact flags keep encoder versions and timestamps out of the file, so
  // two encodes of the same frames with the same ffmpeg are byte-identical.
  run([
    ...input,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-bitexact",
    "-fflags",
    "+bitexact",
    "-flags",
    "+bitexact",
    "-map_metadata",
    "-1",
    mp4,
  ]);
  return { webp, mp4 };
};
