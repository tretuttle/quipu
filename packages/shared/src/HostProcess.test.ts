import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as HostProcess from "./HostProcess.ts";

describe("HostProcess references", () => {
  it.effect("isWindows follows the provided Platform reference", () =>
    Effect.gen(function* () {
      const onWindows = yield* HostProcess.isWindows.pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );
      const onLinux = yield* HostProcess.isWindows.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(onWindows).toBe(true);
      expect(onLinux).toBe(false);
    }),
  );

  it("defaults every reference to the live process", () => {
    // oxlint-disable-next-line quipu/no-global-process-runtime -- The test asserts the default reads the live process.
    expect(HostProcess.Platform.defaultValue()).toBe(process.platform);
    // oxlint-disable-next-line quipu/no-global-process-runtime -- The test asserts the default reads the live process.
    expect(HostProcess.Architecture.defaultValue()).toBe(process.arch);
    expect(HostProcess.ExecutablePath.defaultValue()).toBe(process.execPath);
  });
});
