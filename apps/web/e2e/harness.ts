import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, inject } from "vite-plus/test";

import "./provided";

// oxlint-disable-next-line quipu/no-global-process-runtime -- Playwright e2e harness runs in plain Node without an Effect runtime.
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** What a test can read about its page's traffic. */
export interface PageNetwork {
  /** The URLs the page asked for on a host other than its own, in order. */
  readonly external: () => ReadonlyArray<string>;
}

/**
 * Records every request and socket of a context that goes to a host other than the app's own.
 * Quipu makes none: a document never leaves the machine. Theme search is the one exception, and
 * the tests that use it name its hosts.
 */
function watchExternalRequests(context: BrowserContext, own: URL): Array<string> {
  const seen: Array<string> = [];
  const record = (raw: string) => {
    const url = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return;
    if (url.host !== own.host) seen.push(raw);
  };
  context.on("request", (request) => record(request.url()));
  context.on("page", (page) => page.on("websocket", (socket) => record(socket.url())));
  return seen;
}

/**
 * One Chromium per test file; each test gets a fresh context, so storage starts empty.
 * A test fails when its page reaches a host other than its own, unless it lists the host.
 */
export function useBrowser() {
  let browser: Browser | null = null;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  return async function withPage<A>(
    run: (page: Page, context: BrowserContext, network: PageNetwork) => Promise<A>,
    options: {
      path?: string;
      baseUrl?: string;
      storage?: Readonly<Record<string, string>>;
      /** Hosts the test means to reach (answered from fixtures): Open VSX, for theme search. */
      externalHosts?: ReadonlyArray<string>;
    } = {},
  ): Promise<A> {
    if (browser === null) throw new Error("The browser has not launched.");
    const baseUrl = options.baseUrl ?? inject("e2eBaseUrl");
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const external = watchExternalRequests(context, new URL(baseUrl));
    try {
      // Settings a test needs from the first paint (which view a document opens in).
      if (options.storage) {
        await context.addInitScript((entries: Record<string, string>) => {
          for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        }, options.storage);
      }
      const page = await context.newPage();
      await page.goto(`${baseUrl}${options.path ?? "/"}`);
      await page.locator("[data-app-sidebar]").waitFor();
      const result = await run(page, context, { external: () => [...external] });
      const allowed = options.externalHosts ?? [];
      const unexpected = external.filter((url) => !allowed.includes(new URL(url).hostname));
      if (unexpected.length > 0) {
        throw new Error(`The page reached outside its own origin:\n${unexpected.join("\n")}`);
      }
      return result;
    } finally {
      await context.close();
    }
  };
}

/** A drop the way the OS delivers one: CDP drag events that carry the file's path. */
export async function dropFile(page: Page, path: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x: 640, y: 400, data });
  }
  await cdp.detach();
}

export async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);
}
