import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Astro does not read this file. It configures the browser test that serves `dist`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
