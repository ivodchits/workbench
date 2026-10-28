// Star run (office plan O5.3b), the TV console's first own game: a ship flying up an
// endless starfield, shooting enemies and asteroids. What comes is generated from the
// run's seed sector by sector (`sectors.ts`), hotter the further you get. Three lives;
// a hit takes one and leaves you a moment where nothing touches you. When they're gone
// the run is over, its score set against the best. `autopilot` flies it for the tests.
// O5.3c: what you shoot down may drop a perk — a wider or faster gun (in levels, one
// lost on a hit), a shield, a bomb, a magnet or a life — and a boss (`boss.ts`) holds
// the scroll at the end of every zone until its cores are gone.

import type { Pad } from "../pad";
import { BOSS_DYING, CORE_R, TURRET_R, bossAt, bossFire, bossPlan, bossState, moveBoss, onHull, type Boss } from "./boss";
import { SECTOR_LEN, SR_H, SR_W, ZONE_SECTORS, dice, mix, pathAt, sector, type EnemyKind, type Path, type RockSpawn, type Spawn } from "./sectors";

/** Pixels of scroll a step. */
export const SCROLL = 0.75;
export const LIVES = 3;
/** Steps nothing touches you after a hit. */
export const SAFE_STEPS = 120;
/** Steps from the last life lost to the game-over screen, and before it takes a press. */
const DYING_STEPS = 70;
export const OVER_WAIT = 40;
const SPEED = 1.7;
const SLOW = 0.7;
/** Steps between your shots while A is held, and their speed. */
const COOL = [7, 5, 4, 3] as const;
const SHOT_V = 4.5;
/** A gun's levels go to this; so does a stack of shields. */
export const MAX_LEVEL = 3;
export const MAX_LIVES = 5;
/** Steps a magnet lasts, and how far it reaches. */
export const MAGNET_STEPS = 900;
const MAGNET_R = 80;
const PICKUP_R = 8;
/** What a perk scores when it can't go any higher. */
const SPARE_POINTS = 500;
/** Chance each kind drops a perk when shot down; rocks by size. */
const DROP: Record<EnemyKind, number> = { dart: 0.05, swoop: 0.06, gunner: 0.4, diver: 0.15 };
const ROCK_DROP = [0, 0.05, 0.15] as const;
const BOSS_POINTS = 1000;
const TURRET_POINTS = 200;
/** How long the warning shows as a boss comes in, and a bomb's flash. */
export const WARNING_STEPS = 150;
const FLASH_STEPS = 14;
const DIVE_V = 2.3;
/** How far ahead spawns are queued, and the margins things leave the screen by. */
const LOOKAHEAD = 40;
const OFF = 24;
export const BURST_STEPS = 18;
/** Your hit circle: smaller than the ship, as a shooter's is. */
export const SHIP_R = 2.5;
const SHOT_R = 1.5;
export const ENEMY_R: Record<EnemyKind, number> = { dart: 4, swoop: 4, gunner: 6, diver: 4 };
export const ROCK_R = [3, 5, 9] as const;
const ROCK_HP = [1, 3, 6] as const;
const ROCK_POINTS = [10, 20, 50] as const;
const POINTS: Record<EnemyKind, number> = { dart: 50, swoop: 60, gunner: 150, diver: 100 };
/** Points for reaching a sector, times its number. */
const SECTOR_POINTS = 100;
/** How long a new sector's name shows. */
export const BANNER_STEPS = 90;

export type PerkKind = "spread" | "rapid" | "shield" | "bomb" | "magnet" | "life";
/** How often each perk drops, against the others. */
const PERK_WEIGHTS: [PerkKind, number][] = [
  ["spread", 3],
  ["rapid", 3],
  ["shield", 2],
  ["magnet", 1.5],
  ["bomb", 1],
  ["life", 0.5],
];

export interface Pickup {
  x: number;
  y: number;
  kind: PerkKind;
  t: number;
}

