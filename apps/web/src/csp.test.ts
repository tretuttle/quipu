import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import { WEB_CSP } from "../vite.config";

describe("web Content-Security-Policy", () => {
  it("declares a strict offline-safe CSP meta tag in index.html", () => {
    const match = indexHtml.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i,
    );
    expect(match?.[1]).toBe(WEB_CSP);
    const policy = match![1]!;
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("connect-src 'self' blob:");
    expect(policy).toContain("img-src 'self' blob: data:");
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/\s\*(?:;|$)/);
  });
});
