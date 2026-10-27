// What workers with nothing to do get up to (office plan O2.1). Nobody ever leaves the
// office: an idle worker picks an activity — a coffee, the water cooler, the sofa, a
// book, the plants, a stroll, the paper at their own desk… — goes there, stays a while,
// and picks another. What they pick is weighted by what they like (`Worker.likes`) and
// the time of day (lunch in the kitchen; at night the quiet things), never the same
// thing twice running, and only where nobody else already is: each spot (or desk) is
// held by one person from the moment they choose it. A new activity is one more entry
// in `ACTIVITIES` (and, for a new place, a spot in `map/office.ts`).

import type { Anim, Dir } from "../art/characters";

/** The parts of the day that change what people feel like doing. */
export type DayPart = "day" | "lunch" | "night";

export function dayPart(hour: number): DayPart {
  if (hour < 7 || hour >= 22) return "night";
  if (hour >= 12 && hour < 14) return "lunch";
  return "day";
}

export interface IdleActivity {
  id: string;
  /** Spot ids it's done at (any free one), or `home` for the worker's own desk. */
  at: readonly string[] | "home";
  anim: Anim;
  /** Which way to face there; the spot's own way when unset. */
  face?: Dir;
  /** How long it lasts once they're there, ms: somewhere between the two. */
  lasts: readonly [number, number];
  /** How likely it is, against the others. */
  weight: number;
  /** How much likelier (or less) at each part of the day; 1 where unset. */
  times?: Partial<Record<DayPart, number>>;
  /** Where people go first when their session ends: the kitchen. */
  kitchen?: boolean;
}

const MIN = 60_000;
const QUIET = { night: 3 } as const;
const BUSY_PLACE = { night: 0.3 } as const;

export const ACTIVITIES: readonly IdleActivity[] = [
  { id: "coffee", at: ["coffee"], anim: "drink", face: "down", lasts: [1 * MIN, 3 * MIN], weight: 3, times: { lunch: 3, night: 0.5 }, kitchen: true },
  { id: "snack", at: ["fridge"], anim: "idle", face: "up", lasts: [0.4 * MIN, 1 * MIN], weight: 1, times: { lunch: 4, night: 0.5 }, kitchen: true },
  { id: "dishes", at: ["sink"], anim: "tinker", face: "up", lasts: [1 * MIN, 2 * MIN], weight: 1, times: { lunch: 2 }, kitchen: true },
  { id: "cooler", at: ["cooler", "cooler-2", "cooler-3"], anim: "drink", lasts: [2 * MIN, 5 * MIN], weight: 3, times: { lunch: 2, ...BUSY_PLACE }, kitchen: true },
  { id: "sofa", at: ["sofa-1", "sofa-2", "sofa-3"], anim: "relax", face: "up", lasts: [3 * MIN, 8 * MIN], weight: 2, times: QUIET },
  { id: "beanbag", at: ["beanbag-1", "beanbag-2"], anim: "relax", face: "up", lasts: [3 * MIN, 6 * MIN], weight: 1.5, times: QUIET },
  { id: "window", at: ["window-lounge", "window-demiurge", "window-demiurge-2"], anim: "idle", face: "up", lasts: [1 * MIN, 4 * MIN], weight: 1.5, times: QUIET },
  { id: "books", at: ["books-demiurge", "books-boss"], anim: "file", face: "up", lasts: [1 * MIN, 3 * MIN], weight: 1.5 },
  { id: "plants", at: ["plant-demiurge", "plant-demiurge-tall", "plant-lounge", "plant-lounge-tall", "plant-kitchen"], anim: "tinker", lasts: [0.5 * MIN, 1.5 * MIN], weight: 1 },
  { id: "doodle", at: ["board-demiurge", "pitch-board"], anim: "board", face: "up", lasts: [1 * MIN, 3 * MIN], weight: 1, times: BUSY_PLACE },
  { id: "stroll", at: ["stroll-hall", "stroll-open", "stroll-tinywizard", "stroll-lounge"], anim: "idle", lasts: [0.3 * MIN, 0.8 * MIN], weight: 1.5, times: BUSY_PLACE },
  { id: "desk", at: "home", anim: "newspaper", lasts: [2 * MIN, 6 * MIN], weight: 1.5, times: QUIET },
];

const BY_ID = new Map(ACTIVITIES.map((a) => [a.id, a]));
export const activity = (id: string): IdleActivity | undefined => BY_ID.get(id);

/** How much likelier a worker is to pick what they like. */
export const LIKED = 3;

export interface Pick {
  activity: IdleActivity;
  /** The spot id, or `home`. */
  place: string;
  /** How long it lasts once there, ms. */
  lasts: number;
}

export interface PickInput {
  likes: readonly string[];
  part: DayPart;
  /** What they did last: not again straight away. */
  last: string | null;
  /** Only the kitchen's activities, if one is free (their session just ended). */
  kitchenFirst: boolean;
  /** Whether their own desk may be used. */
  homeOk: boolean;
  /** Whether a spot is free for them. */
  free: (spot: string) => boolean;
  random: () => number;
  activities?: readonly IdleActivity[];
}

/** Picks what to do next and where; null when nothing has a free place. Pure. */
export function pickIdle(input: PickInput): Pick | null {
  const all = input.activities ?? ACTIVITIES;
  const places = (a: IdleActivity) => (a.at === "home" ? (input.homeOk ? ["home"] : []) : a.at.filter(input.free));
  const open = all.filter((a) => a.id !== input.last && places(a).length > 0);
  const kitchen = open.filter((a) => a.kitchen);
  const pool = input.kitchenFirst && kitchen.length ? kitchen : open;
  const weight = (a: IdleActivity) => a.weight * (input.likes.includes(a.id) ? LIKED : 1) * (a.times?.[input.part] ?? 1);
  const total = pool.reduce((sum, a) => sum + weight(a), 0);
  if (total <= 0) return null;
  let r = input.random() * total;
  const chosen = pool.find((a) => (r -= weight(a)) < 0) ?? pool[pool.length - 1];
  const where = places(chosen);
  const place = where[Math.floor(input.random() * where.length)] ?? where[0];
  const [lo, hi] = chosen.lasts;
  return { activity: chosen, place, lasts: lo + input.random() * (hi - lo) };
}
