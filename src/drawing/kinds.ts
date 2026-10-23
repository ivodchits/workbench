// Drawing kinds (step G3): what a worker can write, and the plain helpers the
// renderer and the canvas share. Nothing here touches the DOM's live document:
// model-written markup is only ever parsed (DOMParser runs no script), never put
// into the app's page.

/** A drawing's kind, as Duck and the worker name it. */
export const DRAWING_KINDS = ["mermaid", "svg", "vega"] as const;
export type DrawingKind = (typeof DRAWING_KINDS)[number];
/** A drawing's kind, or `image` (step G6): a picture from the image model, with no
 *  source to render. */
export type AnyKind = DrawingKind | "image";

/** The source file's extension for each kind. */
export const EXT: Record<DrawingKind, "mmd" | "svg" | "json"> = { mermaid: "mmd", svg: "svg", vega: "json" };

export function kindOf(ext: string): DrawingKind | null {
  return (Object.keys(EXT) as DrawingKind[]).find((k) => EXT[k] === ext) ?? null;
}

/** A Vega-Lite spec rather than a full Vega one: its `$schema` says so, or it has
 *  a `mark` or a composition and no `marks`. */
export function isVegaLite(spec: unknown): boolean {
  if (!spec || typeof spec !== "object") return false;
  const s = spec as Record<string, unknown>;
  if (typeof s.$schema === "string") return s.$schema.includes("vega-lite");
  if ("marks" in s) return false;
  return ["mark", "layer", "facet", "repeat", "concat", "hconcat", "vconcat"].some((k) => k in s);
}

/** The width and height an SVG draws at: its `width` / `height` in px, else its
 *  `viewBox`; null when neither says. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const root = parseSvg(svg);
  if (!root) return null;
  const px = (v: string | null) => (v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? parseFloat(v) : null);
  const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const vb = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null;
  const w = px(root.getAttribute("width"));
  const h = px(root.getAttribute("height"));
  if (w && h) return { width: w, height: h };
  if (vb && w) return { width: w, height: (w * vb.height) / vb.width };
  if (vb && h) return { width: (h * vb.width) / vb.height, height: h };
  return vb;
}

/** The SVG with its size written as `width` / `height` in px (an `<img>` and a
 *  canvas need one; Mermaid's says `width="100%"`); as it was when it has none. */
export function sized(svg: string): string {
  const size = svgSize(svg);
  const root = parseSvg(svg);
  if (!size || !root) return svg;
  root.setAttribute("width", String(Math.round(size.width)));
  root.setAttribute("height", String(Math.round(size.height)));
  // Mermaid caps it with `max-width` in a style; the size is the cap.
  const style = (root.getAttribute("style") ?? "").replace(/max-width\s*:[^;]*;?/i, "").trim();
  if (style) root.setAttribute("style", style);
  else root.removeAttribute("style");
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

function parseSvg(svg: string): Element | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  return root && root.nodeName.toLowerCase() === "svg" && !doc.querySelector("parsererror") ? root : null;
}

/** An image (G6) as an SVG the canvas shows like any drawing: the picture, inline. */
export const imageSvg = (dataUrl: string, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="${dataUrl}" xlink:href="${dataUrl}"/></svg>`;

/** An SVG as an `<img>` source. Shown that way it runs no script and loads nothing. */
export const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The source text from a reply or a `result.md`: the first fenced block in the
 *  kind's language (```mermaid, ```svg / ```xml, ```json), else null. For the API
 *  worker, which hands the drawing in its result. */
export function fencedSource(text: string, kind: DrawingKind): string | null {
  const langs = kind === "mermaid" ? ["mermaid", "mmd"] : kind === "svg" ? ["svg", "xml", "html"] : ["json", "vega", "vega-lite"];
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(re)) if (langs.includes(m[1].toLowerCase()) && m[2].trim()) return m[2].trim();
  return null;
}
