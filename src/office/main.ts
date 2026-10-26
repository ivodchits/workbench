// The office page (office plans O0.1, O0.2): the office as large as fits beside the
// sidebar, on the loop in loop.ts, with the performance HUD, and the link to Workbench. Until O1 it draws the static office from the floor-plan
// preview, and the sidebar lists the sessions as text.

import { fitSize } from "./canvas";
import { startHud } from "./hud";
import { startLoop } from "./loop";
import { connect } from "./net";
import { OFFICE_H, OFFICE_W, drawOffice } from "./previewOffice";
import { showLink } from "./sidebar";

const canvas = document.querySelector<HTMLCanvasElement>("#office")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const shown = canvas.getContext("2d")!;

/** The office at 1:1; each frame is copied up onto the page's canvas. */
const scene = document.createElement("canvas");
scene.width = OFFICE_W;
scene.height = OFFICE_H;
const ctx = scene.getContext("2d")!;

/** Copies the scene up by whole pixels; the browser takes it the rest of the way. */
function present(): void {
  shown.imageSmoothingEnabled = false;
  shown.drawImage(scene, 0, 0, canvas.width, canvas.height);
}

const view = { overlay: false, paused: false, pausedAt: 0 };

const loop = startLoop({
  step: () => false,
  draw: (ms) => {
    const next = drawOffice(ctx, view.paused ? view.pausedAt : ms, view.overlay);
    present();
    return view.paused ? Infinity : next;
  },
});
const linkEl = document.querySelector<HTMLElement>("#link")!;
const link = connect((state) => showLink(linkEl, state));
startHud(hud, loop, () => link.cost());

/** Fills the stage. At a whole-number scale every office pixel is a block of device
 *  pixels; between those, the canvas holds the next whole scale up and the browser
 *  shrinks it smoothly, which stays sharp where nearest-neighbour would leave some
 *  pixels a device pixel wider than others. */
function fit(): void {
  const dpr = devicePixelRatio || 1;
  const { scale, backing } = fitSize(stage.clientWidth - 16, stage.clientHeight - 16, dpr, OFFICE_W, OFFICE_H);
  canvas.style.width = `${(OFFICE_W * scale) / dpr}px`;
  canvas.style.height = `${(OFFICE_H * scale) / dpr}px`;
  canvas.style.imageRendering = backing === scale ? "pixelated" : "auto";
  if (canvas.width !== OFFICE_W * backing) {
    canvas.width = OFFICE_W * backing;
    canvas.height = OFFICE_H * backing;
    present();
  }
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
