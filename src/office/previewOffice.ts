// The office with everyone at their home desk (office plans O1.1, O1.2), for the
// preview and, until sessions drive the workers in O1.3, the office page. A fixed cast
// of states shows what the renderer can draw: most people typing, Ada standing up to
// wave because she needs you, a few status icons, a speech bubble, and Duck talking.
// A debug click moves people: click a worker to pick them, then a spot on the floor to
// send them there, a desk to sit at it, or the door to walk out (they come back in to
// their own desk a little later).

import { buildOffice, type Point } from "./map/build";
import { workerAt as hit, createWorld, setAnim, setDuckAnim, type WorkerEntity, type World } from "./world/entities";
import { enter, leave, stepWalkers, walkTo } from "./world/move";
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
  Object.assign(ada, { x: seat.stand.x, y: seat.stand.y, prev: { ...seat.stand }, dir: "down", seat: null, overhead: "needs", tag: "needs" });
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

/** How long someone who walked out stays out. */
const AWAY_MS = 3000;
const outSince = new Map<WorkerEntity, number>();

/** One sim step at `ms`; true when the picture changed. */
export function stepOffice(ms: number): boolean {
  let changed = stepWalkers(world, office, ms);
  for (const w of world.workers) {
    if (!w.away) continue;
    const since = outSince.get(w) ?? ms;
    outSince.set(w, since);
    if (ms - since < AWAY_MS) continue;
    outSince.delete(w);
    enter(office, w, office.seats[w.home].stand, ms, { kind: "sit", seat: w.home });
    changed = true;
  }
  return changed;
}

const DOOR_REACH = 12;

/** The desk (with its chair and monitor) under `p`. */
function deskAt(p: Point): number | undefined {
  return office.seats.find((s) => p.x >= s.desk.x && p.x < s.desk.x + 32 && p.y >= s.monitor.y && p.y < s.sit.base + 4)?.index;
}

/** A debug click at (x, y): picks the worker there, or sends the one picked. Returns
 *  who's picked now. */
export function clickOffice(picked: string | null, x: number, y: number, ms: number): string | null {
  const under = hit(world, x, y);
  if (under) return under.worker.id;
  const w = world.workers.find((o) => o.worker.id === picked);
  if (!w || w.away) return null;
  const p = { x, y };
  const desk = deskAt(p);
  if (Math.hypot(x - office.door.x, y - office.door.y) <= DOOR_REACH) leave(office, w, ms);
  else if (desk !== undefined && !world.workers.some((o) => o !== w && o.seat === desk)) {
    walkTo(office, w, p, ms, { kind: "sit", seat: desk });
  } else walkTo(office, w, p, ms);
  return w.worker.id;
}

/** The worker at (x, y) in office pixels, for hover. */
export function workerAt(x: number, y: number): string | null {
  return hit(world, x, y)?.worker.id ?? null;
}

/** Draws the office at `ms`; returns how long until it looks different. */
export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, view: View = {}): number {
  return renderer.draw(ctx, world, ms, view);
}
