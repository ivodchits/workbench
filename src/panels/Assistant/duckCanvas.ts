// The ASCII duck drawn on a canvas: the frame loop behind the drawer's
// `DuckAvatar` and the phone's Duck view (step R2). Framework-free, so the PWA can
// use it without React.
//
// The duck is duck-yellow or in the canvas's text color (`duck3d.ts` does the 3D).
// It spins while Duck thinks or runs a tool, works its beak while it talks, and
// tilts its head while it waits for you. With a `level` (the loudness of what's
// playing, 0..1) the beak opens on the syllables actually heard; otherwise it
// follows a stand-in rhythm.

import type { DuckAvatarPrefs } from "../../ipc/prefs";
import { Animator, MAT_BEAK, MAT_EYE, render, type DuckMode, type Frame } from "./duck3d";

export type DuckLook = Pick<DuckAvatarPrefs, "ink" | "chars" | "cols" | "fps">;

/** What the duck shows now, read every frame. */
export interface DuckLive {
  mode: DuckMode;
  look: DuckLook;
  /** The speech loudness now (0..1); absent: the stand-in rhythm. */
  level?: () => number;
}

const RAMPS: Record<DuckLook["chars"], string> = {
  classic: " .:-=+*#%@",
  blocks: " ░▒▓█",
};

type Rgb = [number, number, number];

const BODY: Rgb = [255, 216, 74];
const BEAK: Rgb = [255, 140, 40];
const EYE = "#3a3f48";
const GLINT = "#ebf0f5";
const LINE_HEIGHT = 1.15;

/** Animate the duck on `canvas` until the returned stop is called. The canvas's
 *  CSS font family and color are its characters' font and the mono ink. */
export function startDuckCanvas(canvas: HTMLCanvasElement, live: () => DuckLive): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const animator = new Animator();
  const colors = new Map<string, string>();
  /** The text color, for the mono ink; re-read now and then so a theme switch
   *  reaches it. */
  let text: Rgb = [215, 219, 224];
  let textReadAt = -1;
  let frame: Frame | undefined;
  let geo: { w: number; h: number; cw: number; lh: number; font: string; cols: number; rows: number } | null = null;

  const layout = () => {
    const { width: w, height: h } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cols = live().look.cols;
    const family = getComputedStyle(canvas).fontFamily;
    ctx.font = `100px ${family}`;
    const advance = ctx.measureText("M").width / 100 || 0.6;
    const cw = w / cols;
    const size = cw / advance;
    const lh = size * LINE_HEIGHT;
    geo = { w, h, cw, lh, font: `${size}px ${family}`, cols, rows: Math.max(6, Math.floor(h / lh)) };
  };
  const observer = new ResizeObserver(layout);
  observer.observe(canvas);
  layout();

  const color = (ink: DuckLook["ink"], m: number, level: number) => {
    const key = `${ink}/${m}/${level}`;
    let c = colors.get(key);
    if (!c) {
      const rgb = ink === "mono" ? text : m === MAT_BEAK ? BEAK : BODY;
      const f = 0.35 + 0.65 * level;
      c = `rgb(${(rgb[0] * f) | 0},${(rgb[1] * f) | 0},${(rgb[2] * f) | 0})`;
      colors.set(key, c);
    }
    return c;
  };

  const start = performance.now();
  let last = 0;
  let due = 0;
  let raf = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const t = (now - start) / 1000;
    const { mode, look, level } = live();
    if (t < due) return;
    if (t - textReadAt > 1) {
      textReadAt = t;
      const rgb = getComputedStyle(canvas).color.match(/\d+/g)?.slice(0, 3).map(Number);
      if (rgb?.length === 3 && rgb.join() !== text.join()) {
        text = rgb as Rgb;
        colors.clear();
      }
    }
    due = t + 1 / look.fps;
    animator.step(t, Math.min(0.1, t - last), mode, level?.());
    last = t;
    if (!geo || geo.cols !== look.cols) layout();
    if (!geo || geo.w === 0) return;
    const { w, h, cw, lh, cols, rows, font } = geo;
    frame = render(animator.pose, cols, rows, cw / lh, frame);
    const ramp = RAMPS[look.chars];
    const top = (h - rows * lh) / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.textBaseline = "top";
    let fill = "";
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const l = frame.lum[k];
        if (l < 0) continue;
        const m = frame.mat[k];
        const step = Math.min(ramp.length - 1, 1 + Math.floor(l * (ramp.length - 1)));
        const c =
          m === MAT_EYE && look.ink === "color" ? (l > 0.5 ? GLINT : EYE) : color(look.ink, m, step / (ramp.length - 1));
        if (c !== fill) {
          ctx.fillStyle = c;
          fill = c;
        }
        ctx.fillText(ramp[step], i * cw, top + j * lh);
      }
    }
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
  };
}
