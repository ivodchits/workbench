// The office page (office plan O0.1): the office at the largest whole-pixel scale that
// fits beside the sidebar, on the loop in loop.ts, with the performance HUD. Until O1 it
// draws the static office from the floor-plan preview.

import { fitScale } from "./canvas";
import { startHud } from "./hud";
import { startLoop } from "./loop";
import { OFFICE_H, OFFICE_W, drawOffice } from "./previewOffice";

const canvas = document.querySelector<HTMLCanvasElement>("#office")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const ctx = canvas.getContext("2d")!;

const view = { overlay: false, paused: false, pausedAt: 0 };

const loop = startLoop({
  step: () => false,
  draw: (ms) => {
    const next = drawOffice(ctx, view.paused ? view.pausedAt : ms, view.overlay);
    return view.paused ? Infinity : next;
  },
});
startHud(hud, loop);

/** Sizes the canvas in CSS pixels so each office pixel is a whole number of device pixels. */
function fit(): void {
  const dpr = devicePixelRatio || 1;
  const scale = fitScale(stage.clientWidth - 16, stage.clientHeight - 16, dpr, OFFICE_W, OFFICE_H);
  canvas.style.width = `${(OFFICE_W * scale) / dpr}px`;
  canvas.style.height = `${(OFFICE_H * scale) / dpr}px`;
}

new ResizeObserver(fit).observe(stage);
// A zoom changes the device pixel ratio without resizing the stage in device pixels.
const watchRatio = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => (fit(), watchRatio()), { once: true });
watchRatio();

addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if (key === "g") view.overlay = !view.overlay;
  else if (key === "p") {
    view.paused = !view.paused;
    view.pausedAt = performance.now();
  } else if (key === "h") hud.hidden = !hud.hidden;
  else return;
  loop.invalidate();
});
