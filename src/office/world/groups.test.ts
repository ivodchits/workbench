import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { behave } from "./behave";
import { createWorld } from "./entities";
import { dice, instance, snapshot, testStaff } from "./fixtures";
import { CHEER_FOR, GOALS_TO_WIN, ballAt, kickerScore, newMatch } from "./groups";
import { stepWalkers } from "./move";
import { seatSessions } from "./sessions";

const office = buildOffice();

describe("a kicker match", () => {
  it("runs to five goals, one side winning", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const m = newMatch("a", "b", 1000, dice(seed));
      const [w, e] = kickerScore(m, m.end);
      expect(Math.max(w, e)).toBe(GOALS_TO_WIN);
      expect(Math.min(w, e)).toBeLessThan(GOALS_TO_WIN);
      expect(kickerScore(m, m.start)).toEqual([0, 0]);
      expect(m.goals.every((g, i) => i === 0 || g.at > m.goals[i - 1].at)).toBe(true);
      expect(m.end).toBe(m.goals[m.goals.length - 1].at);
    }
  });

  it("keeps the ball on the table, and puts it in the net at each goal", () => {
    const m = newMatch("a", "b", 0, dice(4));
    for (let ms = 0; ms < m.end; ms += 37) {
      const b = ballAt(m, ms);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThanOrEqual(1);
    }
    for (const g of m.goals) {
      const b = ballAt(m, g.at - 1);
      expect(Math.abs(b.x - (g.side === "west" ? 1 : 0))).toBeLessThan(0.01);
    }
  });
});

describe("idle workers together", () => {
  /** An office for `minutes` with a few sessions working, as the page steps it: what
   *  went in the log, and what was seen along the way. */
  function run(minutes: number, seed: number, hour = 15) {
    const world = createWorld(office);
    const staff = testStaff();
    staff.hour = () => hour;
    staff.random = dice(seed);
    let ms = 0;
    seatSessions(office, world, staff, snapshot(["a", "b", "c"].map((id) => instance(id, "misc"))), ms, () => 0);
    const log: string[] = [];
    let tvAlone = 0;
    let saidAtCooler = 0;
    let movedMidMatch = 0;
    for (const end = minutes * 60_000; ms < end; ) {
      stepWalkers(world, office, (ms += 100));
      behave(office, world, staff, ms);
      log.push(...staff.events.map((e) => e.text));
      staff.events.length = 0;
      const onSofa = world.workers.filter((w) => staff.idle.get(w.worker.id)?.activity === "sofa" && staff.idle.get(w.worker.id)?.until !== null && !w.walk);
      if (world.tv && onSofa.length < 2) tvAlone++;
      for (const w of world.workers) if (w.bubble?.tone === "say" && staff.idle.get(w.worker.id)?.activity === "cooler") saidAtCooler++;
      const m = world.kicker;
      if (m && ms < m.end + CHEER_FOR) for (const id of [m.west, m.east]) if (world.workers.find((w) => w.worker.id === id)!.walk) movedMidMatch++;
    }
    return { log, tvAlone, saidAtCooler, movedMidMatch };
  }

  it("chat at the cooler, play the kicker and the console by themselves, in an ordinary afternoon", () => {
    for (const seed of [1, 2, 3]) {
      const { log, tvAlone, saidAtCooler, movedMidMatch } = run(30, seed);
      expect(log.some((l) => l.endsWith("are chatting at the water cooler")), `seed ${seed}: ${log.join(" | ")}`).toBe(true);
      expect(log.some((l) => l.endsWith("got the console out")), `seed ${seed}: ${log.join(" | ")}`).toBe(true);
      expect(log.some((l) => / beat .* 5:\d at the kicker$/.test(l)), `seed ${seed}: ${log.join(" | ")}`).toBe(true);
      expect(saidAtCooler).toBeGreaterThan(0);
      expect(tvAlone).toBe(0);
      expect(movedMidMatch).toBe(0);
    }
  }, 30_000);
});
