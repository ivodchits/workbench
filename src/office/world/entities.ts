// The office's people (office plans O1.1, O1.2): a worker per roster entry and Duck,
// each with a position, a facing, the animation playing, what floats over them, and for
// workers the walk they're on. Plain data, no drawing: the sim (move.ts) changes it,
// render.ts draws it.

import type { KickerMatch } from "./groups";
import { ANIMS, FRAME_H, FRAME_W, type Anim, type Dir } from "../art/characters";
import { DUCK_ANIMS, DUCK_H, DUCK_W, type DuckAnim, type DuckView } from "../art/duck";
import type { BubbleTone, Overhead, TagGlyph } from "../art/labels";
import type { OfficeMap, Point, Seat } from "../map/build";
import { ROSTER, type Team, type Worker } from "../roster";
import { play, type Clip, type Playing } from "./anim";

export interface Bubble {
  text: string;
  tone: BubbleTone;
  /** Flashes between its tone and the plain "needs you" one (office plan O1.4). */
  pulse?: boolean;
}

/** What every entity has. `x`, `y` are the feet (the sprite's bottom centre), and
 *  depth sorts by `y`. */
interface Body {
  x: number;
  y: number;
  /** Where the feet were before the last step; drawing slides from here to `x`, `y`. */
  prev: Point;
  playing: Playing;
  bubble: Bubble | null;
}

export interface WorkerEntity extends Body {
  kind: "worker";
  worker: Worker;
  dir: Dir;
  anim: Anim;
  /** The desk whose chair they're on (no shadow, the chair hides the legs), if any. */
  seat: number | null;
  /** The desk they sit at when they have nowhere else to be. */
  home: number;
  walk: Walk | null;
  /** Out of the office: not drawn, not hit. */
  away: boolean;
  overhead: Overhead | null;
  /** The status glyph on the name tag; none when there's no session. */
  tag: TagGlyph | null;
}

/** What happens at the end of a walk. */
export type Arrival = { kind: "stand"; face?: Dir } | { kind: "sit"; seat: number } | { kind: "leave" };

export interface Walk {
  /** Feet positions still to reach, in order; the last is the destination. */
  points: Point[];
  then: Arrival;
  /** Steps spent waiting for someone to get out of the way. */
  waited: number;
}

export interface DuckEntity extends Body {
  kind: "duck";
  view: DuckView;
  anim: DuckAnim;
  /** Feet positions still to reach while waddling somewhere (office plan O2.3). */
  walk: Point[] | null;
}

export type Entity = WorkerEntity | DuckEntity;

/** What a desk's monitor shows; a contractor's desk has a laptop instead. */
export type Screen = "off" | "code" | "alert" | "laptop";

/** A session with no worker free for it, at a desk of its own (office plan O1.3). */
export interface Contractor {
  desk: number;
  tag: TagGlyph | null;
  /** The `!`/`?` when the session needs you (office plan O1.4). */
  bubble: Bubble | null;
}

export interface World {
  workers: WorkerEntity[];
  duck: DuckEntity;
  /** By seat index. */
  screens: Screen[];
  contractors: Contractor[];
  /** When the sim last stepped, ms: drawing slides people between steps from here. */
  stepAt: number;
  /** The lounge TV is on: someone's playing on the console (office plan O2.2). */
  tv: boolean;
  /** The kicker match being played, if any. */
  kicker: KickerMatch | null;
}

const clips = new Map<string, Clip>();

export function workerClip(anim: Anim): Clip {
  let clip = clips.get(anim);
  if (!clip) clips.set(anim, (clip = { durations: ANIMS[anim].frames.map((f) => f.ms) }));
  return clip;
}

export function duckClip(anim: DuckAnim): Clip {
  const key = `duck/${anim}`;
  let clip = clips.get(key);
  if (!clip) clips.set(key, (clip = { durations: DUCK_ANIMS[anim].map((f) => f.ms) }));
  return clip;
}

/** Switch a worker's animation at `ms`; the same one keeps playing undisturbed. */
export function setAnim(w: WorkerEntity, anim: Anim, ms: number): void {
  if (w.anim === anim) return;
  w.anim = anim;
  w.playing = play(workerClip(anim), ms);
}

export function setDuckAnim(d: DuckEntity, anim: DuckAnim, ms: number): void {
  if (d.anim === anim) return;
  d.anim = anim;
  d.playing = play(duckClip(anim), ms);
}

/** Each team fills its own room's desks in roster order; by desk index. */
export function homeDesks(seats: readonly Seat[]): Map<number, Worker> {
  const room: Record<Team, Seat["room"]> = { demiurge: "demiurge", tinywizard: "tinywizard", open: "open" };
  const seated = new Map<number, Worker>();
  for (const team of Object.keys(room) as Team[]) {
    const mine = seats.filter((s) => s.room === room[team]);
    ROSTER.filter((w) => w.team === team).forEach((w, i) => seated.set(mine[i].index, w));
  }
  return seated;
}

/** Where a seated worker's feet are: their sprite's top-left is `seat.sit`. */
export function seatedAt(seat: Seat): { x: number; y: number } {
  return { x: seat.sit.x + FRAME_W / 2, y: seat.sit.y + FRAME_H };
}

/** Everyone at their home desk, typing, back to the camera; Duck behind the boss desk.
 *  Clips start offset by where people sit, so neighbours don't move in step. */
export function createWorld(office: OfficeMap, ms = 0): World {
  const seated = homeDesks(office.seats);
  const workers: WorkerEntity[] = [];
  for (const seat of office.seats) {
    const worker = seated.get(seat.index);
    if (!worker) continue;
    const at = seatedAt(seat);
    workers.push({
      kind: "worker",
      worker,
      ...at,
      prev: at,
      dir: "up",
      anim: "type",
      seat: seat.index,
      walk: null,
      away: false,
      playing: play(workerClip("type"), ms - seat.sit.x * 53),
      home: seat.index,
      overhead: null,
      tag: null,
      bubble: null,
    });
  }
  const duckAt = { x: office.duck.x + DUCK_W / 2, y: office.duck.y + DUCK_H };
  const duck: DuckEntity = {
    kind: "duck",
    ...duckAt,
    prev: duckAt,
    view: "down",
    anim: "idle",
    playing: play(duckClip("idle"), ms),
    bubble: null,
    walk: null,
  };
  const screens = office.seats.map((s): Screen => (seated.has(s.index) ? "code" : "off"));
  return { workers, duck, screens, contractors: [], stepAt: ms, tv: false, kicker: null };
}

/** The frontmost worker whose sprite covers (x, y). */
export function workerAt(world: World, x: number, y: number): WorkerEntity | undefined {
  let hit: WorkerEntity | undefined;
  for (const w of world.workers) {
    if (w.away) continue;
    const inside = x >= w.x - FRAME_W / 2 && x < w.x + FRAME_W / 2 && y >= w.y - FRAME_H && y < w.y;
    if (inside && (!hit || w.y >= hit.y)) hit = w;
  }
  return hit;
}
