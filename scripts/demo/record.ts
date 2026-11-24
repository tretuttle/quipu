// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - drives Chromium through Playwright and paces the flow with real timers.
/**
 * Drives a flow in a clean Chromium context while CDP's screencast saves JPEG
 * frames to disk. Pointer glides and key presses are paced here and logged to
 * `recording.json`, so the renderer can plan its camera and draw its own cursor
 * without touching the browser again.
 *
 * The log runs on a virtual clock that only `hold` advances. Waiting for the
 * app (a card to appear, a dialog to open) takes real time but no virtual time,
 * so a slow machine records the same event times as a fast one, and the camera,
 * which is planned from those times alone, is the same on every run.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { chromium, type Locator, type Page } from "playwright-core";

import { encodeEventLog, type Box, type DemoEvent, type EventLog } from "./eventLog.ts";

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where the camera looks after a key: an element, or a step that waits for the app and names one. */
export type LookAt = Locator | (() => Promise<Locator>);

/** What a flow script may do. Every pointer and key action is logged for the camera. */
export interface FlowContext {
  readonly page: Page;
  /** Glides the pointer to a page point over `ms`. */
  readonly moveTo: (to: Point, ms?: number) => Promise<void>;
  /** Glides to the middle of `target` and clicks it; a point is clicked where it is. */
  readonly click: (target: Locator | Point, ms?: number) => Promise<void>;
  /** Glides to the middle of `target` and double-clicks it. */
  readonly doubleClick: (target: Locator, ms?: number) => Promise<void>;
  /** Presses at `from`, drags to `to` over `ms`, and releases. The camera frames both ends. */
  readonly drag: (from: Point, to: Point, ms?: number) => Promise<void>;
  /** Types into whatever has focus, one logged key press per character. */
  readonly type: (text: string, perKeyMs?: number) => Promise<void>;
  /**
   * Presses a key or chord such as `Control+f`. The camera looks at the focused
   * element, or at `lookAt` once it is visible, for a key whose effect lands elsewhere.
   */
  readonly press: (key: string, lookAt?: LookAt) => Promise<void>;
  /** Pastes `text` into the page, logged as Control+V, with the camera on `lookAt`. */
  readonly paste: (text: string, lookAt?: LookAt) => Promise<void>;
  /** Lets `ms` pass on screen. */
  readonly wait: (ms: number) => Promise<void>;
}

export interface RecordOptions {
  readonly flowId: string;
  readonly url: string;
  readonly outDir: string;
  readonly viewport: Viewport;
  /** Resolves once the page is worth filming; the clip starts after it, so no loading screen is recorded. */
  readonly ready: (page: Page) => Promise<void>;
  readonly run: (context: FlowContext) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

const SCREENCAST_QUALITY = 92;
const GLIDE_STEP_MS = 16;
/** A locator that stops matching fails the flow after this long instead of Playwright's 30 s. */
const LOCATOR_TIMEOUT_MS = 10_000;
/** Margin around a drag's two ends, in CSS pixels, so the camera shows what is drawn. */
const DRAG_MARGIN = 60;

// The two page scripts below are source text because this package compiles without the DOM lib.
const PASTE_SCRIPT = `(text) => {
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  document.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
}`;

const FOCUSED_BOX = `(() => {
  const element = document.activeElement;
  if (element === null || element === document.body) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()`;

/**
 * Resolves with the element's box once it has held still for a few frames.
 * Runs in the page; the types are spelled out because this package compiles
 * without the DOM lib.
 */
const settledBox = (element: { getBoundingClientRect: () => Box }) =>
  new Promise<Box>((resolve) => {
    const page = globalThis as unknown as { requestAnimationFrame: (run: () => void) => void };
    let last: Box | null = null;
    let still = 0;
    let frames = 0;
    const tick = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const box = { x, y, width, height };
      const moved =
        last === null ||
        Math.abs(box.x - last.x) + Math.abs(box.y - last.y) > 0.5 ||
        Math.abs(box.width - last.width) + Math.abs(box.height - last.height) > 0.5;
      still = moved ? 0 : still + 1;
      last = box;
      frames += 1;
      if (still >= 4 || frames >= 180) resolve(box);
      else page.requestAnimationFrame(tick);
    };
    tick();
  });

const isLocator = (target: Locator | Point): target is Locator => "boundingBox" in target;

