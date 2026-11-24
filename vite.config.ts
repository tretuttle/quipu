import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

/** Import restrictions every file keeps. */
const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@quipu/shared",
    message: "Import from an explicit @quipu/shared/* subpath. The package has no root export.",
  },
];

/**
 * The cva functions behind components/ui exports. They style a foreign element to look
 * like a Button or Toggle, which bypasses the component's variants; render the component
 * instead (`render={<Button …/>}`, or `SelectButton` for a picker trigger).
 */
const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

/**
 * The engine is reached from the UI through one typed client and the engine RPC contracts in
 * @quipu/contracts. The parsers and the document engine never load on the UI thread.
 */
const RESTRICTED_ENGINE_PATHS = [
  {
    name: "@quipu/core",
    message:
      "UI code reaches the engine through apps/web/src/engine/client.ts and the @quipu/contracts engine RPC. @quipu/core runs in workers.",
  },
  {
    name: "@quipu/formats",
    message:
      "UI code reaches the engine through apps/web/src/engine/client.ts and the @quipu/contracts engine RPC. @quipu/formats runs in workers.",
  },
];

/** Everything under a @quipu/core or @quipu/formats subpath, which `paths` does not cover. */
const RESTRICTED_ENGINE_PACKAGE_PATTERNS = [
  {
    group: ["@quipu/core/**", "@quipu/formats/**"],
    message:
      "UI code reaches the engine through apps/web/src/engine/client.ts and the @quipu/contracts engine RPC, never through the engine packages.",
  },
];

/**
 * The engine's internals (workers, indexes, parsers) under apps/web/src/engine. Only client.ts
 * is importable from outside that directory, by the alias or by a relative path.
 */
