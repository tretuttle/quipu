// @effect-diagnostics nodeBuiltinImport:off - reads the host's CPU and frequency state from /sys for the bench record.
/** What the bench file records about this machine: CPU, governor, energy preference, a frequency snapshot and RAM. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

const readSys = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8").trim();
  } catch {
    return "unknown";
  }
};

export const machineRecord = () => {
  const cpus = NodeOS.cpus();
  const freqs = cpus.map((c) => c.speed * 1000).sort((a, b) => a - b);
  const mid = freqs.length >> 1;
  return {
    cpu: cpus[0]?.model ?? "unknown",
    logicalCpus: cpus.length,
    governor: readSys("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    energyPerformancePreference: readSys(
      "/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference",
    ),
    freqKHz: { min: freqs[0] ?? 0, median: freqs[mid] ?? 0, max: freqs[freqs.length - 1] ?? 0 },
    ramBytes: NodeOS.totalmem(),
  };
};

/** Anonymous memory of this process's cgroup (the whole browser tree under the guard), the number the OOM killer sees. */
export const cgroupAnonBytes = () => {
  const line = readSys("/proc/self/cgroup")
    .split("\n")
    .find((l) => l.startsWith("0::"));
  if (!line) return 0;
  const stat = readSys(`/sys/fs/cgroup${line.slice(3)}/memory.stat`);
  const match = /^anon (\d+)/m.exec(stat);
  return match ? Number(match[1]) : 0;
};
