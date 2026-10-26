// The office with everyone at their home desk (office plan O1.1), for the preview and,
// until sessions drive the workers in O1.3, the office page. A fixed cast of states
// shows what the renderer can draw: most people typing, Ada standing up to wave
// because she needs you, a few status icons, a speech bubble, and Duck talking.

import { buildOffice } from "./map/build";
import { workerAt as hit, createWorld, setAnim, setDuckAnim, type World } from "./world/entities";
import { OFFICE_H, OFFICE_W, createRenderer, type View } from "./world/render";

export { OFFICE_H, OFFICE_W };

const office = buildOffice();
const world: World = createWorld(office);
const renderer = createRenderer(office);

function demo(world: World): void {
  const by = (id: string) => world.workers.find((w) => w.worker.id === id)!;
  for (const w of world.workers) w.tag = "working";

  const ada = by("ada");
  const seat = office.seats[ada.home];
  Object.assign(ada, { x: seat.stand.x, y: seat.stand.y, dir: "down", seated: false, overhead: "needs", tag: "needs" });
  setAnim(ada, "wave", 0);
  ada.bubble = { text: "!", tone: "needs" };
  world.screens[ada.home] = "alert";

  Object.assign(by("felix"), { overhead: "working" });
  Object.assign(by("pip"), { overhead: "done", tag: "done" });
  setAnim(by("pip"), "idle", 0);
  Object.assign(by("gus"), { overhead: "stuck" });
  setAnim(by("gus"), "sleep", 0);
  by("theo").bubble = { text: "Who touched main?", tone: "say" };
  for (const id of ["mira", "lola"]) by(id).tag = null;

  setDuckAnim(world.duck, "speak", 0);
  world.duck.bubble = { text: "Ship it.", tone: "say" };
}

demo(world);

/** The worker at (x, y) in office pixels, for hover. */
export function workerAt(x: number, y: number): string | null {
  return hit(world, x, y)?.worker.id ?? null;
}

/** Draws the office at `ms`; returns how long until it looks different. */
export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, view: View = {}): number {
  return renderer.draw(ctx, world, ms, view);
}
