import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import detailJson from "./testFixtures/open-vsx/detail-dracula-theme.theme-dracula.json?raw";
import manifestJson from "./testFixtures/open-vsx/manifest-dracula-theme.theme-dracula.json?raw";
import searchJson from "./testFixtures/open-vsx/search-dracula.json?raw";
import draculaSoftTheme from "./testFixtures/open-vsx/theme-dracula-soft.json?raw";
import draculaTheme from "./testFixtures/open-vsx/theme-dracula.json?raw";
import {
  checkOpenVsxTheme,
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "./openVsxThemes";
import { SORT_OPTIONS, SUGGESTED_SEARCHES } from "./openVsxThemeSearch";
import { getThemeColorsForMode, themeColorToHex, THEME_COLOR_ROLES } from "./themePalette";

// Recorded from open-vsx.org on 2026-10-11: the Dracula
// search, the dracula-theme.theme-dracula detail and manifest, and the two
// theme files out of its VSIX. The VSIX is rebuilt from those exact bytes
// because the original carries 400 KB of screenshots.

const ROOT = "https://open-vsx.org/api/dracula-theme/theme-dracula";
const FILES = `${ROOT}/2.25.1/file`;
const VSIX_URL = `${FILES}/dracula-theme.theme-dracula-2.25.1.vsix`;
const SHA256_URL = `${FILES}/dracula-theme.theme-dracula-2.25.1.sha256`;
const MANIFEST_URL = `${FILES}/package.json`;

const EXTENSION: OpenVsxThemeExtension = {
  id: "dracula-theme.theme-dracula",
  collectionId: "open-vsx:dracula-theme.theme-dracula",
  name: "Dracula Official",
  publisher: "dracula-theme",
  description: "",
  downloadCount: 0,
  iconUrl: null,
  sourceUrl: null,
  manifestUrl: MANIFEST_URL,
  sha256Url: SHA256_URL,
  vsixUrl: VSIX_URL,
  version: "2.25.1",
  license: "MIT",
};

type FetchCall = { url: string; init: RequestInit | undefined };

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildVsix(
  themeFiles: { readonly dracula: string; readonly soft: string } = {
    dracula: draculaTheme,
    soft: draculaSoftTheme,
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const zip = new JSZip();
  zip.file("extension/package.json", manifestJson);
  zip.file("extension/theme/dracula.json", themeFiles.dracula);
  zip.file("extension/theme/dracula-soft.json", themeFiles.soft);
  return new Uint8Array(await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }));
}

