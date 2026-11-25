// Media in the transcript (improvement plan Track S): a strip of thumbnails under the
// item that carried them, and a viewer that opens over the panel showing the
// transcript (not the whole window) when one is clicked.
//
// Framework-free, like the renderer, so the desktop console, the remote console and
// the phone all use the same one. S1 has pictures only (a tool result's, a pasted
// one); S2 adds video, sound and files shown with `show_media`.
//
// A thumbnail's `src` is only ever a `data:` URL built from a type the model checked
// against an allow-list, so nothing here loads from the network.

export interface MediaRef {
  kind: "image";
  /** What the `<img>` loads. */
  src: string;
  /** Said under the picture in the viewer, and as the thumbnail's tooltip. */
  label: string;
}

const THUMB = "wb-tx-thumb";

/** A row of thumbnails, scrolling sideways; a click on one opens the viewer once the
 *  host has `attachMediaViewer`. */
export function mediaStrip(refs: readonly MediaRef[], caption?: string): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "wb-tx-media";
  const row = document.createElement("div");
  row.className = "wb-tx-media-row";
  for (const ref of refs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = THUMB;
    button.title = ref.label;
    const img = document.createElement("img");
    img.className = "wb-tx-image";
    img.src = ref.src;
    img.alt = ref.label;
    img.loading = "lazy";
    img.draggable = false;
    button.append(img);
    row.append(button);
  }
  strip.append(row);
  if (caption) {
    const c = document.createElement("div");
    c.className = "wb-tx-media-caption";
    c.textContent = caption;
    strip.append(c);
  }
  return strip;
}

/** Every thumbnail in `scope`, in order, as the viewer's list. */
function refsIn(scope: HTMLElement): { refs: MediaRef[]; buttons: HTMLElement[] } {
  const buttons = [...scope.querySelectorAll<HTMLElement>(`.${THUMB}`)];
  const refs = buttons.map((b): MediaRef => {
    const img = b.querySelector("img");
    return { kind: "image", src: img?.getAttribute("src") ?? "", label: b.title };
  });
  return { refs, buttons };
}

export interface MediaViewer {
  close(): void;
  /** Which item it shows, by position in its list. */
  readonly index: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

const open = new WeakMap<HTMLElement, MediaViewer>();

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "wb-media-btn";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * Open the viewer over `host` (which must be positioned) at `list[index]`: the
 * picture fits the panel, with 1:1, zoom (wheel, pinch, the buttons) and pan (drag).
 * The arrow keys move through the list, Esc closes. One viewer per host: opening
 * another replaces it.
 */
export function openMediaViewer(host: HTMLElement, list: readonly MediaRef[], index: number): MediaViewer {
  open.get(host)?.close();
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const root = document.createElement("div");
  root.className = "wb-media-viewer";
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "media viewer");

  const stage = document.createElement("div");
  stage.className = "wb-media-stage";
  const img = document.createElement("img");
  img.className = "wb-media-img";
  img.draggable = false;
  stage.append(img);

  const counter = document.createElement("span");
  counter.className = "wb-media-count";
  const label = document.createElement("span");
  label.className = "wb-media-label";

  let at = Math.max(0, Math.min(index, list.length - 1));
  let scale = 1;
  let x = 0;
  let y = 0;
  let fitted = true;

  const paint = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const size = () => ({ w: stage.clientWidth, h: stage.clientHeight, nw: img.naturalWidth || 1, nh: img.naturalHeight || 1 });
  const centre = (s: number) => {
    const { w, h, nw, nh } = size();
    scale = s;
    x = (w - nw * s) / 2;
    y = (h - nh * s) / 2;
    paint();
  };
  const fit = () => {
    const { w, h, nw, nh } = size();
    fitted = true;
    centre(Math.min(w / nw, h / nh, 1));
  };
  const actual = () => {
    fitted = false;
    centre(1);
  };
  /** Zoom by `factor`, keeping the point (`cx`, `cy`) of the stage still. */
  const zoom = (factor: number, cx?: number, cy?: number) => {
    const { w, h } = size();
    const px = cx ?? w / 2;
    const py = cy ?? h / 2;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    x = px - (px - x) * (next / scale);
    y = py - (py - y) * (next / scale);
    scale = next;
    fitted = false;
    paint();
  };

