// Media in the transcript (improvement plan Track S): a strip of thumbnails under the
// item that carried them, and a viewer that opens over the panel showing the
// transcript (not the whole window) when one is clicked.
//
// Framework-free, like the renderer, so the desktop console, the remote console and
// the phone all use the same one. Pictures come from the transcript itself (S1: a
// tool result's, a pasted one, as `data:` URLs); files a session showed with
// `show_media` (S2) are loaded by id from where the host serves them, so a thumbnail
// never names a path.

export type MediaKind = "image" | "video" | "audio" | "file";

export interface MediaRef {
  kind: MediaKind;
  /** What the element loads; empty for a file card. */
  src: string;
  /** Said under the item in the viewer, and as the thumbnail's tooltip. */
  label: string;
  /** A registered file's id (S2), for the host's actions. */
  id?: string;
  /** Its size in bytes, when known. */
  size?: number;
  /** Something to say about it: "file gone", "changed since it was shown". */
  note?: string;
  /** Gone since it was shown: a card with nothing to open. */
  gone?: boolean;
  /** Another machine's file too big to fetch without asking (S3): a card, and what
   *  it would be once fetched. */
  held?: MediaKind;
}

/** Pictures up to 20 MB and video or sound up to 50 MB are fetched from another
 *  machine without asking (S3, `media/fleet.rs`); anything else is a card. */
export const IMAGE_MAX = 20 * 1024 * 1024;
export const AV_MAX = 50 * 1024 * 1024;

export function fetchable(kind: MediaKind, size: number): boolean {
  return kind === "image" ? size <= IMAGE_MAX : kind === "video" || kind === "audio" ? size <= AV_MAX : false;
}

/** "picture", "video", "sound", "file". */
export function kindWord(kind: MediaKind): string {
  return kind === "image" ? "picture" : kind === "audio" ? "sound" : kind;
}

/** Another thing a file card offers: "fetch anyway". Its `run` may give the item
 *  as it is now (fetched), which the viewer then shows. */
export interface ExtraAction {
  label: string;
  title?: string;
  run(): MediaRef | void | Promise<MediaRef | void>;
}

/** What the host can do with a registered file, offered in the viewer. */
export interface ViewerActions {
  /** Open it in its default app. */
  open?(ref: MediaRef): void;
  /** What `open` is called: "open on laptop" for another machine's. */
  openLabel?: string;
  /** More a file card offers. */
  more?(ref: MediaRef): ExtraAction[];
  /** Show it in its folder. */
  reveal?(ref: MediaRef): void;
  /** Move it into a panel of its own. */
  popOut?(ref: MediaRef): void;
}

const THUMB = "wb-tx-thumb";
const refOf = new WeakMap<Element, MediaRef>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "12 KB", "1.2 GB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

const FILE_GLYPH: Record<MediaKind, string> = { image: "▣", video: "▶", audio: "♪", file: "▤" };

/** A file card's lines: its name, then its size and what's said about it. */
function cardLines(ref: MediaRef): HTMLElement[] {
  const facts = [ref.size !== undefined ? sizeWords(ref.size) : "", ref.note ?? ""].filter(Boolean).join(" · ");
  return [
    el("span", "wb-tx-file-name", `${FILE_GLYPH[ref.held ?? ref.kind]} ${ref.label}`),
    ...(facts ? [el("span", "wb-tx-file-facts", facts)] : []),
  ];
}

