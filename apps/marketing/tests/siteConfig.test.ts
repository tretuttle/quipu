import { describe, expect, it } from "vite-plus/test";

import { readSiteConfig } from "../src/lib/site";

describe("readSiteConfig", () => {
  it("links nothing when no release or web app is configured", () => {
    expect(readSiteConfig({})).toEqual({ release: null, webAppPath: null });
    expect(readSiteConfig({ QUIPU_RELEASE_VERSION: " ", QUIPU_WEB_APP_PATH: "" })).toEqual({
      release: null,
      webAppPath: null,
    });
  });

  it("names the installers the way the desktop packaging script does", () => {
    expect(
      readSiteConfig({ QUIPU_RELEASE_VERSION: "0.4.0-beta.1", QUIPU_WEB_APP_PATH: "/app/" }),
    ).toEqual({
      release: {
        version: "0.4.0-beta.1",
        linuxAppImage: "/downloads/Quipu-0.4.0-beta.1-x86_64.AppImage",
        windowsInstaller: "/downloads/Quipu-0.4.0-beta.1-x64.exe",
      },
      webAppPath: "/app/",
    });
  });

  it("refuses a version that is not one, so a link never points at a made-up file", () => {
    for (const version of ["latest", "1.2", "v1.2.3", "1.2.3/../x", "1.2.3 beta"]) {
      expect(() => readSiteConfig({ QUIPU_RELEASE_VERSION: version }), version).toThrow(
        /QUIPU_RELEASE_VERSION/,
      );
    }
  });

  it("refuses a web app address on another origin", () => {
    for (const path of ["https://example.com/app/", "//example.com/app/", "app/"]) {
      expect(() => readSiteConfig({ QUIPU_WEB_APP_PATH: path }), path).toThrow(
        /QUIPU_WEB_APP_PATH/,
      );
    }
  });
});
