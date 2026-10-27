// The office for the preview (office plans O1.1–O1.4); the office page runs on real
// sessions instead (liveOffice.ts). A made-up snapshot with one session in each state
// from "Status → behaviour" (world/fixtures.ts) is seated as the page would seat it, so
// every behaviour shows at once: typing, typing fast, at the rack and the whiteboard,
// reading, filing, waving with a `!` or a `?`, sweating, slumped, leaning back with a
// coffee, and two contractors. Theo is saying something, and so is Duck.
// A debug click moves people: click a worker to pick them, then a spot on the floor to
// send them there, a desk to sit at it, or the door to walk out (they go back to what
// they were doing a few seconds after getting there).

import { buildOffice } from "./map/build";
import { behave } from "./world/behave";
import { debugClick } from "./world/debug";
import { workerAt as hit, createWorld, setDuckAnim, type World } from "./world/entities";
import { EVERY_STATE, EVERY_STATE_ROOMS, snapshot } from "./world/fixtures";
import { stepWalkers } from "./world/move";
import { OFFICE_H, OFFICE_W, createRenderer, type View } from "./world/render";
import { createStaff, seatSessions } from "./world/sessions";

export { OFFICE_H, OFFICE_W };

const office = buildOffice();
const world: World = createWorld(office);
const renderer = createRenderer(office);
const staff = createStaff({ rooms: { ...EVERY_STATE_ROOMS } });

seatSessions(office, world, staff, snapshot(EVERY_STATE), 0, () => 0);
world.workers.find((w) => w.worker.id === "theo")!.bubble = { text: "Who touched main?", tone: "say" };
setDuckAnim(world.duck, "speak", 0);
world.duck.bubble = { text: "Ship it.", tone: "say" };

/** One sim step at `ms`; true when the picture changed. */
export function stepOffice(ms: number): boolean {
  const walked = stepWalkers(world, office, ms);
  return behave(office, world, staff, ms) || walked;
}

/** A debug click at (x, y): picks the worker there, or sends the one picked. Returns
 *  who's picked now. */
export const clickOffice = (picked: string | null, x: number, y: number, ms: number): string | null =>
  debugClick(office, world, picked, x, y, ms, (w) => staff.loose.set(w.worker.id, ms));

/** The worker at (x, y) in office pixels, for hover. */
export function workerAt(x: number, y: number): string | null {
  return hit(world, x, y)?.worker.id ?? null;
}

/** Draws the office at `ms`; returns how long until it looks different. */
export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, view: View = {}): number {
  return renderer.draw(ctx, world, ms, view);
}