function stubOpenVsx(options: {
  readonly vsix: Uint8Array<ArrayBuffer>;
  readonly checksum?: string;
  readonly vsixHeaders?: Record<string, string>;
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/-/search?")) return new Response(searchJson, { status: 200 });
      if (url === ROOT) return new Response(detailJson, { status: 200 });
      if (url === MANIFEST_URL) return new Response(manifestJson, { status: 200 });
      if (url === SHA256_URL) {
        const checksum = options.checksum ?? toHex(sha256(options.vsix));
        return new Response(`${checksum}  dracula-theme.theme-dracula-2.25.1.vsix`, {
          status: 200,
        });
      }
      if (url === VSIX_URL) {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(options.vsix.byteLength) },
          });
        }
        return new Response(options.vsix, { status: 200, headers: options.vsixHeaders ?? {} });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Open VSX search against recorded responses", () => {
  it("lists every hit of the recorded search from that one response", async () => {
    const { calls } = stubOpenVsx({ vsix: await buildVsix() });

    const results = await searchOpenVsxThemes("Dracula");

    const recorded = (JSON.parse(searchJson) as { extensions: Array<{ displayName: string }> })
      .extensions;
    expect(results.map((candidate) => candidate.name)).toEqual(
      recorded.map((hit) => hit.displayName),
    );
    expect(results[0]).toEqual({
      id: "dracula-theme.theme-dracula",
      namespace: "dracula-theme",
      extensionName: "theme-dracula",
      name: "Dracula Theme Official",
      publisher: "dracula-theme",
      description: expect.stringContaining("The official Dracula Theme"),
      downloadCount: 432796,
      iconUrl: `${FILES}/icon.png`,
      version: "2.25.1",
    });
    // Typing a query downloads nothing but the search itself.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/-/search"]);
  });

  it("checks one hit's license and themes with its detail and manifest", async () => {
    const { calls } = stubOpenVsx({ vsix: await buildVsix() });
    const [dracula] = await searchOpenVsxThemes("Dracula");
    calls.length = 0;

    const check = await checkOpenVsxTheme(dracula!);

    expect(check).toEqual({
      status: "supported",
      extension: expect.objectContaining({
        id: "dracula-theme.theme-dracula",
        license: "MIT",
        version: "2.25.1",
        vsixUrl: VSIX_URL,
        sha256Url: SHA256_URL,
        manifestUrl: MANIFEST_URL,
      }),
    });
    expect(calls.map((call) => call.url)).toEqual([ROOT, MANIFEST_URL]);
    expect(calls.every((call) => call.init?.mode === "cors")).toBe(true);
  });

  it.each(SORT_OPTIONS.map((option) => [option.label, option.value] as const))(
    "sorts by %s",
    async (_label, sortBy) => {
      const { calls } = stubOpenVsx({ vsix: await buildVsix() });

      await searchOpenVsxThemes("Dracula", { sortBy });

      const search = new URL(calls[0]!.url);
      expect(search.pathname).toBe("/api/-/search");
      expect(search.searchParams.get("query")).toBe("Dracula");
      expect(search.searchParams.get("category")).toBe("Themes");
      expect(search.searchParams.get("sortBy")).toBe(sortBy);
      expect(search.searchParams.get("sortOrder")).toBe("desc");
      expect(search.searchParams.get("size")).toBe("12");
    },
  );

  it("offers four popular picks and four sort orders", () => {
    expect(SUGGESTED_SEARCHES).toEqual(["Dracula", "Catppuccin", "Nord", "Tokyo Night"]);
    expect(SORT_OPTIONS.map((option) => option.label)).toEqual([
      "Most downloaded",
      "Best rated",
      "Newest",
      "Most relevant",
    ]);
  });

  it("refuses a detail response that points a file at another host", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        const detail = JSON.parse(detailJson) as { files: Record<string, string> };
        detail.files.download = "https://evil.example/dracula.vsix";
        return new Response(JSON.stringify(detail));
      }),
    );

    await expect(
      checkOpenVsxTheme({ namespace: "dracula-theme", extensionName: "theme-dracula" }),
    ).rejects.toThrow();
    expect(calls.some((url) => url.includes("evil.example"))).toBe(false);
  });
});

describe("Open VSX install of a recorded extension", () => {
  it("imports both Dracula themes with workbench colors and no token colors", async () => {
    stubOpenVsx({ vsix: await buildVsix() });

    const themes = await importOpenVsxThemeExtension(EXTENSION);

    expect(themes.map((theme) => theme.label).sort()).toEqual([
      "Dracula Theme",
      "Dracula Theme Soft",
    ]);
    expect(themes.every((theme) => theme.collection?.id === EXTENSION.collectionId)).toBe(true);
    for (const theme of themes) {
      expect(theme.appearance).toBe("dark");
      const colors = getThemeColorsForMode(theme, "dark")!;
      expect(themeColorToHex(colors.canvas)?.slice(0, 7)).toBe("#282a36");
      expect(Object.keys(colors)).toEqual([...THEME_COLOR_ROLES]);
      expect(JSON.stringify(theme)).not.toContain("tokenColors");
    }
  });

  it("derives no palette color from token colors", async () => {
    const original = JSON.parse(draculaTheme) as Record<string, unknown>;
    const withoutTokens = { ...original, tokenColors: [] };
    stubOpenVsx({ vsix: await buildVsix() });
    const first = await importOpenVsxThemeExtension(EXTENSION);

    const changed = JSON.stringify(withoutTokens);
    const second = await buildVsix({ dracula: changed, soft: draculaSoftTheme });
    stubOpenVsx({ vsix: second });
    const result = await importOpenVsxThemeExtension(EXTENSION);

    // Token colors reach the theme only as the optional syntax table; every
    // palette field is the same as without them.
    const withoutSyntax = (themes: typeof first) =>
      themes.map(({ syntax: _syntax, ...theme }) => theme);
    expect(withoutSyntax(result)).toEqual(withoutSyntax(first));
    expect(first.every((theme) => theme.syntax?.dark !== undefined)).toBe(true);
    expect(result.find((theme) => theme.label === "Dracula Theme")?.syntax).toBeUndefined();
  });

  it("rejects a VSIX whose checksum does not match", async () => {
    stubOpenVsx({ vsix: await buildVsix(), checksum: "0".repeat(64) });

    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow(
      "That Open VSX theme failed its integrity check.",
    );
  });

  it("rejects a VSIX larger than 20 MiB before reading it", async () => {
    stubOpenVsx({
      vsix: await buildVsix(),
      vsixHeaders: { "content-length": String(20 * 1024 * 1024 + 1) },
    });

    await expect(importOpenVsxThemeExtension(EXTENSION)).rejects.toThrow(
      "That theme extension is too large to import safely.",
    );
  });
});