export interface Ship {
  x: number;
  y: number;
  /** Steps left of the safe moment after a hit. */
  safe: number;
  /** Steps until it can fire again. */
  cool: number;
  /** The gun's levels: more shots wider, and shots sooner. */
  spread: number;
  rapid: number;
  /** Hits the shield takes for you, and steps of magnet left. */
  shield: number;
  magnet: number;
}

export interface Enemy {
  kind: EnemyKind;
  path: Path;
  x: number;
  y: number;
  hp: number;
  /** Steps since it came on. */
  t: number;
  fire: number;
  shot: number;
  /** Steps to its next shot. */
  next: number;
  /** Its heading once diving. */
  dive: { vx: number; vy: number } | null;
  /** Steps left of the white flash of a hit. */
  flash: number;
}

export interface Rock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: 0 | 1 | 2;
  shape: number;
  hp: number;
  flash: number;
}

export interface Bolt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Burst {
  x: number;
  y: number;
  r: number;
  t: number;
}

export interface RunState {
  seed: number;
  /** In-run dice (splits, first shots), from the seed. */
  random: () => number;
  phase: "play" | "dying" | "over";
  /** Steps since the phase began. */
  t: number;
  distance: number;
  /** The sector reached, and how long its name has left to show. */
  sector: number;
  banner: number;
  /** The zone you're in; its boss, once it comes; how long its warning shows. */
  zone: number;
  boss: Boss | null;
  warning: number;
  /** The stars' own scroll, which goes on while a boss holds the rest. */
  stars: number;
  /** Hits taken, a shield's too. */
  hits: number;
  /** Steps left of a bomb's flash. */
  flash: number;
  /** Next sector to generate, and the spawns queued, by distance. */
  made: number;
  pending: (Spawn & { abs: number })[];
  ship: Ship;
  lives: number;
  score: number;
  /** The best before this run, and since the cartridge came on. */
  best: number;
  enemies: Enemy[];
  rocks: Rock[];
  shots: Bolt[];
  bolts: Bolt[];
  bursts: Burst[];
  pickups: Pickup[];
  paused: boolean;
  /** Buttons held at the last step, so a press counts once. */
  held: { a: boolean; start: boolean };
  gamepad: boolean;
}

/** A run from `seed`; `from` starts it at that sector (for the tests). */
export function runState(seed: number, best = 0, from = 0): RunState {
  const s: RunState = {
    seed,
    random: dice(mix(seed, -1)),
    phase: "play",
    t: 0,
    distance: from * SECTOR_LEN,
    sector: from,
    banner: BANNER_STEPS,
    zone: Math.floor(from / ZONE_SECTORS),
    boss: null,
    warning: 0,
    stars: 0,
    hits: 0,
    flash: 0,
    made: from,
    pending: [],
    ship: { x: SR_W / 2, y: SR_H - 24, safe: 0, cool: 0, spread: 0, rapid: 0, shield: 0, magnet: 0 },
    lives: LIVES,
    score: 0,
    best,
    enemies: [],
    rocks: [],
    shots: [],
    bolts: [],
    bursts: [],
    pickups: [],
    paused: false,
    held: { a: true, start: true },
    gamepad: false,
  };
  queue(s);
  return s;
}

/** Queues the spawns of every sector that's come within reach. */
function queue(s: RunState): void {
  let added = false;
  while (s.made * SECTOR_LEN <= s.distance + SR_H + LOOKAHEAD) {
    const base = s.made * SECTOR_LEN;
    for (const sp of sector(s.seed, s.made).spawns) s.pending.push({ ...sp, abs: base + sp.at });
    s.made++;
    added = true;
  }
  if (added) s.pending.sort((a, b) => a.abs - b.abs);
}

function spawn(s: RunState, sp: Spawn): void {
  if (sp.type === "rock") {
    s.rocks.push(rock(sp, sp.x, -ROCK_R[sp.size] - 2));
    return;
  }
  const at = pathAt(sp.path, 0);
  s.enemies.push({
    kind: sp.kind,
    path: sp.path,
    x: at.x,
    y: at.y,
    hp: sp.hp,
    t: 0,
    fire: sp.fire,
    shot: sp.shot,
    next: sp.fire ? Math.round(sp.fire * (0.3 + 0.7 * s.random())) : 0,
    dive: null,
    flash: 0,
  });
}

