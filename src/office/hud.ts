// The performance HUD (office plan O0.1): draws per second, time per draw, simulation
// steps per second and, in Chromium, the JS heap. Rewritten once a second, from the
// loop's running totals; a still office reads 0 draws.

import type { Loop, LoopStats } from "./loop";

/** Chromium's non-standard `performance.memory`. */
interface HeapInfo {
  usedJSHeapSize: number;
}

export function startHud(el: HTMLElement, loop: Loop): void {
  let last: LoopStats = { ...loop.stats };
  let lastAt = performance.now();

  const update = () => {
    const now = performance.now();
    if (document.hidden || el.hidden) {
      last = { ...loop.stats };
      lastAt = now;
      return;
    }
    const secs = (now - lastAt) / 1000;
    const s = loop.stats;
    const draws = s.draws - last.draws;
    const lines = [
      `draws ${(draws / secs).toFixed(1)}/s`,
      `draw  ${draws ? ((s.drawMs - last.drawMs) / draws).toFixed(2) : "–"} ms`,
      `steps ${((s.steps - last.steps) / secs).toFixed(1)}/s`,
    ];
    const heap = (performance as Performance & { memory?: HeapInfo }).memory;
    if (heap) lines.push(`heap  ${(heap.usedJSHeapSize / 2 ** 20).toFixed(1)} MB`);
    el.textContent = lines.join("\n");
    last = { ...s };
    lastAt = now;
  };

  setInterval(update, 1000);
}
