// Star run's bosses (office plan O5.3c): one guards the end of every zone. Each is built
// from the run's seed and the zone's number out of parts — a mirrored hull, turrets in
// pairs along its front and the weak points (cores) that take its health — so a seed
// always meets the same ones. The further the zone, the bigger the hull, the more
// turrets, the more of their patterns unlocked, and the faster and thicker they fire.
// Shots stop on the hull; only the cores count, and the boss goes when they all have.

import { dice, mix, SR_W } from "./sectors";

export type Pattern = "aimed" | "fan" | "stream" | "ring" | "spiral";

export interface Turret {
  /** From the boss's centre. */
  dx: number;
  dy: number;
  pattern: Pattern;
  /** Steps between its volleys, shots in one, and their speed. */
  every: number;
  count: number;
  speed: number;
  hp: number;
}

export interface Core {
  dx: number;
  dy: number;
  hp: number;
}

export interface BossPlan {
  /** Which run and zone it's for: the same pair is the same boss. */
  id: string;
  zone: number;
  /** The hull, mirrored about its middle column: "." space, "h" hull, "e" its edge,
   *  "p" its plating's lines. */
  rows: string[];
  w: number;
  h: number;
  turrets: Turret[];
  cores: Core[];
  /** Its sway side to side once it's in: how far, and radians a step. */
  sway: { amp: number; w: number };
}

/** Where a boss holds, and how long it takes to come in. */
export const BOSS_Y = 46;
export const ENTER_STEPS = 140;
export const BOSS_DYING = 120;
export const CORE_R = 3.5;
export const TURRET_R = 3.5;

/** The patterns open by zone: the first two from the start, then one more a zone. */
const PATTERNS: readonly Pattern[] = ["aimed", "fan", "stream", "ring", "spiral"];

