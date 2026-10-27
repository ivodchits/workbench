// Walking (office plan O1.2): sending a worker somewhere, and the 10 Hz step that moves
// them along. A route is the A* path (path.ts) through cell centres, ending exactly on
// the destination; people move one axis at a time, so they always face where they go.
// Someone in the next cell makes them wait; after a second they look for a way round,
// and after three they squeeze past. Getting up puts them behind their chair; sitting
// down puts them on it. Coming in and leaving are walks from and to the door. Duck
// waddles the same routes (O2.3), and nobody waits for anybody over it.

import type { Dir } from "../art/characters";
import { WALK_CELL, cellOf, isFree, reachable, type OfficeMap, type Point } from "../map/build";
import { seatedAt, setAnim, setDuckAnim, type Arrival, type DuckEntity, type WorkerEntity, type World } from "./entities";
import { findPath, nearestFree } from "./path";

/** Pixels per step: 50 px/s, about one stride per walk cycle. */
export const WALK_SPEED = 5;
/** Duck's pixels per step: a waddle, as quick as anyone's walk. */
export const DUCK_SPEED = 5;
/** Steps of waiting before looking for another way round. */
export const REPATH_AFTER = 10;
/** Steps of waiting before walking through whoever is in the way. */
export const SQUEEZE_AFTER = 30;

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const centre = (c: Point): Point => ({ x: c.x * WALK_CELL + WALK_CELL / 2, y: c.y * WALK_CELL + WALK_CELL / 2 });

const fromDoor = new WeakMap<OfficeMap, Uint8Array>();

/** Where someone sent to `to` ends up: `to` itself if it can be reached from the door,
 *  else the centre of the nearest cell that can. */
export function landing(office: OfficeMap, to: Point): Point {
  let mask = fromDoor.get(office);
  if (!mask) fromDoor.set(office, (mask = reachable(office.walk, cellOf(office.door))));
  const c = cellOf(to);
  if (isFree(office.walk, c) && mask[c.y * office.walk.cols + c.x]) return to;
  return centre(nearestFree(office.walk, c, mask) ?? cellOf(office.door));
}

/** Feet positions from `from` to `to`: the centres where the path turns, then `to`. */
function route(office: OfficeMap, from: Point, to: Point, avoid?: (c: Point) => boolean): Point[] | null {
  const cells = findPath(office.walk, cellOf(from), cellOf(to), avoid);
  if (!cells) return null;
  const turns = cells.filter((_, i) => {
    if (i === 0 || i === cells.length - 1) return false;
    const [a, b] = [cells[i - 1], cells[i + 1]];
    return a.x !== b.x && a.y !== b.y;
  });
  return [...turns.map(centre), to];
}

/** Cells where other people are standing (not seated, not away). */
function standing(world: World, me: WorkerEntity): (c: Point) => boolean {
  const cells = world.workers.filter((o) => o !== me && !o.away && o.seat === null).map((o) => cellOf(o));
  return (c) => cells.some((o) => same(o, c));
}

/** Gets up if seated: from the chair to behind it. */
function standUp(office: OfficeMap, w: WorkerEntity): void {
  if (w.seat === null) return;
  const { stand } = office.seats[w.seat];
  w.x = stand.x;
  w.y = stand.y;
  w.prev = { ...stand };
  w.seat = null;
}

/** Sends `w` walking to `to` (or the nearest place that can be reached), doing `then`
 *  on arrival. False if there's no way there from where they are. */
export function walkTo(office: OfficeMap, w: WorkerEntity, to: Point, ms: number, then: Arrival = { kind: "stand" }): boolean {
  if (w.away) return false;
  const goal = then.kind === "leave" ? office.door : then.kind === "sit" ? office.seats[then.seat].stand : landing(office, to);
  const seat = w.seat;
  standUp(office, w);
  const points = route(office, w, goal);
  if (!points) {
    if (seat !== null) sitAt(office, w, seat, ms);
    return false;
  }
  w.walk = { points, then, waited: 0 };
  setAnim(w, "walk", ms);
  return true;
}

/** Comes in at the door and walks to `to`. */
export function enter(office: OfficeMap, w: WorkerEntity, to: Point, ms: number, then?: Arrival): boolean {
  Object.assign(w, { away: false, seat: null, x: office.door.x, y: office.door.y, prev: { ...office.door }, dir: "down" });
  return walkTo(office, w, to, ms, then);
}

