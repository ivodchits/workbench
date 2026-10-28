// Star run's sectors (office plan O5.3b): everything ahead of the ship, generated from the
// run's seed one sector at a time, so a seed always flies the same. A sector is a list of
// spawns by distance — asteroid fields and enemy formations on their flight paths — and
// its number sets the heat: how many, how fast, how tough and how often they shoot.
// Sectors come in zones of three (O5.3c), each with its own palette and its own mix of
// enemies, and a boss at the end of each; the zone's last sector clears out early for it.

export const SR_W = 160;
export const SR_H = 224;
/** A sector's length, in pixels of scroll. */
export const SECTOR_LEN = 800;
/** The first stretch of a sector stays empty while its name shows. */
const QUIET = 60;

/** Sectors in a zone; a boss waits at the end of the last. */
export const ZONE_SECTORS = 3;
/** How many palettes the zones go through (they're drawn in `draw.ts`). */
export const PALETTES = 5;
/** Distance the last sector of a zone keeps clear before the boss. */
const BOSS_CLEAR = 220;

/** Dice from a seed (mulberry32): the same rolls every time. */
export function dice(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two numbers stirred into one, for a sector's own seed out of the run's. */
export function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) | 0, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

export type EnemyKind = "dart" | "swoop" | "gunner" | "diver";

/** A flight path, as a function of the steps since it came on (`pathAt`). */
export interface Path {
  x: number;
  vx: number;
  vy: number;
  /** A weave across: its size, its speed (radians a step) and where it starts. */
  amp: number;
  w: number;
  phase: number;
  /** Stops at this height for `hold` steps (a gunner), then goes on down. */
  stop?: number;
  hold?: number;
  /** After this many steps it turns on the ship and dives (a diver). */
  dive?: number;
}

export interface EnemySpawn {
  type: "enemy";
  /** Distance into the sector it comes on at. */
  at: number;
  kind: EnemyKind;
  path: Path;
  hp: number;
  /** Steps between its shots, 0 for none, and their speed. */
  fire: number;
  shot: number;
}

export interface RockSpawn {
  type: "rock";
  at: number;
  x: number;
  vx: number;
  vy: number;
  /** 0 small, 1 middling, 2 big; a hit big one splits in two of the next size down. */
  size: 0 | 1 | 2;
  /** Which of the lumpy outlines. */
  shape: number;
}

export type Spawn = EnemySpawn | RockSpawn;

export interface Sector {
  n: number;
  kind: "squadron" | "field" | "mixed";
  /** By distance, soonest first. */
  spawns: Spawn[];
}

export interface Heat {
  /** Enemy formations in a sector (a field has a third of them). */
  waves: number;
  /** Asteroids in a field (a mixed sector has half). */
  rocks: number;
  /** Enemies' speed, times. */
  speed: number;
  /** Steps between a gunner's shots; a dart's are twice that. */
  fire: number;
  /** Enemy shots' speed. */
  shot: number;
  /** Extra hits every enemy takes. */
  hp: number;
  /** Chance an asteroid is a big one. */
  big: number;
  /** Members a formation adds. */
  more: number;
  kinds: readonly EnemyKind[];
}

/** How hot sector `n` runs: everything rises with it, to a ceiling. */
export function heat(n: number): Heat {
  return {
    waves: Math.min(14, 5 + Math.floor(n * 0.7)),
    rocks: Math.min(36, 8 + 2 * n),
    speed: Math.min(1.7, 0.75 + 0.06 * n),
    fire: Math.max(30, 110 - 7 * n),
    shot: Math.min(2.6, 1.1 + 0.1 * n),
    hp: Math.floor(n / 5),
    big: Math.min(0.5, 0.1 + 0.04 * n),
    more: Math.min(4, Math.floor(n / 4)),
    kinds: (["dart", "swoop", "gunner", "diver"] as const).filter((_, i) => n >= [0, 1, 2, 4][i]),
  };
}

const BASE_HP: Record<EnemyKind, number> = { dart: 1, swoop: 1, gunner: 4, diver: 2 };

export interface Zone {
  /** Its palette, never the one before's; the first zone's is always the first. */
  palette: number;
  /** How likely each kind of enemy is, of those come in yet. */
  weights: Record<EnemyKind, number>;
}

/** Zone `z` of the run seeded `seed`: two kinds of enemy it favours, and its look. */
export function zoneOf(seed: number, z: number): Zone {
  const weights: Record<EnemyKind, number> = { dart: 1, swoop: 1, gunner: 1, diver: 1 };
  if (z === 0) return { palette: 0, weights };
  const roll = dice(mix(mix(seed, 104729), z));
  const kinds = ["dart", "swoop", "gunner", "diver"] as const;
  const first = Math.floor(roll() * 4);
  const second = (first + 1 + Math.floor(roll() * 3)) % 4;
  weights[kinds[first]] = 3;
  weights[kinds[second]] = 2;
  const before = zoneOf(seed, z - 1).palette;
  return { palette: (before + 1 + Math.floor(roll() * (PALETTES - 1))) % PALETTES, weights };
}