function thumb(ref: MediaRef): HTMLElement {
  // A sound's thumbnail holds a player, which can't sit inside a button.
  const node = ref.kind === "audio" && !ref.gone ? el("div", THUMB) : el("button", THUMB);
  if (node instanceof HTMLButtonElement) node.type = "button";
  else {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
  }
  node.title = ref.note ? `${ref.label} (${ref.note})` : ref.label;
  refOf.set(node, ref);
  if (ref.gone || ref.kind === "file") {
    node.classList.add("wb-tx-thumb-file");
    if (ref.gone) node.classList.add("wb-tx-thumb-gone");
    node.append(...cardLines(ref));
  } else if (ref.kind === "image") {
    const img = el("img", "wb-tx-image");
    img.src = ref.src;
    img.alt = ref.label;
    img.loading = "lazy";
    img.draggable = false;
    node.append(img);
  } else if (ref.kind === "video") {
    node.classList.add("wb-tx-thumb-video");
    const video = el("video", "wb-tx-image");
    // Its first frame, without playing or loading the whole file.
    video.preload = "metadata";
    video.muted = true;
    video.src = `${ref.src}#t=0.1`;
    node.append(video, el("span", "wb-tx-play", "▶"));
  } else {
    node.classList.add("wb-tx-thumb-audio");
    const audio = el("audio", "wb-tx-audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = ref.src;
    node.append(el("span", "wb-tx-file-name", `♪ ${ref.label}`), audio);
  }
  return node;
}

/** A row of thumbnails, scrolling sideways, with the caption; a click on one opens
 *  the viewer once the host has `attachMediaViewer`. */
export function mediaStrip(refs: readonly MediaRef[], caption?: string | null): HTMLElement {
  const strip = el("div", "wb-tx-media");
  const row = el("div", "wb-tx-media-row");
  row.append(...refs.map(thumb));
  strip.append(row);
  if (caption) strip.append(el("div", "wb-tx-media-caption", caption));
  return strip;
}

/** A strip waiting for what its files are (`count` grey boxes), replaced by
 *  `fill` once they're known. */
export function pendingStrip(count: number, caption?: string | null): { node: HTMLElement; fill(refs: MediaRef[]): void } {
  const node = el("div", "wb-tx-media");
  const row = el("div", "wb-tx-media-row");
  for (let i = 0; i < count; i++) row.append(el("span", "wb-tx-thumb wb-tx-thumb-pending", "…"));
  node.append(row);
  if (caption) node.append(el("div", "wb-tx-media-caption", caption));
  return {
    node,
    fill(refs) {
      node.replaceWith(mediaStrip(refs, caption));
    },
  };
}

/** Every thumbnail in `scope`, in order, as the viewer's list. */
function refsIn(scope: HTMLElement): { refs: MediaRef[]; thumbs: Element[] } {
  const thumbs = [...scope.querySelectorAll(`.${THUMB}`)].filter((t) => refOf.has(t));
  return { refs: thumbs.map((t) => refOf.get(t)!), thumbs };
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
  const b = el("button", "wb-media-btn", label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * Open the viewer over `host` (which must be positioned) at `list[index]`. A picture
 * fits the panel, with 1:1, zoom (wheel, pinch, the buttons) and pan (drag); a video
 * or sound has its controls; a file the host's actions. The arrow keys move through
 * the list, Esc closes. One viewer per host: opening another replaces it.
 */
export function openMediaViewer(
  host: HTMLElement,
  items: readonly MediaRef[],
  index: number,
  actions: ViewerActions = {},
): MediaViewer {
  // Its own copy: "fetch anyway" puts the fetched item in its place.
  const list = [...items];
  open.get(host)?.close();
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const root = el("div", "wb-media-viewer");
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "media viewer");
  const stage = el("div", "wb-media-stage");
  const counter = el("span", "wb-media-count");
  const label = el("span", "wb-media-label");
  const zoomButtons = el("span", "wb-media-zoom");
  const popOut = actions.popOut;
  const popButton = popOut ? button("pop out", "open it in a panel of its own", () => {
    const ref = list[at];
    viewer.close();
    popOut(ref);
  }) : null;

  let at = Math.max(0, Math.min(index, list.length - 1));
  let img: HTMLImageElement | null = null;
  let scale = 1;
  let x = 0;
  let y = 0;
  let fitted = true;

  const paint = () => {
    if (img) img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const size = () => ({
    w: stage.clientWidth,
    h: stage.clientHeight,
    nw: img?.naturalWidth || 1,
    nh: img?.naturalHeight || 1,
  });
  const centre = (s: number) => {
    const { w, h, nw, nh } = size();
    scale = s;
    x = (w - nw * s) / 2;
    y = (h - nh * s) / 2;
    paint();
  };
  const fit = () => {
    if (!img) return;
    const { w, h, nw, nh } = size();
    fitted = true;
    centre(Math.min(w / nw, h / nh, 1));
  };
  const actual = () => {
    if (!img) return;
    fitted = false;
    centre(1);
  };
  /** Zoom by `factor`, keeping the point (`cx`, `cy`) of the stage still. */
  const zoom = (factor: number, cx?: number, cy?: number) => {
    if (!img) return;
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

  /** A card for what can't be shown here, with what the host can do with it. */
  const fileCard = (ref: MediaRef, why?: string): HTMLElement => {
    const card = el("div", "wb-media-file");
    card.append(...cardLines(ref));
    if (why) card.append(el("span", "wb-tx-file-facts", why));
    if (!ref.gone) {
      const row = el("div", "wb-media-file-actions");
      if (actions.open)
        row.append(button(actions.openLabel ?? "open externally", "open it in its default app", () => actions.open!(ref)));
      if (actions.reveal) row.append(button("show in folder", "show it in its folder", () => actions.reveal!(ref)));
      for (const extra of actions.more?.(ref) ?? []) {
        row.append(
          button(extra.label, extra.title ?? extra.label, () => {
            const was = at;
            void Promise.resolve(extra.run()).then(
              (now) => {
                if (!now) return;
                list[was] = now;
                // Still on it, and still open: show it as it is now.
                if (at === was && open.get(host) === viewer) show(was);
              },
              () => {},
            );
          }),
        );
      }
      if (row.childElementCount) card.append(row);
    }
    return card;
  };

  const show = (i: number) => {
    for (const m of stage.querySelectorAll("video, audio")) (m as HTMLMediaElement).pause();
    at = (i + list.length) % list.length;
    const ref = list[at];
    counter.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    label.textContent = ref.note ? `${ref.label} · ${ref.note}` : ref.label;
    img = null;
    fitted = true;
    stage.classList.remove("wb-media-stage-pan");
    zoomButtons.hidden = true;
    if (popButton) popButton.hidden = !ref.id || ref.gone === true;
    if (ref.gone || ref.kind === "file") {
      stage.replaceChildren(fileCard(ref));
    } else if (ref.kind === "image") {
      const pic = el("img", "wb-media-img");
      pic.draggable = false;
      pic.alt = ref.label;
      img = pic;
      zoomButtons.hidden = false;
      stage.classList.add("wb-media-stage-pan");
      stage.replaceChildren(pic);
      pic.onload = fit;
      pic.src = ref.src;
      if (pic.complete && pic.naturalWidth) fit();
    } else {
      const media = ref.kind === "video" ? el("video", "wb-media-video") : el("audio", "wb-media-audio");
      media.controls = true;
      media.autoplay = true;
      media.src = ref.src;
      // A video this webview can't play (a mov that isn't H.264, say): the card.
      media.onerror = () => stage.replaceChildren(fileCard(ref, "can't play here"));
      const box = el("div", ref.kind === "video" ? "wb-media-play" : "wb-media-play wb-media-play-audio");
      if (ref.kind === "audio") box.append(el("span", "wb-tx-file-name", `♪ ${ref.label}`));
      box.append(media);
      stage.replaceChildren(box);
    }
  };

  const bar = el("div", "wb-media-bar");
  const many = list.length > 1;
  zoomButtons.append(
    button("fit", "fit to the panel (0)", fit),
    button("1:1", "actual size (1)", actual),
    button("−", "zoom out (-)", () => zoom(1 / 1.25)),
    button("+", "zoom in (+)", () => zoom(1.25)),
  );
  bar.append(
    ...(many ? [button("‹", "previous (←)", () => show(at - 1))] : []),
    counter,
    ...(many ? [button("›", "next (→)", () => show(at + 1))] : []),
    label,
    zoomButtons,
    ...(popButton ? [popButton] : []),
    button("✕", "close (Esc)", () => viewer.close()),
  );
  root.append(bar, stage);

  // Wheel zooms a picture where the pointer is.
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!img) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  // One pointer pans a picture; two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: number | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (!img) return;
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
    // The arrows seek a focused player rather than move on.
    const inPlayer = e.target instanceof HTMLMediaElement;
    if (k === "Escape") viewer.close();
    else if (k === "ArrowLeft" && many && !inPlayer) show(at - 1);
    else if (k === "ArrowRight" && many && !inPlayer) show(at + 1);
    else if (img && (k === "+" || k === "=")) zoom(1.25);
    else if (img && k === "-") zoom(1 / 1.25);
    else if (img && k === "0") fit();
    else if (img && k === "1") actual();
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
      for (const m of stage.querySelectorAll("video, audio")) (m as HTMLMediaElement).pause();
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

/** Open the viewer over `host` when a thumbnail inside `scope` is clicked (or
 *  Enter'd), on every thumbnail in `scope` (the session's media, in order). Returns
 *  the undo. */
export function attachMediaViewer(scope: HTMLElement, host: HTMLElement, actions: ViewerActions = {}): () => void {
  const openAt = (e: Event, target: EventTarget | null) => {
    const t = target instanceof Element ? target.closest(`.${THUMB}`) : null;
    if (!t || !scope.contains(t) || !refOf.has(t)) return;
    e.preventDefault();
    e.stopPropagation();
    const { refs, thumbs } = refsIn(scope);
    openMediaViewer(host, refs, thumbs.indexOf(t), actions);
  };
  const onClick = (e: MouseEvent) => {
    // A sound's own player plays it where it is.
    if (e.target instanceof Element && e.target.closest("audio")) return;
    openAt(e, e.target);
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLElement && e.target.classList.contains(THUMB))
      openAt(e, e.target);
  };
  scope.addEventListener("click", onClick);
  scope.addEventListener("keydown", onKey);
  return () => {
    scope.removeEventListener("click", onClick);
    scope.removeEventListener("keydown", onKey);
    open.get(host)?.close();
  };
}
