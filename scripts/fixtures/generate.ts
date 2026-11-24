// @effect-diagnostics nodeBuiltinImport:off - creates the scratch directory a fixture is generated into.
/** Writes one fixture to `out` through the streaming sink and records its sidecar. */
import * as NodeFS from "node:fs";

import { writeDeep } from "./deep.ts";
import {
  DEFAULT_SEED,
  FIXTURE_DIR,
  type Fixture,
  fixtureByName,
  fixturePath,
  fixtureProblem,
  generateCommand,
  type RequiredFixture,
  requireFixture,
  writeSidecar,
} from "./fixtures.ts";
import { writeHar } from "./har.ts";
import { createPrng } from "./prng.ts";
import { openSink } from "./sink.ts";
import { writeWide } from "./wide.ts";

export interface Generated {
  readonly bytes: number;
  readonly detail: Record<string, number>;
}

export const generateFixture = (fixture: Fixture, out: string, seed: number): Generated => {
  const sink = openSink(out);
  const prng = createPrng(seed);
  let detail: Record<string, number> = {};
  switch (fixture.shape) {
    case "har":
      detail = writeHar({
        sink,
        prng,
        targetBytes: fixture.minBytes,
        bigBodyChars: fixture.bigBodyChars,
        nestedBodyBytes: fixture.nestedBodyBytes,
      });
      break;
    case "wide":
      detail = writeWide(sink, prng, fixture.minBytes);
      break;
    case "deep":
      writeDeep(sink, prng, fixture.depth, fixture.padBytes);
      detail = { depth: fixture.depth };
      break;
  }
  const bytes = sink.close();
  if (bytes < fixture.minBytes)
    throw new Error(`${fixture.name}: wrote ${bytes} bytes, below stated ${fixture.minBytes}`);
  writeSidecar(out, { name: fixture.name, bytes, seed });
  return { bytes, detail };
};

/** Above this a fixture is never generated on demand: it takes minutes and gigabytes of disk. */
export const ON_DEMAND_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A small fixture from the cache, or, when the cache has no usable copy,
 * generated with the default seed into `scratchDir`, so a fresh clone runs the
 * tests that need it. Big fixtures are refused: those tests skip instead.
 */
export const ensureFixture = (
  name: string,
  scratchDir: string,
  cacheDir = FIXTURE_DIR,
): RequiredFixture => {
  if (fixtureProblem(name, cacheDir) === null) return requireFixture(name, cacheDir);
  const fixture = fixtureByName(name);
  if (fixture.minBytes > ON_DEMAND_MAX_BYTES)
    throw new Error(`${name} is too big to generate on demand; run: ${generateCommand(name)}`);
  if (fixtureProblem(name, scratchDir) !== null) {
    NodeFS.mkdirSync(scratchDir, { recursive: true });
    generateFixture(fixture, fixturePath(name, scratchDir), DEFAULT_SEED);
  }
  return requireFixture(name, scratchDir);
};
