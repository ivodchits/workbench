import { describe, expect, it } from "vitest";

import { readPad, type Pad } from "../pad";
import { heat, pathAt, sector, SECTOR_LEN, SR_H, SR_W, type Sector } from "./sectors";
import { autopilot, LIVES, OVER_WAIT, runState, SAFE_STEPS, SCROLL, stepRun, type RunState } from "./starrun";

const idle = readPad(new Set());
const press = (more: Partial<Pad>): Pad => ({ ...idle, ...more });

/** How much a sector throws at you: every hit it takes to clear, and its shooting. */
function threat(sec: Sector): number {
  return sec.spawns.reduce((sum, sp) => sum + (sp.type === "rock" ? [1, 3, 6][sp.size] * 0.5 : sp.hp + (sp.fire ? (600 / sp.fire) * sp.shot : 0)), 0);
}

/** Steps the computer flies from sector `from` until its first hit (at most `cap`). It
 *  looks again only every 12 steps, a player's reactions: it sees ahead perfectly, and
 *  reacting at once it gets through nearly anything. */
function firstHit(seed: number, from: number, cap = 3000): number {
  const s = runState(seed, 0, from);
  let pad = autopilot(s);
  for (let n = 0; n < cap; n++) {
    if (n % 12 === 0) pad = autopilot(s);
    stepRun(s, pad);
    if (s.hits > 0) return n;
  }
  return cap;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("star run's sectors", () => {
  it("are the same from the same seed, and differ from another", () => {
    for (const n of [0, 1, 5, 20]) {
      expect(sector(42, n)).toEqual(sector(42, n));
      expect(sector(42, n)).not.toEqual(sector(43, n));
    }
    // A run made twice queues the same spawns.
    expect(runState(9).pending).toEqual(runState(9).pending);
  });

  it("start quiet and get hotter with distance", () => {
    expect(sector(1, 0).kind).toBe("squadron");
    expect(heat(0).kinds).toEqual(["dart"]);
    expect(heat(4).kinds).toEqual(["dart", "swoop", "gunner", "diver"]);
    for (const key of ["waves", "rocks", "speed", "shot", "hp", "big", "more"] as const) expect(heat(12)[key]).toBeGreaterThan(heat(0)[key]);
    expect(heat(12).fire).toBeLessThan(heat(0).fire);
    const early = mean(SEEDS.flatMap((seed) => [0, 1, 2].map((n) => threat(sector(seed, n)))));
    const middle = mean(SEEDS.flatMap((seed) => [6, 7, 8].map((n) => threat(sector(seed, n)))));
    const late = mean(SEEDS.flatMap((seed) => [14, 15, 16].map((n) => threat(sector(seed, n)))));
    expect(middle).toBeGreaterThan(early * 2);
    expect(late).toBeGreaterThan(middle * 1.3);
  });

  it("keep their spawns in the sector and on the screen's width", () => {
    for (const seed of SEEDS) {
      for (let n = 0; n < 20; n++) {
        for (const sp of sector(seed, n).spawns) {
          expect(sp.at).toBeGreaterThanOrEqual(0);
          expect(sp.at).toBeLessThan(SECTOR_LEN + 100);
          if (sp.type === "rock") {
            expect(sp.x).toBeGreaterThan(0);
            expect(sp.x).toBeLessThan(SR_W);
          } else if (sp.kind !== "swoop") {
            const p = pathAt(sp.path, 0);
            expect(p.x).toBeGreaterThan(0);
            expect(p.x).toBeLessThan(SR_W);
          }
        }
      }
    }
  });

  it("send gunners down to stop and shoot, then on", () => {
    const path = { x: 50, vx: 0, vy: 1, amp: 0, w: 0, phase: 0, stop: 40, hold: 100 };
    expect(pathAt(path, 50).y).toBe(40);
    expect(pathAt(path, 120).y).toBe(40);
    expect(pathAt(path, 170).y).toBeCloseTo(60);
  });
});

describe("star run", () => {
  it("scrolls on, brings on what the sectors hold, and scores a sector reached", () => {
    const s = runState(5);
    const steps = Math.ceil(SECTOR_LEN / SCROLL) + 1;
    let seen = 0;
    for (let n = 0; n < steps; n++) {
      stepRun(s, idle);
      seen = Math.max(seen, s.enemies.length);
      // Kept alive to see the whole sector come on.
      s.ship.safe = SAFE_STEPS;
    }
    expect(s.sector).toBe(1);
    expect(seen).toBeGreaterThan(0);
    expect(s.score).toBeGreaterThanOrEqual(100);
  });

  it("flies by the pad inside the screen, and fires while A is held", () => {
    const s = runState(5);
    for (let n = 0; n < 200; n++) stepRun(s, press({ x: -1, y: 1 }));
    expect(s.ship.x).toBe(6);
    expect(s.ship.y).toBe(SR_H - 10);
    stepRun(s, press({ a: true }));
    expect(s.shots.length).toBe(1);
    for (let n = 0; n < 6; n++) stepRun(s, press({ a: true }));
    expect(s.shots.length).toBe(1);
    stepRun(s, press({ a: true }));
    expect(s.shots.length).toBe(2);
  });

  it("shoots down an enemy for points, and splits a big asteroid in two", () => {
    const s = runState(5);
    s.pending = [];
    // Hovering in the ship's way.
    s.enemies.push({ kind: "dart", path: { x: 80, vx: 0, vy: 1, amp: 0, w: 0, phase: 0, stop: 100, hold: 1000 }, x: 80, y: 100, hp: 1, t: 110, fire: 0, shot: 0, next: 0, dive: null, flash: 0 });
    s.ship.x = 80;
    for (let n = 0; n < 40 && s.enemies.length; n++) stepRun(s, press({ a: true }));
    expect(s.enemies).toEqual([]);
    expect(s.score).toBe(50);
    s.rocks.push({ x: 80, y: 60, vx: 0, vy: 0, size: 2, shape: 0, hp: 1, flash: 0 });
    for (let n = 0; n < 40 && s.rocks.length === 1; n++) stepRun(s, press({ a: true }));
    expect(s.rocks.map((r) => r.size)).toEqual([1, 1]);
  });

  it("takes a life on a hit, then nothing touches you for a moment", () => {
    const s = runState(5);
    s.pending = [];
    const bolt = () => s.bolts.push({ x: s.ship.x, y: s.ship.y, vx: 0, vy: 0 });
    bolt();
    stepRun(s, idle);
    expect(s.lives).toBe(LIVES - 1);
    expect(s.bolts).toEqual([]);
    bolt();
    stepRun(s, idle);
    expect(s.lives).toBe(LIVES - 1);
    s.bolts = [];
    for (let n = 0; n < SAFE_STEPS; n++) stepRun(s, idle);
    bolt();
    stepRun(s, idle);
    expect(s.lives).toBe(LIVES - 2);
  });

  it("ends when the lives are gone, shows the best, and flies again on a press", () => {
    const s: RunState = runState(5, 400);
    s.pending = [];
    for (let life = 0; life < LIVES; life++) {
      s.ship.safe = 0;
      s.bolts.push({ x: s.ship.x, y: s.ship.y, vx: 0, vy: 0 });
      stepRun(s, idle);
    }
    expect(s.lives).toBe(0);
    expect(s.phase).toBe("dying");
    s.score = 900;
    for (let n = 0; n < 200 && s.phase !== "over"; n++) stepRun(s, idle);
    expect(s.phase).toBe("over");
    // A press too soon, or one held from before, doesn't start again.
    stepRun(s, press({ a: true }));
    for (let n = 0; n < OVER_WAIT; n++) stepRun(s, press({ a: true }));
    expect(s.phase).toBe("over");
    stepRun(s, idle);
    stepRun(s, press({ start: true }));
    expect(s.phase).toBe("play");
    expect(s.score).toBe(0);
    expect(s.lives).toBe(LIVES);
    expect(s.best).toBe(900);
    expect(s.seed).not.toBe(5);
  });

  it("pauses on Start", () => {
    const s = runState(5);
    stepRun(s, idle);
    stepRun(s, press({ start: true }));
    const at = s.distance;
    for (let n = 0; n < 30; n++) stepRun(s, idle);
    expect(s.distance).toBe(at);
    stepRun(s, press({ start: true }));
    stepRun(s, idle);
    expect(s.distance).toBeGreaterThan(at);
  });

  it("is the same run, step for step, from the same seed and pad", () => {
    const fly = () => {
      const s = runState(77);
      for (let n = 0; n < 1500; n++) stepRun(s, autopilot(s));
      return [s.score, s.lives, s.distance, s.enemies.length, s.rocks.length];
    };
    expect(fly()).toEqual(fly());
  });

  it("is survived longer by the computer in the early sectors than the late ones", () => {
    const seeds = [...SEEDS, 9, 10, 11, 12];
    const easy = seeds.map((seed) => firstHit(seed, 0));
    const hard = seeds.map((seed) => firstHit(seed, 18));
    // Untouched through the first sectors, every time; hit in most runs late on.
    expect(easy.every((n) => n === 3000)).toBe(true);
    expect(hard.filter((n) => n < 3000).length).toBeGreaterThanOrEqual(seeds.length / 2);
    expect(mean(easy)).toBeGreaterThan(mean(hard) * 1.5);
  });
});
