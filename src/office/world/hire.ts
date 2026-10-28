// Giving tasks (office plan O3.2): a session started from the office, at a desk you
// picked, by the worker you dragged there (or the one the desk suggests). Once the
// `create` action is off, the desk and the worker are held for it (`assign.ts`) and the
// worker walks over and waits there; when the new instance shows up in a snapshot,
// matched by the request's id, it's seated with them. A request that failed, or that
// Workbench never heard of, lets them go.

import type { RemoteSnapshot } from "../../remote/protocol";
import type { OfficeMap } from "../map/build";
import type { Seating } from "./assign";
import type { World } from "./entities";
import type { Staff } from "./sessions";

/** A session on its way to a desk. */
export interface Hire {
  requestId: string;
  /** Null for a contractor: nobody was free. */
  worker: string | null;
  desk: number;
  /** When it was asked for (sim ms). */
  at: number;
}

/** With no word of the request from Workbench in this long, it isn't coming. */
export const UNHEARD_MS = 20_000;
/** Nobody waits at the desk longer than this for the session to start. */
export const HIRE_MAX = 5 * 60_000;

/** Seats each hire whose instance is live now and lets go of those that won't come.
 *  Returns what's still held, for `assign`. */
export function bindHires(staff: Staff, snapshot: RemoteSnapshot, ms: number): Seating[] {
  const live = new Set(snapshot.instances.filter((i) => i.live).map((i) => i.id));
  staff.hires = staff.hires.filter((h) => {
    const rec = snapshot.created.find((c) => c.requestId === h.requestId);
    if (rec?.instanceId && live.has(rec.instanceId)) {
      // Over whoever a snapshot that came first seated with it.
      staff.seating.set(rec.instanceId, { worker: h.worker, desk: h.desk });
      if (h.worker) staff.sticky[rec.instanceId] = h.worker;
      return false;
    }
    if (rec?.state === "failed") return false;
    return ms - h.at < (rec ? HIRE_MAX : UNHEARD_MS);
  });
  return staff.hires.map((h) => ({ worker: h.worker, desk: h.desk }));
}

/** The hire `id` is on their way to, if any. */
export const hireOf = (staff: Staff, id: string): Hire | undefined => staff.hires.find((h) => h.worker === id);

/** Whether `id` has nothing to do: no session, and none on its way. */
export const isFree = (staff: Staff, id: string): boolean => !staff.jobs.has(id) && !hireOf(staff, id);

/** Whether nothing sits at `desk`: no session, nor one on its way. */
export function deskFree(staff: Staff, desk: number): boolean {
  for (const s of staff.seating.values()) if (s.desk === desk) return false;
  return !staff.hires.some((h) => h.desk === desk);
}

/** Who'd take a session at `desk`: its owner if they're free, else the nearest free
 *  worker of its room's team, else the nearest free one; null when nobody is (a
 *  contractor, then). */
export function workerFor(office: OfficeMap, world: World, staff: Staff, desk: number): string | null {
  const seat = office.seats[desk];
  const free = world.workers.filter((w) => isFree(staff, w.worker.id));
  const owner = free.find((w) => w.home === desk);
  if (owner) return owner.worker.id;
  const far = (w: (typeof free)[number]) => Math.hypot(w.x - seat.stand.x, w.y - seat.stand.y);
  const team = (w: (typeof free)[number]) => (w.worker.team === seat.room ? 0 : 1);
  return free.sort((a, b) => team(a) - team(b) || far(a) - far(b))[0]?.worker.id ?? null;
}
