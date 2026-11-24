// @effect-diagnostics nodeBuiltinImport:off - a CLI entry point that builds, records and encodes on disk.
/**
 * `vp run demo <flow>`: builds the web app, records a flow in Chromium,
 * renders the camera over it and encodes an animated WebP and an MP4.
 * Everything goes to `--out` (default `demo-out/<flow>`, which git ignores).
 *
 *   vp run demo map
 *   vp run demo edit --url http://localhost:5300/   (record a running dev server)
 *   vp run demo board --render-only                (render the last recording again)
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { serveBuiltApp } from "./app.ts";
import { CAMERA, FPS, FRAME, VIEWPORT } from "./config.ts";
import { encodeClip, ffmpegProblem } from "./encode.ts";
import { appReady, FLOWS, findFlow } from "./flows.ts";
import { record } from "./record.ts";
import { renderRecording } from "./render.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");

const USAGE = `usage: vp run demo <flow> [--out DIR] [--url URL] [--render-only] [--webp-quality 0-100]
flows: ${FLOWS.map((flow) => `${flow.id} (${flow.title})`).join(", ")}
`;

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    out: { type: "string" },
    "render-only": { type: "boolean", default: false },
    "webp-quality": { type: "string", default: "70" },
  },
});

const main = async () => {
  const [flowId] = positionals;
  const flow = flowId === undefined ? undefined : findFlow(flowId);
  if (flow === undefined) {
    process.stderr.write(flowId === undefined ? USAGE : `Unknown flow "${flowId}".\n${USAGE}`);
    return 2;
  }
  const missingFfmpeg = ffmpegProblem();
  if (missingFfmpeg !== null) {
    process.stderr.write(`${missingFfmpeg}\n`);
    return 1;
  }
  const outDir = NodePath.resolve(values.out ?? NodePath.join(repoRoot, "demo-out", flow.id));
  const recordingDir = NodePath.join(outDir, "recording");

  if (!values["render-only"]) {
    const buildDir =
      values.url === undefined
        ? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-demo-app-"))
        : null;
    const app = buildDir === null ? null : await serveBuiltApp({ outDir: buildDir });
    try {
      await record({
        flowId: flow.id,
        url: app?.url ?? values.url!,
        outDir: recordingDir,
        viewport: VIEWPORT,
        ready: appReady,
        run: flow.run,
      });
    } finally {
      await app?.close();
      if (buildDir !== null) NodeFS.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  const rendered = await renderRecording({
    recordingDir,
    outDir: NodePath.join(outDir, "render"),
    camera: CAMERA,
    frame: FRAME,
    fps: FPS,
  });
  const encoded = encodeClip({
    framesDir: rendered.framesDir,
    outDir,
    name: flow.id,
    fps: FPS,
    webpQuality: Number(values["webp-quality"]),
    crf: 20,
  });
  for (const file of [encoded.webp, encoded.mp4]) {
    process.stdout.write(`${file}  ${NodeFS.statSync(file).size} bytes\n`);
  }
  return 0;
};

process.exitCode = await main();
