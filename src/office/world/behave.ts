// What a worker does about their session (office plan O1.4, "Status → behaviour"). Each
// sim step, every worker with a session is given a place and a pose from it: typing at
// the desk (faster with subagents out), reading a newspaper or a document there, at the
// server rack for a command, at the whiteboard for tests, filing papers while the
// context compacts, up and waving when the session needs you (sweating once it's been
// too long), slumped on the keyboard when it seems stuck, leaning back with a coffee
// when it's done — wandering off after ten minutes of that — and off to the kitchen or
// the lounge when the session has ended; up and cheering for a moment after a commit
// (O2.3, `reactions.ts`, which also sends Duck round; at home, Duck shows what it's
// doing, O3.1 `boss.ts`). Nobody leaves the office. Over the head: the
// `!`/`?` bubble, or the status icon (the working one only away from the desk). Anyone
// with nothing to do (no session, or wandered off from one) is the idle planner's
// (O2.1, `idle.ts`): an activity at a time, somewhere free, moving on every so often.
// Someone given a session from the office (O3.2, `hire.ts`) goes to its desk and sits
// waiting there till it starts.
//
// A change of activity only moves someone once it has held for a moment, and nobody
// leaves the rack or the whiteboard straight after getting there, so a session
// flicking between tools doesn't send its worker running back and forth. A change of
// phase is acted on at once.

import { ANIMS, type Anim, type Dir } from "../art/characters";
import type { Overhead } from "../art/labels";
import type { OfficeMap, Point, Seat } from "../map/build";
import type { SpotSpec } from "../map/office";
import type { RemoteInstance } from "../../remote/protocol";
import { seatedAt, setAnim, type Bubble, type Screen, type WorkerEntity, type World } from "./entities";
import { playGroups } from "./groups";
import { duckRounds } from "./reactions";
import { duckAtDesk } from "./boss";
import { hireOf } from "./hire";
import { activity, dayPart, pickIdle } from "./idle";
import { enter, landing, walkTo } from "./move";
import type { IdleState, Staff } from "./sessions";

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
/** An idle worker who hasn't got where they were going in this long picks again. */
export const TRAVEL_MAX = 90_000;
/** With nowhere free to go, an idle worker looks again after this. */
export const IDLE_RETRY = 5000;

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
    const hire = job ? undefined : hireOf(staff, id);
    if (hire) {
      staff.plans.delete(id);
      w.tag = null;
      w.overhead = null;
      if (isStatusBubble(w.bubble)) w.bubble = null;
      leaveIdle(staff, id);
      staff.spots.delete(id);
      if (w.seat === hire.desk && !w.walk) pose(w, "relax", "up", ms);
      else toDesk(office, w, hire.desk, ms);
    } else if (!job) {
      staff.plans.delete(id);
      w.tag = null;
      w.overhead = null;
      if (isStatusBubble(w.bubble)) w.bubble = null;
      // Nothing to do yet, after the start: just let go, so the kitchen first.
      idle(office, staff, w, ms, instant, !instant && !staff.idle.has(id), true);
    } else {
      const since = staff.phases.get(job.instance.id);
      const want = doing(job.instance, job.instance.phase === "done" && since ? ms - since.at : 0);
      const plan = choose(staff.plans.get(id), want, job.instance.phase, ms, instant);
      staff.plans.set(id, plan);
      w.tag = job.tag;
      if (want.bubble || isStatusBubble(w.bubble)) w.bubble = want.bubble;
      go(office, staff, w, job.desk, cheering(staff, id, ms) ? cheer(plan) : plan, ms, instant);
      // At the desk, the monitor says they're working.
      w.overhead = want.overhead === "working" && w.seat === job.desk ? null : want.overhead;
    }
    if (look(w) !== before) changed = true;
  }
  const tv = world.tv;
  const kicker = world.kicker;
  if (playGroups(world, staff, ms) || world.tv !== tv || world.kicker !== kicker) changed = true;
  if (duckRounds(office, world, staff, ms)) changed = true;
  if (duckAtDesk(world, staff, ms)) changed = true;
  showScreens(office, world, staff);
  return changed;
}

/** Whether `id` is cheering a commit (`reactions.ts`); a cheer over is forgotten. */
function cheering(staff: Staff, id: string, ms: number): boolean {
  const until = staff.cheers.get(id);
  if (until === undefined) return false;
  if (ms < until) return true;
  staff.cheers.delete(id);
  return false;
}

/** `plan` with a cheer in it: up beside the desk, or where they are at a station.
 *  Nobody cheers mid-question or wandered off. */
function cheer(plan: Plan): Plan {
  const { place } = plan.doing;
  if (place.kind === "desk") return { ...plan, doing: { ...plan.doing, place: { kind: "stand" }, anim: "cheer" } };
  if (place.kind === "station") return { ...plan, doing: { ...plan.doing, anim: "cheer" } };
  return plan;
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
      leaveIdle(staff, id);
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
      leaveIdle(staff, id);
      staff.spots.delete(id);
      return stand(office, w, besideDesk(seat), "down", anim, ms, instant, () => staff.settled.add(id));
    }
    case "station": {
      leaveIdle(staff, id);
      const spot = stationFor(office, staff, w, place.station, seat.stand);
      if (!spot) return go(office, staff, w, desk, { ...plan, doing: { ...plan.doing, place: { kind: "desk" }, anim: "type" } }, ms, instant);
      staff.spots.set(id, spot.id);
      // Cheering turns to face the room.
      return stand(office, w, spot, anim === "cheer" ? "down" : spot.face, anim, ms, instant, () => (plan.arrived ??= ms));
    }
    case "about": {
      staff.settled.delete(id);
      // Their desk is the session's: idle anywhere else. An ended session sends them to
      // the kitchen first.
      return idle(office, staff, w, ms, instant, staff.jobs.get(id)?.instance.phase === "ended", false);
    }
  }
}