const rock = (sp: Omit<RockSpawn, "type" | "at" | "x">, x: number, y: number): Rock => ({
  x,
  y,
  vx: sp.vx,
  vy: sp.vy,
  size: sp.size,
  shape: sp.shape,
  hp: ROCK_HP[sp.size],
  flash: 0,
});

const near = (ax: number, ay: number, bx: number, by: number, r: number) => (ax - bx) ** 2 + (ay - by) ** 2 < r * r;

/** One step of the run. */
export function stepRun(s: RunState, pad: Pad): void {
  const pressA = pad.a && !s.held.a;
  const pressStart = pad.start && !s.held.start;
  s.held = { a: pad.a, start: pad.start };
  if (pad.gamepad) s.gamepad = true;
  else if (pad.x || pad.y || pad.a || pad.b || pad.start) s.gamepad = false;

  if (s.phase === "over") {
    s.t++;
    if (s.t >= OVER_WAIT && (pressA || pressStart)) {
      const best = Math.max(s.best, s.score);
      Object.assign(s, runState(mix(s.seed, 1), best), { gamepad: s.gamepad, held: s.held });
    }
    return;
  }
  if (pressStart && s.phase === "play") s.paused = !s.paused;
  if (s.paused) return;
  s.t++;

  // At the end of a zone the scroll holds while its boss is about.
  const gate = (s.zone + 1) * ZONE_SECTORS * SECTOR_LEN - 1;
  s.stars += SCROLL;
  if (!s.boss && s.distance + SCROLL >= gate && s.phase === "play") {
    s.distance = gate;
    s.boss = bossState(bossPlan(s.seed, s.zone));
    s.warning = WARNING_STEPS;
  } else if (!s.boss) {
    s.distance = Math.min(gate, s.distance + SCROLL);
  }
  if (s.warning > 0) s.warning--;
  if (s.flash > 0) s.flash--;
  const reached = Math.floor(s.distance / SECTOR_LEN);
  if (reached > s.sector) {
    s.sector = reached;
    s.banner = BANNER_STEPS;
    if (s.phase === "play") s.score += SECTOR_POINTS * reached;
  }
  if (s.banner > 0) s.banner--;
  queue(s);
  while (s.pending.length && s.pending[0].abs <= s.distance) spawn(s, s.pending.shift()!);

  const ship = s.ship;
  if (s.phase === "play") {
    const v = pad.b ? SLOW : SPEED;
    const len = Math.hypot(pad.x, pad.y);
    const k = len > 1 ? 1 / len : 1;
    ship.x = Math.max(6, Math.min(SR_W - 6, ship.x + pad.x * k * v));
    ship.y = Math.max(20, Math.min(SR_H - 10, ship.y + pad.y * k * v));
    if (ship.cool > 0) ship.cool--;
    if (pad.a && ship.cool === 0) {
      fire(s);
      ship.cool = COOL[ship.rapid];
    }
    if (ship.safe > 0) ship.safe--;
    if (ship.magnet > 0) ship.magnet--;
  }

  for (const e of s.enemies) {
    e.t++;
    if (e.flash > 0) e.flash--;
    if (e.dive) {
      e.x += e.dive.vx;
      e.y += e.dive.vy;
    } else {
      if (e.path.dive !== undefined && e.t >= e.path.dive) {
        const dx = ship.x - e.x;
        const dy = Math.max(20, ship.y - e.y);
        const d = Math.hypot(dx, dy);
        e.dive = { vx: (dx / d) * DIVE_V, vy: (dy / d) * DIVE_V };
      }
      const at = pathAt(e.path, e.t);
      e.x = at.x;
      e.y = at.y;
    }
    if (e.fire && e.y > 0 && e.y < SR_H * 0.7 && --e.next <= 0) {
      e.next = e.fire;
      if (e.kind === "gunner" && s.phase === "play") {
        const dx = ship.x - e.x;
        const dy = ship.y - e.y;
        const d = Math.hypot(dx, dy) || 1;
        s.bolts.push({ x: e.x, y: e.y + 4, vx: (dx / d) * e.shot, vy: (dy / d) * e.shot });
      } else {
        s.bolts.push({ x: e.x, y: e.y + 4, vx: 0, vy: e.shot });
      }
    }
  }
  for (const r of s.rocks) {
    r.x += r.vx;
    r.y += r.vy;
    if (r.flash > 0) r.flash--;
  }
  for (const b of [...s.shots, ...s.bolts]) {
    b.x += b.vx;
    b.y += b.vy;
  }
  for (const b of s.bursts) b.t++;
  for (const p of s.pickups) {
    p.t++;
    const d = Math.hypot(ship.x - p.x, ship.y - p.y);
    if (ship.magnet > 0 && d < MAGNET_R && d > 0) {
      p.x += ((ship.x - p.x) / d) * 2.4;
      p.y += ((ship.y - p.y) / d) * 2.4;
    } else {
      p.y += 0.55;
    }
  }
  const boss = s.boss;
  if (boss) {
    moveBoss(boss, s.random);
    if (s.phase === "play") bossFire(boss, ship, s.bolts);
    if (boss.phase === "dying") {
      if (boss.t % 6 === 0) {
        const x = boss.x + (s.random() - 0.5) * boss.plan.w;
        const y = boss.y + (s.random() - 0.5) * boss.plan.h;
        s.bursts.push({ x, y, r: 6 + s.random() * 8, t: 0 });
      }
      if (boss.t >= BOSS_DYING) {
        s.bursts.push({ x: boss.x, y: boss.y, r: boss.plan.w / 2, t: 0 }, { x: boss.x, y: boss.y, r: boss.plan.w / 3, t: 4 });
        // It leaves the gun's perks and a shield behind.
        for (const [kind, dx] of [["spread", -14], ["shield", 0], ["rapid", 14]] as const) s.pickups.push({ x: boss.x + dx, y: boss.y, kind, t: 0 });
        s.boss = null;
        s.zone++;
      }
    }
  }

  // Your shots against what they meet.
  s.shots = s.shots.filter((b) => {
    if (boss && boss.phase !== "dying") {
      // Once it's in, its cores and guns take a shot; its hull just stops one.
      const c = boss.phase === "fight" && boss.cores.find((c) => c.hp > 0 && near(b.x, b.y, boss.x + c.dx, boss.y + c.dy, CORE_R + SHOT_R));
      const t = boss.phase === "fight" && !c && boss.turrets.find((t) => t.hp > 0 && near(b.x, b.y, boss.x + t.dx, boss.y + t.dy, TURRET_R + SHOT_R));
      if (c) hitCore(s, boss, c, 1);
      else if (t) hitTurret(s, boss, t, 1);
      if (c || t || onHull(boss, b.x, b.y, 1)) return false;
    }
    const e = s.enemies.find((e) => e.hp > 0 && near(b.x, b.y, e.x, e.y, ENEMY_R[e.kind] + SHOT_R));
    if (e) {
      hitEnemy(s, e, 1);
      return false;
    }
    const r = s.rocks.find((r) => r.hp > 0 && near(b.x, b.y, r.x, r.y, ROCK_R[r.size] + SHOT_R));
    if (r) {
      hitRock(s, r);
      return false;
    }
    return b.y > -8;
  });

  // What meets you.
  if (s.phase === "play" && ship.safe === 0) {
    const bolt = s.bolts.findIndex((b) => near(b.x, b.y, ship.x, ship.y, SHIP_R + SHOT_R));
    const e = s.enemies.find((e) => e.hp > 0 && near(e.x, e.y, ship.x, ship.y, SHIP_R + ENEMY_R[e.kind] - 1));
    const r = s.rocks.find((r) => r.hp > 0 && near(r.x, r.y, ship.x, ship.y, SHIP_R + ROCK_R[r.size] - 1));
    const rammed = !!boss && boss.phase !== "dying" && onHull(boss, ship.x, ship.y, 1);
    if (bolt >= 0 || e || r || rammed) {
      if (bolt >= 0) s.bolts.splice(bolt, 1);
      if (e) hitEnemy(s, e, 3);
      if (r) hitRock(s, r, r.hp);
      hitShip(s);
    }
  }

  s.enemies = s.enemies.filter((e) => e.hp > 0 && e.y < SR_H + OFF && e.y > -OFF * 2 && e.x > -OFF * 2 && e.x < SR_W + OFF * 2);
  s.rocks = s.rocks.filter((r) => r.hp > 0 && r.y < SR_H + OFF && r.x > -OFF && r.x < SR_W + OFF);
  s.bolts = s.bolts.filter((b) => b.y < SR_H + 4 && b.y > -4 && b.x > -4 && b.x < SR_W + 4);
  s.bursts = s.bursts.filter((b) => b.t < BURST_STEPS);
  s.pickups = s.pickups.filter((p) => {
    if (s.phase === "play" && near(p.x, p.y, ship.x, ship.y, PICKUP_R)) {
      perk(s, p.kind);
      return false;
    }
    return p.y < SR_H + 8;
  });

  if (s.phase === "dying" && s.t >= DYING_STEPS) Object.assign(s, { phase: "over", t: 0 });
}

