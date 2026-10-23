// The desktop's sketch pad (step G5): one sketch, shared by the drawer's view and
// a dock tab, its background picture, and the sketches sent lately (their strokes,
// to open again, in this webview's storage). An external store in the house pattern.
//
// Sending flattens it to a PNG and stages it like any file (`staging.stageMade`):
// while you talk it goes with what you say (G2), else it waits in the composer for
// your words. With "live" on, the pad goes with each voice turn when it changed
// since it last went.

import { useSyncExternalStore } from "react";

import { emptyDoc, parseSketch, Sketch, sketchName, type Background, type SketchDoc } from "../../sketch/model";
import { sketchPng } from "../../sketch/render";
import { getStaging, stageMade } from "./staging";

/** A sketch sent lately: its PNG's name and thumbnail; its strokes are kept in
 *  this webview's storage under `wb-sketch:<name>`. */
export interface SentSketch {
  name: string;
  at: number;
  thumb?: string;
}

interface SketchState {
  open: boolean;
  live: boolean;
  /** The background picture's URL (a data or blob URL), when it has one. */
  image: string | null;
  sending: boolean;
  error: string | null;
  recent: SentSketch[];
}

const RECENT = 12;
const RECENT_KEY = "wb-sketches";

export const sketch = new Sketch();
let state: SketchState = { open: false, live: false, image: null, sending: false, error: null, recent: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<SketchState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
export const getSketchState = () => state;
export const useSketchState = () => useSyncExternalStore(subscribe, getSketchState);

let loaded = false;
function loadRecent(): void {
  if (loaded) return;
  loaded = true;
  let r: unknown = [];
  try {
    r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    r = [];
  }
  set({ recent: Array.isArray(r) ? (r as SentSketch[]) : [] });
}

/** Open the pad, on a new background when given (a drawing to mark up, say). */
export function openSketch(bg?: { background: Background; image: string | null; size?: { width: number; height: number } }): void {
  loadRecent();
  if (bg) {
    sketch.load(emptyDoc(bg.background, bg.size));
    sketch.dirty = false;
    set({ image: bg.image });
  }
  set({ open: true, error: null });
}

export const closeSketch = () => set({ open: false });
export const setLive = (live: boolean) => set({ live });

/** A new background for the sketch as it is: the marks stay. */
export function setBackground(background: Background, image: string | null, size?: { width: number; height: number }): void {
  sketch.setBackground(background, size);
  set({ image });
}

/** Load an image URL; resolves to the element once it's decoded. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

const strokesKey = (name: string) => `wb-sketch:${name}`;

/** Send the pad to Duck: its PNG staged (the voice turn's while you talk), its
 *  strokes kept to open again. */
export async function sendSketch(image: CanvasImageSource | null): Promise<void> {
  if (state.sending) return;
  const doc = sketch.doc;
  set({ sending: true, error: null });
  try {
    const name = sketchName(doc.background);
    const png = await sketchPng(doc, image);
    if (!png) throw new Error("the sketch couldn't be made into a picture");
    sketch.sent();
    await stageMade(`${name}.png`, png);
    try {
      localStorage.setItem(strokesKey(name), JSON.stringify(doc));
    } catch {
      // Storage full or off: it was sent, it just can't be opened again.
    }
    const thumb = getStaging().files.find((f) => f.name === `${name}.png`)?.thumb;
    const recent = [{ name, at: Date.now(), ...(thumb && { thumb }) }, ...state.recent].slice(0, RECENT);
    for (const old of state.recent.slice(RECENT - 1))
      try {
        localStorage.removeItem(strokesKey(old.name));
      } catch {
        // Nothing to tidy.
      }
    set({ recent });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // Not kept: it was still sent.
    }
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    set({ sending: false });
  }
}

/** Open a sketch sent earlier, from its kept strokes. */
export function reopenSketch(s: SentSketch): void {
  try {
    let json: string | null = null;
    try {
      json = localStorage.getItem(strokesKey(s.name));
    } catch {
      json = null;
    }
    const doc = json ? parseSketch(json) : null;
    if (!doc) throw new Error("its strokes couldn't be read");
    // A picture background isn't kept with the strokes: it opens on white.
    const usable: SketchDoc = doc.background.kind === "image" ? { ...doc, background: { kind: "blank" } } : doc;
    sketch.load(usable);
    set({ image: null, open: true, error: doc.background.kind === "image" ? "its picture wasn't kept: it opens on white" : null });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}
