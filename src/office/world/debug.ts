// The debug click (office plan O1.2), on the preview and the office page: click a worker
// to pick them, then a spot on the floor to send them there, a free desk to sit at it,
// or the door to walk out.

import type { OfficeMap, Point } from "../map/build";
import { workerAt, type World } from "./entities";
import { leave, walkTo } from "./move";

const DOOR_REACH = 12;

/** The desk (with its chair and monitor) under `p`. */
export function deskAt(office: OfficeMap, p: Point): number | undefined {
  return office.seats.find((s) => p.x >= s.desk.x && p.x < s.desk.x + 32 && p.y >= s.monitor.y && p.y < s.sit.base + 4)?.index;
}

/** A debug click at (x, y): picks the worker there, or sends the one picked. Returns
 *  who's picked now. */
export function debugClick(office: OfficeMap, world: World, picked: string | null, x: number, y: number, ms: number): string | null {
  const under = workerAt(world, x, y);
  if (under) return under.worker.id;
  const w = world.workers.find((o) => o.worker.id === picked);
  if (!w || w.away) return null;
  const p = { x, y };
  const desk = deskAt(office, p);
  if (Math.hypot(x - office.door.x, y - office.door.y) <= DOOR_REACH) leave(office, w, ms);
  else if (desk !== undefined && !world.workers.some((o) => o !== w && o.seat === desk)) {
    walkTo(office, w, p, ms, { kind: "sit", seat: desk });
  } else walkTo(office, w, p, ms);
  return w.worker.id;
}