/** The boss for zone `zone` of the run seeded `seed`: the same every time. */
export function bossPlan(seed: number, zone: number): BossPlan {
  const roll = dice(mix(mix(seed, 7919), zone));
  const between = (lo: number, hi: number) => lo + roll() * (hi - lo);
  const z = zone;

  // The hull: a half-width for each row eased between a few made-up widths, mirrored.
  const half = 15 + Math.floor(roll() * 6) + Math.min(6, z);
  const h = 17 + Math.floor(roll() * 6) + Math.min(8, z);
  const w = 2 * half + 1;
  const knots = [between(0.35, 0.7), between(0.6, 1), 1, between(0.4, 0.8), between(0.2, 0.5)];
  // A notch or two cut in from the sides makes it less of a blob.
  const notches = Array.from({ length: 1 + Math.floor(roll() * 2) }, () => ({ y: Math.floor(between(0.2, 0.8) * h), k: between(0.45, 0.75) }));
  const widths: number[] = [];
  for (let y = 0; y < h; y++) {
    const t = (y / (h - 1)) * (knots.length - 1);
    const i = Math.min(knots.length - 2, Math.floor(t));
    const f = t - i;
    let k = knots[i] + (knots[i + 1] - knots[i]) * (f * f * (3 - 2 * f));
    if (notches.some((n) => Math.abs(n.y - y) <= 1)) k *= notches.find((n) => Math.abs(n.y - y) <= 1)!.k;
    widths.push(Math.max(2, Math.round(half * k)));
  }
  const lineAt = 2 + Math.floor(roll() * 3);
  const inside = (x: number, y: number) => y >= 0 && y < h && Math.abs(x - half) <= widths[y];
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) row += ".";
      else if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) row += "e";
      else if (y % (lineAt + 3) === lineAt || Math.abs(x - half) === Math.floor(half / 2)) row += "p";
      else row += "h";
    }
    rows.push(row);
  }

  // Cores and turrets sit on its underside, facing the ship: each at the lowest hull
  // under its column, so a shot from below meets it before the hull.
  const under = (dx: number) => {
    let y = h - 1;
    while (y > 0 && !inside(half + dx, y)) y--;
    return y - Math.floor(h / 2);
  };
  const reach = (dx: number) => Math.abs(dx) <= Math.max(...widths) - 2;
  // Up to `k` rows above that, staying on the hull.
  const behind = (dx: number, k: number) => {
    let y = under(dx);
    for (let n = 0; n < k && inside(half + dx, y - 1 + Math.floor(h / 2)); n++) y--;
    return y;
  };

  // Cores: one in the middle, then a pair off it, then both.
  const cores: Core[] = [];
  const coreHp = 45 + 18 * z;
  const coreCount = z < 2 ? 1 : z < 4 ? 2 : 3;
  if (coreCount !== 2) cores.push({ dx: 0, dy: under(0), hp: 0 });
  if (coreCount >= 2) {
    const dx = Math.round(half * between(0.3, 0.45));
    cores.push({ dx: -dx, dy: under(-dx), hp: 0 }, { dx, dy: under(dx), hp: 0 });
  }
  for (const c of cores) c.hp = Math.round(coreHp / cores.length);

  // Turrets, in pairs out along it, each pair with its own pattern. One over a core's
  // column sits up on the hull behind it, so the core still takes the shots from below.
  const open = PATTERNS.slice(0, Math.min(PATTERNS.length, 2 + z));
  const pairs = Math.min(3, 1 + Math.floor((z + 1) / 2));
  const turrets: Turret[] = [];
  const pace = Math.max(0.5, 1 - 0.06 * z);
  const speed = Math.min(2.4, 1.1 + 0.13 * z);
  const spots: number[] = [];
  for (let p = 0; p < pairs; p++) {
    // The newest pattern opened goes on the first pair, so each zone shows it.
    const pattern = p === 0 && z > 0 ? open[open.length - 1] : open[Math.floor(roll() * open.length)];
    // Somewhere clear of the cores if it can, so it can be shot out from below.
    const clear = (dx: number, tries: number) => reach(dx) && !spots.some((t) => Math.abs(t - dx) < 6) && (tries >= 20 || cores.every((c) => Math.abs(Math.abs(c.dx) - dx) >= 7));
    let dx = Math.round(half * between(0.25, 0.95));
    for (let tries = 0; tries < 30 && !clear(dx, tries); tries++) dx = Math.round(half * between(0.15, 0.95));
    if (!reach(dx) || spots.some((t) => Math.abs(t - dx) < 6)) continue;
    spots.push(dx);
    const up = cores.some((c) => Math.abs(Math.abs(c.dx) - dx) < 7) ? 5 : 0;
    const t = turret(pattern, z, pace, speed);
    turrets.push({ ...t, dx: -dx, dy: behind(-dx, up) }, { ...t, dx, dy: behind(dx, up) });
  }
  // From the second zone a gun in the middle too, always aimed.
  if (z >= 1) turrets.push({ ...turret("aimed", z, pace * 1.2, speed), dx: 0, dy: behind(0, cores.some((c) => c.dx === 0) ? 5 : 0) });

  const room = (SR_W - w) / 2 - 4;
  return {
    id: `${seed}:${zone}`,
    zone,
    rows,
    w,
    h,
    turrets,
    cores,
    sway: { amp: Math.max(6, room * between(0.6, 0.95)), w: between(0.008, 0.014) * (1 + 0.04 * Math.min(10, z)) },
  };
}

function turret(pattern: Pattern, z: number, pace: number, speed: number): Omit<Turret, "dx" | "dy"> {
  const hp = 6 + 3 * z;
  switch (pattern) {
    case "aimed":
      return { pattern, every: Math.round(55 * pace), count: Math.min(4, 1 + Math.floor(z / 2)), speed, hp };
    case "fan":
      return { pattern, every: Math.round(70 * pace), count: Math.min(9, 4 + z), speed: speed * 0.9, hp };
    case "stream":
      return { pattern, every: Math.round(75 * pace), count: Math.min(9, 5 + Math.floor(z / 2)), speed: speed * 1.1, hp };
    case "ring":
      return { pattern, every: Math.round(90 * pace), count: Math.min(20, 10 + 2 * z), speed: speed * 0.8, hp };
    case "spiral":
      return { pattern, every: Math.max(6, Math.round(9 * pace)), count: z >= 6 ? 4 : 3, speed: speed * 0.75, hp };
  }
}

export interface LiveTurret extends Turret {
  /** Steps to its next volley; a stream's shots left in this one; a spiral's angle. */
  next: number;
  burst: number;
  angle: number;
  flash: number;
}

export interface LiveCore extends Core {
  max: number;
  flash: number;
}

export interface Boss {
  plan: BossPlan;
  x: number;
  y: number;
  /** Steps since it came on, or since it began to die. */
  t: number;
  phase: "enter" | "fight" | "dying";
  turrets: LiveTurret[];
  cores: LiveCore[];
}

