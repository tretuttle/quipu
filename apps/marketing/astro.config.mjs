import { defineConfig } from "astro/config";

// No `site` and no `base`: the built pages carry no origin, so the same `dist`
// serves from any docroot.
export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 5690),
  },
  vite: {
    build: {
      // The deployed CSP is `script-src 'self'`, which blocks inline scripts. Astro
      // inlines small bundled scripts unless the inline limit is 0.
      assetsInlineLimit: 0,
    },
  },
});
