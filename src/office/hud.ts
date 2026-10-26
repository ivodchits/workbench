// The performance HUD (office plan O0.1): draws per second, time per draw, simulation
// steps per second and, in Chromium, the JS heap. Rewritten once a second, from the
// loop's running totals; a still office reads 0 draws. Below that, what Workbench
// costs (O0.4), asked every few seconds: itself with its webview, and its sessions.

import type { Loop, LoopStats } from "./loop";
import type { Cost, Usage } from "./net";

/** How often Workbench is asked; its CPU is the average since the last ask. */
const COST_EVERY_MS = 3000;

/** Chromium's non-standard `performance.memory`. */
interface HeapInfo {
  usedJSHeapSize: number;
}

function usage(label: string, u: Usage): string {
  return `${label} ${u.cpu.toFixed(1)}% · ${Math.round(u.ramMb)} MB · ${u.processes} proc`;
}

export function startHud(el: HTMLElement, loop: Loop, cost: () => Promise<Cost | null>): void {
  let last: LoopStats = { ...loop.stats };
  let lastAt = performance.now();
  let costLines: string[] = [];

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
    el.textContent = [...lines, ...costLines].join("\n");
    last = { ...s };
    lastAt = now;
  };

  setInterval(update, 1000);
  setInterval(() => {
    if (document.hidden || el.hidden) return;
    void cost().then((c) => {
      costLines = c ? [usage("app  ", c.workbench), usage("cli  ", c.sessions)] : [];
    });
  }, COST_EVERY_MS);
}
