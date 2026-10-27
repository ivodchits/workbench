import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { TRAVEL_MAX, behave } from "./behave";
import { createWorld } from "./entities";
import { dice, instance, snapshot, testStaff } from "./fixtures";
import { ACTIVITIES, LIKED, activity, dayPart, pickIdle, type PickInput } from "./idle";
import { stepWalkers } from "./move";
import { seatSessions } from "./sessions";

const office = buildOffice();

describe("the time of day", () => {
  it("has a lunch and a night", () => {
    expect([6, 7, 11, 12, 13, 14, 21, 22, 0].map(dayPart)).toEqual(["night", "day", "day", "lunch", "lunch", "day", "day", "night", "night"]);
  });
});

describe("picking what to do", () => {
  const base: PickInput = { likes: [], part: "day", last: null, kitchenFirst: false, homeOk: true, free: () => true, random: dice() };
  const tally = (over: Partial<PickInput>, n = 2000) => {
    const counts = new Map<string, number>();
    const random = dice(7);
    for (let i = 0; i < n; i++) {
      const id = pickIdle({ ...base, random, ...over })?.activity.id ?? "none";
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return (id: string) => (counts.get(id) ?? 0) / n;
  };

  it("knows every place it names", () => {
    const spots = new Set(office.spots.map((s) => s.id));
    for (const a of ACTIVITIES) if (a.at !== "home") for (const id of a.at) expect(spots, `${a.id}: ${id}`).toContain(id);
  });

  it("never does the same thing twice running, and only where it's free", () => {
    const share = tally({ last: "coffee", free: (s) => s !== "sofa-1" && s !== "sofa-2" });
    expect(share("coffee")).toBe(0);
    for (let i = 0; i < 200; i++) {
      const pick = pickIdle({ ...base, random: dice(i), free: (s) => s !== "sofa-1" && s !== "sofa-2" })!;
      if (pick.activity.id === "sofa") expect(pick.place).toBe("sofa-3");
    }
  });

  it("goes to the kitchen first when a session ends, if there's room", () => {
    expect(ACTIVITIES.filter((a) => tally({ kitchenFirst: true })(a.id) > 0).every((a) => a.kitchen)).toBe(true);
    const kitchen = new Set(ACTIVITIES.filter((a) => a.kitchen).flatMap((a) => (a.at === "home" ? [] : a.at)));
    expect(tally({ kitchenFirst: true, free: (s) => !kitchen.has(s) })("none")).toBe(0);
  });

  it("likes what they like, and fits the time of day", () => {
    expect(tally({ likes: ["books"] })("books") / tally({})("books")).toBeGreaterThan(LIKED * 0.7);
    const night = tally({ part: "night" });
    const day = tally({});
    expect(night("sofa")).toBeGreaterThan(day("sofa") * 1.5);
    expect(night("coffee")).toBeLessThan(day("coffee"));
    expect(tally({ part: "lunch" })("snack")).toBeGreaterThan(day("snack") * 2);
  });

  it("uses their own desk only when it may, and gives up with nowhere free", () => {
    expect(tally({ homeOk: false })("desk")).toBe(0);
    expect(pickIdle({ ...base, homeOk: false, free: () => false })).toBeNull();
    expect(pickIdle({ ...base, free: () => false })?.place).toBe("home");
  });

  it("lasts as long as the activity says", () => {
    for (let i = 0; i < 100; i++) {
      const pick = pickIdle({ ...base, random: dice(i) })!;
      const [lo, hi] = pick.activity.lasts;
      expect(pick.lasts).toBeGreaterThanOrEqual(lo);
      expect(pick.lasts).toBeLessThanOrEqual(hi);
    }
  });
});

describe("an idle office", () => {
  /** Twelve idle workers (or fewer, with sessions) for `minutes`, stepped like the page;
   *  checks every step that no two hold one place or stand on one spot. */
  function live(minutes: number, hour: number, sessions: string[] = [], seed = 3) {
    const world = createWorld(office);
    const staff = testStaff();
    staff.hour = () => hour;
    staff.random = dice(seed);
    let ms = 0;
    seatSessions(office, world, staff, snapshot(sessions.map((id) => instance(id, "misc"))), ms, () => 0);
    const picks = new Map<string, number>();
    const travels: number[] = [];
    const seen = new Map<string, { activity: string; since: number; arrived: boolean }>();
    let walking = 0;
    let steps = 0;
    for (const end = minutes * 60_000; ms < end; ) {
      stepWalkers(world, office, (ms += 100));
      behave(office, world, staff, ms);
      steps++;
      const held = [...staff.spots.values()];
      expect(new Set(held).size, `two hold one place at ${ms}`).toBe(held.length);
      const resting = world.workers.filter((w) => !w.walk && w.seat === null).map((w) => `${w.x},${w.y}`);
      expect(new Set(resting).size, `two stand on one spot at ${ms}`).toBe(resting.length);
      for (const w of world.workers) {
        const s = staff.idle.get(w.worker.id);
        if (w.walk && s) walking++;
        if (!s) continue;
        const was = seen.get(w.worker.id);
        if (!was || was.since !== s.since) {
          seen.set(w.worker.id, { activity: s.activity, since: s.since, arrived: false });
          picks.set(w.worker.id, (picks.get(w.worker.id) ?? 0) + 1);
        } else if (!was.arrived && s.until !== null) {
          was.arrived = true;
          travels.push(ms - s.since);
        }
      }
    }
    return { world, staff, picks, travels, walking: walking / (steps * world.workers.length) };
  }

  it("keeps everyone busy for ten minutes: nobody stuck, nobody on top of anyone", () => {
    const { world, picks, travels, walking } = live(10, 10);
    for (const w of world.workers) expect(picks.get(w.worker.id), w.worker.id).toBeGreaterThanOrEqual(2);
    // Nobody gave up on getting somewhere (two meeting head-on in a corridor can take a
    // few seconds to sort out), and most get there quickly.
    expect(Math.max(...travels)).toBeLessThan(TRAVEL_MAX);
    expect([...travels].sort((x, y) => x - y)[travels.length >> 1]).toBeLessThan(30_000);
    // Mostly doing things, not walking between them.
    expect(walking).toBeLessThan(0.3);
  });

  it("works round people at work, at lunch and at night", () => {
    for (const hour of [12, 23]) {
      const { world, picks } = live(10, hour, ["a", "b", "c"], hour);
      const idle = world.workers.filter((w) => picks.has(w.worker.id));
      expect(idle.length).toBeGreaterThanOrEqual(9);
      for (const w of idle) expect(picks.get(w.worker.id)).toBeGreaterThanOrEqual(2);
    }
  });

  it("sits people on the sofa and the beanbags behind their fronts", () => {
    for (const seat of office.spots.filter((s) => s.kind === "sit")) {
      const under = office.props.find((p) => /sofa|beanbag/.test(p.id) && seat.x >= p.x && seat.x < p.x + p.prop.w);
      expect(under, seat.id).toBeDefined();
      // Drawn back to front by the feet: theirs above the furniture's means behind it.
      expect(seat.y, seat.id).toBeLessThan(under!.base);
    }
    // Getting up again: the night runs above move everyone on, sofa and all.
  });

  it("does what the activity says once there", () => {
    const { world, staff } = live(3, 10);
    for (const w of world.workers) {
      const s = staff.idle.get(w.worker.id)!;
      if (s.until === null || w.walk) continue;
      expect(w.anim, `${w.worker.id} at ${s.activity}`).toBe(activity(s.activity)!.anim);
    }
  });
});
