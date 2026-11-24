// @effect-diagnostics nodeBuiltinImport:off - re-executes the current process inside a systemd scope before anything else runs.
/**
 * Memory guard: every process that generates, reads, benchmarks or browses a
 * big file runs inside a systemd scope capped at 8 GiB with no swap, so a
 * runaway process kills only itself. A script calls
 * `ensureMemoryGuard()` first thing; outside the scope it re-executes itself
 * inside one and exits with that run's status.
 *
 * `QUIPU_MEMORY_GUARD` decides what happens:
 *   unset   re-execute inside a scope when systemd can make one, else run as is
 *   1       already capped (inside the scope, or a container with its own
 *           memory limit): run as is
 *   0, off  opted out: run as is
 */
import * as NodeChildProcess from "node:child_process";

const GUARD_ENV = "QUIPU_MEMORY_GUARD";
const SCOPE = ["--user", "--scope", "--quiet", "-p", "MemoryMax=8G", "-p", "MemorySwapMax=0"];

export const memoryGuardCommand = (argv: ReadonlyArray<string>) => [
  "systemd-run",
  ...SCOPE,
  `--setenv=${GUARD_ENV}=1`,
  "--",
  ...argv,
];

export type MemoryGuardDecision =
  | { readonly run: "in-scope" }
  | { readonly run: "in-process"; readonly reason: string };

/**
 * Whether to re-execute inside a scope. `canMakeScope` is asked only when the
 * environment leaves the choice open, because probing starts a process.
 */
export const decideMemoryGuard = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  canMakeScope: () => boolean,
): MemoryGuardDecision => {
  const setting = env[GUARD_ENV]?.trim().toLowerCase();
  if (setting === "1") return { run: "in-process", reason: `${GUARD_ENV}=1: already capped` };
  if (setting === "0" || setting === "off")
    return { run: "in-process", reason: `${GUARD_ENV}=${setting}: opted out` };
  if (platform !== "linux")
    return {
      run: "in-process",
      reason: `no systemd on ${platform}: running without the 8 GiB cap`,
    };
  if (!canMakeScope())
    return {
      run: "in-process",
      reason: "systemd-run cannot make a user scope here: running without the 8 GiB cap",
    };
  return { run: "in-scope" };
};

/** Asks systemd for a throwaway scope with the guard's own limits. */
const probeScope = () => {
  const probe = NodeChildProcess.spawnSync("systemd-run", [...SCOPE, "--", "true"], {
    stdio: "ignore",
  });
  return probe.error === undefined && probe.status === 0;
};

export const ensureMemoryGuard = (): void => {
  // oxlint-disable-next-line quipu/no-global-process-runtime -- runs before any Effect runtime exists, to choose whether to re-execute.
  const decision = decideMemoryGuard(process.env, process.platform, probeScope);
  if (decision.run === "in-process") {
    // "already capped" is the normal case inside the scope; only the fallbacks are worth a line.
    if (process.env[GUARD_ENV]?.trim() !== "1")
      process.stderr.write(`memory guard: ${decision.reason}\n`);
    return;
  }
  const command = memoryGuardCommand([
    process.execPath,
    ...process.execArgv,
    ...process.argv.slice(1),
  ]);
  process.stdout.write(`${command.join(" ")}\n`);
  const result = NodeChildProcess.spawnSync(command[0] as string, command.slice(1), {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
};
