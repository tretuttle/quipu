// @effect-diagnostics nodeBuiltinImport:off - builds the web app and records each flow in Chromium.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { chromium } from "playwright-core";

import { serveBuiltApp, type ServedApp } from "./app.ts";
import { VIEWPORT } from "./config.ts";
import { decodeEventLog, type EventLog } from "./eventLog.ts";
import { appReady, FLOWS, findFlow } from "./flows.ts";
import { record } from "./record.ts";

const chromiumProblem = (): string | null => {
  const path = chromium.executablePath();
  return NodeFS.existsSync(path)
    ? null
    : `Chromium for playwright-core is not installed (no ${path}); install it with node apps/desktop/node_modules/playwright-core/cli.js install chromium`;
};
const missingChromium = chromiumProblem();

const RECORD_TIMEOUT_MS = 120_000;

let scratch = "";
let app: ServedApp | null = null;
beforeAll(async () => {
  if (missingChromium !== null) return;
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-demo-flows-"));
  app = await serveBuiltApp({ outDir: NodePath.join(scratch, "app") });
}, RECORD_TIMEOUT_MS);
afterAll(async () => {
  await app?.close();
  if (scratch !== "") NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const recordFlow = async (id: string, run = 0): Promise<EventLog> => {
  const flow = findFlow(id);
  if (flow === undefined || app === null) throw new Error(`cannot record ${id}`);
  const file = await record({
    flowId: flow.id,
    url: app.url,
    outDir: NodePath.join(scratch, `${id}-${run}`),
    viewport: VIEWPORT,
    ready: appReady,
    run: flow.run,
  });
  return decodeEventLog(NodeFS.readFileSync(file, "utf8"));
};

/** What the log says the flow did: clicks, the text it typed, and its other keys. */
const summarize = (log: EventLog) => {
  let typed = "";
  const keys: string[] = [];
  for (const event of log.events) {
    if (event.kind !== "key") continue;
    if (event.key.length === 1) typed += event.key;
    else keys.push(event.key);
  }
  return {
    presses: log.events.filter((event) => event.kind === "down").length,
    typed,
    keys,
    seconds: log.durationMs / 1000,
  };
};

/** Every key press and every press on an element has a box for the camera, inside the page. */
const targetsInsideThePage = (log: EventLog) =>
  log.events.every((event) => {
    if (event.kind === "move" || event.kind === "up") return true;
    const box = event.target;
    if (box === null) return event.kind === "down";
    return (
      box.x + box.width > 0 &&
      box.y + box.height > 0 &&
      box.x < log.viewport.width &&
      box.y < log.viewport.height
    );
  });

const EXPECTED = {
  // Five chevrons (sensors, sensor 2, uplink, last_packet, readings), the pan
  // that brings the decoded card in, and the value Find starts after.
  map: { presses: 7, typed: "snow", keys: ["Control+v", "Control+f", "Enter", "F3"] },
  // Tree, location, a double-click on a value and on a key, location, Transform,
  // Sort keys, Undo, Export, Format, YAML.
  edit: {
    presses: 13,
    typed: "maintenancename",
    keys: ["Control+v", "Control+a", "Enter", "Control+a", "Enter"],
  },
  // New board, then a tool and a stroke or click for each of the five elements.
  board: { presses: 11, typed: "Check the wind sensorWinter plan", keys: ["Escape", "Escape"] },
} as const;

describe("the demo flows, recorded against the built app", () => {
  it("covers every registered flow", () => {
    expect(FLOWS.map((flow) => flow.id).toSorted()).toStrictEqual(Object.keys(EXPECTED).toSorted());
  });

  it.for(Object.entries(EXPECTED).map(([id, expected]) => ({ id, expected })))(
    "$id: every step finds its element, and the log holds its interactions",
    { timeout: RECORD_TIMEOUT_MS },
    async ({ id, expected }, context) => {
      if (missingChromium !== null) context.skip(missingChromium);
      const log = await recordFlow(id);
      const { seconds, ...interactions } = summarize(log);
      expect(interactions).toStrictEqual(expected);
      expect(seconds).toBeGreaterThanOrEqual(10);
      expect(seconds).toBeLessThanOrEqual(20);
      expect(targetsInsideThePage(log)).toBe(true);
      expect(log.frames.length).toBeGreaterThan(20);
    },
  );

  it(
    "logs the same event times on a second recording, so the camera is planned the same",
    async (context) => {
      if (missingChromium !== null) context.skip(missingChromium);
      const [first, second] = [await recordFlow("board", 1), await recordFlow("board", 2)];
      const times = (log: EventLog) => log.events.map((event) => `${event.kind}@${event.t}`);
      expect(times(second)).toStrictEqual(times(first));
      expect(second.durationMs).toBe(first.durationMs);
    },
    2 * RECORD_TIMEOUT_MS,
  );
});
