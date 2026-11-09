import { describe, expect, it } from "vitest";

import { FRAME_H } from "../art/characters";
import { buildOffice } from "../map/build";
import { GUESTS, ROSTER, isGuest } from "../roster";
import { frameAt } from "./anim";
import { createWorld, setAnim, workerAt } from "./entities";

const office = buildOffice();

describe("the world at the start", () => {
  const all = createWorld(office);
  const world = { ...all, workers: all.workers.filter((w) => !isGuest(w.worker.id)) };

  it("seats every worker once, at a desk in their team's room", () => {
    expect(world.workers.map((w) => w.worker.id).sort()).toEqual(ROSTER.map((w) => w.id).sort());
    expect(new Set(world.workers.map((w) => w.home)).size).toBe(ROSTER.length);
    for (const w of world.workers) expect(office.seats[w.home].room).toBe(w.worker.team);
  });

  it("has the guests about too, standing, with no desk of their own", () => {
    const guests = all.workers.filter((w) => isGuest(w.worker.id));
    expect(guests.map((w) => w.worker.id)).toEqual(GUESTS.map((g) => g.id));
    for (const g of guests) expect([g.home, g.seat]).toEqual([-1, null]);
  });

  it("brings Lupa and her ball, on the floor", () => {
    for (const p of [all.lupa, all.ball]) expect(office.walk.blocked[Math.floor(p.y / 8) * office.walk.cols + Math.floor(p.x / 8)]).toBe(0);
  });

  it("draws seated workers at the seat's depth, so desk and chair layer as approved", () => {
    for (const w of world.workers) {
      const seat = office.seats[w.home];
      expect(w.y).toBe(seat.sit.base);
      expect(w.y - FRAME_H).toBe(seat.sit.y);
    }
  });

  it("starts neighbours' typing out of step", () => {
    const frames = new Set(world.workers.map((w) => frameAt(w.playing, 0).index));
    expect(frames.size).toBeGreaterThan(1);
  });

  it("lights the monitors of occupied desks only", () => {
    const home = new Set(world.workers.map((w) => w.home));
    world.screens.forEach((s, i) => expect(s).toBe(home.has(i) ? "code" : "off"));
  });

  it("puts Duck's feet at the bottom of the boss's spot", () => {
    expect(world.duck.y).toBeGreaterThan(office.duck.y);
  });
});

describe("animations and hit tests", () => {
  it("switching animation restarts it; the same one keeps going", () => {
    const world = createWorld(office);
    const w = world.workers[0];
    const before = w.playing;
    setAnim(w, "type", 5000);
    expect(w.playing).toBe(before);
    setAnim(w, "wave", 5000);
    expect(w.anim).toBe("wave");
    expect(frameAt(w.playing, 5000).index).toBe(0);
  });

  it("finds the worker under a point, the front one when two overlap", () => {
    const world = createWorld(office);
    const [a, b] = world.workers;
    expect(workerAt(world, a.x, a.y - 4)?.worker.id).toBe(a.worker.id);
    expect(workerAt(world, a.x, a.y + 40)).not.toBe(a);
    b.x = a.x;
    b.y = a.y + 4;
    expect(workerAt(world, a.x, a.y - 2)?.worker.id).toBe(b.worker.id);
  });
});