/** A volley: one shot at first, then two side by side, then three and five fanned out. */
function fire(s: RunState): void {
  const { x, y, spread } = s.ship;
  const shot = (dx: number, a = 0) => s.shots.push({ x: x + dx, y: y - 5, vx: Math.sin(a) * SHOT_V, vy: -Math.cos(a) * SHOT_V });
  if (spread === 0) shot(0);
  else if (spread === 1) [-2, 2].forEach((dx) => shot(dx));
  else if (spread === 2) [-0.2, 0, 0.2].forEach((a) => shot(0, a));
  else [-0.36, -0.18, 0, 0.18, 0.36].forEach((a) => shot(0, a));
}

/** Maybe drops a perk where something went, by `chance`. */
function drop(s: RunState, x: number, y: number, chance: number): void {
  if (s.phase !== "play" || s.random() >= chance) return;
  let r = s.random() * PERK_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  const kind = PERK_WEIGHTS.find(([, w]) => (r -= w) < 0)?.[0] ?? "spread";
  s.pickups.push({ x, y, kind, t: 0 });
}

/** What a perk does when you fly into it. They stack, to a ceiling; past it they
 *  score instead. */
export function perk(s: RunState, kind: PerkKind): void {
  const ship = s.ship;
  const up = (now: number, max: number) => {
    if (now >= max) s.score += SPARE_POINTS;
    return Math.min(max, now + 1);
  };
  if (kind === "spread") ship.spread = up(ship.spread, MAX_LEVEL);
  else if (kind === "rapid") ship.rapid = up(ship.rapid, MAX_LEVEL);
  else if (kind === "shield") ship.shield = up(ship.shield, MAX_LEVEL);
  else if (kind === "life") s.lives = up(s.lives, MAX_LIVES);
  else if (kind === "magnet") ship.magnet = Math.min(MAGNET_STEPS * 2, ship.magnet + MAGNET_STEPS);
  else bomb(s);
}