  const show = (i: number) => {
    at = (i + list.length) % list.length;
    const ref = list[at];
    counter.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    label.textContent = ref.label;
    img.alt = ref.label;
    fitted = true;
    img.onload = fit;
    img.src = ref.src;
    if (img.complete && img.naturalWidth) fit();
  };

  const bar = document.createElement("div");
  bar.className = "wb-media-bar";
  const many = list.length > 1;
  bar.append(
    ...(many ? [button("‹", "previous (←)", () => show(at - 1))] : []),
    counter,
    ...(many ? [button("›", "next (→)", () => show(at + 1))] : []),
    label,
    button("fit", "fit to the panel (0)", fit),
    button("1:1", "actual size (1)", actual),
    button("−", "zoom out (-)", () => zoom(1 / 1.25)),
    button("+", "zoom in (+)", () => zoom(1.25)),
    button("✕", "close (Esc)", () => viewer.close()),
  );
  root.append(bar, stage);

  // Wheel zooms where the pointer is.
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  // One pointer pans; two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: number | null = null;
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch = null;
  });
  stage.addEventListener("pointermove", (e) => {
    const was = pointers.get(e.pointerId);
    if (!was) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      x += now.x - was.x;
      y += now.y - was.y;
      fitted = false;
      paint();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = stage.getBoundingClientRect();
      if (pinch) zoom(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      pinch = d;
    }
  });
  const lift = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = null;
  };
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);
  stage.addEventListener("dblclick", () => (fitted ? actual() : fit()));

  root.addEventListener("keydown", (e) => {
    // Nothing typed here reaches the transcript's own keys (or the composer).
    e.stopPropagation();
    const k = e.key;
    if (k === "Escape") viewer.close();
    else if (k === "ArrowLeft" && many) show(at - 1);
    else if (k === "ArrowRight" && many) show(at + 1);
    else if (k === "+" || k === "=") zoom(1.25);
    else if (k === "-") zoom(1 / 1.25);
    else if (k === "0") fit();
    else if (k === "1") actual();
    else return;
    e.preventDefault();
  });
  // Clicks stay in the viewer: the transcript under it doesn't see them.
  root.addEventListener("click", (e) => e.stopPropagation());

  const resized =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (fitted) fit();
        });
  resized?.observe(stage);

  const viewer: MediaViewer = {
    close() {
      if (open.get(host) !== viewer) return;
      open.delete(host);
      resized?.disconnect();
      root.remove();
      if (back?.isConnected) back.focus({ preventScroll: true });
    },
    get index() {
      return at;
    },
  };
  open.set(host, viewer);
  host.append(root);
  show(at);
  root.focus({ preventScroll: true });
  return viewer;
}

/** Open the viewer over `host` when a thumbnail inside `scope` is clicked, on every
 *  thumbnail in `scope` (the session's media, in order). Returns the undo. */
export function attachMediaViewer(scope: HTMLElement, host: HTMLElement): () => void {
  const onClick = (e: MouseEvent) => {
    const thumb = e.target instanceof Element ? e.target.closest<HTMLElement>(`.${THUMB}`) : null;
    if (!thumb || !scope.contains(thumb)) return;
    e.preventDefault();
    e.stopPropagation();
    const { refs, buttons } = refsIn(scope);
    openMediaViewer(host, refs, buttons.indexOf(thumb));
  };
  scope.addEventListener("click", onClick);
  return () => {
    scope.removeEventListener("click", onClick);
    open.get(host)?.close();
  };
}
