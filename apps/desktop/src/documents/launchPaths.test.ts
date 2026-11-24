import { describe, expect, it } from "vite-plus/test";

import { documentPathsFromArgv } from "./launchPaths.ts";

describe("documentPathsFromArgv", () => {
  it("takes the files after the executable of a packaged app, not its switches", () => {
    expect(
      documentPathsFromArgv(["/opt/quipu/quipu", "--no-sandbox", "/data/capture.har", "b.json"], {
        appPath: "/opt/quipu/resources/app.asar",
      }),
    ).toEqual(["/data/capture.har", "b.json"]);
  });

  it("leaves out the app's own script when it runs as `electron <app> <file>`", () => {
    expect(
      documentPathsFromArgv(
        [
          "/usr/bin/electron",
          "--inspect=0",
          "/work/dist-electron/boot.cjs",
          "--user-data-dir=/tmp/x",
          "/a/b.json",
        ],
        { appPath: "/work/dist-electron" },
      ),
    ).toEqual(["/a/b.json"]);
  });

  it("ignores URLs and repeats", () => {
    expect(
      documentPathsFromArgv(["quipu", "https://example.com/x.har", "x.har", "x.har"], {
        appPath: "/opt/quipu/resources/app.asar",
      }),
    ).toEqual(["x.har"]);
  });

  it("finds nothing when launched bare", () => {
    expect(
      documentPathsFromArgv(["/opt/quipu/quipu"], { appPath: "/opt/quipu/resources/app.asar" }),
    ).toEqual([]);
  });
});