/** Where someone stands to wave at you: beside the desk, level with the chair, so
 *  their bubble doesn't hide the monitor. */
export function besideDesk(seat: Seat): Point {
  return { x: seat.desk.x + DESK_W + 6, y: seatedAt(seat).y };
}

/** Gets `w` standing at `p` facing `face`, then posing as `anim`. `onto` is for a seat
 *  on furniture (the sofa, a beanbag): nobody can walk there, so they walk up to it and
 *  then settle onto `p` itself, which puts them behind the furniture's front. */
function stand(office: OfficeMap, w: WorkerEntity, p: Point, face: Dir, anim: Anim, ms: number, instant: boolean, arrived?: () => void, onto = false): void {
  const at = landing(office, p);
  const end = onto ? p : at;
  if (instant) Object.assign(w, { x: end.x, y: end.y, prev: { ...end }, seat: null, walk: null, away: false });
  const still = !w.walk && !w.away && w.seat === null;
  if (still && w.x === end.x && w.y === end.y) {
    arrived?.();
    return pose(w, anim, face, ms);
  }
  if (onto && still && w.x === at.x && w.y === at.y) {
    // Got to it: sit down onto the seat (drawn as a short slide).
    Object.assign(w, { x: p.x, y: p.y, prev: { ...at } });
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

/** What `staff.spots` holds for `w`'s idle place: the spot, or `desk:<n>` for home. */
const holdOf = (place: string, w: WorkerEntity) => (place === "home" ? `desk:${w.home}` : place);

/** Done with idle life for now (a session wants them): the activity's place is let go. */
function leaveIdle(staff: Staff, id: string): void {
  if (!staff.idle.delete(id)) return;
  staff.spots.delete(id);
}

/** Whether `desk` has a session on it (or on its way), or someone else holds it. */
function deskTaken(staff: Staff, desk: number, id: string): boolean {
  for (const s of staff.seating.values()) if (s.desk === desk) return true;
  if (staff.hires.some((h) => h.desk === desk)) return true;
  for (const [who, held] of staff.spots) if (who !== id && held === `desk:${desk}`) return true;
  return false;
}

/** Keeps `w` busy with nothing to do: on with their activity, or on to the next one
 *  once it's over (or they can't get there, or their desk is wanted). `kitchenFirst`
 *  sends someone just let go to the kitchen; `homeOk` lets them use their own desk. */
function idle(office: OfficeMap, staff: Staff, w: WorkerEntity, ms: number, instant: boolean, kitchenFirst: boolean, homeOk: boolean): void {
  const id = w.worker.id;
  let s = staff.idle.get(id);
  const over =
    !!s &&
    ((s.until !== null && ms >= s.until) ||
      (s.until === null && ms - s.since > TRAVEL_MAX) ||
      (s.place === "home" && (!homeOk || deskTaken(staff, w.home, id))));
  if (!s || over) {
    staff.idle.delete(id);
    staff.spots.delete(id);
    s = startIdle(office, staff, w, ms, instant, kitchenFirst && !over, homeOk);
  }
  const state = s;
  const doing = activity(state.activity);
  const there = () => void (state.until ??= ms + state.lasts);
  // A group activity may ask for its own pose (a controller on the sofa, the kicker).
  const anim = staff.groupPose.get(id) ?? doing?.anim ?? "idle";
  if (!doing) {
    // Nowhere was free: stand where they are a moment.
    if (!w.walk && w.seat === null) setAnim(w, "idle", ms);
    return;
  }
  if (state.place === "home") {
    if (instant) sitNow(office, w, w.home, ms);
    if (w.seat === w.home && !w.walk) {
      there();
      return pose(w, anim, "up", ms);
    }
    return toDesk(office, w, w.home, ms);
  }
  const spot = office.spots.find((p) => p.id === state.place)!;
  const face = doing.face ?? spot.dir;
  // A pose drawn only one way (watering faces up) would turn them from what they're at.
  stand(office, w, spot, face, ANIMS[anim].dirs.includes(face) ? anim : "idle", ms, instant, there, spot.kind === "sit");
}

/** Picks `w`'s next activity and holds its place; with nothing free, a short wait. */
function startIdle(office: OfficeMap, staff: Staff, w: WorkerEntity, ms: number, instant: boolean, kitchenFirst: boolean, homeOk: boolean): IdleState {
  const id = w.worker.id;
  const held = new Set([...staff.spots].filter(([who]) => who !== id).map(([, spot]) => spot));
  const known = new Set(office.spots.map((p) => p.id));
  const pick = pickIdle({
    likes: w.worker.likes,
    part: dayPart(staff.hour()),
    last: staff.lastIdle.get(id) ?? null,
    kitchenFirst,
    homeOk: homeOk && !deskTaken(staff, w.home, id),
    free: (spot) => known.has(spot) && !held.has(spot),
    company: (a) => [...staff.idle].filter(([who, s]) => who !== id && s.activity === a).length,
    random: staff.random,
  });
  const state: IdleState = pick
    ? { activity: pick.activity.id, place: pick.place, since: ms, lasts: pick.lasts, until: instant ? ms + pick.lasts : null }
    : { activity: "", place: "", since: ms, lasts: IDLE_RETRY, until: ms + IDLE_RETRY };
  staff.idle.set(id, state);
  if (pick) {
    staff.lastIdle.set(id, pick.activity.id);
    staff.spots.set(id, holdOf(pick.place, w));
  }
  return state;
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
