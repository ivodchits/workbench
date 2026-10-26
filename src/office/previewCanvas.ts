// Shared by the preview's sections: bitmaps → canvases, cached, and frame timing.

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
