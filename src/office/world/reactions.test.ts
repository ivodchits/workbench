import { describe, expect, it } from "vitest";

import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import { buildOffice } from "../map/build";
import { behave } from "./behave";
import { createWorld } from "./entities";
import { instance, snapshot, testStaff } from "./fixtures";
import { stepWalkers } from "./move";
import { CHEER_LASTS, VISIT_FOR, besideForDuck } from "./reactions";
import { seatSessions } from "./sessions";

const office = buildOffice();

/** An office driven like the page, with each snapshot's projects and autopilots. */
function office$() {
  const world = createWorld(office);
  const staff = testStaff();
  let ms = 0;
  const seat = (list: RemoteInstance[], commits: Record<string, number> = {}, autopilots: string[] = []) => {
    const s: RemoteSnapshot = {
      ...snapshot(list),
      projects: Object.entries(commits).map(([id, n]) => ({ id, name: id, group: null, remote: false, lastCommitAt: null, commitsToday: n })),
      duck: { state: "idle", autopilots },
    };
    seatSessions(office, world, staff, s, ms, () => 0);
  };
  return {
    world,
    staff,
    seat,
    run(span: number, each?: () => void) {
      for (const end = ms + span; ms < end; ) {
        stepWalkers(world, office, (ms += 100));
        behave(office, world, staff, ms);
        each?.();
      }
    },
    of: (id: string) => world.workers.find((w) => w.worker.id === staff.seating.get(id)?.worker)!,
  };
}

describe("a commit", () => {
  it("has the worker on its project get up and cheer, then go back to work", () => {
    const o = office$();
    const list = [instance("a", "p", { activity: "edit" }), instance("b", "q", { activity: "edit" })];
    o.seat(list, { p: 3, q: 1 });
    o.run(20_000);
    const [a, b] = [o.of("a"), o.of("b")];
    expect([a.seat, a.anim]).toEqual([a.home, "type"]);
    o.seat(list, { p: 4, q: 1 });
    let cheered = false;
    o.run(CHEER_LASTS, () => (cheered ||= a.anim === "cheer" && a.seat === null && a.dir === "down"));
    expect(cheered).toBe(true);
    expect(b.anim).toBe("type");
    o.run(20_000);
    expect([a.seat, a.anim]).toEqual([a.home, "type"]);
  });

  it("is cheered by whoever is running a command, at the rack", () => {
    const o = office$();
    const list = [instance("a", "p", { activity: "edit" }), instance("b", "p", { activity: "bash" })];
    o.seat(list, { p: 3 });
    o.run(30_000);
    o.seat(list, { p: 5 });
    o.run(1000);
    expect([o.of("b").anim, o.of("b").dir, o.of("a").anim]).toEqual(["cheer", "down", "type"]);
  });

  it("isn't news on the first snapshot, nor when the count first turns up, nor on a new day", () => {
    const o = office$();
    const list = [instance("a", "p")];
    o.seat(list, { p: 3 });
    o.run(1000);
    o.seat(list, { p: 0 });
    o.run(1000);
    expect(o.staff.cheers.size).toBe(0);
    const late = office$();
    late.seat(list);
    late.run(1000);
    late.seat(list, { p: 7 });
    late.run(1000);
    expect(late.staff.cheers.size).toBe(0);
  });
});

describe("Duck's autopilot", () => {
  it("brings Duck waddling over when it moves a session on, for a word, then back behind the desk", () => {
    const o = office$();
    const d = o.world.duck;
    const home = { x: d.x, y: d.y };
    o.seat([instance("a", "p", { phase: "done" })], {}, ["a"]);
    o.run(20_000);
    expect(d.walk).toBeNull();
    o.seat([instance("a", "p")], {}, ["a"]);
    o.run(200);
    expect([d.walk !== null, d.anim]).toEqual([true, "waddle"]);
    let said: string | null = null;
    o.run(60_000, () => (said ??= d.bubble?.text ?? null));
    expect(said).not.toBeNull();
    o.run(60_000);
    expect([d.x, d.y, d.view, d.anim, d.bubble, o.staff.trip]).toEqual([home.x, home.y, "down", "idle", null, null]);
  });

  it("stands beside the desk while it talks", () => {
    const o = office$();
    const d = o.world.duck;
    o.seat([instance("a", "p", { phase: "done" })], {}, ["a"]);
    o.run(20_000);
    o.seat([instance("a", "p", { compacting: true, phase: "done" })], {}, ["a"]);
    for (let i = 0; i < 1000 && !d.bubble; i++) o.run(100);
    expect(d.bubble).not.toBeNull();
    const by = besideForDuck(office.seats[o.staff.seating.get("a")!.desk!]);
    expect(Math.hypot(d.x - by.x, d.y - by.y)).toBeLessThan(24);
    expect([d.anim, d.walk]).toEqual(["speak", null]);
    o.run(VISIT_FOR - 200);
    expect(d.bubble).not.toBeNull();
    o.run(400);
    expect([d.bubble, d.anim]).toEqual([null, "waddle"]);
  });

  it("stays put for a session it doesn't drive, and for one that was already working", () => {
    const o = office$();
    const d = o.world.duck;
    o.seat([instance("a", "p", { phase: "done" })]);
    o.run(5000);
    o.seat([instance("a", "p")]);
    o.run(1000);
    o.seat([instance("a", "p", { activity: "bash" })], {}, ["a"]);
    o.run(1000);
    expect([d.walk, o.staff.trip]).toEqual([null, null]);
  });
});