export function bossState(plan: BossPlan): Boss {
  return {
    plan,
    x: SR_W / 2,
    y: -plan.h / 2 - 2,
    t: 0,
    phase: "enter",
    turrets: plan.turrets.map((t, n) => ({ ...t, next: Math.round(t.every * (0.4 + 0.15 * (n % 4))), burst: 0, angle: 0, flash: 0 })),
    cores: plan.cores.map((c) => ({ ...c, max: c.hp, flash: 0 })),
  };
}

/** Its health left, 0 to 1. */
export function bossHealth(b: Boss): number {
  const max = b.cores.reduce((sum, c) => sum + c.max, 0);
  return b.cores.reduce((sum, c) => sum + Math.max(0, c.hp), 0) / max;
}

/** Whether (x, y) is on the hull, with `pad` pixels to spare. */
export function onHull(b: Boss, x: number, y: number, pad = 0): boolean {
  const { rows, w, h } = b.plan;
  const cx = Math.round(x - (b.x - (w - 1) / 2));
  const cy = Math.round(y - (b.y - (h - 1) / 2));
  for (let dy = -pad; dy <= pad; dy++) {
    for (let dx = -pad; dx <= pad; dx++) {
      if (rows[cy + dy]?.[cx + dx] !== undefined && rows[cy + dy][cx + dx] !== ".") return true;
    }
  }
  return false;
}

/** Where it is `t` steps into the fight. */
export function bossAt(plan: BossPlan, t: number): { x: number; y: number } {
  return { x: SR_W / 2 + plan.sway.amp * Math.sin(plan.sway.w * t), y: BOSS_Y + 5 * Math.sin(plan.sway.w * 1.7 * t) };
}

/** Moves it on a step; it fires only once in. */
export function moveBoss(b: Boss, random: () => number): void {
  b.t++;
  for (const t of b.turrets) if (t.flash > 0) t.flash--;
  for (const c of b.cores) if (c.flash > 0) c.flash--;
  if (b.phase === "enter") {
    const k = Math.min(1, b.t / ENTER_STEPS);
    b.y = -b.plan.h / 2 - 2 + (BOSS_Y + b.plan.h / 2 + 2) * (1 - (1 - k) ** 2);
    if (k === 1) Object.assign(b, { phase: "fight", t: 0 });
  } else if (b.phase === "fight") {
    Object.assign(b, bossAt(b.plan, b.t));
  } else {
    // Dying, it shudders and sinks.
    b.x += (random() - 0.5) * 1.2;
    b.y += 0.15;
  }
}

/** Fires what's due at the ship, into `bolts`. A boss below half its health fires
 *  faster. */
export function bossFire(b: Boss, ship: { x: number; y: number }, bolts: { x: number; y: number; vx: number; vy: number }[]): void {
  if (b.phase !== "fight") return;
  const angry = bossHealth(b) < 0.5;
  for (const t of b.turrets) {
    if (t.hp <= 0) continue;
    const x = b.x + t.dx;
    const y = b.y + t.dy + 2;
    const shoot = (a: number, v = t.speed) => bolts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v });
    const aim = Math.atan2(ship.y - y, ship.x - x);
    if (t.burst > 0) {
      // A stream, shot by shot.
      if (--t.next <= 0) {
        shoot(aim);
        t.burst--;
        t.next = t.burst > 0 ? 6 : Math.round(t.every * (angry ? 0.7 : 1));
      }
      continue;
    }
    if (--t.next > 0) continue;
    t.next = Math.round(t.every * (angry ? 0.7 : 1));
    switch (t.pattern) {
      case "aimed":
        for (let n = 0; n < t.count; n++) shoot(aim + (n - (t.count - 1) / 2) * 0.16);
        break;
      case "fan":
        for (let n = 0; n < t.count; n++) shoot(Math.PI / 2 + (n - (t.count - 1) / 2) * (1.1 / Math.max(1, t.count - 1)));
        break;
      case "stream":
        shoot(aim);
        t.burst = t.count - 1;
        t.next = 6;
        break;
      case "ring":
        t.angle += 0.37;
        for (let n = 0; n < t.count; n++) shoot(t.angle + (n / t.count) * Math.PI * 2);
        break;
      case "spiral":
        t.angle += 0.33 * Math.sign(t.dx || 1);
        for (let n = 0; n < t.count; n++) shoot(t.angle + (n / t.count) * Math.PI * 2);
        break;
    }
  }
}
