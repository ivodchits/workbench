// Lupa, the office dog, and the office ball. She has no session and no job: she roams
// (a wander, a sit, a sniff about, a nap anywhere on the floor, a visit to someone),
// and a click pets her (`petLupa`): she sits up happy for a moment, a heart over her.
//
// The ball lies on the floor and can be picked up, dragged and thrown by the pointer
// (`grabBall`, `holdBall`, `throwBall`); thrown, it flies, bounces and rolls to a stop
// off the walls and the furniture (`stepBall`, on the walk grid). Dragged over Lupa, it
// has her attention: she chases it — follows it while it's held, runs after it once
// thrown — picks it up, brings it to the pointer, drops it there and sits waiting for
// the next throw. Chasing and bringing it back each give up after `PLAY_MAX`, waiting
// after `WAIT_MAX`, and she goes back to roaming.

import type { LupaAnim, LupaView } from "../art/lupa";
import { LUPA_ANIMS, LUPA_H, LUPA_W } from "../art/lupa";
import { WALK_CELL, cellOf, isFree, reachable, type OfficeMap, type Point } from "../map/build";
import { SIM_STEP } from "../loop";
import { play, type Clip, type Playing } from "./anim";
import { landing, route } from "./move";

/** What Lupa does with herself, unasked. */
export type Roam = "wander" | "sit" | "sniff" | "sleep" | "visit";

export type LupaMood =
  /** On her own: `until` is when she picks again, null while she's on her way. */
  | { kind: "roam"; doing: Roam; until: number | null; since: number }
  /** After the ball: `since` counts from when it was last let go of. */
  | { kind: "chase"; since: number }
  /** Bringing it back to the pointer. */
  | { kind: "fetch"; since: number }
  /** Dropped it by you; sitting, waiting for a throw. */
  | { kind: "wait"; since: number }
  /** Being petted till `until`, then back to `after`. */
  | { kind: "petted"; until: number; after: LupaMood };

export interface LupaEntity {
  x: number;
  y: number;
  prev: Point;
  view: LupaView;
  anim: LupaAnim;
  playing: Playing;
  /** Feet positions still to reach. */
  walk: Point[] | null;
  /** Where `walk` ends, to tell when the target has moved. */
  goal: Point | null;
  mood: LupaMood;
  /** The ball is in her mouth. */
  carrying: boolean;
  /** A held ball was over her last step: it's bringing it over her that gets her
   *  attention, not leaving it there once she's lost interest. */
  ballOver?: boolean;
}

export interface Ball {
  x: number;
  y: number;
  /** Height off the floor, px. */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  prev: { x: number; y: number; z: number };
  /** In the pointer's hand. */
  held: boolean;
  /** In Lupa's mouth (then it's drawn with her). */
  carried: boolean;
}

/** Chasing, or bringing it back, gives up after this. */
export const PLAY_MAX = 30_000;
/** Waiting for a throw gives up after this. */
export const WAIT_MAX = 20_000;
/** A pet lasts this long. */
export const PET_MS = 1800;
/** A trip somewhere that takes longer than this is given up. */
const TRAVEL_MAX = 40_000;

/** Pixels per step: walking, running after the ball, trotting it back. */
export const LUPA_WALK = 3;
export const LUPA_RUN = 9;
export const LUPA_TROT = 5;
/** Close enough to the ball to pick it up (and low enough). */
const GRAB_PX = 6;
const GRAB_Z = 4;
/** Close enough to the pointer to drop it. */
const DROP_PX = 14;
/** While the ball is held, she keeps about this close to it. */
const HEEL_PX = 14;

/** Ball physics, per step: gravity, the bounce kept, rolling and air friction, the
 *  wall's bounce kept, the slowest roll that still moves, the fastest throw. */
const GRAVITY = 1.6;
const BOUNCE = 0.5;
const ROLL = 0.86;
const AIR = 0.98;
const WALL = 0.6;
const REST = 0.2;
export const THROW_MAX = 26;
/** How high a held ball is carried. */
export const HELD_Z = 8;
const SUBSTEPS = 4;

const clips = new Map<LupaAnim, Clip>();
const clipOf = (anim: LupaAnim): Clip => {
  let c = clips.get(anim);
  if (!c) clips.set(anim, (c = { durations: LUPA_ANIMS[anim].frames.map((f) => f.ms) }));
  return c;
};

