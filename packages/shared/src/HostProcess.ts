import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const Platform = Context.Reference<NodeJS.Platform>("@quipu/shared/HostProcess/Platform", {
  defaultValue: () => process.platform,
});

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@quipu/shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);

export const ExecutablePath = Context.Reference<string>(
  "@quipu/shared/HostProcess/ExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const isWindows = Effect.map(Platform, (platform) => platform === "win32");
