import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "astro";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const siteRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
// Built by the package's test script with no release configured.
const distDir = NodeURL.fileURLToPath(new URL("../dist/", import.meta.url));
const webPublicDir = NodeURL.fileURLToPath(new URL("../../web/public/", import.meta.url));
const RELEASE_ENV = { QUIPU_RELEASE_VERSION: "1.2.3", QUIPU_WEB_APP_PATH: "/app/" };

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// The deploy ships this file as the docroot's .htaccess. Serving the same lines
// from the test server means the browser sees exactly the headers production sends.
function readDeployHeaders(dir: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = NodeFS.readFileSync(NodePath.join(dir, ".htaccess"), "utf8").split("\n");
  for (const line of lines) {
    const match = /^\s*Header always set (\S+) "(.*)"\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) headers[match[1]] = match[2];
  }
  return headers;
}

function listFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir).flatMap((name) => {
    const path = NodePath.join(dir, name);
    return NodeFS.statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Serves `dir` the way the deployed docroot does; resolves to the origin it listens on. */
async function serve(dir: string): Promise<{ origin: string; server: NodeHttp.Server }> {
  const headers = readDeployHeaders(dir);
  const server = NodeHttp.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const file = NodePath.normalize(NodePath.join(dir, relative));
    if (!file.startsWith(dir)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = NodeFS.readFileSync(file);
      response.writeHead(200, {
        ...headers,
        "Content-Type": mimeTypes[NodePath.extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404, headers).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function buildWithEnv(outDir: string, env: Record<string, string>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await build({ root: siteRoot, outDir, logLevel: "error" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const servers: NodeHttp.Server[] = [];
let browser: Browser;
let origin = "";
let releaseDir = "";
let releaseOrigin = "";

beforeAll(async () => {
  // Inside the package: Astro moves built assets with rename(), which fails across file systems.
  releaseDir = NodePath.join(siteRoot, "dist-release") + NodePath.sep;
  NodeFS.rmSync(releaseDir, { recursive: true, force: true });
  await buildWithEnv(releaseDir, RELEASE_ENV);
  const plain = await serve(distDir);
  const withRelease = await serve(releaseDir);
  servers.push(plain.server, withRelease.server);
  origin = plain.origin;
  releaseOrigin = withRelease.origin;
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  if (releaseDir !== "") NodeFS.rmSync(releaseDir, { recursive: true, force: true });
});

async function linksOn(url: string) {
  const page = await browser.newPage();
  await page.goto(url);
  const downloads = await page.$$eval("a[data-download]", (links) =>
    links.map((link) => [link.getAttribute("data-download"), link.getAttribute("href")]),
  );
  const hrefs = await page.$$eval("a[href]", (links) =>
    links.map((link) => link.getAttribute("href") ?? ""),
  );
  const text = await page.locator("main").innerText();
  await page.close();
  return { downloads, hrefs, text };
}

describe("the built site, served with the deploy headers", () => {
  it("renders the headline and the sections a visitor reads", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/`);
    await expect(page.getByRole("heading", { level: 1 }).innerText()).resolves.toMatch(
      /Open any data file\.\s*See it as a map\./,
    );
    for (const name of ["Map", "Decode", "Search", "Edit", "Draw", "Themes"]) {
      await expect(
        page.getByRole("heading", { level: 3, name, exact: true }).count(),
      ).resolves.toBe(1);
    }
    for (const name of ["Local-first", "No accounts", "No telemetry"]) {
      await expect(
        page.getByRole("heading", { level: 3, name, exact: true }).count(),
      ).resolves.toBe(1);
    }
    await page.close();
  });

  it("offers no installer and no web app before a release is configured", async () => {
    for (const path of ["/", "/download/"]) {
      const { downloads, hrefs } = await linksOn(`${origin}${path}`);
      expect(downloads).toEqual([]);
      expect(hrefs.filter((href) => href.startsWith("/downloads/") || href === "/app/")).toEqual(
        [],
      );
    }
    await expect(linksOn(`${origin}/`).then((links) => links.text)).resolves.toContain(
      "Desktop downloads for Linux and Windows will appear here with the first release.",
    );
    await expect(linksOn(`${origin}/download/`).then((links) => links.text)).resolves.toContain(
      "Downloads will appear here with the first release.",
    );
  });

  it("links the configured release's installers and the web app at same-origin paths", async () => {
    for (const path of ["/", "/download/"]) {
      const { downloads, hrefs, text } = await linksOn(`${releaseOrigin}${path}`);
      expect(downloads).toEqual([
        ["linux", "/downloads/Quipu-1.2.3-x86_64.AppImage"],
        ["windows", "/downloads/Quipu-1.2.3-x64.exe"],
      ]);
      expect(hrefs).toContain("/app/");
      expect(hrefs.filter((href) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href))).toEqual([]);
      expect(text).not.toContain("first release");
    }
    await expect(
      linksOn(`${releaseOrigin}/download/`).then((links) => links.text),
    ).resolves.toContain("chmod +x Quipu-1.2.3-x86_64.AppImage");
  });

  it("is cross-origin isolated, with no console errors from the CSP", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(`${origin}/`);
    expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(response?.headers()["content-security-policy"]).toContain(
      "connect-src 'self' https://open-vsx.org https://openvsx.eclipsecontent.org",
    );
    await expect(page.evaluate(() => crossOriginIsolated)).resolves.toBe(true);
    await page.getByRole("link", { name: "Download", exact: true }).first().click();
    await page.waitForURL(`${origin}/download/`);
    await expect(page.evaluate(() => crossOriginIsolated)).resolves.toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("makes zero requests that leave its own origin", async () => {
    const page = await browser.newPage();
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));
    await page.goto(`${origin}/`);
    await page.evaluate(() => document.fonts.ready);
    await page.goto(`${origin}/download/`);
    await page.evaluate(() => document.fonts.ready);
    const network = urls.filter((url) => /^https?:/.test(url));
    expect(network.length).toBeGreaterThan(2);
    expect(network.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    await page.close();
  });
});

describe("the files written to dist", () => {
  it("carry no origin and no inline script, so any docroot can serve them", () => {
    for (const dir of [distDir, releaseDir]) {
      const text = listFiles(dir).filter((file) => /\.(html|css|js)$/.test(file));
      expect(text.length).toBeGreaterThan(4);
      for (const file of text) {
        const content = NodeFS.readFileSync(file, "utf8");
        expect(content.match(/https?:\/\/[^\s"')]+/g) ?? [], file).toEqual([]);
      }
      for (const file of text.filter((name) => name.endsWith(".html"))) {
        expect(
          NodeFS.readFileSync(file, "utf8").match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? [],
          file,
        ).toEqual([]);
      }
    }
  });

  it("ship the same icon bytes as the web app", () => {
    for (const name of [
      "favicon.ico",
      "favicon.svg",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "apple-touch-icon.png",
    ]) {
      expect(
        NodeFS.readFileSync(NodePath.join(distDir, name)).equals(
          NodeFS.readFileSync(NodePath.join(webPublicDir, name)),
        ),
        name,
      ).toBe(true);
    }
  });
});
