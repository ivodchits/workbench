// What a worker does about their session (office plan O1.4, "Status → behaviour"). Each
// sim step, every worker with a session is given a place and a pose from it: typing at
// the desk (faster with subagents out), reading a newspaper or a document there, at the
// server rack for a command, at the whiteboard for tests, filing papers while the
// context compacts, up and waving when the session needs you (sweating once it's been
// too long), slumped on the keyboard when it seems stuck, leaning back with a coffee
// when it's done — wandering off after ten minutes of that — and off to the kitchen or
// the lounge when the session has ended. Nobody leaves the office. Over the head: the
// `!`/`?` bubble, or the status icon (the working one only away from the desk).
//
// A change of activity only moves someone once it has held for a moment, and nobody
// leaves the rack or the whiteboard straight after getting there, so a session
// flicking between tools doesn't send its worker running back and forth. A change of
// phase is acted on at once.

import type { Anim, Dir } from "../art/characters";
import type { Overhead } from "../art/labels";
import type { OfficeMap, Point, Seat } from "../map/build";
import type { SpotKind, SpotSpec } from "../map/office";
import type { RemoteInstance } from "../../remote/protocol";
import { seatedAt, setAnim, type Bubble, type Screen, type WorkerEntity, type World } from "./entities";
import { enter, landing, walkTo } from "./move";
import type { Staff } from "./sessions";

/** Away from the desk for work: which spots, and which way to face there. */
export type Station = "rack" | "board" | "cabinet";
const STATIONS: Record<Station, readonly { id: string; face: Dir }[]> = {
  rack: [{ id: "rack", face: "up" }],
  board: [
    { id: "board-demiurge", face: "up" },
    { id: "pitch-board", face: "up" },
  ],
  cabinet: [{ id: "cabinet", face: "up" }],
};

export type Place = { kind: "desk" } | { kind: "stand" } | { kind: "station"; station: Station } | { kind: "about" };

/** What a session asks of its worker. */
export interface Doing {
  place: Place;
  /** The pose once they're there. */
  anim: Anim;
  overhead: Overhead | null;
  bubble: Bubble | null;
}

const DESK_W = 32;

/** Done for this long, a worker wanders off until the next turn. */
export const WANDER_AFTER = 10 * 60_000;
/** A new activity has to hold this long before the worker acts on it. */
export const SETTLE = 1500;
/** Nobody leaves a station sooner than this after getting there. */
export const STAY = 6000;
/** Someone a debug click sent somewhere stays there this long. */
export const LOOSE_FOR = 3000;

const WORKING: Partial<Record<NonNullable<RemoteInstance["activity"]>, Omit<Doing, "overhead" | "bubble">>> = {
  bash: { place: { kind: "station", station: "rack" }, anim: "tinker" },
  test: { place: { kind: "station", station: "board" }, anim: "board" },
  web: { place: { kind: "desk" }, anim: "newspaper" },
  read: { place: { kind: "desk" }, anim: "document" },
};

/** What `i` asks of its worker, done for `doneFor` ms. Pure. */
export function doing(i: RemoteInstance, doneFor = 0): Doing {
  const plain = { overhead: null, bubble: null };
  if (i.phase === "ended") return { place: { kind: "about" }, anim: "idle", ...plain };
  if (i.phase === "needs_you") {
    if (i.escalated) return { place: { kind: "stand" }, anim: "fret", overhead: null, bubble: { text: "!", tone: "alert", pulse: true } };
    const text = i.choice?.kind === "question" ? "?" : "!";
    return { place: { kind: "stand" }, anim: "wave", overhead: null, bubble: { text, tone: "needs" } };
  }
  if (i.compacting) return { place: { kind: "station", station: "cabinet" }, anim: "file", overhead: "working", bubble: null };
  if (i.phase === "working") {
    if (i.stuck) return { place: { kind: "desk" }, anim: "sleep", overhead: "stuck", bubble: null };
    const job = (i.activity && WORKING[i.activity]) || { place: { kind: "desk" }, anim: i.subagents > 0 ? "typeFast" : "type" };
    return { ...job, overhead: "working", bubble: null };
  }
  if (i.phase === "done") {
    if (doneFor >= WANDER_AFTER) return { place: { kind: "about" }, anim: "idle", overhead: "done", bubble: null };
    return { place: { kind: "desk" }, anim: "coffee", overhead: "done", bubble: null };
  }
  return { place: { kind: "desk" }, anim: "relax", ...plain };
}

/** What a worker is doing now, and since when. */
export interface Plan {
  doing: Doing;
  phase: RemoteInstance["phase"];
  since: number;
  /** When they got there, for a station. */
  arrived?: number;
  /** What they'd rather be doing, and since when: taken up after `SETTLE`. */
  next?: { key: string; since: number };
}

const placeKey = (p: Place) => (p.kind === "station" ? `station:${p.station}` : p.kind);
const keyOf = (d: Doing) => `${placeKey(d.place)}/${d.anim}`;

