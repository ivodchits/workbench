// The APK's own page (`web/loader.ts`) → `www/`, the app's `frontendDist`. Run by
// the workbench repo's `npm run build:duck-android` (the Tauri CLI's
// `beforeBuildCommand`).

import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: here("./web"),
  base: "./",
  publicDir: false,
  build: {
    outDir: here("./www"),
    emptyOutDir: true,
    // The phone brain (H7) brings the engine and the SDK: one file in the APK,
    // never fetched, so its size doesn't matter.
    chunkSizeWarningLimit: 1000,
  },
});
