// @effect-diagnostics nodeBuiltinImport:off - stats and reads fixture files on disk before any Effect runtime exists.
/**
 * The fixture manifest. Every consumer goes through
 * `requireFixture`, which refuses a file that is missing, smaller than its stated
 * size, or without the sidecar the generator writes, so a "2 GiB" measurement can
 * never silently run on a stub or a sparse file.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const FIXTURE_DIR = NodePath.join(NodeOS.homedir(), ".cache", "quipu", "fixtures");
export const DEFAULT_SEED = 0x51_55_49_50;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** The big HAR body is at least this many base64 characters (600 MiB), over V8's string cap once decoded. */
export const BIG_BODY_CHARS = 629_145_600;

export type Fixture =
  | {
      readonly name: string;
      readonly shape: "har";
      readonly minBytes: number;
      readonly bigBodyChars: number;
      readonly nestedBodyBytes: ReadonlyArray<number>;
    }
  | { readonly name: string; readonly shape: "wide"; readonly minBytes: number }
  | {
      readonly name: string;
      readonly shape: "deep";
      readonly minBytes: number;
      readonly depth: number;
      readonly padBytes: number;
    };

export const FIXTURES: ReadonlyArray<Fixture> = [
  {
    name: "har-2g.har",
    shape: "har",
    minBytes: 2 * GiB,
    bigBodyChars: BIG_BODY_CHARS,
    nestedBodyBytes: [1 * MiB, 8 * MiB, 32 * MiB, 60 * MiB],
  },
  {
    name: "har-50m.har",
    shape: "har",
    minBytes: 50 * MiB,
    bigBodyChars: 4 * MiB,
    nestedBodyBytes: [256 * 1024, 1 * MiB, 2 * MiB],
  },
  {
    name: "har-1m.har",
    shape: "har",
    minBytes: 1 * MiB,
    bigBodyChars: 128 * 1024,
    nestedBodyBytes: [16 * 1024, 64 * 1024],
  },
  { name: "json-2g-wide.json", shape: "wide", minBytes: 2 * GiB },
  { name: "json-50m-wide.json", shape: "wide", minBytes: 50 * MiB },
  { name: "json-1m-wide.json", shape: "wide", minBytes: 1 * MiB },
  { name: "json-deep.json", shape: "deep", minBytes: 1 * MiB, depth: 100_000, padBytes: 8 },
  { name: "json-deep-50m.json", shape: "deep", minBytes: 50 * MiB, depth: 100_000, padBytes: 1040 },
];

export const fixtureByName = (name: string) => {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture)
    throw new Error(`unknown fixture ${name}; known: ${FIXTURES.map((f) => f.name).join(", ")}`);
  return fixture;
};

export type HarFixture = Extract<Fixture, { readonly shape: "har" }>;

export const harFixture = (name: string): HarFixture => {
  const fixture = fixtureByName(name);
  if (fixture.shape !== "har") throw new Error(`fixture ${name} is ${fixture.shape}, not a HAR`);
  return fixture;
};

export const fixturePath = (name: string, dir = FIXTURE_DIR) => NodePath.join(dir, name);

/** Written beside every fixture; a file without one was not written by the generator. */
export interface FixtureSidecar {
  readonly name: string;
  readonly bytes: number;
  readonly seed: number;
}

export const sidecarPath = (path: string) => `${path}.meta.json`;

export interface RequiredFixture {
  readonly path: string;
  readonly size: number;
  readonly fixture: Fixture;
}

/** The command that (re)generates a fixture into {@link FIXTURE_DIR}. */
export const generateCommand = (name: string) => `vp run fixtures ${name}`;

/**
 * Why the fixture at `dir` cannot be used, naming the command that fixes it,
 * or null when it exists, is at least its stated size and carries the
 * generator's sidecar.
 */
export const fixtureProblem = (name: string, dir = FIXTURE_DIR): string | null => {
  const fixture = fixtureByName(name);
  const path = fixturePath(name, dir);
  const fix = `run: ${generateCommand(name)}`;
  const stat = NodeFS.statSync(path, { throwIfNoEntry: false });
  if (!stat) return `fixture ${name} is missing at ${path}; ${fix}`;
  if (stat.size < fixture.minBytes)
    return `fixture ${name} is ${stat.size} bytes, below its stated ${fixture.minBytes}; refusing to measure on a stub; ${fix}`;
  const sidecar = readSidecar(path);
  if (!sidecar || sidecar.bytes !== stat.size)
    return `fixture ${name} has no matching sidecar at ${sidecarPath(path)}; a file the generator did not write is not a fixture; ${fix}`;
  return null;
};

/** Path of a fixture that exists, is at least its stated size and carries the generator's sidecar. */
export const requireFixture = (name: string, dir = FIXTURE_DIR): RequiredFixture => {
  const problem = fixtureProblem(name, dir);
  if (problem !== null) throw new Error(problem);
  const path = fixturePath(name, dir);
  return { path, size: NodeFS.statSync(path).size, fixture: fixtureByName(name) };
};

const readSidecar = (path: string): FixtureSidecar | null => {
  const text = NodeFS.existsSync(sidecarPath(path))
    ? NodeFS.readFileSync(sidecarPath(path), "utf8")
    : null;
  if (text === null) return null;
  const parsed = JSON.parse(text) as Partial<FixtureSidecar>;
  if (
    typeof parsed.name !== "string" ||
    typeof parsed.bytes !== "number" ||
    typeof parsed.seed !== "number"
  )
    return null;
  return { name: parsed.name, bytes: parsed.bytes, seed: parsed.seed };
};

export const writeSidecar = (path: string, sidecar: FixtureSidecar) => {
  NodeFS.writeFileSync(sidecarPath(path), `${JSON.stringify(sidecar, null, 2)}\n`);
};