/** Clears the screen: every enemy and asteroid on it goes, whole, and every shot; a
 *  boss's guns and cores take a heavy hit, though the bomb never finishes it. */
function bomb(s: RunState): void {
  s.flash = FLASH_STEPS;
  for (const e of s.enemies) if (e.y > -4 && e.hp > 0) hitEnemy(s, e, e.hp);
  for (const r of s.rocks) {
    if (r.y < -4 || r.hp <= 0) continue;
    hitRock(s, r, r.hp, true);
  }
  s.bolts = [];
  const boss = s.boss;
  if (boss?.phase === "fight") {
    for (const t of boss.turrets) if (t.hp > 0) hitTurret(s, boss, t, 10);
    for (const c of boss.cores) if (c.hp > 1) hitCore(s, boss, c, Math.min(c.hp - 1, Math.ceil(c.max * 0.15)));
  }
}

function hitEnemy(s: RunState, e: Enemy, damage: number): void {
  e.hp -= damage;
  e.flash = 4;
  if (e.hp > 0) return;
  s.bursts.push({ x: e.x, y: e.y, r: ENEMY_R[e.kind] + 4, t: 0 });
  if (s.phase === "play") s.score += POINTS[e.kind];
  drop(s, e.x, e.y, DROP[e.kind]);
}

