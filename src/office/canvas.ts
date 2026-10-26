// Shared by the office page and the preview: bitmaps → canvases, cached, frame timing,
// and the whole-pixel scale.

import type { Bitmap } from "./art/pixels";

const cache = new Map<string, HTMLCanvasElement>();

/** A canvas for `key`, drawn once from `make()`. */
export function cached(key: string, make: () => Bitmap): HTMLCanvasElement {
  let canvas = cache.get(key);
  if (!canvas) {
    const bmp = make();
    canvas = document.createElement("canvas");
    canvas.width = bmp.w;
    canvas.height = bmp.h;
    canvas.getContext("2d")!.putImageData(new ImageData(bmp.data, bmp.w, bmp.h), 0, 0);
    cache.set(key, canvas);
  }
  return canvas;
}

/** Which of `durations` is showing `ms` into the loop. */
export function frameIn(durations: readonly number[], ms: number): number {
  const total = durations.reduce((sum, d) => sum + d, 0);
  let t = ms % total;
  for (let i = 0; i < durations.length; i++) {
    if (t < durations[i]) return i;
    t -= durations[i];
  }
  return 0;
}

/** How long after `ms` the frame `frameIn` picks changes; Infinity for a still. */
export function untilNextFrame(durations: readonly number[], ms: number): number {
  if (durations.length < 2) return Infinity;
  const total = durations.reduce((sum, d) => sum + d, 0);
  let t = ms % total;
  for (const d of durations) {
    if (t < d) return d - t;
    t -= d;
  }
  return durations[0];
}

/** Device pixels per office pixel: the largest whole number that fits `w`×`h` CSS
 *  pixels, so no office pixel is drawn wider than another. At least 1. */
export function fitScale(w: number, h: number, dpr: number, sceneW: number, sceneH: number): number {
  return Math.max(1, Math.floor(Math.min((w * dpr) / sceneW, (h * dpr) / sceneH)));
}