/** Walks out through the door. */
export const leave = (office: OfficeMap, w: WorkerEntity, ms: number): boolean => walkTo(office, w, office.door, ms, { kind: "leave" });

function sitAt(office: OfficeMap, w: WorkerEntity, seat: number, ms: number): void {
  const at = seatedAt(office.seats[seat]);
  Object.assign(w, { ...at, prev: at, seat, dir: "up" });
  setAnim(w, "type", ms);
}

/** Sends Duck waddling to `to` (or the nearest place that can be reached); `exact`
 *  ends on `to` itself, off the walkable floor (back behind the boss desk). False if
 *  there's no way there. */
export function waddleTo(office: OfficeMap, d: DuckEntity, to: Point, ms: number, exact = false): boolean {
  const goal = landing(office, to);
  // From behind the boss desk, first out onto the floor.
  const start = landing(office, d);
  const points = route(office, start, goal);
  if (!points) return false;
  if (!same(start, d)) points.unshift(start);
  d.walk = exact && !same(goal, to) ? [...points, to] : points;
  setDuckAnim(d, "waddle", ms);
  return true;
}

/** One sim step for everyone walking; true when anyone moved or changed what they do. */
export function stepWalkers(world: World, office: OfficeMap, ms: number): boolean {
  world.stepAt = ms;
  let changed = false;
  for (const w of world.workers) {
    if (w.prev.x !== w.x || w.prev.y !== w.y) w.prev = { x: w.x, y: w.y };
    if (w.walk) changed = advance(world, office, w, ms) || changed;
  }
  const d = world.duck;
  if (d.prev.x !== d.x || d.prev.y !== d.y) d.prev = { x: d.x, y: d.y };
  if (d.walk) changed = waddle(d, ms) || changed;
  return changed;
}

/** Duck along its walk, one axis at a time like everyone; on arrival it stands there. */
function waddle(d: DuckEntity, ms: number): boolean {
  const points = d.walk!;
  let budget = DUCK_SPEED;
  while (budget > 0 && points.length) {
    const p = points[0];
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    if (!dx && !dy) {
      points.shift();
      continue;
    }
    const across = dx !== 0;
    const step = Math.min(budget, Math.abs(across ? dx : dy));
    if (across) d.x += Math.sign(dx) * step;
    else d.y += Math.sign(dy) * step;
    d.view = across ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    budget -= step;
  }
  if (!points.length) {
    d.walk = null;
    setDuckAnim(d, "idle", ms);
  }
  return true;
}

function advance(world: World, office: OfficeMap, w: WorkerEntity, ms: number): boolean {
  const walk = w.walk!;
  let budget = WALK_SPEED;
  let moved = false;
  while (budget > 0 && walk.points.length) {
    const p = walk.points[0];
    const dx = p.x - w.x;
    const dy = p.y - w.y;
    if (!dx && !dy) {
      walk.points.shift();
      continue;
    }
    // One axis at a time: across first, then along.
    const across = dx !== 0;
    const d = Math.min(budget, Math.abs(across ? dx : dy));
    const next = { x: w.x + (across ? Math.sign(dx) * d : 0), y: w.y + (across ? 0 : Math.sign(dy) * d) };
    const into = cellOf(next);
    if (!same(into, cellOf(w)) && walk.waited < SQUEEZE_AFTER && standing(world, w)(into)) {
      walk.waited++;
      if (walk.waited === REPATH_AFTER) {
        const around = route(office, w, walk.points[walk.points.length - 1], standing(world, w));
        if (around) walk.points = around;
      }
      const was = w.anim;
      setAnim(w, "idle", ms);
      return moved || was !== "idle";
    }
    const dir: Dir = across ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    if (!moved) setAnim(w, "walk", ms);
    Object.assign(w, next, { dir });
    walk.waited = 0;
    budget -= d;
    moved = true;
  }
  if (walk.points.length) return moved;
  arrive(office, w, walk.then, ms);
  return true;
}

function arrive(office: OfficeMap, w: WorkerEntity, then: Arrival, ms: number): void {
  w.walk = null;
  if (then.kind === "sit") return sitAt(office, w, then.seat, ms);
  setAnim(w, "idle", ms);
  if (then.kind === "leave") w.away = true;
  else if (then.face) w.dir = then.face;
}