/** `whole`, it goes without splitting. */
function hitRock(s: RunState, r: Rock, damage = 1, whole = false): void {
  r.hp -= damage;
  r.flash = 4;
  if (r.hp > 0) return;
  s.bursts.push({ x: r.x, y: r.y, r: ROCK_R[r.size] + 2, t: 0 });
  if (s.phase === "play") s.score += ROCK_POINTS[r.size];
  drop(s, r.x, r.y, ROCK_DROP[r.size]);
  if (r.size === 0 || whole) return;
  const size = (r.size - 1) as 0 | 1;
  for (const side of [-1, 1]) {
    const shape = Math.floor(s.random() * 8);
    s.rocks.push(rock({ vx: r.vx + side * (0.3 + s.random() * 0.3), vy: r.vy * (0.8 + s.random() * 0.3), size, shape }, r.x + side * 2, r.y));
  }
}

function hitCore(s: RunState, boss: Boss, c: Boss["cores"][number], damage: number): void {
  c.hp -= damage;
  c.flash = 4;
  if (c.hp > 0) return;
  s.bursts.push({ x: boss.x + c.dx, y: boss.y + c.dy, r: 8, t: 0 });
  if (boss.cores.some((c) => c.hp > 0)) return;
  // The last core: it goes up, and takes its shots with it.
  Object.assign(boss, { phase: "dying", t: 0 });
  for (const b of s.bolts) s.bursts.push({ x: b.x, y: b.y, r: 2, t: BURST_STEPS / 2 });
  s.bolts = [];
  if (s.phase === "play") s.score += BOSS_POINTS * (boss.plan.zone + 1);
}

function hitTurret(s: RunState, boss: Boss, t: Boss["turrets"][number], damage: number): void {
  t.hp -= damage;
  t.flash = 4;
  if (t.hp > 0) return;
  s.bursts.push({ x: boss.x + t.dx, y: boss.y + t.dy, r: 6, t: 0 });
  if (s.phase === "play") s.score += TURRET_POINTS;
  drop(s, boss.x + t.dx, boss.y + t.dy + 4, 0.35);
}

/** A hit: the shield takes it if it's up; if not, it costs a life and a level off the
 *  gun, off the higher of the two. */
function hitShip(s: RunState): void {
  const ship = s.ship;
  s.hits++;
  // The shots close by go with the hit, so it doesn't come straight back.
  s.bolts = s.bolts.filter((b) => !near(b.x, b.y, ship.x, ship.y, 36));
  if (ship.shield > 0) {
    ship.shield--;
    ship.safe = SAFE_STEPS / 2;
    s.bursts.push({ x: ship.x, y: ship.y, r: 8, t: BURST_STEPS / 3 });
    return;
  }
  s.bursts.push({ x: ship.x, y: ship.y, r: 10, t: 0 });
  s.lives--;
  if (ship.spread > 0 && ship.spread >= ship.rapid) ship.spread--;
  else if (ship.rapid > 0) ship.rapid--;
  if (s.lives > 0) ship.safe = SAFE_STEPS;
  else Object.assign(s, { phase: "dying", t: 0 });
}

/** A ship flown by the computer: always firing, it tries each way it could go a little
 *  ahead and takes the one furthest from harm, staying low and under the enemies. */