// Central directory entry layout (offsets from its signature): compressed size
// at +20 and uncompressed size at +24, both little-endian uint32.
function patchCentralDirectory(
  bytes: Uint8Array<ArrayBuffer>,
  patch: (view: DataView, entryOffset: number, index: number) => void,
): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  let index = 0;
  for (let offset = 0; offset < copy.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      patch(view, offset, index);
      index += 1;
    }
  }
  return copy;
}

describe("Open VSX install zip limits", () => {
  async function importPackage(vsix: Uint8Array<ArrayBuffer>): Promise<unknown> {
    stubOpenVsx({ vsix });
    return importOpenVsxThemeExtension(EXTENSION);
  }

  it("rejects ZIP64 sizes", async () => {
    const zip64 = patchCentralDirectory(await buildVsix(), (view, offset, index) => {
      if (index === 0) view.setUint32(offset + 24, 0xffffffff, true);
    });

    await expect(importPackage(zip64)).rejects.toThrow(
      "That extension package has unsupported ZIP64 metadata.",
    );
  });

  it("rejects a package that expands past 100 MiB", async () => {
    const bomb = patchCentralDirectory(await buildVsix(), (view, offset, index) => {
      if (index === 0) {
        view.setUint32(offset + 20, 60 * 1024 * 1024, true);
        view.setUint32(offset + 24, 100 * 1024 * 1024 + 1, true);
      }
    });

    await expect(importPackage(bomb)).rejects.toThrow(
      "That extension package expands beyond the safe import limit.",
    );
  });

  it("rejects a compression ratio above 200 to 1", async () => {
    const bomb = patchCentralDirectory(await buildVsix(), (view, offset, index) => {
      if (index === 0) {
        view.setUint32(offset + 20, 1000, true);
        view.setUint32(offset + 24, 1000 * 201, true);
      }
    });

    await expect(importPackage(bomb)).rejects.toThrow(
      "That extension package has an unsafe compression ratio.",
    );
  });

  it("accepts a compression ratio of exactly 200 to 1", async () => {
    const edge = patchCentralDirectory(await buildVsix(), (view, offset, index) => {
      if (index === 0) {
        view.setUint32(offset + 20, 1000, true);
        view.setUint32(offset + 24, 1000 * 200, true);
      }
    });

    await expect(importPackage(edge)).resolves.toHaveLength(2);
  });

  it("rejects more than 5000 entries", async () => {
    const zip = new JSZip();
    zip.file("extension/package.json", manifestJson);
    for (let index = 0; index < 5_001; index += 1) zip.file(`extension/n/${index}.txt`, "");
    const crowded = new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));

    await expect(importPackage(crowded)).rejects.toThrow(
      "That extension package has too many files.",
    );
  });

  it("rejects bytes with no ZIP directory", async () => {
    const notZip = new TextEncoder().encode("this is not a zip archive at all, only text");

    await expect(importPackage(notZip)).rejects.toThrow(
      "That extension package has no ZIP directory.",
    );
  });

  it("rejects a package that carries trailing bytes after its directory", async () => {
    const valid = await buildVsix();
    const trailing = new Uint8Array(valid.byteLength + 4096);
    trailing.set(valid);

    await expect(importPackage(trailing)).rejects.toThrow(
      "That extension package has no ZIP directory.",
    );
  });
});
