import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import type { BrowserContext } from "playwright-core";

/**
 * Open VSX, answered from the responses recorded on 2026-10-11.
 * The VSIX is rebuilt from the recorded manifest and theme files, as the unit
 * tests do, because the original carries 400 KB of screenshots.
 */
const FIXTURE_DIRECTORY = NodePath.join(import.meta.dirname, "../src/testFixtures/open-vsx");

function fixture(name: string): string {
  return NodeFS.readFileSync(NodePath.join(FIXTURE_DIRECTORY, name), "utf8");
}

const FILE_PATH = "/api/dracula-theme/theme-dracula/2.25.1/file";
const VSIX_NAME = "dracula-theme.theme-dracula-2.25.1.vsix";

/** The two hosts Open VSX traffic may reach. */
export const OPEN_VSX_HOSTS: ReadonlyArray<string> = ["open-vsx.org", "openvsx.eclipsecontent.org"];

async function buildVsix(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("extension/package.json", fixture("manifest-dracula-theme.theme-dracula.json"));
  zip.file("extension/theme/dracula.json", fixture("theme-dracula.json"));
  zip.file("extension/theme/dracula-soft.json", fixture("theme-dracula-soft.json"));
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A 1x1 PNG, served for the recorded extension's icon. */
const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNY5qr1HwAEvwIVAMwWDQAAAABJRU5ErkJggg==",
  "base64",
);

export interface OpenVsxRecording {
  /** Every request that left the page for a host other than the dev server, in order. */
  readonly externalRequests: Array<{
    readonly host: string;
    readonly url: string;
    readonly method: string;
  }>;
  /** The search queries Open VSX received, as sent. */
  readonly searches: Array<URLSearchParams>;
}

/**
 * Answers Open VSX from fixtures and refuses every other external host.
 *
 * The live service redirects each file URL to openvsx.eclipsecontent.org.
 * Chromium sends a redirect hop that a test fulfilled out to the real
 * network, so files are served directly here instead; the unit tests cover
 * the file host's URLs.
 */
export async function stubOpenVsx(context: BrowserContext): Promise<OpenVsxRecording> {
  const vsix = await buildVsix();
  const recording: OpenVsxRecording = { externalRequests: [], searches: [] };
  const cors = { "access-control-allow-origin": "*" };

  await context.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      recording.externalRequests.push({
        host: url.hostname,
        url: request.url(),
        method: request.method(),
      });

      const isOpenVsx = OPEN_VSX_HOSTS.includes(url.hostname);
      if (isOpenVsx && url.pathname === "/api/-/search") {
        recording.searches.push(url.searchParams);
        return route.fulfill({
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
          body: fixture("search-dracula.json"),
        });
      }
      if (isOpenVsx && url.pathname === "/api/dracula-theme/theme-dracula") {
        return route.fulfill({
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
          body: fixture("detail-dracula-theme.theme-dracula.json"),
        });
      }
      if (isOpenVsx && /^\/api\/[^/]+\/[^/]+$/.test(url.pathname)) {
        // Only the recorded extension has a detail document; every other
        // search hit answers as an extension Open VSX does not know.
        return route.fulfill({ status: 404, headers: cors, body: "" });
      }
      if (isOpenVsx && url.pathname.startsWith(FILE_PATH)) {
        if (url.pathname.endsWith("package.json")) {
          return route.fulfill({
            status: 200,
            headers: { ...cors, "content-type": "application/json" },
            body: fixture("manifest-dracula-theme.theme-dracula.json"),
          });
        }
        if (url.pathname.endsWith("icon.png")) {
          // CORS only, no Cross-Origin-Resource-Policy: what Open VSX sends.
          return route.fulfill({
            status: 200,
            headers: { ...cors, "content-type": "image/png" },
            body: ICON_PNG,
          });
        }
        if (url.pathname.endsWith(".sha256")) {
          return route.fulfill({
            status: 200,
            headers: { ...cors, "content-type": "text/plain" },
            body: `${toHex(sha256(vsix))}  ${VSIX_NAME}`,
          });
        }
        if (url.pathname.endsWith(".vsix")) {
          return route.fulfill({
            status: 200,
            headers: {
              ...cors,
              "content-type": "application/octet-stream",
              "content-length": String(vsix.byteLength),
            },
            body: request.method() === "HEAD" ? "" : vsix,
          });
        }
      }

      return route.abort("blockedbyclient");
    },
  );
  return recording;
}
