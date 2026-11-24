import { describe, expect, it } from "vite-plus/test";

import { decideMemoryGuard, memoryGuardCommand } from "./memoryGuard.ts";

const neverAsked = () => {
  throw new Error("probed systemd although the environment had decided");
};

describe("the memory guard", () => {
  it("re-executes inside a scope on Linux when systemd can make one", () => {
    expect(decideMemoryGuard({}, "linux", () => true)).toEqual({ run: "in-scope" });
  });

  it("runs in-process, saying why, when systemd cannot make a scope or there is no systemd", () => {
    const noScope = decideMemoryGuard({}, "linux", () => false);
    expect(noScope.run).toBe("in-process");
    expect(noScope.run === "in-process" && noScope.reason).toMatch(/cannot make a user scope/);
    const windows = decideMemoryGuard({}, "win32", neverAsked);
    expect(windows.run === "in-process" && windows.reason).toMatch(/no systemd on win32/);
  });

  it("runs in-process when already capped or opted out, without probing", () => {
    for (const value of ["1", "0", "off", "OFF "]) {
      expect(decideMemoryGuard({ QUIPU_MEMORY_GUARD: value }, "linux", neverAsked).run).toBe(
        "in-process",
      );
    }
    // Any other value leaves the choice to systemd.
    expect(decideMemoryGuard({ QUIPU_MEMORY_GUARD: "yes" }, "linux", () => true).run).toBe(
      "in-scope",
    );
  });

  it("marks the re-executed run as capped, so it does not re-execute again", () => {
    const command = memoryGuardCommand(["node", "script.ts"]);
    expect(command.slice(0, 1)).toEqual(["systemd-run"]);
    expect(command).toContain("MemoryMax=8G");
    expect(command).toContain("--setenv=QUIPU_MEMORY_GUARD=1");
    expect(command.slice(-3)).toEqual(["--", "node", "script.ts"]);
    expect(decideMemoryGuard({ QUIPU_MEMORY_GUARD: "1" }, "linux", neverAsked).run).toBe(
      "in-process",
    );
  });
});
