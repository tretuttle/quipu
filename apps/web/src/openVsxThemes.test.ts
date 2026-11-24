import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  checkOpenVsxTheme,
  fetchOpenVsxIcon,
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "./openVsxThemes";
import { getThemeColorsForMode, themeColorToHex } from "./themePalette";

const ASSET_ROOT = "https://open-vsx.org/api/demo/theme/1.0.0/file";

function extensionDetail(overrides: Record<string, unknown> = {}) {
  return {
    namespace: "demo",
    name: "theme",
    displayName: "Demo Theme",
    description: "A nice theme",
    version: "1.0.0",
    downloadCount: 123456,
    license: "MIT",
    repository: "https://github.com/demo/theme",
    files: {
      icon: `${ASSET_ROOT}/icon.png`,
      manifest: `${ASSET_ROOT}/package.json`,
      sha256: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      download: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Open VSX themes", () => {
  it("reads every hit from the search response alone", async () => {
    const fetchMock = vi.fn(
      async (..._args: unknown[]) =>
        new Response(
          JSON.stringify({
            extensions: [
              {
                namespace: "demo",
                name: "theme",
                displayName: "Demo Theme",
                description: "A nice theme",
                version: "1.0.0",
                downloadCount: 123456,
                files: { icon: `${ASSET_ROOT}/icon.png` },
              },
              { namespace: "plain", name: "theme", files: { icon: "https://evil.example/i.png" } },
              { namespace: "demo", name: "theme" },
              { namespace: "", name: "nameless" },
              "not a hit",
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchOpenVsxThemes("  dracula  ");

    expect(results).toEqual([
      {
        id: "demo.theme",
        namespace: "demo",
        extensionName: "theme",
        name: "Demo Theme",
        publisher: "demo",
        description: "A nice theme",
        downloadCount: 123456,
        iconUrl: `${ASSET_ROOT}/icon.png`,
        version: "1.0.0",
      },
      {
        id: "plain.theme",
        namespace: "plain",
        extensionName: "theme",
        name: "theme",
        publisher: "plain",
        description: "",
        downloadCount: 0,
        iconUrl: null,
        version: "",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("query")).toBe("dracula");
    expect(searchUrl.searchParams.get("category")).toBe("Themes");
    expect(searchUrl.searchParams.get("sortBy")).toBe("downloadCount");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
    expect(searchUrl.searchParams.get("size")).toBe("12");
  });

  it("checks a hit's license and themes before it can be installed", async () => {
    const manifestOf = (namespace: string) =>
      `${ASSET_ROOT.replace("demo/theme", `${namespace}/theme`)}/package.json`;
    const detailOf = (namespace: string, overrides: Record<string, unknown> = {}) =>
      extensionDetail({
        namespace,
        files: { ...extensionDetail().files, manifest: manifestOf(namespace) },
        ...overrides,
      });
    const themes = { contributes: { themes: [{ path: "./theme.json" }] } };
    const responses = new Map<string, unknown>([
      ["https://open-vsx.org/api/demo/theme", detailOf("demo")],
      [manifestOf("demo"), { license: "MIT", ...themes }],
      ["https://open-vsx.org/api/closed/theme", detailOf("closed", { license: "Proprietary" })],
      ["https://open-vsx.org/api/icons/theme", detailOf("icons")],
      [manifestOf("icons"), { license: "MIT", contributes: { iconThemes: [{}] } }],
      ["https://open-vsx.org/api/unlicensed/theme", detailOf("unlicensed")],
      [manifestOf("unlicensed"), themes],
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const body = responses.get(String(input));
      return body === undefined
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const check = (namespace: string) => checkOpenVsxTheme({ namespace, extensionName: "theme" });

    await expect(check("demo")).resolves.toEqual({
      status: "supported",
      extension: expect.objectContaining({
        id: "demo.theme",
        license: "MIT",
        sourceUrl: "https://github.com/demo/theme",
        vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
      }),
    });
    await expect(check("closed")).resolves.toEqual({ status: "unsupported", reason: "license" });
    await expect(check("icons")).resolves.toEqual({ status: "unsupported", reason: "no-themes" });
    await expect(check("unlicensed")).resolves.toEqual({
      status: "unsupported",
      reason: "license",
    });
    // No check ever touches a package.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(".vsix"))).toBe(false);
  });

  it("reports a check that Open VSX cannot answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/limited/theme")
          ? new Response(null, { status: 429 })
          : String(input).endsWith("/huge/theme")
            ? new Response(JSON.stringify({ padding: "x".repeat(256 * 1024) }), { status: 200 })
            : new Response("{}", { status: 200 }),
      ),
    );
    const check = (namespace: string) => checkOpenVsxTheme({ namespace, extensionName: "theme" });

    await expect(check("limited")).rejects.toThrow("Open VSX theme details are unavailable");
    await expect(check("huge")).rejects.toThrow("unexpectedly large detail response");
    await expect(check("malformed")).rejects.toThrow("Open VSX returned malformed theme details");
  });

  it("fetches an icon as an image Blob, and refuses one it should not show", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.mode).toBe("cors");
      const url = String(input);
      if (url.endsWith("/small.png")) {
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      if (url.endsWith("/screenshot.png")) {
        return new Response(new Uint8Array(65 * 1024), {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.endsWith("/page.png")) {
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const icon = await fetchOpenVsxIcon(`${ASSET_ROOT}/small.png`);
    expect(icon?.type).toBe("image/png");
    expect(new Uint8Array(await icon!.arrayBuffer())).toEqual(png);
    await expect(fetchOpenVsxIcon(`${ASSET_ROOT}/screenshot.png`)).resolves.toBeNull();
    await expect(fetchOpenVsxIcon(`${ASSET_ROOT}/page.png`)).resolves.toBeNull();
    await expect(fetchOpenVsxIcon(`${ASSET_ROOT}/missing.png`)).resolves.toBeNull();
    // Only open-vsx.org icons are fetched at all.
    await expect(fetchOpenVsxIcon("https://evil.example/icon.png")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("supports sorting theme searches", async () => {
    const fetchMock = vi.fn(
      async (..._args: unknown[]) =>
        new Response(JSON.stringify({ extensions: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchOpenVsxThemes("nord", { sortBy: "rating" });

    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("sortBy")).toBe("rating");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
  });

  it("rejects malformed search responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 200 })),
    );

    await expect(searchOpenVsxThemes("nord")).rejects.toThrow(
      "Open VSX returned an unreadable search response.",
    );
  });

  it("times out a stalled search request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );

    const search = expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX took too long to respond",
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await search;
  });

  it("downloads a verified VSIX, reads JSONC includes, and pairs contributed variants", async () => {
    const zip = new JSZip();
    zip.file("extension/.gitkeep", "");
    // Theme extensions sometimes publish their development dependencies too.
    // Those unused files should not prevent importing the small theme payload.
    for (let index = 0; index < 3_000; index += 1) {
      zip.file(`extension/node_modules/package-${index}.js`, "");
    }
    zip.file(
      "extension/themes/base.jsonc",
      `{
        // inherited workbench colors
        "colors": {
          "editor.foreground": "#eeeeee",
          "focusBorder": "#8b5cf6",
          "editor.findMatchBackground": "#663399",
          "editor.findMatchForeground": "#ffffff",
          "editor.findMatchHighlightBackground": "#445566",
          "editor.findMatchHighlightForeground": "#ffffff",
        },
      }`,
    );
    zip.file(
      "extension/themes/demo-dark.json",
      `{
        "include": "./base.jsonc",
        "colors": {
          "editor.background": "#111111",
          "editor.findMatchHighlightBackground": "#ffffff20"
        }
      }`,
    );
    zip.file(
      "extension/themes/demo-light.json",
      `{
        "colors": {
          "editor.background": "#fafafa",
          "editor.foreground": "#222222",
          "focusBorder": "#8b5cf6",
          "editor.findMatchBackground": "#335577",
          "editor.findMatchForeground": "#ffffff",
          "editor.findMatchHighlightBackground": "#bbddff",
          "editor.findMatchHighlightForeground": "#112233"
        }
      }`,
    );
    zip.file(
      "extension/themes/demo.json",
      `{
        "colors": {
          "editor.background": "#181818",
          "editor.foreground": "#eeeeee"
        }
      }`,
    );
    const packagedManifest = {
      publisher: "demo",
      name: "theme",
      version: "1.0.0",
      license: "MIT",
      contributes: {
        themes: [
          { label: "Demo Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
          { label: "Demo Light", uiTheme: "vs", path: "./themes/demo-light.json" },
          { label: "Demo", uiTheme: "vs-dark", path: "./themes/demo.json" },
        ],
      },
    };
    let packageBytes = new ArrayBuffer(0);
    let checksum = "";
    const rebuildPackage = async () => {
      zip.file("extension/package.json", JSON.stringify(packagedManifest));
      packageBytes = await zip.generateAsync({
        type: "arraybuffer",
        comment: `PK\u0005\u0006${"x".repeat(26)}`,
      });
      checksum = [...sha256(new Uint8Array(packageBytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    };
    await rebuildPackage();
    // The public manifest is only a preflight hint. Imports must use the manifest
    // inside the checksummed VSIX rather than this inconsistent contribution.
    const manifest = {
      contributes: { themes: [{ label: "Wrong", path: "./themes/missing.json" }] },
    };
    const extension: OpenVsxThemeExtension = {
      collectionId: "open-vsx:demo.theme",
      id: "demo.theme",
      name: "Demo Theme",
      publisher: "demo",
      description: "",
      downloadCount: 1,
      iconUrl: null,
      sourceUrl: null,
      license: "MIT",
      manifestUrl: `${ASSET_ROOT}/package.json`,
      sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      version: "1.0.0",
      vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === extension.manifestUrl) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (url === extension.sha256Url) return new Response(`${checksum}  demo.vsix`);
        return new Response(packageBytes, {
          status: 200,
          headers: { "Content-Length": String(packageBytes.byteLength) },
        });
      }),
    );

    const themes = await importOpenVsxThemeExtension(extension);

    expect(themes).toHaveLength(2);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(2);
    expect(themes.every((theme) => /^ovx-[a-z0-9-]+-[0-9a-f]{12}$/.test(theme.id))).toBe(true);
    expect(themes.every((theme) => theme.collection?.id === "open-vsx:demo.theme")).toBe(true);
    const paired = themes.find(
      (theme) =>
        getThemeColorsForMode(theme, "light") !== null &&
        getThemeColorsForMode(theme, "dark") !== null,
    )!;
    expect(paired.label).toBe("Demo");
    expect(themeColorToHex(paired.colors.canvas)).toBe("#fafafa");
    expect(themeColorToHex(getThemeColorsForMode(paired, "dark")!.canvas)).toBe("#111111");
    expect(themeColorToHex(getThemeColorsForMode(paired, "dark")!.text)).toBe("#eeeeee");
    const darkColors = getThemeColorsForMode(paired, "dark")!;
    expect(themeColorToHex(darkColors.searchMatchActiveBackground)).toBe("#663399");
    expect(themeColorToHex(darkColors.searchMatchActiveForeground)).toBe("#ffffff");
    expect(themeColorToHex(darkColors.searchMatchBackground)).toBe("#2f2f2f");
    expect(themeColorToHex(darkColors.searchMatchForeground)).toBe("#ffffff");
    expect(themeColorToHex(paired.colors.searchMatchActiveBackground)).toBe("#335577");
    expect(themeColorToHex(paired.colors.searchMatchActiveForeground)).toBe("#ffffff");
    expect(themeColorToHex(paired.colors.searchMatchBackground)).toBe("#bbddff");
    expect(themeColorToHex(paired.colors.searchMatchForeground)).toBe("#112233");

    packagedManifest.contributes.themes[0]!.label = "Renamed Dark";
    packagedManifest.contributes.themes[1]!.label = "Renamed Light";
    packagedManifest.contributes.themes[2]!.label = "Renamed Solo";
    await rebuildPackage();
    const renamedThemes = await importOpenVsxThemeExtension(extension);
    expect(renamedThemes.map((theme) => theme.id)).toEqual(themes.map((theme) => theme.id));

    packagedManifest.contributes.themes.push({
      label: "Duplicate Demo",
      uiTheme: "vs-dark",
      path: "./themes/demo.json",
    });
    await rebuildPackage();
    const duplicatePathThemes = await importOpenVsxThemeExtension(extension);
    expect(new Set(duplicatePathThemes.map((theme) => theme.id)).size).toBe(
      duplicatePathThemes.length,
    );
    expect(themes.every(({ id }) => duplicatePathThemes.some((theme) => theme.id === id))).toBe(
      true,
    );
    packagedManifest.contributes.themes.pop();

    packagedManifest.contributes.themes[2]!.path = "./themes/missing.json";
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "could not be imported safely",
    );
    packagedManifest.contributes.themes[2]!.path = "./themes/demo.json";

    packagedManifest.license = "Proprietary";
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "does not match its advertised license",
    );

    Reflect.deleteProperty(packagedManifest, "license");
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "does not match its advertised license",
    );
  });

  it("stops import work when the request is canceled", async () => {
    const packageBytes = new Uint8Array([1, 2, 3]);
    const checksum = [...sha256(packageBytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const controller = new AbortController();
    const extension: OpenVsxThemeExtension = {
      collectionId: "open-vsx:demo.theme",
      id: "demo.theme",
      name: "Demo Theme",
      publisher: "demo",
      description: "",
      downloadCount: 1,
      iconUrl: null,
      sourceUrl: null,
      license: "MIT",
      manifestUrl: `${ASSET_ROOT}/package.json`,
      sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      version: "1.0.0",
      vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === extension.manifestUrl) {
          return new Response(
            JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          );
        }
        if (url === extension.sha256Url) {
          controller.abort();
          return new Response(checksum);
        }
        return new Response(packageBytes);
      }),
    );

    await expect(importOpenVsxThemeExtension(extension, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects a package whose Open VSX checksum does not match", async () => {
    const extension: OpenVsxThemeExtension = {
      collectionId: "open-vsx:demo.theme",
      id: "demo.theme",
      name: "Demo Theme",
      publisher: "demo",
      description: "",
      downloadCount: 1,
      iconUrl: null,
      sourceUrl: null,
      license: "MIT",
      manifestUrl: `${ASSET_ROOT}/package.json`,
      sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      version: "1.0.0",
      vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === extension.manifestUrl) {
          return new Response(
            JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          );
        }
        if (url === extension.sha256Url) return new Response("0".repeat(64));
        return new Response(new Uint8Array([1, 2, 3]));
      }),
    );

    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow("integrity check");
  });
});