export function setLupaAnim(l: LupaEntity, anim: LupaAnim, ms: number): void {
  if (l.anim === anim) return;
  l.anim = anim;
  l.playing = play(clipOf(anim), ms);
}

export function createLupa(at: Point, ms = 0): LupaEntity {
  return {
    ...at,
    prev: { ...at },
    view: "right",
    anim: "sleep",
    playing: play(clipOf("sleep"), ms),
    walk: null,
    goal: null,
    mood: { kind: "roam", doing: "sleep", until: ms + 60_000, since: ms },
    carrying: false,
  };
}

export function createBall(at: Point): Ball {
  return { ...at, z: 0, vx: 0, vy: 0, vz: 0, prev: { ...at, z: 0 }, held: false, carried: false };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whether (x, y) is on Lupa's sprite. */
export function onLupa(l: LupaEntity, x: number, y: number): boolean {
  const h = l.anim === "sleep" ? 9 : LUPA_H;
  return x >= l.x - LUPA_W / 2 && x < l.x + LUPA_W / 2 && y >= l.y - h && y < l.y;
}

/** Whether (x, y) is on the ball (a little slack: it's small). */
export function onBall(b: Ball, x: number, y: number): boolean {
  return !b.carried && Math.abs(x - b.x) <= 4 && y >= b.y - b.z - 6 && y <= b.y - b.z + 2;
}

// ── The ball ─────────────────────────────────────────────────────────────────

const blockedAt = (office: OfficeMap, x: number, y: number) => !isFree(office.walk, cellOf({ x, y }));

/** Picks the ball up (out of her mouth, if it's there): it follows the pointer. */
export function grabBall(b: Ball, l: LupaEntity, x: number, y: number, ms: number): void {
  b.held = true;
  b.carried = false;
  if (l.carrying) {
    l.carrying = false;
    // Snatched from her: she wants it back.
    l.mood = { kind: "chase", since: ms };
  } else if (l.mood.kind === "wait") l.mood = { kind: "chase", since: ms };
  holdBall(b, x, y);
  b.prev = { x: b.x, y: b.y, z: b.z };
}

/** The held ball, at the pointer (`x`, `y`): up off the floor, its shadow under it. */
export function holdBall(b: Ball, x: number, y: number): void {
  Object.assign(b, { x, y: y + HELD_Z, z: HELD_Z, vx: 0, vy: 0, vz: 0 });
}

/** Lets go of the ball with the pointer's velocity (px per step): thrown, or dropped
 *  when still. Let go over furniture, it lands on the nearest floor. */
export function throwBall(office: OfficeMap, b: Ball, l: LupaEntity, vx: number, vy: number, ms: number): void {
  b.held = false;
  if (blockedAt(office, b.x, b.y)) Object.assign(b, landing(office, b));
  const speed = Math.hypot(vx, vy);
  const k = speed > THROW_MAX ? THROW_MAX / speed : 1;
  b.vx = vx * k;
  b.vy = vy * k;
  b.vz = Math.min(4, (speed * k) / 6);
  b.prev = { x: b.x, y: b.y, z: b.z };
  // The chase's time runs from the throw.
  if (l.mood.kind === "chase") l.mood = { kind: "chase", since: ms };
}

/** One step of the ball flying, bouncing and rolling; true when it moved. */
export function stepBall(office: OfficeMap, b: Ball): boolean {
  b.prev = { x: b.x, y: b.y, z: b.z };
  if (b.held || b.carried) return false;
  if (!b.vx && !b.vy && !b.vz && !b.z) return false;
  const dt = 1 / SUBSTEPS;
  for (let i = 0; i < SUBSTEPS; i++) {
    b.vz -= GRAVITY * dt;
    b.z += b.vz * dt;
    if (b.z <= 0) {
      b.z = 0;
      b.vz = b.vz < -GRAVITY ? -b.vz * BOUNCE : 0;
    }
    const keep = (b.z > 0 ? AIR : ROLL) ** dt;
    b.vx *= keep;
    b.vy *= keep;
    // Off whatever it hits, an axis at a time.
    const nx = b.x + b.vx * dt;
    if (blockedAt(office, nx, b.y)) b.vx = -b.vx * WALL;
    else b.x = nx;
    const ny = b.y + b.vy * dt;
    if (blockedAt(office, b.x, ny)) b.vy = -b.vy * WALL;
    else b.y = ny;
  }
  if (b.z === 0 && !b.vz && Math.hypot(b.vx, b.vy) < REST) b.vx = b.vy = 0;
  return true;
}

// ── Lupa ─────────────────────────────────────────────────────────────────────

/** What Lupa needs to know about the rest of the office each step. */
export interface LupaSense {
  /** Where the pointer is over the office, null when it's off it. */
  pointer: Point | null;
  /** People she can go and sit by. */
  people: () => Point[];
  /** The part of the day: she sleeps more at night. */
  night: boolean;
  random: () => number;
}

/** Floor cells she can nap on: reachable, with room either side for her length. */
const beds = new WeakMap<OfficeMap, Point[]>();
function napCells(office: OfficeMap): Point[] {
  let cells = beds.get(office);
  if (cells) return cells;
  const mask = reachable(office.walk, cellOf(office.door));
  const ok = (x: number, y: number) => isFree(office.walk, { x, y }) && mask[y * office.walk.cols + x] === 1;
  cells = [];
  for (let y = 0; y < office.walk.rows; y++) for (let x = 1; x < office.walk.cols - 1; x++) if (ok(x, y) && ok(x - 1, y) && ok(x + 1, y)) cells.push({ x, y });
  beds.set(office, cells);
  return cells;
}

const centre = (c: Point): Point => ({ x: c.x * WALK_CELL + WALK_CELL / 2, y: c.y * WALK_CELL + WALK_CELL / 2 + 2 });

/** Sets off for `to` (the nearest floor to it); false when there's no way. */
function goTo(office: OfficeMap, l: LupaEntity, to: Point): boolean {
  const goal = landing(office, to);
  const start = landing(office, l);
  const points = route(office, start, goal);
  if (!points) return false;
  if (start.x !== l.x || start.y !== l.y) points.unshift(start);
  l.walk = points;
  l.goal = goal;
  return true;
}

/** Along her walk by `speed`, one axis at a time; true when she got there. */
function along(l: LupaEntity, speed: number): boolean {
  const points = l.walk;
  if (!points) return true;
  let budget = speed;
  while (budget > 0 && points.length) {
    const p = points[0];
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    if (!dx && !dy) {
      points.shift();
      continue;
    }
    const across = dx !== 0;
    const step = Math.min(budget, Math.abs(across ? dx : dy));
    if (across) l.x += Math.sign(dx) * step;
    else l.y += Math.sign(dy) * step;
    l.view = across ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    budget -= step;
  }
  if (points.length) return false;
  l.walk = null;
  l.goal = null;
  return true;
}

/** Straight at `p` (the last few pixels to the ball); true when there. */
function straightAt(l: LupaEntity, p: Point, speed: number): boolean {
  const d = dist(l, p);
  if (d <= speed) {
    Object.assign(l, { x: p.x, y: p.y });
    return true;
  }
  const dx = p.x - l.x;
  const dy = p.y - l.y;
  l.x += (dx / d) * speed;
  l.y += (dy / d) * speed;
  l.view = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return false;
}

/** Heads for `target`, path-finding again whenever it's moved to another cell. True
 *  when she's there. */
function pursue(office: OfficeMap, l: LupaEntity, target: Point, speed: number, near: number): boolean {
  if (dist(l, target) <= near) {
    l.walk = null;
    l.goal = null;
    return true;
  }
  // Close, and nothing in the way: straight at it.
  if (dist(l, target) < WALK_CELL * 2 && !blockedAt(office, target.x, target.y)) {
    l.walk = null;
    straightAt(l, target, speed);
    return dist(l, target) <= near;
  }
  const goal = landing(office, target);
  const moved = !l.goal || cellOf(l.goal).x !== cellOf(goal).x || cellOf(l.goal).y !== cellOf(goal).y;
  if ((moved || !l.walk) && !goTo(office, l, target)) return false;
  along(l, speed);
  return false;
}

/** Faces `p`, side on (or down at it when it's straight below). */
function faceTo(l: LupaEntity, p: Point): void {
  const dx = p.x - l.x;
  l.view = Math.abs(dx) < 3 ? "down" : dx > 0 ? "right" : "left";
}

/** The weights of what she does next on her own. */
function pickRoam(sense: LupaSense, last: Roam): Roam {
  const w: Record<Roam, number> = { wander: 3, sit: 2, sniff: 1.5, sleep: sense.night ? 6 : 2, visit: 1.2 };
  w[last] *= 0.3;
  const total = Object.values(w).reduce((s, n) => s + n, 0);
  let r = sense.random() * total;
  for (const k of Object.keys(w) as Roam[]) if ((r -= w[k]) < 0) return k;
  return "sit";
}

const between = (random: () => number, lo: number, hi: number) => lo + random() * (hi - lo);

/** Starts something new on her own. */
function roam(office: OfficeMap, l: LupaEntity, sense: LupaSense, ms: number, last: Roam): void {
  const doing = pickRoam(sense, last);
  const r = sense.random;
  l.walk = null;
  l.goal = null;
  const at = (until: number | null): LupaMood => ({ kind: "roam", doing, until, since: ms });
  if (doing === "sit") {
    l.mood = at(ms + between(r, 6000, 15000));
    return;
  }
  let to: Point | null = null;
  if (doing === "sleep" || doing === "wander") {
    const cells = napCells(office);
    to = cells.length ? centre(cells[Math.floor(r() * cells.length)]) : null;
  } else if (doing === "sniff") {
    to = { x: l.x + between(r, -48, 48), y: l.y + between(r, -24, 24) };
  } else {
    const people = sense.people();
    const p = people[Math.floor(r() * people.length)];
    to = p ? { x: p.x + (r() < 0.5 ? -14 : 14), y: p.y + 2 } : null;
  }
  l.mood = at(null);
  if (!to || !goTo(office, l, to)) l.mood = { kind: "roam", doing: "sit", until: ms + 5000, since: ms };
}

/** Pets her: a happy moment sitting up, then on with what she was doing; busy with the
 *  ball, she takes it on the run. True when she stopped for it. */
export function petLupa(l: LupaEntity, ms: number): boolean {
  const m = l.mood;
  if (m.kind === "chase" || m.kind === "fetch") return false;
  if (m.kind === "petted") {
    m.until = ms + PET_MS;
    return true;
  }
  l.walk = null;
  l.goal = null;
  l.mood = { kind: "petted", until: ms + PET_MS, after: m };
  return true;
}

/** One step of Lupa; true when the picture changed. */
export function stepLupa(office: OfficeMap, l: LupaEntity, b: Ball, sense: LupaSense, ms: number): boolean {
  if (l.prev.x !== l.x || l.prev.y !== l.y) l.prev = { x: l.x, y: l.y };
  const before = `${l.anim}|${l.view}|${l.carrying}`;
  const m = l.mood;

  // A ball brought over her gets her attention, whatever she's at.
  const over = b.held && onLupa(l, b.x, b.y - b.z);
  const arrived = over && !l.ballOver;
  l.ballOver = over;
  if (arrived && m.kind !== "chase") {
    l.mood = { kind: "chase", since: ms };
    l.walk = null;
    l.goal = null;
  }
  act(office, l, b, sense, ms);
  if (l.carrying) Object.assign(b, { x: l.x, y: l.y, z: 0, vx: 0, vy: 0, vz: 0 });
  return before !== `${l.anim}|${l.view}|${l.carrying}` || l.prev.x !== l.x || l.prev.y !== l.y;
}

function act(office: OfficeMap, l: LupaEntity, b: Ball, sense: LupaSense, ms: number): void {
  const m = l.mood;
  switch (m.kind) {
    case "petted": {
      if (ms < m.until) {
        if (l.anim !== "sleep") l.view = "down";
        return setLupaAnim(l, "happy", ms);
      }
      const after = m.after;
      // Back to sleep, or to sitting; anything else is picked anew.
      if (after.kind === "roam" && (after.doing === "sleep" || after.doing === "sit") && after.until !== null) l.mood = after;
      else if (after.kind === "wait") l.mood = after;
      else roam(office, l, sense, ms, after.kind === "roam" ? after.doing : "sit");
      return;
    }
    case "chase": {
      if (ms - m.since > PLAY_MAX) return giveUp(l, sense, ms);
      if (b.held) {
        // Heeling the ball in your hand, panting at it.
        const below = { x: b.x, y: b.y + 4 };
        if (pursue(office, l, below, LUPA_RUN, HEEL_PX)) {
          faceTo(l, b);
          return setLupaAnim(l, l.view === "down" ? "pant" : "idle", ms);
        }
        return setLupaAnim(l, "run", ms);
      }
      if (dist(l, b) <= GRAB_PX && b.z <= GRAB_Z) {
        l.carrying = true;
        b.carried = true;
        l.mood = { kind: "fetch", since: ms };
        return setLupaAnim(l, "idle", ms);
      }
      pursue(office, l, b, LUPA_RUN, 0);
      return setLupaAnim(l, "run", ms);
    }
    case "fetch": {
      if (ms - m.since > PLAY_MAX) {
        drop(office, l, b);
        return giveUp(l, sense, ms);
      }
      const to = sense.pointer;
      if (!to || pursue(office, l, to, LUPA_TROT, DROP_PX)) {
        if (!to) return setLupaAnim(l, "idle", ms);
        drop(office, l, b);
        l.view = "down";
        l.mood = { kind: "wait", since: ms };
        return setLupaAnim(l, "pant", ms);
      }
      return setLupaAnim(l, "walk", ms);
    }
    case "wait": {
      if (ms - m.since > WAIT_MAX) return giveUp(l, sense, ms);
      l.view = "down";
      return setLupaAnim(l, "pant", ms);
    }
    case "roam": {
      if (m.until !== null) {
        if (ms >= m.until) return roam(office, l, sense, ms, m.doing);
        return settle(l, m.doing, ms);
      }
      if (ms - m.since > TRAVEL_MAX) return roam(office, l, sense, ms, m.doing);
      if (!along(l, LUPA_WALK)) return setLupaAnim(l, "walk", ms);
      // Got there.
      const r = sense.random;
      const stay = m.doing === "sleep" ? between(r, 40_000, 120_000) : m.doing === "visit" ? between(r, 6000, 12_000) : between(r, 2500, 7000);
      m.until = ms + stay;
      if (m.doing === "visit") {
        const near = sense.people().sort((a, c) => dist(a, l) - dist(c, l))[0];
        if (near) faceTo(l, near);
      }
      return settle(l, m.doing, ms);
    }
  }
}

/** The pose for staying at what she's doing. */
function settle(l: LupaEntity, doing: Roam, ms: number): void {
  if (doing === "sleep") {
    if (l.view !== "left" && l.view !== "right") l.view = "right";
    return setLupaAnim(l, "sleep", ms);
  }
  if (doing === "sit" || doing === "visit") {
    l.view = "down";
    return setLupaAnim(l, "sit", ms);
  }
  if (doing === "sniff") {
    if (l.view !== "left" && l.view !== "right") l.view = "right";
    return setLupaAnim(l, "sniff", ms);
  }
  setLupaAnim(l, "idle", ms);
}

/** Drops the ball in front of her, onto the floor. */
function drop(office: OfficeMap, l: LupaEntity, b: Ball): void {
  if (!l.carrying) return;
  l.carrying = false;
  b.carried = false;
  const ahead = l.view === "right" ? 10 : l.view === "left" ? -10 : 0;
  const at = { x: l.x + ahead, y: l.y + (l.view === "down" ? 3 : l.view === "up" ? -3 : 0) };
  Object.assign(b, blockedAt(office, at.x, at.y) ? landing(office, at) : at, { z: 4, vx: 0, vy: 0, vz: 0 });
  b.prev = { x: b.x, y: b.y, z: b.z };
}

/** Bored of it: back to roaming, from a sit (the ball dropped first, if she has it). */
function giveUp(l: LupaEntity, sense: LupaSense, ms: number): void {
  l.walk = null;
  l.goal = null;
  l.mood = { kind: "roam", doing: "sit", until: ms + between(sense.random, 3000, 8000), since: ms };
}

/** What she's up to, in a few words, for her tooltip. */
export function lupaDoing(l: LupaEntity): string {
  const m = l.mood;
  if (m.kind === "petted") return "being petted";
  if (m.kind === "chase") return "after the ball";
  if (m.kind === "fetch") return "bringing the ball back";
  if (m.kind === "wait") return "waiting for a throw";
  if (m.until === null) return m.doing === "sleep" ? "looking for a nap spot" : "trotting about";
  return { wander: "looking about", sit: "sitting", sniff: "sniffing about", sleep: "asleep", visit: "keeping someone company" }[m.doing];
}

/** Steps per second, for turning the pointer's px/ms into a throw's px/step. */
export const PER_STEP = SIM_STEP;
