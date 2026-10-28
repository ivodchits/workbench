import { describe, expect, it } from "vitest";

import { readPad, type Pad } from "../pad";
import { BOSS_DYING, bossPlan, ENTER_STEPS, type BossPlan } from "./boss";
import { SECTOR_LEN, ZONE_SECTORS, zoneOf } from "./sectors";
import { autopilot, LIVES, MAGNET_STEPS, MAX_LEVEL, MAX_LIVES, perk, runState, stepRun, type RunState } from "./starrun";

const idle = readPad(new Set());
const press = (more: Partial<Pad>): Pad => ({ ...idle, ...more });
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A run just short of zone `zone`'s boss, with nothing else about. */
function atBoss(seed: number, zone: number): RunState {
  const s = runState(seed, 0, zone * ZONE_SECTORS + ZONE_SECTORS - 1);
  s.pending = [];
  s.distance = (zone + 1) * ZONE_SECTORS * SECTOR_LEN - 3;
  return s;
}

/** The computer fights zone `zone`'s boss, looking again every 12 steps, with a gun of
 *  `gun` levels kept up and its lives topped up: the steps it takes, and the hits. */
function fight(seed: number, zone: number, gun: number, cap = 9000): { steps: number; hits: number } {
  const s = atBoss(seed, zone);
  let pad = autopilot(s);
  let n = 0;
  for (; n < cap && (n < 10 || s.boss); n++) {
    Object.assign(s.ship, { spread: gun, rapid: gun, shield: 0 });
    s.lives = LIVES;
    if (n % 12 === 0) pad = autopilot(s);
    stepRun(s, pad);
  }
  return { steps: n, hits: s.hits };
}

/** Whether the hull is filled at (dx, dy) from its centre. */
const filled = (p: BossPlan, dx: number, dy: number) => (p.rows[dy + Math.floor(p.h / 2)]?.[dx + (p.w - 1) / 2] ?? ".") !== ".";

