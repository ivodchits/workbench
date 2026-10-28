import { describe, expect, it } from "vitest";

import type { RemoteCreated } from "../../remote/protocol";
import { buildOffice } from "../map/build";
import { ROSTER } from "../roster";
import { behave } from "./behave";
import { createWorld, homeDesks } from "./entities";
import { instance, snapshot, testStaff } from "./fixtures";
import { HIRE_MAX, UNHEARD_MS, deskFree, isFree, workerFor } from "./hire";
import { stepWalkers } from "./move";
import { seatSessions } from "./sessions";

const office = buildOffice();
const homes = homeDesks(office.seats);
const homeOf = (id: string) => [...homes].find(([, w]) => w.id === id)![0];
/** A desk in the open space nobody calls home. */
const spare = office.seats.find((s) => s.room === "open" && !homes.has(s.index))!.index;
const created = (requestId: string, over: Partial<RemoteCreated> = {}): RemoteCreated => ({ requestId, instanceId: null, state: "creating", message: null, ...over });

describe("giving tasks", () => {
  it("walks the worker to the desk asked for, and seats the new session with them there", () => {
    const world = createWorld(office);
    const staff = testStaff();
    seatSessions(office, world, staff, snapshot([]), 0);
    const worker = ROSTER.find((w) => w.team === "demiurge")!.id;
    staff.hires.push({ requestId: "r1", worker, desk: spare, at: 0 });
    expect([isFree(staff, worker), deskFree(staff, spare)]).toEqual([false, false]);

    behave(office, world, staff, 100);
    const w = world.workers.find((o) => o.worker.id === worker)!;
    expect(w.walk?.then).toEqual({ kind: "sit", seat: spare });

    // Another session meanwhile isn't given them, nor the desk.
    seatSessions(office, world, staff, { ...snapshot([instance("other", "misc")]), created: [created("r1")] }, 200, () => 0);
    expect(staff.seating.get("other")!.worker).not.toBe(worker);
    expect(staff.seating.get("other")!.desk).not.toBe(spare);

    // The request's instance turns up: theirs, at that desk, wherever its project sits.
    const ready = { ...snapshot([instance("other", "misc"), instance("new", "misc")]), created: [created("r1", { instanceId: "new", state: "sent" })] };
    expect(seatSessions(office, world, staff, ready, 300)).toBe(true);
    expect(staff.seating.get("new")).toEqual({ worker, desk: spare });
    expect(staff.sticky.new).toBe(worker);
    expect(staff.hires).toEqual([]);
    for (let ms = 400; world.workers.some((o) => o.walk) && ms < 300_000; ms += 100) {
      stepWalkers(world, office, ms);
      behave(office, world, staff, ms);
    }
    expect(w.seat).toBe(spare);
  });

  it("lets them go when the request failed, or Workbench never heard of it", () => {
    const world = createWorld(office);
    const staff = testStaff();
    seatSessions(office, world, staff, snapshot([]), 0);
    const [a, b, c] = ROSTER.map((w) => w.id);
    staff.hires.push({ requestId: "failed", worker: a, desk: 1, at: 0 }, { requestId: "unheard", worker: b, desk: 2, at: 0 }, { requestId: "slow", worker: c, desk: 3, at: 0 });
    const snap = { ...snapshot([]), created: [created("failed", { state: "failed", message: "no" }), created("slow")] };
    seatSessions(office, world, staff, snap, UNHEARD_MS - 1);
    expect(staff.hires.map((h) => h.requestId)).toEqual(["unheard", "slow"]);
    seatSessions(office, world, staff, snap, UNHEARD_MS);
    expect(staff.hires.map((h) => h.requestId)).toEqual(["slow"]);
    seatSessions(office, world, staff, snap, HIRE_MAX);
    expect(staff.hires).toEqual([]);
  });

  it("offers a desk's owner, else the nearest free worker of its room's team, else nobody", () => {
    const world = createWorld(office);
    const staff = testStaff();
    seatSessions(office, world, staff, snapshot([]), 0);
    const owned = [...homes].find(([, w]) => w.team === "tinywizard")!;
    expect(workerFor(office, world, staff, owned[0])).toBe(owned[1].id);
    staff.hires.push({ requestId: "r", worker: owned[1].id, desk: spare, at: 0 });
    const next = workerFor(office, world, staff, owned[0]);
    expect(ROSTER.find((w) => w.id === next)!.team).toBe("tinywizard");
    expect(next).not.toBe(owned[1].id);
    staff.hires = ROSTER.map((w, n) => ({ requestId: `r${n}`, worker: w.id, desk: homeOf(w.id), at: 0 }));
    expect(workerFor(office, world, staff, spare)).toBeNull();
  });
});
