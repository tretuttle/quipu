import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import config from "../vite.config.ts";
import { lintWithConfig } from "./test/utils.ts";

/**
 * Runs the real lint block of vite.config.ts over files placed at real repo paths in a temp
 * tree, so a per-path override that matches the wrong files fails here. @shadcn/lint is left
 * out: it needs the web app's Tailwind setup and has its own tests.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutShadcn = (rules: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(rules).filter(([name]) => !name.startsWith("shadcn/")));

const buildOxlintrc = (pluginSpecifier: string) => {
  const lint: unknown = config.lint;
  if (!isRecord(lint) || !isRecord(lint.rules) || !Array.isArray(lint.overrides)) {
    throw new Error("vite.config.ts has no lint block with rules and overrides");
  }
  if (!isRecord(lint.options)) throw new Error("vite.config.ts lint has no options");
  const overrides = lint.overrides.flatMap((override: unknown) =>
    isRecord(override) && isRecord(override.rules)
      ? [{ ...override, rules: withoutShadcn(override.rules) }]
      : [],
  );
  return {
    oxlintrc: {
      plugins: lint.plugins,
      categories: {},
      jsPlugins: [{ name: "quipu", specifier: pluginSpecifier }],
      rules: withoutShadcn(lint.rules),
      overrides: overrides.filter((override) => Object.keys(override.rules).length > 0),
    },
    unusedDirectives: lint.options.reportUnusedDisableDirectives,
  };
};

const { unusedDirectives } = buildOxlintrc("");

const lint = Effect.fnUntraced(function* (files: Record<string, string>) {
  const path = yield* Path.Path;
  const { oxlintrc } = buildOxlintrc(path.join(import.meta.dirname, "index.ts"));
  return yield* lintWithConfig({
    config: oxlintrc,
    files,
    args: [`--report-unused-disable-directives-severity=${String(unusedDirectives)}`],
  });
});

const materializes = `export const a = JSON.parse(source);`;

describe("lint config", () => {
  const test = it.layer(NodeServices.layer);

  test("per-path wiring", (it) => {
    it.effect("reports unused disable directives as errors", () =>
      Effect.gen(function* () {
        assert.strictEqual(unusedDirectives, "error");
        const output = yield* lint({
          "packages/shared/src/a.ts": `// oxlint-disable-next-line no-debugger -- nothing here to disable\nexport const a = 1;\n`,
        });
        assert.match(output, /Unused eslint-disable directive|unused/i);
      }),
    );

    it.effect.each([
      "packages/core/src/a.ts",
      "packages/formats/src/json/a.ts",
      "apps/web/src/documents/a.ts",
      "apps/web/src/engine/a.ts",
      "apps/web/src/engine/a.worker.ts",
    ])("applies no-whole-document-materialization to %s", (path) =>
      Effect.gen(function* () {
        assert.match(
          yield* lint({ [path]: materializes }),
          /quipu\(no-whole-document-materialization\)/,
        );
      }),
    );

    it.effect("exempts only boundedSlice.ts from no-whole-document-materialization", () =>
      Effect.gen(function* () {
        assert.notMatch(
          yield* lint({ "packages/core/src/boundedSlice.ts": materializes }),
          /no-whole-document-materialization/,
        );
        assert.match(
          yield* lint({ "packages/core/src/boundedSlices.ts": materializes }),
          /no-whole-document-materialization/,
        );
      }),
    );

    it.effect.each(["packages/shared/src/a.ts", "apps/web/src/lib/a.ts"])(
      "leaves no-whole-document-materialization off in %s",
      (path) =>
        Effect.gen(function* () {
          assert.notMatch(
            yield* lint({ [path]: materializes }),
            /no-whole-document-materialization/,
          );
        }),
    );

    it.effect("keeps the UI away from the engine packages and its internals", () =>
      Effect.gen(function* () {
        const output = yield* lint({
          "apps/web/src/a.ts": [
            `import { x } from "@quipu/core";`,
            `import { y } from "@quipu/formats";`,
            `import { z } from "@quipu/core/boundedSlice";`,
            `import { w } from "~/engine/workers/index";`,
            `import { v } from "../engine/parsers/json";`,
            `export { x, y, z, w, v };`,
          ].join("\n"),
        });
        for (const specifier of [
          "@quipu/core",
          "@quipu/formats",
          "@quipu/core/boundedSlice",
          "~/engine/workers/index",
          "../engine/parsers/json",
        ]) {
          assert.include(output, `'${specifier}' import is restricted`);
        }
      }),
    );

    it.effect("lets the UI import the engine client and the contracts", () =>
      Effect.gen(function* () {
        const output = yield* lint({
          "apps/web/src/a.ts": [
            `import { a } from "~/engine/client";`,
            `import { b } from "./engine/client";`,
            `import { c } from "@quipu/contracts/engineRpc";`,
            `export { a, b, c };`,
          ].join("\n"),
        });
        assert.notMatch(output, /no-restricted-imports/);
      }),
    );

    it.effect("lets the engine directory import its internals but not the engine packages", () =>
      Effect.gen(function* () {
        const output = yield* lint({
          "apps/web/src/engine/client.ts": [
            `import { a } from "./workers/pool";`,
            `import { b } from "@quipu/core";`,
            `export { a, b };`,
          ].join("\n"),
        });
        assert.include(output, "'@quipu/core' import is restricted");
        // The code frame of the @quipu/core diagnostic prints the neighboring import line, so
        // the specifier alone shows up in the output. Only the restriction message counts.
        assert.notInclude(output, "'./workers/pool' import is restricted");
      }),
    );

    it.effect("keeps the engine ban on components/ui", () =>
      Effect.gen(function* () {
        const output = yield* lint({
          "apps/web/src/components/ui/a.ts": `import { x } from "@quipu/core";\nexport { x };`,
        });
        assert.include(output, "'@quipu/core' import is restricted");
      }),
    );

    it.effect.each(["packages/shared/src/a.test.ts", "apps/web/src/b.test.tsx"])(
      "bans snapshot assertions in %s",
      (path) =>
        Effect.gen(function* () {
          assert.match(
            yield* lint({ [path]: `expect(1).toMatchSnapshot();` }),
            /quipu\(no-snapshot-assertions\)/,
          );
        }),
    );

    it.effect.each(["apps/web/src/a.tsx", "packages/canvas/src/a.tsx"])(
      "bans raw SVG and canvas paint in %s",
      (path) =>
        Effect.gen(function* () {
          assert.match(
            yield* lint({ [path]: `export const el = <rect fill="#fff" />;` }),
            /quipu\(no-raw-svg-paint\)/,
          );
        }),
    );

    it.effect("leaves paint to the packages that have no UI", () =>
      Effect.gen(function* () {
        assert.notMatch(
          yield* lint({ "packages/shared/src/a.tsx": `export const el = <rect fill="#fff" />;` }),
          /no-raw-svg-paint/,
        );
      }),
    );

    it.effect("exempts observeResize.ts, and only it, from no-raw-resize-observer", () =>
      Effect.gen(function* () {
        const source = `export const o = new ResizeObserver(() => undefined);`;
        assert.notMatch(
          yield* lint({ "apps/web/src/lib/observeResize.ts": source }),
          /no-raw-resize-observer/,
        );
        assert.match(
          yield* lint({ "apps/web/src/lib/other.ts": source }),
          /quipu\(no-raw-resize-observer\)/,
        );
      }),
    );

    it.effect("exempts HostProcess.ts, and only it, from no-global-process-runtime", () =>
      Effect.gen(function* () {
        const source = `export const p = process.platform;`;
        assert.notMatch(
          yield* lint({ "packages/shared/src/HostProcess.ts": source }),
          /no-global-process-runtime/,
        );
        assert.match(
          yield* lint({ "packages/shared/src/other.ts": source }),
          /quipu\(no-global-process-runtime\)/,
        );
      }),
    );

    it.effect("requires a reason on every suppression", () =>
      Effect.gen(function* () {
        assert.match(
          yield* lint({
            "packages/shared/src/a.ts": `// oxlint-disable-next-line no-debugger\ndebugger;\n`,
          }),
          /quipu\(require-suppression-reason\)/,
        );
      }),
    );
  });
});
