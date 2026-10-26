import { describe, expect, it } from "vitest";

import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import { buildOffice } from "../map/build";
import { createWorld, seatedAt, type World } from "./entities";
import { stepWalkers } from "./move";
import { createStaff, seatSessions, showScreens, type Staff } from "./sessions";

const office = buildOffice();

const instance = (id: string, projectId: string, live = true): RemoteInstance => ({
  id,
  projectId,
  projectName: projectId,
  title: id,
  taskNote: "",
  branch: null,
  worktreeOn: false,
  remote: false,
  phase: live ? "working" : null,
  compacting: false,
  subagents: 0,
  activity: null,
  status: "idle",
  ctxTokens: 0,
  live,
  needsSince: null,
  escalated: false,
  stuck: false,
  choice: null,
});

const snapshot = (instances: RemoteInstance[]): RemoteSnapshot => ({
  updatedAt: 0,
  usageLimits: null,
  instances,
  projects: [],
  duck: { state: "idle", autopilots: [] },
  created: [],
});

/** Steps until nobody's walking. */
function settle(world: World, staff: Staff): void {
  let ms = 0;
  for (let n = 0; n < 3000 && world.workers.some((w) => w.walk); n++) {
    if (stepWalkers(world, office, (ms += 100))) showScreens(office, world, staff);
  }
  expect(world.workers.filter((w) => w.walk).map((w) => w.worker.id)).toEqual([]);
}

const workerOf = (staff: Staff, id: string) => staff.seating.get(id)!.worker!;

describe("sessions in the office", () => {
  it("puts the first snapshot's workers straight at their desks, everyone else about the place", () => {
    const world = createWorld(office);
    const staff = createStaff({ rooms: { dem: "demiurge" } });
    seatSessions(office, world, staff, snapshot([instance("a", "dem"), instance("b", "misc")]), 0, () => 0);
    for (const id of ["a", "b"]) {
      const s = staff.seating.get(id)!;
      const w = world.workers.find((o) => o.worker.id === s.worker)!;
      expect([w.seat, w.walk, w.tag]).toEqual([s.desk, null, "working"]);
      expect(world.screens[s.desk!]).toBe("code");
    }
    const free = world.workers.filter((w) => w.seat === null);
    expect(free.length).toBe(10);
    expect(free.every((w) => !w.walk && w.tag === null)).toBe(true);
    expect(new Set(free.map((w) => `${w.x},${w.y}`)).size).toBe(10);
  });

  it("walks a newly assigned worker to their desk, and a released one to the kitchen", () => {
    const world = createWorld(office);
    const staff = createStaff();
    seatSessions(office, world, staff, snapshot([]), 0);
    seatSessions(office, world, staff, snapshot([instance("a", "misc")]), 0, () => 0);
    const w = world.workers.find((o) => o.worker.id === workerOf(staff, "a"))!;
    expect(w.walk?.then).toEqual({ kind: "sit", seat: staff.seating.get("a")!.desk });
    expect(world.screens[staff.seating.get("a")!.desk!]).toBe("off");
    settle(world, staff);
    expect(w.seat).toBe(staff.seating.get("a")!.desk);
    expect(world.screens[w.seat!]).toBe("code");

    // It ends: they get up and go to a free kitchen spot, and the screen goes dark.
    const desk = w.seat!;
    seatSessions(office, world, staff, snapshot([instance("a", "misc", false)]), 0);
    expect(w.tag).toBeNull();
    settle(world, staff);
    const spot = office.spots.find((s) => s.id === staff.spots.get(w.worker.id))!;
    expect(["drink", "chat", "play", "dnd", "window"]).toContain(spot.kind);
    expect([w.x, w.y, w.dir]).toEqual([spot.x, spot.y, spot.dir]);
    expect(world.screens[desk]).toBe("off");
  });

  it("sends the first ones released to the kitchen when it has room", () => {
    const world = createWorld(office);
    const staff = createStaff();
    const all = Array.from({ length: 12 }, (_, i) => instance(`s${i}`, "misc"));
    seatSessions(office, world, staff, snapshot(all), 0);
    const first = workerOf(staff, "s0");
    seatSessions(office, world, staff, snapshot(all.slice(1)), 0);
    expect(["drink", "chat"]).toContain(office.spots.find((s) => s.id === staff.spots.get(first))!.kind);
  });

  it("brings in a worker who is out, through the door", () => {
    const world = createWorld(office);
    const staff = createStaff();
    seatSessions(office, world, staff, snapshot([]), 0);
    for (const w of world.workers) w.away = true;
    seatSessions(office, world, staff, snapshot([instance("a", "misc")]), 0);
    const w = world.workers.find((o) => o.worker.id === workerOf(staff, "a"))!;
    expect([w.away, w.x, w.y]).toEqual([false, office.door.x, office.door.y]);
    settle(world, staff);
    expect({ x: w.x, y: w.y }).toEqual(seatedAt(office.seats[w.seat!]));
  });

  it("gives contractors a laptop", () => {
    const world = createWorld(office);
    const staff = createStaff();
    const all = Array.from({ length: 13 }, (_, i) => instance(`s${i}`, "misc"));
    seatSessions(office, world, staff, snapshot(all), 0);
    expect(world.contractors).toHaveLength(1);
    expect(world.screens[world.contractors[0].desk]).toBe("laptop");
  });

  it("says when the sticky map changed, so it can be saved", () => {
    const world = createWorld(office);
    const staff = createStaff();
    expect(seatSessions(office, world, staff, snapshot([instance("a", "misc")]), 0)).toBe(true);
    expect(seatSessions(office, world, staff, snapshot([instance("a", "misc")]), 0)).toBe(false);
  });
});