const RESTRICTED_ENGINE_INTERNAL_PATTERNS = [
  {
    // Gitignore-style: a later `!` re-allows the client. Oxlint's regex option has no lookahead.
    group: [
      "~/engine",
      "~/engine/**",
      "!~/engine/client",
      "!~/engine/client.ts",
      "./engine",
      "./engine/**",
      "!./engine/client",
      "!./engine/client.ts",
      "../**/engine",
      "../**/engine/**",
      "!../**/engine/client",
      "!../**/engine/client.ts",
    ],
    message:
      "Import the engine through apps/web/src/engine/client.ts. Its workers, indexes and parsers are not UI code.",
  },
];

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
  },
  staged: {
    // Only the formatter runs on commit; lint and typecheck run separately.
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      // Recorded responses and an exported theme file are compared byte for
      // byte; the formatter must not rewrite them.
      "**/testFixtures/**",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-quipu/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }],
      "quipu/namespace-node-imports": "error",
      "quipu/no-global-process-runtime": "error",
      "quipu/no-inline-schema-compile": "warn",
      "quipu/no-manual-effect-runtime-in-tests": "error",
      "quipu/no-native-title-tooltip": "error",
      "quipu/no-snapshot-assertions": "error",
      "quipu/no-test-in-loop": "error",
      "quipu/no-unscoped-has": "error",
      "quipu/prefer-catch-tags": "error",
      "quipu/require-centered-scroll-gutter": "error",
      "quipu/require-suppression-reason": "error",
    },
    overrides: [
      {
        // The one place that reads the host platform to seed the injected references.
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "quipu/no-global-process-runtime": "off" },
      },
      // Overrides replace a rule, so each of the three below carries the whole restricted-imports
      // config for its files. Together they cover apps/web/src once. components/ui defines the
      // UI variants, so the variant ban skips it; the engine directory imports its own internals.
      {
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/components/ui/**",
          "apps/web/src/engine/**",
          // A worker entry point: it hashes the file's head and tail off the UI thread.
          "apps/web/src/documents/fingerprint.worker.ts",
        ],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_ENGINE_PATHS],
              patterns: [
                ...RESTRICTED_UI_VARIANT_PATTERNS,
                ...RESTRICTED_ENGINE_PACKAGE_PATTERNS,
                ...RESTRICTED_ENGINE_INTERNAL_PATTERNS,
              ],
            },
          ],
        },
      },
      {
        files: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_ENGINE_PATHS],
              patterns: [
                ...RESTRICTED_ENGINE_PACKAGE_PATTERNS,
                ...RESTRICTED_ENGINE_INTERNAL_PATTERNS,
              ],
            },
          ],
        },
      },
      {
        files: ["apps/web/src/engine/**"],
        excludeFiles: [
          // The engine's worker entry points are the engine's runtime, not UI code: the
          // coordinator and the scanner load @quipu/core on the worker thread. Named files,
          // so client.ts and everything else in the app still go through @quipu/contracts.
          "apps/web/src/engine/engine.worker.ts",
          "apps/web/src/engine/scan.worker.ts",
          "apps/web/src/engine/jq.worker.ts",
          // Runs @quipu/formats' conversion jobs on a worker thread.
          "apps/web/src/engine/format.worker.ts",
          // Serves the engine worker's JournalStore over a MessagePort on the desktop.
          "apps/web/src/engine/desktopJournal.ts",
        ],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_ENGINE_PATHS],
              patterns: [...RESTRICTED_UI_VARIANT_PATTERNS, ...RESTRICTED_ENGINE_PACKAGE_PATTERNS],
            },
          ],
        },
      },
      {
        files: [
          "apps/web/src/engine/engine.worker.ts",
          "apps/web/src/engine/scan.worker.ts",
          "apps/web/src/engine/jq.worker.ts",
          "apps/web/src/engine/format.worker.ts",
          "apps/web/src/engine/desktopJournal.ts",
          "apps/web/src/documents/fingerprint.worker.ts",
        ],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            { paths: RESTRICTED_IMPORT_PATHS, patterns: [...RESTRICTED_UI_VARIANT_PATTERNS] },
          ],
        },
      },
      {
        // A document never becomes one string or object graph: the engine, the
        // format adapters and the web app's document and worker code read bounded slices.
        // Tests are exempt: the differential tests compare against reference readers.
        files: [
          "packages/core/**",
          "packages/formats/**",
          "apps/web/src/documents/**",
          "apps/web/src/engine/**",
        ],
        excludeFiles: ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
        rules: { "quipu/no-whole-document-materialization": "error" },
      },
      {
        // The one module allowed to materialize bytes: its functions take a byte limit and fail
        // above it, and its tests prove that.
        files: ["packages/core/src/boundedSlice.ts"],
        rules: { "quipu/no-whole-document-materialization": "off" },
      },
      {
        // Test fixtures: builds small, known encodings (base64, gzip) for the decoder tests.
        files: ["packages/core/src/testing/decoderSamples.ts"],
        rules: { "quipu/no-whole-document-materialization": "off" },
      },
      {
        // The value editor reads what the user typed (at most the editor's 1 MiB), never the document.
        files: ["apps/web/src/documents/editorValue.ts"],
        rules: { "quipu/no-whole-document-materialization": "off" },
      },
      {
        // The tests' reference JSON reader: it reads small generated texts whole, by design.
        files: ["packages/core/src/testing/readJson.ts"],
        rules: { "quipu/no-whole-document-materialization": "off" },
      },
      {
        // React commits state set in a raw ResizeObserver callback after the paint, so derived
        // layout lands a frame late. observeResize flushes every observed resize in one render.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/lib/observeResize.ts",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "quipu/no-raw-resize-observer": "error" },
      },
      {
        // Paint comes from theme tokens. @shadcn/lint reads class names only; this covers SVG
        // attributes, inline style objects and canvas assignments.
        files: ["apps/web/src/**", "packages/canvas/**"],
        rules: { "quipu/no-raw-svg-paint": "error" },
      },
      {
        // Brand marks keep the brand's own colors; the monochrome variant paints from currentColor.
        files: ["apps/web/src/components/Icons.tsx"],
        rules: { "quipu/no-raw-svg-paint": "off" },
      },
      {
        // State indicators paint inward; decorative rings keep their own geometry.
        files: ["apps/web/src/**"],
        rules: { "quipu/no-outset-state-indicators": "error" },
      },
      {
        // Every class in web code must be one Tailwind generates: a typo or a class nothing
        // declares ships silently unstyled. JS hooks use data attributes, not class names.
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        // Colors come from theme tokens so status tones follow custom themes. components/ui
        // has no findings and stays covered too.
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // components/ui exports own their look. App code picks a variant or size instead
        // of restyling with className; layout classes (width, flex, margin, position) stay
        // allowed because placement belongs to the parent. components/ui is for generic
        // primitives: a look that belongs to one feature stays in that feature's component.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          // A className built at runtime on a ui component is one no-restyle cannot read.
          "shadcn/require-static-classes": "error",
          // Appearance values come from the theme and Tailwind's scales. Layout stays free
          // (placement belongs to the parent); the other entries are values no scale can hold.
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                // Which properties an element animates is per-element behavior, like layout,
                // not a design value; timing curves and durations still come from the theme.
                "transition",
                // Overlays that follow their frame's corner radius, which is set at
                // runtime or by the element they decorate.
                "rounded-[inherit]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