/** Where people with nothing to do stand, in the order they fill. Released workers
 *  go to the kitchen's first. */
const IDLE_KINDS: readonly SpotKind[] = ["drink", "chat", "play", "dnd", "window"];
const KITCHEN_KINDS: readonly SpotKind[] = ["drink", "chat"];
const IDLE_SPOT = new Set<SpotKind>(IDLE_KINDS);

/** Moves everyone to match their session, or to an idle spot without one. `instant`
 *  puts people where they belong without walking (the first snapshot). True when the
 *  picture changed. */
export function behave(office: OfficeMap, world: World, staff: Staff, ms: number, instant = false): boolean {
  let changed = false;
  for (const w of world.workers) {
    const before = look(w);
    const id = w.worker.id;
    const loose = staff.loose.get(id);
    if (loose !== undefined) {
      if (w.walk) staff.loose.set(id, ms);
      else if (ms - loose >= LOOSE_FOR) staff.loose.delete(id);
      continue;
    }
    const job = staff.jobs.get(id);
    if (!job) {
      staff.plans.delete(id);
      w.tag = null;
      w.overhead = null;
      if (isStatusBubble(w.bubble)) w.bubble = null;
      if (!IDLE_SPOT.has(spotOf(office, staff, id)?.kind as SpotKind)) toSpot(office, staff, w, ms, instant, KITCHEN_KINDS);
    } else {
      const since = staff.phases.get(job.instance.id);
      const want = doing(job.instance, job.instance.phase === "done" && since ? ms - since.at : 0);
      const plan = choose(staff.plans.get(id), want, job.instance.phase, ms, instant);
      staff.plans.set(id, plan);
      w.tag = job.tag;
      if (want.bubble || isStatusBubble(w.bubble)) w.bubble = want.bubble;
      go(office, staff, w, job.desk, plan, ms, instant);
      // At the desk, the monitor says they're working.
      w.overhead = want.overhead === "working" && w.seat === job.desk ? null : want.overhead;
    }
    if (look(w) !== before) changed = true;
  }
  showScreens(office, world, staff);
  return changed;
}

/** Takes up `want` now, or once it has held long enough. */
function choose(plan: Plan | undefined, want: Doing, phase: Plan["phase"], ms: number, instant: boolean): Plan {
  const now = (): Plan => ({ doing: want, phase, since: ms });
  if (!plan || instant || plan.phase !== phase) return now();
  const key = keyOf(want);
  if (key === keyOf(plan.doing)) return { ...plan, doing: want, next: undefined };
  const next = plan.next?.key === key ? plan.next : { key, since: ms };
  const staying = plan.arrived !== undefined && ms - plan.arrived < STAY;
  if (ms - next.since >= SETTLE && !staying) return now();
  return { ...plan, next };
}

/** Sends `w` to where `plan` has them, or once there, strikes its pose. */
function go(office: OfficeMap, staff: Staff, w: WorkerEntity, desk: number, plan: Plan, ms: number, instant: boolean): void {
  const id = w.worker.id;
  const { place, anim } = plan.doing;
  const seat = office.seats[desk];
  // Put in place on the first snapshot: as if they'd been at the desk already.
  if (instant && place.kind !== "about") staff.settled.add(id);
  switch (place.kind) {
    case "desk": {
      staff.spots.delete(id);
      if (w.seat === desk && !w.walk) {
        staff.settled.add(id);
        return pose(w, anim, "up", ms);
      }
      if (instant) {
        sitNow(office, w, desk, ms);
        staff.settled.add(id);
        return pose(w, anim, "up", ms);
      }
      return toDesk(office, w, desk, ms);
    }
    case "stand": {
      staff.spots.delete(id);
      return stand(office, w, besideDesk(seat), "down", anim, ms, instant, () => staff.settled.add(id));
    }
    case "station": {
      const spot = stationFor(office, staff, w, place.station, seat.stand);
      if (!spot) return go(office, staff, w, desk, { ...plan, doing: { ...plan.doing, place: { kind: "desk" }, anim: "type" } }, ms, instant);
      staff.spots.set(id, spot.id);
      return stand(office, w, spot, spot.face, anim, ms, instant, () => (plan.arrived ??= ms));
    }
    case "about": {
      staff.settled.delete(id);
      if (!IDLE_SPOT.has(spotOf(office, staff, id)?.kind as SpotKind)) toSpot(office, staff, w, ms, instant, IDLE_KINDS);
      return;
    }
  }
}

/** Where someone stands to wave at you: beside the desk, level with the chair, so
 *  their bubble doesn't hide the monitor. */
export function besideDesk(seat: Seat): Point {
  return { x: seat.desk.x + DESK_W + 6, y: seatedAt(seat).y };
}