/** Records the flow and returns the path of its `recording.json`. */
export const record = async (options: RecordOptions): Promise<string> => {
  const { viewport } = options;
  NodeFS.rmSync(options.outDir, { recursive: true, force: true });
  const framesDir = NodePath.join(options.outDir, "frames");
  NodeFS.mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(LOCATOR_TIMEOUT_MS);
    await page.goto(options.url);
    await page.evaluate("document.fonts.ready");
    await options.ready(page);

    const events: DemoEvent[] = [];
    const frames: Array<{ t: number; file: string }> = [];
    let virtualMs = 0;
    let holding: { readonly startedAt: number; readonly from: number; readonly ms: number } | null =
      null;
    const now = () => Math.round(virtualMs);
    const hold = async (ms: number) => {
      holding = { startedAt: Date.now(), from: virtualMs, ms };
      await sleep(ms);
      virtualMs += ms;
      holding = null;
    };
    // A frame painted during a hold is placed where it fell inside that hold, so
    // motion on the page plays at its own speed; one painted while the flow
    // waits on the app lands at the current virtual time.
    const frameTime = () =>
      holding === null
        ? now()
        : Math.round(holding.from + Math.min(holding.ms, Date.now() - holding.startedAt));

    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (frame) => {
      const file = `frames/${String(frames.length).padStart(6, "0")}.jpg`;
      NodeFS.writeFileSync(NodePath.join(options.outDir, file), Buffer.from(frame.data, "base64"));
      frames.push({ t: frameTime(), file });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: SCREENCAST_QUALITY,
      maxWidth: viewport.width * viewport.deviceScaleFactor,
      maxHeight: viewport.height * viewport.deviceScaleFactor,
      everyNthFrame: 1,
    });
    // A static page sends no frame until something repaints; nudge one so the clip has a first frame.
    await page.evaluate("document.body.getBoundingClientRect()");
    await hold(300);

    let pointer: Point = { x: viewport.width / 2, y: viewport.height / 2 };

    const glide = async (to: Point, ms: number) => {
      const from = pointer;
      const steps = Math.max(8, Math.round(ms / GLIDE_STEP_MS));
      for (let step = 1; step <= steps; step += 1) {
        const eased = easeInOut(step / steps);
        const x = from.x + (to.x - from.x) * eased;
        const y = from.y + (to.y - from.y) * eased;
        await page.mouse.move(x, y);
        events.push({ kind: "move", t: now(), x, y });
        await hold(ms / steps);
      }
      pointer = to;
    };

    // Cards and dialogs animate into place; a box is read once it has held still.
    const boxOf = async (target: Locator): Promise<Box> => {
      await target.waitFor({ state: "visible" });
      return target.evaluate(settledBox);
    };
    const centerOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

    const pressAt = async (at: Point, target: Box | null, clicks: number) => {
      for (let click = 1; click <= clicks; click += 1) {
        events.push({ kind: "down", t: now(), x: at.x, y: at.y, target });
        await page.mouse.down({ clickCount: click });
        await hold(70);
        events.push({ kind: "up", t: now(), x: at.x, y: at.y });
        await page.mouse.up({ clickCount: click });
        if (click < clicks) await hold(60);
      }
    };

    const keyEvent = async (key: string, lookAt: LookAt | undefined, act: () => Promise<void>) => {
      const event = {
        kind: "key" as const,
        t: now(),
        key,
        target: lookAt === undefined ? await page.evaluate<Box | null>(FOCUSED_BOX) : null,
      };
      events.push(event);
      await act();
      if (lookAt !== undefined) {
        // The log is written at the end, so the box of what the key brought up can still fill it in.
        const element = typeof lookAt === "function" ? await lookAt() : lookAt;
        events[events.indexOf(event)] = { ...event, target: await boxOf(element) };
      }
    };

    const flow: FlowContext = {
      page,
      moveTo: (to, ms = 700) => glide(to, ms),
      click: async (target, ms = 700) => {
        const box = isLocator(target) ? await boxOf(target) : null;
        const at = box === null ? (target as Point) : centerOf(box);
        await glide(at, ms);
        await pressAt(at, box, 1);
      },
      doubleClick: async (target, ms = 700) => {
        const box = await boxOf(target);
        await glide(centerOf(box), ms);
        await pressAt(centerOf(box), box, 2);
      },
      drag: async (from, to, ms = 700) => {
        await glide(from, 500);
        const target = {
          x: Math.min(from.x, to.x) - DRAG_MARGIN,
          y: Math.min(from.y, to.y) - DRAG_MARGIN,
          width: Math.abs(to.x - from.x) + 2 * DRAG_MARGIN,
          height: Math.abs(to.y - from.y) + 2 * DRAG_MARGIN,
        };
        events.push({ kind: "down", t: now(), x: from.x, y: from.y, target });
        await page.mouse.down();
        await hold(80);
        await glide(to, ms);
        events.push({ kind: "up", t: now(), x: to.x, y: to.y });
        await page.mouse.up();
      },
      type: async (text, perKeyMs = 55) => {
        for (const character of text) {
          await keyEvent(character, undefined, () => page.keyboard.type(character));
          await hold(perKeyMs);
        }
      },
      press: (key, lookAt) => keyEvent(key, lookAt, () => page.keyboard.press(key)),
      paste: (text, lookAt) =>
        keyEvent("Control+v", lookAt, () =>
          page.evaluate(`(${PASTE_SCRIPT})(${JSON.stringify(text)})`),
        ),
      wait: hold,
    };

    await options.run(flow);
    await hold(400);
    const durationMs = now();
    await cdp.send("Page.stopScreencast");

    const log: EventLog = {
      version: 1,
      flow: options.flowId,
      viewport: {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
      },
      durationMs,
      frames,
      events,
    };
    const file = NodePath.join(options.outDir, "recording.json");
    NodeFS.writeFileSync(file, `${encodeEventLog(log)}\n`);
    return file;
  } finally {
    await browser.close();
  }
};
