// Build of the phone's PWA (step R1): `src/pwa/` → one self-contained page plus its
// service worker, in `src-tauri/src/remote/pwa/dist/`, which the Rust remote server
// embeds (`include_str!`). Separate from `vite.config.ts` — the desktop frontend
// knows nothing of it, and no React goes in.
//
// Plain JS: the project has no Node types, and this file needs `fs` and `crypto`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** The static shell assets the server embeds as they are; hashed into the cache name. */
const STATIC_DIR = here("./src-tauri/src/remote/pwa/");
const STATIC = [
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  // The app shortcuts' (assistant plan R3).
  "icon-talk-96.png",
  "icon-chat-96.png",
  "icon-task-96.png",
  "icon-status-96.png",
];

/** Fold the script and stylesheet into `index.html`, and write `sw.js` with a cache
 *  name taken from the shell's content. */
function singlePage() {
  return {
    name: "workbench-pwa-single-page",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      let html = page.source.toString();
      for (const [name, file] of Object.entries(bundle)) {
        if (name === "index.html") continue;
        const ref = new RegExp(`<(script|link)[^>]*"/${name}"[^>]*>(</script>)?`);
        if (!ref.test(html)) this.error(`${name} is not referenced by index.html`);
        let inline;
        if (file.type === "chunk") {
          // The page's parser must not see the end of the script inside the script.
          const code = file.code.replace(/<\/script/gi, "<\/script").replace(/<!--/g, "<\!--");
          inline = `<script type="module">${code}</script>`;
        } else {
          const css = file.source.toString();
          if (/<\/style/i.test(css)) this.error(`${name} contains </style`);
          inline = `<style>${css}</style>`;
        }
        html = html.replace(ref, () => inline);
        delete bundle[name];
      }
      page.source = html;

      const hash = createHash("sha256").update(html);
      for (const name of STATIC) hash.update(readFileSync(STATIC_DIR + name));
      const cache = `wb-remote-${hash.digest("hex").slice(0, 12)}`;
      const worker = readFileSync(here("./src/pwa/sw.js"), "utf8");
      if (!worker.includes("__WB_CACHE__")) this.error("sw.js has no cache placeholder");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: worker.replace("__WB_CACHE__", cache),
      });
    },
  };
}

export default defineConfig({
  root: here("./src/pwa"),
  publicDir: false,
  plugins: [singlePage()],
  build: {
    outDir: here("./src-tauri/src/remote/pwa/dist"),
    emptyOutDir: true,
    // One script, one stylesheet, nothing fetched later.
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