/** Where a path has got to `t` steps after it came on, ignoring a dive. */
export function pathAt(p: Path, t: number): { x: number; y: number } {
  let down = t;
  if (p.stop !== undefined) {
    const reach = (p.stop + 10) / p.vy;
    if (t > reach) down = t < reach + (p.hold ?? 0) ? reach : t - (p.hold ?? 0);
  }
  return { x: p.x + p.vx * t + p.amp * Math.sin(p.w * t + p.phase), y: -10 + p.vy * down };
}

/** Sector `n` of the run seeded `seed`: the same every time. */
export function sector(seed: number, n: number): Sector {
  const roll = dice(mix(seed, n));
  const between = (lo: number, hi: number) => lo + roll() * (hi - lo);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(roll() * xs.length)];
  const h = heat(n);
  const { weights } = zoneOf(seed, Math.floor(n / ZONE_SECTORS));
  const pickKind = (): EnemyKind => {
    let r = roll() * h.kinds.reduce((sum, k) => sum + weights[k], 0);
    for (const k of h.kinds) if ((r -= weights[k]) < 0) return k;
    return h.kinds[h.kinds.length - 1];
  };
  const r = roll();
  const kind: Sector["kind"] = n === 0 || r < 0.45 ? "squadron" : r < 0.7 ? "field" : "mixed";
  const spawns: Spawn[] = [];
  const span = SECTOR_LEN - QUIET - ((n + 1) % ZONE_SECTORS === 0 ? BOSS_CLEAR : 0);

  const enemy = (at: number, k: EnemyKind, path: Path): EnemySpawn => {
    const fire = k === "gunner" ? h.fire : k === "dart" && n >= 3 ? h.fire * 2 : k === "swoop" && n >= 5 ? h.fire * 2 : 0;
    return { type: "enemy", at, kind: k, path, hp: BASE_HP[k] + (k === "gunner" ? 2 * h.hp : h.hp), fire, shot: h.shot };
  };
  const still = { amp: 0, w: 0, phase: 0 };

  const waves = kind === "field" ? Math.max(1, Math.round(h.waves / 3)) : h.waves;
  for (let i = 0; i < waves; i++) {
    const at = QUIET + ((i + 0.2 + roll() * 0.6) * span) / waves;
    const k = pickKind();
    const vy = h.speed * between(0.8, 1.2);
    if (k === "dart") {
      const form = pick(["line", "vee", "column"] as const);
      const count = 3 + Math.floor(roll() * 3) + h.more;
      if (form === "column") {
        const x = between(24, SR_W - 24);
        const weave = { amp: between(10, 30), w: between(0.03, 0.06), phase: 0 };
        for (let m = 0; m < count; m++) spawns.push(enemy(at + m * 14, k, { x, vx: 0, vy: vy * 1.1, ...weave }));
      } else {
        const gap = Math.min(22, (SR_W - 24) / count);
        const left = (SR_W - gap * (count - 1)) / 2;
        const mid = (count - 1) / 2;
        for (let m = 0; m < count; m++) {
          const lag = form === "vee" ? Math.abs(m - mid) * 10 : 0;
          spawns.push(enemy(at + lag, k, { x: left + m * gap, vx: 0, vy, ...still }));
        }
      }
    } else if (k === "swoop") {
      // A string of them weaving across from one side to the other.
      const from = roll() < 0.5 ? -1 : 1;
      const count = 4 + h.more;
      const vx = -from * between(0.35, 0.6) * h.speed;
      const path = { x: SR_W / 2 + from * (SR_W / 2 + 6), vx, vy: vy * 0.7, amp: between(12, 24), w: between(0.04, 0.07), phase: 0 };
      for (let m = 0; m < count; m++) spawns.push(enemy(at + m * 12, k, path));
    } else if (k === "gunner") {
      const count = 1 + (roll() < 0.3 + 0.05 * n ? 1 : 0);
      for (let m = 0; m < count; m++) {
        const x = count === 1 ? between(30, SR_W - 30) : m === 0 ? between(24, SR_W / 2 - 16) : between(SR_W / 2 + 16, SR_W - 24);
        const stop = between(28, 70);
        spawns.push(enemy(at, k, { x, vx: 0, vy: vy * 0.8, amp: between(4, 14), w: 0.025, phase: roll() * 6, stop, hold: Math.round(between(150, 240)) }));
      }
    } else {
      const count = 2 + Math.floor(roll() * 2) + Math.floor(h.more / 2);
      const gap = (SR_W - 40) / Math.max(1, count - 1);
      for (let m = 0; m < count; m++) {
        spawns.push(enemy(at + m * 6, k, { x: 20 + m * gap, vx: 0, vy: vy * 0.9, ...still, dive: Math.round(between(45, 80)) }));
      }
    }
  }

  const rocks = kind === "field" ? h.rocks : kind === "mixed" ? Math.round(h.rocks / 2) : Math.floor(roll() * 3);
  for (let i = 0; i < rocks; i++) {
    const size = roll() < h.big ? 2 : roll() < 0.5 ? 1 : 0;
    spawns.push({
      type: "rock",
      at: QUIET + roll() * span,
      x: between(8, SR_W - 8),
      vx: between(-0.25, 0.25),
      vy: between(0.6, 1.1) * (0.8 + h.speed * 0.3),
      size,
      shape: Math.floor(roll() * 8),
    });
  }
  spawns.sort((a, b) => a.at - b.at);
  return { n, kind, spawns };
}