export function autopilot(s: RunState): Pad {
  const ship = s.ship;
  const AHEAD = 14;
  // Each threat's path over the next steps.
  const threats: { at: (k: number) => { x: number; y: number }; r: number }[] = [
    ...s.bolts.map((b) => ({ at: (k: number) => ({ x: b.x + b.vx * k, y: b.y + b.vy * k }), r: SHOT_R })),
    ...s.rocks.map((r) => ({ at: (k: number) => ({ x: r.x + r.vx * k, y: r.y + r.vy * k }), r: ROCK_R[r.size] })),
    ...s.enemies.map((e) => ({
      at: (k: number) => {
        if (e.dive) return { x: e.x + e.dive.vx * k, y: e.y + e.dive.vy * k };
        if (e.path.dive !== undefined && e.t + k >= e.path.dive) {
          // About to dive at us: it could come straight down on where we are.
          const dx = ship.x - e.x;
          const dy = Math.max(20, ship.y - e.y);
          const d = Math.hypot(dx, dy);
          const go = e.t + k - e.path.dive;
          return { x: e.x + (dx / d) * DIVE_V * go, y: e.y + (dy / d) * DIVE_V * go };
        }
        return pathAt(e.path, e.t + k);
      },
      r: ENEMY_R[e.kind],
    })),
  ].filter((th) => {
    const p = th.at(0);
    return Math.abs(p.x - ship.x) < 60 && Math.abs(p.y - ship.y) < 80;
  });
  const boss = s.boss;
  let target = s.enemies.reduce<number | null>((best, e) => (e.y > 0 && (best === null || Math.abs(e.x - ship.x) < Math.abs(best - ship.x)) ? e.x : best), null);
  // A boss's nearest core living, where it'll be by the time a shot gets there.
  if (boss?.phase === "fight") {
    const lead = (ship.y - boss.y) / SHOT_V;
    const at = bossAt(boss.plan, boss.t + lead);
    const core = boss.cores.filter((c) => c.hp > 0).sort((a, b) => Math.abs(at.x + a.dx - ship.x) - Math.abs(at.x + b.dx - ship.x))[0];
    if (core) target = at.x + core.dx;
  }
  // A perk close by and below the boss is worth going for.
  const prize = s.pickups.filter((p) => p.y > 40 && Math.abs(p.x - ship.x) < 50 && Math.abs(p.y - ship.y) < 70)[0];
  let choice = { x: 0, y: 0, cost: Infinity };
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      const k1 = dx && dy ? Math.SQRT1_2 : 1;
      let cost = 0;
      for (let k = 1; k <= AHEAD; k++) {
        const x = Math.max(6, Math.min(SR_W - 6, ship.x + dx * k1 * SPEED * k));
        const y = Math.max(20, Math.min(SR_H - 10, ship.y + dy * k1 * SPEED * k));
        for (const th of threats) {
          const p = th.at(k);
          const d = Math.hypot(p.x - x, p.y - y) - th.r - SHIP_R;
          if (d < 6) cost += (6 - d) * (AHEAD + 1 - k);
        }
        if (boss && boss.phase !== "dying" && y < boss.y + boss.plan.h / 2 + 10 && Math.abs(x - boss.x) < boss.plan.w / 2 + 6) cost += 8 * (AHEAD + 1 - k);
      }
      const x = ship.x + dx * SPEED * 4;
      const y = ship.y + dy * SPEED * 4;
      if (prize) cost += Math.hypot(x - prize.x, y - prize.y) * 0.06;
      else cost += Math.abs(y - (SR_H - 30)) * 0.05;
      if (target !== null) cost += Math.abs(x - target) * (prize ? 0.01 : 0.03);
      if (x < 12 || x > SR_W - 12) cost += 2;
      if (cost < choice.cost) choice = { x: dx, y: dy, cost };
    }
  }
  return {
    x: choice.x,
    y: choice.y,
    a: true,
    b: false,
    start: false,
    back: false,
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
    move: { left: 0, right: 0 },
    gamepad: null,
    retro: new Set(),
  };
}
