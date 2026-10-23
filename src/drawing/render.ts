// Rendering a drawing for display (step G3): source → SVG → PNG.
//
// What a worker writes is untrusted, so none of it ever runs in the app's page:
// - Mermaid and Vega render inside a sandboxed iframe (`sandbox="allow-scripts"`,
//   no same origin, a CSP with no network). The renderers' code is handed to it as
//   text the first time a kind needs it (lazy chunks, so idle cost is nothing), and
//   only the SVG string comes back.
// - Every SVG, a worker's own or a renderer's, is shown as an `<img>` from a data
//   URL, which runs no script and loads nothing; the PNG is that image drawn on a
//   canvas. An SVG that taints the canvas (a `foreignObject`) gets no PNG.

import { isVegaLite, sized, svgSize, svgUrl, type DrawingKind } from "./kinds";

/** How long one render may take. */
const RENDER_MS = 15_000;
/** The PNG's longest side at most, and how much bigger than the SVG it's drawn. */
const PNG_MAX_SIDE = 2400;
const PNG_SCALE = 2;

// The sandbox's own page: it runs the renderers on what the app posts it.
const BOOT = `
addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  const m = e.data || {};
  const answer = (x) => parent.postMessage(Object.assign({ id: m.id }, x), "*");
  try {
    if (m.type === "load") {
      // A classic script, not eval: the bundles' top-level vars must be globals
      // (Mermaid's is strict code, whose vars eval would keep to itself).
      let failed = null;
      const onError = (ev) => { failed = ev.message; };
      addEventListener("error", onError);
      const s = document.createElement("script");
      s.textContent = m.code;
      document.head.append(s);
      removeEventListener("error", onError);
      answer(failed ? { error: String(failed) } : { ok: true });
      return;
    }
    if (m.type !== "render") return;
    if (m.kind === "mermaid") {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", htmlLabels: false,
        flowchart: { htmlLabels: false }, fontFamily: "Segoe UI, Arial, sans-serif" });
      const r = await mermaid.render("d" + m.id, m.source);
      answer({ svg: r.svg });
    } else {
      let spec = JSON.parse(m.source);
      if (m.lite) spec = vegaLite.compile(spec).spec;
      const view = new vega.View(vega.parse(spec), { renderer: "none" });
      const svg = await view.toSVG();
      view.finalize();
      answer({ svg });
    }
  } catch (err) {
    answer({ error: String((err && err.message) || err).slice(0, 500) });
  }
});
`;

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:";

let frame: Promise<HTMLIFrameElement> | null = null;
const loaded = new Map<string, Promise<void>>();
const waiting = new Map<string, { ok: (v: Record<string, unknown>) => void }>();
let seq = 0;

function sandbox(): Promise<HTMLIFrameElement> {
  frame ??= new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    // Laid out (Mermaid measures its text) but out of sight.
    Object.assign(f.style, { position: "fixed", left: "-10000px", top: "0", width: "1200px", height: "900px", border: "0", visibility: "hidden" });
    f.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><body><script>${BOOT}</script></body>`;
    window.addEventListener("message", (e) => {
      if (e.source !== f.contentWindow) return;
      const d = e.data as { id?: string } | null;
      const w = d?.id ? waiting.get(d.id) : undefined;
      if (w && d?.id) {
        waiting.delete(d.id);
        w.ok(d as Record<string, unknown>);
      }
    });
    f.addEventListener("load", () => resolve(f), { once: true });
    document.body.append(f);
  });
  return frame;
}

async function ask(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const f = await sandbox();
  const id = `r${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("the drawing took too long to render"));
    }, RENDER_MS);
    waiting.set(id, {
      ok: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
    });
    f.contentWindow?.postMessage({ ...msg, id }, "*");
  });
}

/** The renderers' code, as text, loaded into the sandbox once each. */
function load(name: "mermaid" | "vega" | "vega-lite"): Promise<void> {
  let p = loaded.get(name);
  if (!p) {
    p = (async () => {
      const code =
        name === "mermaid"
          ? (await import("mermaid/dist/mermaid.min.js?raw")).default
          : name === "vega"
            ? (await import("../../node_modules/vega/build/vega.min.js?raw")).default
            : (await import("../../node_modules/vega-lite/build/vega-lite.min.js?raw")).default;
      const r = await ask({ type: "load", code });
      if (r.error) throw new Error(String(r.error));
    })();
    p.catch(() => loaded.delete(name));
    loaded.set(name, p);
  }
  return p;
}

/** A drawing's source as an SVG with its size set. Throws with the renderer's
 *  error (a Mermaid parse error, say). */
export async function renderSvg(kind: DrawingKind, source: string): Promise<string> {
  if (kind === "svg") {
    if (!svgSize(source)) throw new Error("the SVG has no viewBox or size, or doesn't parse");
    return sized(source);
  }
  let lite = false;
  if (kind === "vega") {
    lite = isVegaLite(JSON.parse(source));
    await load("vega");
    if (lite) await load("vega-lite");
  } else await load("mermaid");
  const r = await ask({ type: "render", kind, source, lite });
  if (typeof r.svg !== "string") throw new Error(String(r.error ?? "it didn't render"));
  return sized(r.svg);
}

/** The SVG drawn on white as a PNG, `width` px wide (else twice its size), up to
 *  `PNG_MAX_SIDE`; null when the browser won't (a tainted canvas). */
export async function toPng(svg: string, width?: number): Promise<Blob | null> {
  const size = svgSize(svg);
  if (!size) return null;
  const img = new Image();
  img.src = svgUrl(svg);
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scale = Math.min(width ? width / size.width : PNG_SCALE, PNG_MAX_SIDE / Math.max(size.width, size.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  } catch {
    return null;
  }
}