describe("star run's bosses", () => {
  it("are the same from the same seed and zone, and differ from another", () => {
    expect(bossPlan(5, 2)).toEqual(bossPlan(5, 2));
    expect(bossPlan(5, 2)).not.toEqual(bossPlan(6, 2));
    expect(bossPlan(5, 2)).not.toEqual(bossPlan(5, 3));
    expect(zoneOf(5, 3)).toEqual(zoneOf(5, 3));
  });

  it("are built of a mirrored hull with their cores and guns on its underside", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (let zone = 0; zone < 10; zone++) {
        const p = bossPlan(seed, zone);
        for (const row of p.rows) expect(row).toBe([...row].reverse().join(""));
        expect(p.cores.length).toBeGreaterThan(0);
        for (const c of p.cores) {
          // On the hull, with nothing under it for a shot from below to stop on.
          expect(filled(p, c.dx, c.dy)).toBe(true);
          for (let y = c.dy + 1; y < p.h; y++) expect(filled(p, c.dx, y)).toBe(false);
        }
        for (const t of p.turrets) expect(filled(p, t.dx, t.dy)).toBe(true);
      }
    }
  });

  it("grow with the zones: bigger, more guns, more patterns, more health", () => {
    const at = (zone: number) => [1, 2, 3, 4, 5, 6].map((seed) => bossPlan(seed, zone));
    const sum = (ps: BossPlan[], f: (p: BossPlan) => number) => mean(ps.map(f));
    const early = at(0);
    const late = at(6);
    expect(sum(late, (p) => p.w * p.h)).toBeGreaterThan(sum(early, (p) => p.w * p.h));
    expect(sum(late, (p) => p.turrets.length)).toBeGreaterThan(sum(early, (p) => p.turrets.length));
    expect(sum(late, (p) => p.cores.reduce((a, c) => a + c.hp, 0))).toBeGreaterThan(sum(early, (p) => p.cores.reduce((a, c) => a + c.hp, 0)));
    expect(new Set(early.flatMap((p) => p.turrets.map((t) => t.pattern)))).toEqual(new Set(["aimed", "fan"].filter((k) => early.some((p) => p.turrets.some((t) => t.pattern === k)))));
    expect(new Set(early.flatMap((p) => p.turrets.map((t) => t.pattern))).size).toBeLessThanOrEqual(2);
    expect(new Set(late.flatMap((p) => p.turrets.map((t) => t.pattern))).size).toBeGreaterThanOrEqual(4);
  });

  it("hold the scroll at the zone's end until beaten, then the next zone begins", () => {
    const s = atBoss(3, 0);
    for (let n = 0; n < 10; n++) stepRun(s, idle);
    const held = s.distance;
    expect(s.boss?.phase).toBe("enter");
    expect(s.warning).toBeGreaterThan(0);
    for (let n = 0; n < ENTER_STEPS + 20; n++) {
      stepRun(s, idle);
      s.ship.safe = 60;
    }
    expect(s.distance).toBe(held);
    expect(s.sector).toBe(ZONE_SECTORS - 1);
    expect(s.boss?.phase).toBe("fight");
    // Shots on its hull do nothing; on a core they count.
    const boss = s.boss!;
    const core = boss.cores[0];
    const hp = core.hp;
    s.shots.push({ x: boss.x + boss.plan.w / 2 - 2, y: boss.y, vx: 0, vy: 0 });
    stepRun(s, idle);
    expect(s.shots).toEqual([]);
    expect(core.hp).toBe(hp);
    const before = s.score;
    for (const c of boss.cores) c.hp = 1;
    for (const c of boss.cores) s.shots.push({ x: boss.x + c.dx, y: boss.y + c.dy + 4, vx: 0, vy: 0 });
    stepRun(s, idle);
    expect(boss.phase).toBe("dying");
    expect(s.score - before).toBeGreaterThanOrEqual(1000);
    expect(s.bolts).toEqual([]);
    for (let n = 0; n < BOSS_DYING + 2; n++) stepRun(s, idle);
    expect(s.boss).toBeNull();
    expect(s.zone).toBe(1);
    expect(s.pickups.map((p) => p.kind).sort()).toEqual(["rapid", "shield", "spread"]);
    for (let n = 0; n < 10; n++) stepRun(s, idle);
    expect(s.distance).toBeGreaterThan(held);
    expect(s.sector).toBe(ZONE_SECTORS);
  });

  it("lose their guns as they're shot out", () => {
    const s = atBoss(3, 2);
    for (let n = 0; n < ENTER_STEPS + 20; n++) {
      stepRun(s, idle);
      s.ship.safe = 60;
    }
    const boss = s.boss!;
    for (const t of boss.turrets) t.hp = 1;
    // One out to the side, clear of the cores, goes to a shot.
    const side = boss.turrets.find((t) => boss.cores.every((c) => Math.abs(c.dx - t.dx) >= 7))!;
    s.shots.push({ x: boss.x + side.dx, y: boss.y + side.dy + 3, vx: 0, vy: 0 });
    stepRun(s, idle);
    expect(side.hp).toBe(0);
    // The rest to a bomb; then nothing more comes.
    perk(s, "bomb");
    expect(boss.turrets.every((t) => t.hp <= 0)).toBe(true);
    s.bolts = [];
    for (let n = 0; n < 300; n++) {
      stepRun(s, idle);
      s.ship.safe = 60;
    }
    expect(s.bolts).toEqual([]);
  });

  it("are beaten by the computer, the early ones untouched, the later hitting back harder", () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const byZone = [0, 1, 2, 3, 4, 5].map((zone) => seeds.map((seed) => fight(seed, zone, Math.min(MAX_LEVEL, Math.floor(zone / 2)))));
    for (const fights of byZone) for (const f of fights) expect(f.steps).toBeLessThan(9000);
    expect(byZone[0].every((f) => f.hits === 0)).toBe(true);
    const hits = byZone.map((fights) => mean(fights.map((f) => f.hits)));
    expect(hits[4] + hits[5]).toBeGreaterThan(hits[0] + hits[1] + 1);
  });

  it("fight the same, step for step, from the same seed and pad", () => {
    const run = () => {
      const s = atBoss(11, 3);
      for (let n = 0; n < 1500; n++) stepRun(s, autopilot(s));
      return [s.score, s.hits, s.boss?.cores.map((c) => c.hp), s.bolts.length];
    };
    expect(run()).toEqual(run());
  });
});

