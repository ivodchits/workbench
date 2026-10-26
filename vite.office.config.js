// The office page (office plan O0.1): `src/office/` → one self-contained page in
// `src-tauri/src/remote/office/dist/`, for the Rust core to embed and serve on loopback
// (O0.2). `npm run dev:office` serves it, and the art preview (`/preview.html`), with
// hot reload. Separate from `vite.config.ts`, like the phone's PWA.
//
// Plain JS, like vite.pwa.config.js.

import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { SINGLE_PAGE_BUILD, inlineIntoPage } from "./vite.singlePage.js";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: here("./src/office"),
  publicDir: false,
  plugins: [
    {
      name: "workbench-office-single-page",
      enforce: "post",
      generateBundle(_options, bundle) {
        inlineIntoPage(this, bundle);
      },
    },
  ],
  // Beside Workbench's own dev server (1430/1431).
  server: { port: 1432, strictPort: true },
  build: {
    ...SINGLE_PAGE_BUILD,
    outDir: here("./src-tauri/src/remote/office/dist"),
  },
});
