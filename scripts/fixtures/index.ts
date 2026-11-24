// @effect-diagnostics nodeBuiltinImport:off - a CLI that writes fixture files; no Effect runtime is involved.
/**
 * Fixture generator CLI. Fixtures are generated, never committed: seeded,
 * deterministic, and streamed to the fixture cache directory (FIXTURE_DIR).
 * Runs under the memory guard.
 *   vp run fixtures                     every fixture in the manifest
 *   vp run fixtures har-50m.har ...     the named fixtures
 *   vp run fixtures -- --seed 7         another seed
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { ensureMemoryGuard } from "../lib/memoryGuard.ts";
import { DEFAULT_SEED, FIXTURE_DIR, FIXTURES, fixtureByName, fixturePath } from "./fixtures.ts";
import { generateFixture } from "./generate.ts";

ensureMemoryGuard();

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { seed: { type: "string" } },
});
const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
const names = positionals.length > 0 ? positionals : FIXTURES.map((f) => f.name);
NodeFS.mkdirSync(FIXTURE_DIR, { recursive: true });
for (const name of names) {
  const fixture = fixtureByName(name);
  const out = fixturePath(name);
  const started = performance.now();
  const { bytes, detail } = generateFixture(fixture, out, seed);
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    `${out}\t${bytes} bytes\t${(bytes / 1048576 / seconds).toFixed(0)} MiB/s\t${JSON.stringify(detail)}\n`,
  );
}
