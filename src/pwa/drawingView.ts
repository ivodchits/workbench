// A drawing on the phone (step G3): full screen, with pinch zoom and pan, and the
// versions to step through. A picture from the thread (a worker's output) opens in
// the same viewer. The PNG is the desktop's render, fetched from
// `GET /api/assistant/image/{id}/{name}` with the device token; nothing Duck's
// worker wrote runs here.

import type { DrawingView } from "../assistant/protocol";
import { el } from "./dom";
import { authHeader } from "./net";

type Png = NonNullable<DrawingView["versions"][number]["png"]>;

let overlay: HTMLElement | null = null;
let shown: { id: string; n: number } | null = null;
let onClose: (() => void) | null = null;
const urls = new Map<string, Promise<string>>();

/** A PNG as an object URL, fetched once. */
function pngUrl(p: Png): Promise<string> {
  const key = `${p.id}/${p.name}`;
  let u = urls.get(key);
  if (!u) {
    u = fetch(`/api/assistant/image/${encodeURIComponent(p.id)}/${encodeURIComponent(p.name)}`, { headers: authHeader() }).then(async (r) => {
      if (!r.ok) throw new Error(`the picture didn't load (${r.status})`);
      return URL.createObjectURL(await r.blob());
    });
    u.catch(() => urls.delete(key));
    urls.set(key, u);
  }
  return u;
}

/** The drawing shown now, if any. */
export const shownDrawing = () => shown;

export function closeDrawing(): void {
  overlay?.remove();
  overlay = null;
  shown = null;
  const cb = onClose;
  onClose = null;
  cb?.();
}

/** Show version `n` of `d` (its newest when null), full screen. `close` runs when
 *  the viewer closes; `markUp` (G5) opens the sketch pad on the picture. */
export function showDrawing(
  d: DrawingView,
  n: number | null,
  close: () => void,
  markUp?: (url: string, size: { width: number; height: number }, name: string) => void,
): void {
  const version = d.versions.find((v) => v.n === n) ?? d.versions[d.versions.length - 1];
  if (!version) return;
  overlay?.remove();
  shown = { id: d.id, n: version.n };
  onClose = close;
  const root = el("div", "duck-drawing");
  const bar = el("div", "bar");
  const title = el("span", "title", d.title);
  title.title = version.headline;
  bar.append(title);
  for (const v of d.versions) {
    const b = el("button", v.n === version.n ? "on" : "", `v${v.n}`);
    b.type = "button";
    b.onclick = () => showDrawing(d, v.n, close);
    bar.append(b);
  }
  if (d.pending) bar.append(el("span", "pending", d.pending.waiting ? `v${d.pending.n} waits` : `drawing v${d.pending.n}…`));
  const mark = el("button", "", "mark up");
  mark.type = "button";
  mark.disabled = true;
  if (markUp) bar.append(mark);
  const x = el("button", "close", "×");
  x.type = "button";
  x.setAttribute("aria-label", "close");
  x.onclick = closeDrawing;
  bar.append(x);

  const stage = el("div", "stage");
  const img = el("img");
  img.alt = version.headline || d.title;
  img.draggable = false;
  stage.append(img);
  const note = el("div", "note", version.png ? "loading…" : "no picture for this version");
  stage.append(note);
  root.append(bar, stage);
  document.body.append(root);
  overlay = root;
  const fit = zoomable(stage, img);

  if (version.png)
    pngUrl(version.png).then(
      (u) => {
        img.onload = () => {
          note.remove();
          fit();
          mark.disabled = false;
          mark.onclick = () => {
            closeDrawing();
            markUp?.(u, { width: img.naturalWidth, height: img.naturalHeight }, `drawing ${d.id} v${version.n} ${d.title}`);
          };
        };
        img.src = u;
      },
      (e: unknown) => (note.textContent = e instanceof Error ? e.message : String(e)),
    );
}

/** Pinch, pan and double-tap-to-fit for `img` in `stage`; returns the fit. */
function zoomable(stage: HTMLElement, img: HTMLImageElement): () => void {
  // Pinch and pan: the pointers down now, and the view they started from.
  let view = { x: 0, y: 0, k: 1 };
  const apply = () => (img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`);
  const fit = () => {
    const b = stage.getBoundingClientRect();
    const k = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
    view = { k, x: (b.width - img.naturalWidth * k) / 2, y: (b.height - img.naturalHeight * k) / 2 };
    apply();
  };
  const down = new Map<number, { x: number; y: number }>();
  let start: { view: typeof view; pts: { x: number; y: number }[] } | null = null;
  const begin = () => (start = { view: { ...view }, pts: [...down.values()].map((p) => ({ ...p })) });
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!down.has(e.pointerId) || !start) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = [...down.values()];
    const b = stage.getBoundingClientRect();
    if (now.length >= 2 && start.pts.length >= 2) {
      const mid = (p: { x: number; y: number }[]) => ({ x: (p[0].x + p[1].x) / 2 - b.left, y: (p[0].y + p[1].y) / 2 - b.top });
      const dist = (p: { x: number; y: number }[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
      const k = Math.min(10, Math.max(0.1, (start.view.k * dist(now)) / dist(start.pts)));
      const m0 = mid(start.pts);
      const m1 = mid(now);
      view = { k, x: m1.x - ((m0.x - start.view.x) * k) / start.view.k, y: m1.y - ((m0.y - start.view.y) * k) / start.view.k };
    } else if (now.length === 1) {
      view = { ...start.view, x: start.view.x + now[0].x - start.pts[0].x, y: start.view.y + now[0].y - start.pts[0].y };
    }
    apply();
  });
  const up = (e: PointerEvent) => {
    down.delete(e.pointerId);
    begin();
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("dblclick", fit);  return fit;
}

/** A picture from the thread (a worker's output, G1), full screen with the same
 *  pinch and pan; `save` offers it as a download. */
export function showPicture(name: string, url: Promise<string>, save: () => void): void {
  closeDrawing();
  const root = el("div", "duck-drawing");
  const bar = el("div", "bar");
  const title = el("span", "title", name);
  title.title = name;
  const keep = el("button", "", "save");
  keep.type = "button";
  keep.onclick = save;
  const x = el("button", "close", "×");
  x.type = "button";
  x.setAttribute("aria-label", "close");
  x.onclick = closeDrawing;
  bar.append(title, keep, x);
  const stage = el("div", "stage");
  const img = el("img");
  img.alt = name;
  img.draggable = false;
  const note = el("div", "note", "loading…");
  stage.append(img, note);
  root.append(bar, stage);
  document.body.append(root);
  overlay = root;
  const fit = zoomable(stage, img);
  url.then(
    (u) => {
      img.onload = () => {
        note.remove();
        fit();
      };
      img.src = u;
    },
    (e: unknown) => (note.textContent = e instanceof Error ? e.message : String(e)),
  );
}
