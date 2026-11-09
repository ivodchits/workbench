import { describe, expect, it } from "vitest";

import { buildOffice, cellOf, isFree, type Point } from "../map/build";
import { PET_MS, PLAY_MAX, WAIT_MAX, createBall, createLupa, grabBall, holdBall, petLupa, stepBall, stepLupa, throwBall, type Ball, type LupaEntity, type LupaSense } from "./lupa";

const office = buildOffice();
const onFloor = (p: Point) => isFree(office.walk, cellOf(p));

/** Dice that go round `seed`'s sequence. */
function dice(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function setup(pointer: Point | null = { x: 460, y: 200 }) {
  const lupa = createLupa({ x: 440, y: 140 });
  const ball = createBall({ x: 420, y: 150 });
  const sense: LupaSense = { pointer, people: () => [{ x: 300, y: 250 }], night: false, random: dice(7) };
  return { lupa, ball, sense };
}

/** Steps Lupa and the ball from `ms` for `steps` steps; returns the time after. */
function run(l: LupaEntity, b: Ball, sense: LupaSense, ms: number, steps: number, each?: (ms: number) => void): number {
  for (let i = 0; i < steps; i++) {
    ms += 100;
    stepBall(office, b);
    stepLupa(office, l, b, sense, ms);
    each?.(ms);
  }
  return ms;
}

describe("the ball", () => {
  it("thrown, flies, bounces and rolls to a stop on the floor, never into the furniture", () => {
    const { lupa, ball } = setup();
    grabBall(ball, lupa, 420, 150, 0);
    throwBall(office, ball, lupa, 20, 6, 0);
    let bounced = 0;
    let wasUp = false;
    for (let i = 0; i < 200; i++) {
      stepBall(office, ball);
      expect(onFloor(ball)).toBe(true);
      if (wasUp && ball.z === 0) bounced++;
      wasUp = ball.z > 0;
    }
    expect(bounced).toBeGreaterThanOrEqual(1);
    expect([ball.vx, ball.vy, ball.vz, ball.z]).toEqual([0, 0, 0, 0]);
    expect(ball.x).toBeGreaterThan(440);
  });

  it("bounces back off a wall", () => {
    const ball = createBall({ x: 440, y: 50 });
    ball.vy = -15;
    for (let i = 0; i < 20; i++) stepBall(office, ball);
    expect(ball.vy).toBeGreaterThanOrEqual(0);
    expect(onFloor(ball)).toBe(true);
  });

  it("let go over furniture, lands on the floor beside it", () => {
    const { lupa, ball } = setup();
    grabBall(ball, lupa, 0, 0, 0);
    holdBall(ball, 304, 136); // over the standup table
    throwBall(office, ball, lupa, 0, 0, 0);
    expect(onFloor(ball)).toBe(true);
  });

  it("throws no faster than the cap", () => {
    const { lupa, ball } = setup();
    grabBall(ball, lupa, 420, 150, 0);
    throwBall(office, ball, lupa, 300, 0, 0);
    expect(Math.hypot(ball.vx, ball.vy)).toBeLessThanOrEqual(26.01);
  });
});

describe("Lupa", () => {
  it("roams the office for an hour, always on the floor, and naps some of it", () => {
    const { lupa, ball, sense } = setup();
    const did = new Set<string>();
    run(lupa, ball, sense, 0, 36_000, () => {
      expect(onFloor(lupa) || lupa.anim === "sleep").toBe(true);
      did.add(lupa.anim);
    });
    for (const anim of ["sleep", "walk", "sit"]) expect(did.has(anim), anim).toBe(true);
    expect(lupa.mood.kind).toBe("roam");
  });

  it("ignores a ball thrown without her attention", () => {
    const { lupa, ball, sense } = setup();
    grabBall(ball, lupa, 380, 200, 0);
    throwBall(office, ball, lupa, 10, 0, 0);
    run(lupa, ball, sense, 0, 50);
    expect(lupa.mood.kind).toBe("roam");
  });

  it("chases a ball brought to her, brings it back to the pointer and waits for the next throw", () => {
    const pointer = { x: 460, y: 200 };
    const { lupa, ball, sense } = setup(pointer);
    lupa.mood = { kind: "roam", doing: "sit", until: 1e9, since: 0 };
    grabBall(ball, lupa, 0, 0, 0);
    holdBall(ball, lupa.x, lupa.y - 6);
    let ms = run(lupa, ball, sense, 0, 1);
    expect(lupa.mood.kind).toBe("chase");
    // Thrown across the lounge.
    throwBall(office, ball, lupa, -18, 4, ms);
    const kinds: string[] = [];
    for (let i = 0; i < 300 && (lupa.mood.kind as string) !== "wait"; i++) ms = run(lupa, ball, sense, ms, 1, () => kinds.push(lupa.mood.kind));
    expect(kinds).toContain("fetch");
    expect(lupa.mood.kind).toBe("wait");
    expect(lupa.carrying).toBe(false);
    expect(Math.hypot(ball.x - pointer.x, ball.y - pointer.y)).toBeLessThan(24);
    // Picked up from by her paws: she's straight after it again.
    grabBall(ball, lupa, ball.x, ball.y, ms);
    expect(lupa.mood.kind).toBe("chase");
  });

  it("gives up the chase after half a minute", () => {
    const { lupa, ball, sense } = setup();
    grabBall(ball, lupa, 0, 0, 0);
    holdBall(ball, lupa.x, lupa.y - 6);
    run(lupa, ball, sense, 0, PLAY_MAX / 100 + 5);
    expect(lupa.mood.kind).toBe("roam");
  });

  it("gives up bringing it back after half a minute, and drops it", () => {
    const { lupa, ball, sense } = setup(null);
    lupa.carrying = true;
    ball.carried = true;
    lupa.mood = { kind: "fetch", since: 0 };
    run(lupa, ball, sense, 0, PLAY_MAX / 100 + 5);
    expect([lupa.mood.kind, lupa.carrying, ball.carried]).toEqual(["roam", false, false]);
  });

  it("stops waiting for a throw after a while", () => {
    const { lupa, ball, sense } = setup();
    lupa.mood = { kind: "wait", since: 0 };
    run(lupa, ball, sense, 0, WAIT_MAX / 100 + 5);
    expect(lupa.mood.kind).toBe("roam");
  });

  it("enjoys a pet, then goes back to sleep where she was", () => {
    const { lupa, ball, sense } = setup();
    const at = { x: lupa.x, y: lupa.y };
    expect(petLupa(lupa, 0)).toBe(true);
    run(lupa, ball, sense, 0, 3);
    expect(lupa.anim).toBe("happy");
    run(lupa, ball, sense, 300, PET_MS / 100);
    expect([lupa.anim, lupa.x, lupa.y]).toEqual(["sleep", at.x, at.y]);
  });

  it("doesn't stop for a pet mid-chase", () => {
    const { lupa } = setup();
    lupa.mood = { kind: "chase", since: 0 };
    expect(petLupa(lupa, 0)).toBe(false);
    expect(lupa.mood.kind).toBe("chase");
  });
});
