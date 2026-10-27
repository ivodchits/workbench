// The office page (office plans O0.1, O0.2, O1.1–O1.6): the office as large as fits
// beside the sidebar, on the loop in loop.ts, with the performance HUD, and the link to
// Workbench. Sessions drive the workers (liveOffice.ts). Hovering a worker shows who
// they are and what their session is doing; clicking one opens their session in the
// sidebar (panel.ts), and clicking the floor or Esc closes it. With the walk grid on
// (`G`) a click is the debug one instead: pick a worker, then send them walking. With
// nobody picked the sidebar shows the stats (stats.ts) and the room each project sits in.

import { fitSize, sideLayout } from "./canvas";
import { startHud } from "./hud";
import { startLoop } from "./loop";
import { connect } from "./net";
import { tooltipLines } from "./describe";
import { OFFICE_H, OFFICE_W, clickOffice, drawOffice, nameOf, officeLog, officeSnapshot, roomOf, setRoom, startOffice, stepOffice, whoAt, workedToday, workerAt } from "./liveOffice";
import type { Cost } from "./net";
import { createPanel } from "./panel";
import { showLink, showRooms } from "./sidebar";
import { showStats } from "./stats";

const canvas = document.querySelector<HTMLCanvasElement>("#office")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
const tip = document.querySelector<HTMLElement>("#tip")!;
const side = document.querySelector<HTMLElement>("#side")!;
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

const view = { overlay: false, tags: false, hover: null as string | null, selected: null as string | null, paused: false, pausedAt: 0 };

const loop = startLoop({
  step: () => !view.paused && stepOffice(performance.now()),
  draw: (ms) => {
    const next = drawOffice(ctx, view.paused ? view.pausedAt : ms, view);
    present();
    return view.paused ? Infinity : next;
  },
});
const linkEl = document.querySelector<HTMLElement>("#link")!;
const statsEl = document.querySelector<HTMLElement>("#stats")!;
const roomsEl = document.querySelector<HTMLElement>("#rooms")!;
let snapshot: Parameters<typeof officeSnapshot>[0] | null = null;
const pickRoom = (id: string, team: Parameters<typeof setRoom>[1]) => {
  setRoom(id, team);
  loop.invalidate();
};
const link = connect((state) => {
  showLink(linkEl, state);
  if (state.kind !== "live") {
    snapshot = null;
    return statsEl.replaceChildren();
  }
  snapshot = state.snapshot;
  officeSnapshot(state.snapshot);
  showRooms(roomsEl, state.snapshot.projects, roomOf, pickRoom);
  showSelected();
  showTip();
});
const panel = createPanel(document.querySelector<HTMLElement>("#session")!, link, () => select(null));

/** The session of whoever is picked, in the sidebar. A pick made for the debug click
 *  (with the walk grid on) isn't one. */
function showSelected(): void {
  const who = view.selected && !view.overlay ? whoAt(view.selected) : null;
  side.classList.toggle("open", !!who);
  panel.show(who);
  if (!who) showStatsNow();
}

function select(id: string | null): void {
  view.selected = id;
  showSelected();
  loop.invalidate();
}
startOffice(link, () => loop.invalidate());

/** How often Workbench's cost is asked, while the HUD or the stats show it; its CPU is
 *  the average since the last ask. */
const COST_EVERY_MS = 3000;
let cost: Cost | null = null;
startHud(hud, loop, () => cost);

/** The stats, while nobody is picked. */
function showStatsNow(): void {
  if (!snapshot || side.classList.contains("open")) return;
  showStats(statsEl, { snapshot, cost, log: officeLog(), workedToday: workedToday(), nameOf });
}
setInterval(() => {
  const statsShown = !!snapshot && !side.classList.contains("open");
  if (document.hidden || (hud.hidden && !statsShown)) return;
  void link.cost().then((c) => {
    cost = c;
    showStatsNow();
  });
}, COST_EVERY_MS);

/** Space round the office in the stage, each side. */
const PAD = 8;
/** The sidebar is never narrower (or, under the office, shorter) than this. */
const SIDE_MIN = 280;

/** Sizes the sidebar so the office, as large as the window allows, fills the rest:
 *  beside it on a landscape screen, under it on a portrait one. The same in every mode. */
function layOut(): void {
  const { below, size } = sideLayout(innerWidth, innerHeight, OFFICE_W, OFFICE_H, PAD, SIDE_MIN);
  document.body.classList.toggle("below", below);
  document.body.style.setProperty("--side", `${size}px`);
}
layOut();
addEventListener("resize", layOut);

/** Fills the stage. At a whole-number scale every office pixel is a block of device
 *  pixels; between those, the canvas holds the next whole scale up and the browser
 *  shrinks it smoothly, which stays sharp where nearest-neighbour would leave some
 *  pixels a device pixel wider than others. */
function fit(): void {
  const dpr = devicePixelRatio || 1;
  const { scale, backing } = fitSize(stage.clientWidth - 2 * PAD, stage.clientHeight - 2 * PAD, dpr, OFFICE_W, OFFICE_H);
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
  if (e.key === "Escape" && view.selected) {
    select(null);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if (key === "g") {
    view.overlay = !view.overlay;
    select(null);
  }
  else if (key === "n") view.tags = !view.tags;
  else if (key === "p") {
    view.paused = !view.paused;
    view.pausedAt = performance.now();
  } else if (key === "h") hud.hidden = !hud.hidden;
  else return;
  loop.invalidate();
});

/** Where a pointer is, in office pixels. */
function sceneAt(e: MouseEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [((e.clientX - rect.left) * OFFICE_W) / rect.width, ((e.clientY - rect.top) * OFFICE_H) / rect.height];
}

/** Where the pointer last was over the office, in page pixels; null when it's off it. */
let pointer: { x: number; y: number } | null = null;

/** The tooltip for whoever is hovered, by the pointer. */
function showTip(): void {
  const who = view.hover && pointer && !view.overlay ? whoAt(view.hover) : null;
  tip.hidden = !who;
  if (!who || !pointer) return;
  tip.replaceChildren(
    ...tooltipLines(who, performance.now()).map((text, n) => {
      const line = document.createElement("div");
      if (n === 0) line.className = "who";
      line.textContent = text;
      return line;
    }),
  );
  const box = stage.getBoundingClientRect();
  const x = Math.min(pointer.x - box.left + 14, box.width - tip.offsetWidth - 8);
  const y = pointer.y - box.top + 18 + tip.offsetHeight > box.height - 8 ? pointer.y - box.top - tip.offsetHeight - 10 : pointer.y - box.top + 18;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
// The "for how long" moves on.
setInterval(() => !tip.hidden && showTip(), 1000);

/** Hovering a worker shows their name tag and the tooltip. */
function hoverAt(e: PointerEvent | null): void {
  pointer = e && { x: e.clientX, y: e.clientY };
  const id = e ? workerAt(...sceneAt(e)) : null;
  canvas.style.cursor = id || (view.overlay && view.selected) ? "pointer" : "";
  const moved = id !== view.hover;
  view.hover = id;
  showTip();
  if (moved) loop.invalidate();
}

canvas.addEventListener("pointermove", hoverAt);
canvas.addEventListener("pointerleave", () => hoverAt(null));
canvas.addEventListener("click", (e) => {
  if (view.paused) return;
  if (view.overlay) {
    view.selected = clickOffice(view.selected, ...sceneAt(e), performance.now());
    loop.invalidate();
    return;
  }
  // A worker (or a contractor's desk) opens their session; anywhere else closes it.
  select(workerAt(...sceneAt(e)));
});
