// Shared by the pages the Rust core embeds (the phone's PWA, the office): fold every
// script and stylesheet of the bundle into `index.html`, so the server serves one file.
//
// Plain JS, like the configs that use it.

/** Inlines the bundle's chunks and stylesheets into `index.html` and drops them from
 *  the bundle. `plugin` is the Rollup plugin context, for errors. Returns the page. */
export function inlineIntoPage(plugin, bundle) {
  const page = bundle["index.html"];
  let html = page.source.toString();
  for (const [name, file] of Object.entries(bundle)) {
    if (name === "index.html") continue;
    const ref = new RegExp(`<(script|link)[^>]*"/${name}"[^>]*>(</script>)?`);
    if (!ref.test(html)) plugin.error(`${name} is not referenced by index.html`);
    let inline;
    if (file.type === "chunk") {
      // The page's parser must not see the end of the script inside the script.
      const code = file.code.replace(/<\/script/gi, "<\/script").replace(/<!--/g, "<\!--");
      inline = `<script type="module">${code}</script>`;
    } else {
      const css = file.source.toString();
      if (/<\/style/i.test(css)) plugin.error(`${name} contains </style`);
      inline = `<style>${css}</style>`;
    }
    html = html.replace(ref, () => inline);
    delete bundle[name];
  }
  page.source = html;
  return html;
}

/** Build options for a single page: one script, one stylesheet, nothing fetched later. */
export const SINGLE_PAGE_BUILD = {
  emptyOutDir: true,
  cssCodeSplit: false,
  modulePreload: false,
  assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  rollupOptions: { output: { inlineDynamicImports: true } },
};