/** Gets `w` standing at `p` facing `face`, then posing as `anim`. */
function stand(office: OfficeMap, w: WorkerEntity, p: Point, face: Dir, anim: Anim, ms: number, instant: boolean, arrived?: () => void): void {
  const at = landing(office, p);
  if (instant) Object.assign(w, { x: at.x, y: at.y, prev: { ...at }, seat: null, walk: null, away: false });
  if (!w.walk && !w.away && w.seat === null && w.x === at.x && w.y === at.y) {
    arrived?.();
    return pose(w, anim, face, ms);
  }
  if (headedTo(w, at)) return;
  const then = { kind: "stand", face } as const;
  if (w.away) enter(office, w, at, ms, then);
  else walkTo(office, w, at, ms, then);
}

function pose(w: WorkerEntity, anim: Anim, dir: Dir, ms: number): void {
  w.dir = dir;
  setAnim(w, anim, ms);
}

const headedTo = (w: WorkerEntity, p: Point) => {
  const last = w.walk?.points[w.walk.points.length - 1];
  return w.walk?.then.kind === "stand" && last !== undefined && last.x === p.x && last.y === p.y;
};

/** The spot `id` holds. */
const spotOf = (office: OfficeMap, staff: Staff, id: string): SpotSpec | undefined => office.spots.find((s) => s.id === staff.spots.get(id));

/** The station spot `w` holds, else the free one nearest their desk. */
function stationFor(office: OfficeMap, staff: Staff, w: WorkerEntity, station: Station, from: Point): (SpotSpec & { face: Dir }) | undefined {
  const mine = staff.spots.get(w.worker.id);
  const taken = new Set([...staff.spots].filter(([who]) => who !== w.worker.id).map(([, s]) => s));
  const options = STATIONS[station]
    .filter((o) => o.id === mine || !taken.has(o.id))
    .map((o) => ({ ...office.spots.find((s) => s.id === o.id)!, face: o.face }))
    .sort((a, b) => (a.id === mine ? -1 : b.id === mine ? 1 : Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y)));
  return options[0];
}

const isStatusBubble = (b: Bubble | null) => b !== null && b.tone !== "say";

/** What of `w` shows, to tell whether a step changed the picture. */
const look = (w: WorkerEntity) => `${w.anim}|${w.dir}|${w.overhead}|${w.tag}|${w.bubble?.text}|${w.bubble?.tone}|${w.walk ? 1 : 0}|${w.away}|${w.seat}`;

function sitNow(office: OfficeMap, w: WorkerEntity, desk: number, ms: number): void {
  const at = seatedAt(office.seats[desk]);
  Object.assign(w, { ...at, prev: at, seat: desk, dir: "up", walk: null, away: false });
  setAnim(w, "type", ms);
}

/** Sends `w` to sit at `desk`, unless they're on their way. */
function toDesk(office: OfficeMap, w: WorkerEntity, desk: number, ms: number): void {
  if (w.walk?.then.kind === "sit" && w.walk.then.seat === desk) return;
  const then = { kind: "sit", seat: desk } as const;
  if (w.away) enter(office, w, office.seats[desk].stand, ms, then);
  else walkTo(office, w, office.seats[desk].stand, ms, then);
}

/** Gives `w` an idle spot nobody has, the first of `first` kinds if one's free:
 *  walked to, or (on the first snapshot) put there. */
function toSpot(office: OfficeMap, staff: Staff, w: WorkerEntity, ms: number, instant: boolean, first: readonly SpotKind[]): void {
  staff.spots.delete(w.worker.id);
  const taken = new Set(staff.spots.values());
  const free = (kinds: readonly SpotKind[]) => kinds.flatMap((k) => office.spots.filter((s) => s.kind === k && !taken.has(s.id)));
  const spot = instant ? free(IDLE_KINDS)[0] : (free(first)[0] ?? free(IDLE_KINDS)[0]);
  if (!spot) return;
  staff.spots.set(w.worker.id, spot.id);
  if (instant) {
    Object.assign(w, { x: spot.x, y: spot.y, prev: { x: spot.x, y: spot.y }, seat: null, dir: spot.dir, walk: null, away: false });
    setAnim(w, "idle", ms);
    return;
  }
  const then = { kind: "stand", face: spot.dir } as const;
  if (w.away) enter(office, w, spot, ms, then);
  else walkTo(office, w, spot, ms, then);
}

/** Monitors: code while a session works, flashing red while it needs you — once its
 *  worker has been to the desk — and dark otherwise; laptops on contractors' desks. */
export function showScreens(office: OfficeMap, world: World, staff: Staff): void {
  const screens = office.seats.map((): Screen => "off");
  for (const s of staff.seating.values()) {
    if (s.desk === null) continue;
    if (!s.worker) {
      screens[s.desk] = "laptop";
      continue;
    }
    const job = staff.jobs.get(s.worker);
    if (!job || !staff.settled.has(s.worker)) continue;
    if (job.instance.phase === "working") screens[s.desk] = "code";
    else if (job.instance.phase === "needs_you") screens[s.desk] = "alert";
  }
  world.screens = screens;
}
