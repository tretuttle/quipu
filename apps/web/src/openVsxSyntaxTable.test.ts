import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { createHighlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { importOpenVsxThemeExtension, type OpenVsxThemeExtension } from "./openVsxThemes";
import { serializeThemeFile } from "./themePalette";

const STRING_RULE = { scope: "string", settings: { foreground: "#aa0000" } };
const ASSET_ROOT = "https://open-vsx.org/api/demo/tokens/1.0.0/file";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importExtension(files: Record<string, string>, themes: ReadonlyArray<unknown>) {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) zip.file(`extension/${path}`, contents);
  zip.file(
    "extension/package.json",
    JSON.stringify({
      publisher: "demo",
      name: "tokens",
      version: "1.0.0",
      license: "MIT",
      contributes: { themes },
    }),
  );
  const packageBytes = await zip.generateAsync({ type: "arraybuffer" });
  const checksum = [...sha256(new Uint8Array(packageBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const extension: OpenVsxThemeExtension = {
    collectionId: "open-vsx:demo.tokens",
    id: "demo.tokens",
    name: "Demo Tokens",
    publisher: "demo",
    description: "",
    downloadCount: 1,
    iconUrl: null,
    sourceUrl: null,
    license: "MIT",
    manifestUrl: `${ASSET_ROOT}/package.json`,
    sha256Url: `${ASSET_ROOT}/demo.tokens-1.0.0.sha256`,
    version: "1.0.0",
    vsixUrl: `${ASSET_ROOT}/demo.tokens-1.0.0.vsix`,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === extension.manifestUrl) {
        return new Response(JSON.stringify({ contributes: { themes } }), { status: 200 });
      }
      if (url === extension.sha256Url) return new Response(`${checksum}  demo.vsix`);
      return new Response(packageBytes, {
        status: 200,
        headers: { "Content-Length": String(packageBytes.byteLength) },
      });
    }),
  );
  return importOpenVsxThemeExtension(extension);
}

describe("syntax colors from an imported extension", () => {
  it("resolves token colors through an include, with the including file's rules winning", async () => {
    const [theme] = await importExtension(
      {
        "themes/base.json": JSON.stringify({
          colors: { "editor.foreground": "#dddddd" },
          tokenColors: [
            { scope: "string", settings: { foreground: "#aa0000" } },
            { scope: "constant.numeric", settings: { foreground: "#00aa00" } },
          ],
        }),
        "themes/child.json": JSON.stringify({
          include: "./base.json",
          colors: { "editor.background": "#101010" },
          tokenColors: [{ scope: "string", settings: { foreground: "#0000aa" } }],
        }),
      },
      [{ label: "Child", uiTheme: "vs-dark", path: "./themes/child.json" }],
    );

    expect(theme?.syntax?.dark).toMatchObject({
      foreground: "#dddddd",
      stringBody: "#0000aa",
      stringQuotes: "#0000aa",
      number: "#00aa00",
    });
    expect(theme?.syntax?.light).toBeUndefined();
  });

  it("paints whitespace with the color shiki paints it when the scope-less rule is named", async () => {
    // Only an unnamed, scope-less rule is shiki's declared foreground, but a
    // named one still sets the grammar's default color. Both orders must agree.
    const orders = {
      first: [{ name: "Default text", settings: { foreground: "#bbbbbb" } }, STRING_RULE],
      later: [STRING_RULE, { name: "Default text", settings: { foreground: "#bbbbbb" } }],
    };
    for (const [order, tokenColors] of Object.entries(orders)) {
      const raw = {
        name: `named-${order}`,
        type: "dark",
        colors: { "editor.background": "#101010", "editor.foreground": "#dddddd" },
        tokenColors,
      };
      const [theme] = await importExtension({ "themes/named.json": JSON.stringify(raw) }, [
        { label: "Named", uiTheme: "vs-dark", path: "./themes/named.json" },
      ]);
      const highlighter = await createHighlighter({
        themes: [raw as never],
        langs: ["json"],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
      const { tokens } = highlighter.codeToTokens('{ "a": 1 }', { lang: "json", theme: raw.name });
      const whitespace = tokens[0]?.find((token) => token.content.startsWith("{ "));

      expect(theme?.syntax?.dark?.foreground, order).toBe(whitespace?.color?.toLowerCase());
      expect(theme?.syntax?.dark?.stringBody, order).toBe("#aa0000");
      highlighter.dispose();
    }
  });

  it("keeps the light and dark tables of a paired theme, and writes them to the exported file", async () => {
    const themeFor = (type: "light" | "dark", string: string, background: string) =>
      JSON.stringify({
        type,
        colors: { "editor.background": background, "editor.foreground": "#777777" },
        tokenColors: [{ scope: "string", settings: { foreground: string } }],
      });
    const themes = await importExtension(
      {
        "themes/demo-light.json": themeFor("light", "#118811", "#fafafa"),
        "themes/demo-dark.json": themeFor("dark", "#44ee44", "#111111"),
      },
      [
        { label: "Demo Light", uiTheme: "vs", path: "./themes/demo-light.json" },
        { label: "Demo Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
      ],
    );

    expect(themes).toHaveLength(1);
    expect(themes[0]?.syntax?.light?.stringBody).toBe("#118811");
    expect(themes[0]?.syntax?.dark?.stringBody).toBe("#44ee44");
    const file = JSON.parse(serializeThemeFile(themes[0]!)) as {
      syntax: { light: { stringBody: string }; dark: { stringBody: string } };
    };
    expect(file.syntax.light.stringBody).toBe("#118811");
    expect(file.syntax.dark.stringBody).toBe("#44ee44");
  });

  it("leaves a theme without token colors without a table", async () => {
    const [theme] = await importExtension(
      {
        "themes/plain.json": JSON.stringify({
          colors: { "editor.background": "#101010", "editor.foreground": "#dddddd" },
        }),
      },
      [{ label: "Plain", uiTheme: "vs-dark", path: "./themes/plain.json" }],
    );

    expect(theme).toBeDefined();
    expect(theme?.syntax).toBeUndefined();
  });
});
