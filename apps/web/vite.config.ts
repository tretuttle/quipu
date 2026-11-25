import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { tailwindPlugins } from "./vite/tailwind";

const port = Number(process.env.PORT ?? 5300);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const sourcemapEnv = process.env.QUIPU_WEB_SOURCEMAP?.trim().toLowerCase();

// Vite 8.1's experimental bundled dev mode: serves rolldown-bundled chunks in
// dev for much faster startup/reload on large module graphs, with HMR served
// as hot patches. Opt-in while experimental: QUIPU_BUNDLED_DEV=1 vp run dev:web
const bundledDevEnv = process.env.QUIPU_BUNDLED_DEV?.trim().toLowerCase();
const bundledDev = bundledDevEnv === "1" || bundledDevEnv === "true";

// The bench page (bench/index.html) joins the build only for a bench run:
// QUIPU_BENCH=1 vp build, then scripts/bench/run.ts serves dist with preview.
const benchBuild = process.env.QUIPU_BENCH?.trim() === "1";

// SharedArrayBuffer needs a cross-origin isolated page, so the dev server and
// `vp preview` send the two isolation headers on every response, worker scripts
// included. The hosted site and Electron send the same. A browser that cached a
// document before these headers existed keeps the old policy on a 304, so a hard
// reload is needed once; see docs/internals/document-engine.md.
export const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const baseConnectSources = [
  "'self'",
  "blob:",
  "https://open-vsx.org",
  "https://openvsx.eclipsecontent.org",
];

function buildWebCsp(allowDevWs: boolean): string {
  const connectSources = allowDevWs ? [...baseConnectSources, "ws:", "wss:"] : baseConnectSources;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    `connect-src ${connectSources.join(" ")}`,
    "img-src 'self' blob: data: https://open-vsx.org https://openvsx.eclipsecontent.org",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "form-action 'self'",
  ].join("; ");
}

export const WEB_CSP = buildWebCsp(false);
export const WEB_DEV_CSP = buildWebCsp(true);

const webSecurityHeaders = {
  ...crossOriginIsolationHeaders,
  "Content-Security-Policy": WEB_CSP,
} as const;

const webDevSecurityHeaders = {
  ...crossOriginIsolationHeaders,
  "Content-Security-Policy": WEB_DEV_CSP,
} as const;

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
} satisfies TestProjectInlineConfiguration;

const e2eTestProject = {
  extends: true,
  test: {
    name: "e2e",
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["./e2e/globalSetup.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig(() => {
  return {
    plugins: [
      thirdPartyLicensesPlugin({
        bundleName: "web",
        configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
        packageManifests: [
          { bundle: "web", path: new URL("./package.json", import.meta.url) },
          { bundle: "desktop", path: new URL("../desktop/package.json", import.meta.url) },
        ],
      }),
      // Route components load as split chunks so settings code stays out of the
      // cold-start payload; the router prefetches them on navigation intent
      // (see getRouter's defaultPreload).
      tanstackRouter({ autoCodeSplitting: true }),
      react(),
      babel({
        // The babel plugin picks TypeScript and JSX parsing from globs relative to
        // the CWD, so workspace packages outside apps/web would fail to parse
        // without explicit parser options.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      tailwindPlugins(bundledDev),
      {
        name: "quipu-dev-csp",
        apply: "serve",
        transformIndexHtml(html: string) {
          return html.replace(WEB_CSP, WEB_DEV_CSP);
        },
      },
    ],
    optimizeDeps: {
      // The engine client and its workers load these on first use; listing them
      // keeps a late discovery from reloading the page mid-session. The scanner
      // never reaches `@quipu/contracts`, whose base schemas pull in
      // `effect/SchemaTransformation`, so it is listed as well.
      include: [
        "effect/Context",
        "effect/Effect",
        "effect/Layer",
        "effect/Schema",
        "effect/SchemaTransformation",
        // A dependency of the engine, not of this app: named through the package that imports it.
        "@quipu/core > graphql",
        // The format workers' parsers, loaded in the engine worker on the first non-JSON file.
        "@quipu/formats > yaml",
        "@quipu/formats > smol-toml",
        "@quipu/formats > saxes",
        "jq-wasm",
        "react-dom/client",
      ],
    },
    define: {
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ["react", "react-dom"],
    },
    experimental: {
      bundledDev,
    },
    server: {
      host,
      port,
      strictPort: true,
      headers: webDevSecurityHeaders,
      // Transform the whole module graph at server start instead of on the
      // first request. Without this, a cold worktree discovers and transforms
      // modules one import-level at a time while the browser waits.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      // Electron's BrowserWindow needs the HMR socket pinned to an explicit
      // host to connect reliably; dev:desktop is the only mode that sets HOST.
      ...(explicitHost
        ? {
            hmr: {
              protocol: "ws",
              host: explicitHost,
              clientPort: port,
            },
          }
        : {}),
    },
    preview: {
      headers: webSecurityHeaders,
    },
    // @tailwindcss/vite only emits a CSS sourcemap when devSourcemap is on; without it
    // rolldown flags the transform as SOURCEMAP_BROKEN on every sourcemapped build.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
      ...(benchBuild
        ? { rolldownOptions: { input: { main: "index.html", bench: "bench/index.html" } } }
        : {}),
    },
    test: {
      projects: [defineProject(unitTestProject), defineProject(e2eTestProject)],
    },
  };
});