describe("star run's perks", () => {
  const quiet = () => {
    const s = runState(5);
    s.pending = [];
    return s;
  };
  const volley = (s: RunState) => {
    s.shots = [];
    s.ship.cool = 0;
    stepRun(s, press({ a: true }));
    return s.shots.length;
  };

  it("widen the gun a level at a time, and quicken it", () => {
    const s = quiet();
    const widths = [volley(s)];
    for (let n = 0; n < MAX_LEVEL; n++) {
      perk(s, "spread");
      widths.push(volley(s));
    }
    expect(widths).toEqual([1, 2, 3, 5]);
    const rate = () => {
      s.shots = [];
      s.ship.cool = 0;
      for (let n = 0; n < 60; n++) stepRun(s, press({ a: true }));
      return s.shots.length;
    };
    s.ship.spread = 0;
    const slow = rate();
    perk(s, "rapid");
    perk(s, "rapid");
    expect(rate()).toBeGreaterThan(slow * 1.5);
  });

  it("stack to a ceiling, and score past it", () => {
    const s = quiet();
    for (let n = 0; n < 5; n++) for (const k of ["spread", "rapid", "shield", "life"] as const) perk(s, k);
    expect([s.ship.spread, s.ship.rapid, s.ship.shield, s.lives]).toEqual([MAX_LEVEL, MAX_LEVEL, MAX_LEVEL, MAX_LIVES]);
    expect(s.score).toBeGreaterThan(0);
    perk(s, "magnet");
    perk(s, "magnet");
    perk(s, "magnet");
    expect(s.ship.magnet).toBe(MAGNET_STEPS * 2);
  });

  it("drop back a level on a hit, unless a shield takes it", () => {
    const s = quiet();
    const hit = () => {
      s.ship.safe = 0;
      s.bolts.push({ x: s.ship.x, y: s.ship.y, vx: 0, vy: 0 });
      stepRun(s, idle);
    };
    Object.assign(s.ship, { spread: 2, rapid: 1, shield: 1 });
    hit();
    expect([s.lives, s.ship.spread, s.ship.rapid, s.ship.shield]).toEqual([LIVES, 2, 1, 0]);
    hit();
    expect([s.lives, s.ship.spread, s.ship.rapid]).toEqual([LIVES - 1, 1, 1]);
    hit();
    expect([s.lives, s.ship.spread, s.ship.rapid]).toEqual([LIVES - 2, 0, 1]);
    expect(s.hits).toBe(3);
  });

  it("bomb the screen clear, but never finish a boss", () => {
    const s = quiet();
    for (let n = 0; n < 30; n++) stepRun(s, idle);
    s.enemies.push({ kind: "gunner", path: { x: 80, vx: 0, vy: 1, amp: 0, w: 0, phase: 0, stop: 60, hold: 1000 }, x: 80, y: 60, hp: 9, t: 80, fire: 0, shot: 0, next: 0, dive: null, flash: 0 });
    s.rocks.push({ x: 40, y: 50, vx: 0, vy: 0, size: 2, shape: 0, hp: 6, flash: 0 });
    s.bolts.push({ x: 100, y: 100, vx: 0, vy: 1 });
    perk(s, "bomb");
    stepRun(s, idle);
    expect([s.enemies, s.rocks, s.bolts]).toEqual([[], [], []]);
    expect(s.flash).toBeGreaterThan(0);

    const b = atBoss(3, 0);
    for (let n = 0; n < ENTER_STEPS + 20; n++) stepRun(b, idle);
    for (const c of b.boss!.cores) c.hp = 2;
    perk(b, "bomb");
    expect(b.boss!.cores.every((c) => c.hp === 1)).toBe(true);
    expect(b.boss!.phase).toBe("fight");
  });

  it("are pulled in by the magnet, and taken by flying into them", () => {
    const s = quiet();
    s.pickups.push({ x: s.ship.x + 50, y: s.ship.y - 40, kind: "shield", t: 0 });
    for (let n = 0; n < 40; n++) stepRun(s, idle);
    expect(s.ship.shield).toBe(0);
    expect(s.pickups.length).toBe(1);
    s.pickups = [{ x: s.ship.x + 50, y: s.ship.y - 40, kind: "shield", t: 0 }];
    perk(s, "magnet");
    for (let n = 0; n < 40; n++) stepRun(s, idle);
    expect(s.pickups).toEqual([]);
    expect(s.ship.shield).toBe(1);
  });

  it("drop from what's shot down, the same from the same run", () => {
    const flown = () => {
      const s = runState(21, 0, 4);
      const kinds: string[] = [];
      for (let n = 0; n < 3000; n++) {
        stepRun(s, autopilot(s));
        for (const p of s.pickups) if (p.t === 1) kinds.push(p.kind);
        s.lives = LIVES;
      }
      return kinds;
    };
    const kinds = flown();
    expect(kinds.length).toBeGreaterThan(2);
    expect(flown()).toEqual(kinds);
  });
});
