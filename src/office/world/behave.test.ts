import { describe, expect, it } from "vitest";

import type { RemoteInstance } from "../../remote/protocol";
import { buildOffice } from "../map/build";
import { LOOSE_FOR, SETTLE, STAY, WANDER_AFTER, behave, besideDesk, doing } from "./behave";
import { debugClick } from "./debug";
import { createWorld, type WorkerEntity, type World } from "./entities";
import { EVERY_STATE, EVERY_STATE_ROOMS, instance, snapshot, testStaff } from "./fixtures";
import { landing, stepWalkers } from "./move";
import { seatSessions, type Staff } from "./sessions";

const office = buildOffice();
const spot = (id: string) => office.spots.find((s) => s.id === id)!;

describe("what a session asks of its worker", () => {
  const of = (over: Partial<RemoteInstance>, doneFor = 0) => {
    const d = doing(instance("a", "p", over), doneFor);
    return [d.place.kind === "station" ? d.place.station : d.place.kind, d.anim, d.overhead, d.bubble && `${d.bubble.text} ${d.bubble.tone}`];
  };

  it("works at the desk, the rack, the whiteboard or with something to read, by the latest tool", () => {
    expect(of({ activity: "edit" })).toEqual(["desk", "type", "working", null]);
    expect(of({ activity: null })).toEqual(["desk", "type", "working", null]);
    expect(of({ activity: "task", subagents: 1 })).toEqual(["desk", "typeFast", "working", null]);
    expect(of({ activity: "bash" })).toEqual(["rack", "tinker", "working", null]);
    expect(of({ activity: "test" })).toEqual(["board", "board", "working", null]);
    expect(of({ activity: "web" })).toEqual(["desk", "newspaper", "working", null]);
    expect(of({ activity: "read" })).toEqual(["desk", "document", "working", null]);
    expect(of({ activity: "edit", compacting: true })).toEqual(["cabinet", "file", "working", null]);
  });

  it("stands and waves when the session needs you: ? for a question, a red ! once escalated", () => {
    expect(of({ phase: "needs_you" })).toEqual(["stand", "wave", null, "! needs"]);
    expect(of({ phase: "needs_you", choice: EVERY_STATE.find((i) => i.id === "question")!.choice })).toEqual(["stand", "wave", null, "? needs"]);
    expect(of({ phase: "needs_you", escalated: true })).toEqual(["stand", "fret", null, "! alert"]);
    expect(doing(instance("a", "p", { phase: "needs_you", escalated: true })).bubble?.pulse).toBe(true);
  });

  it("slumps when stuck, leans back when done and wanders off later, goes off when ended", () => {
    expect(of({ activity: "edit", stuck: true })).toEqual(["desk", "sleep", "stuck", null]);
    expect(of({ phase: "done" })).toEqual(["desk", "coffee", "done", null]);
    expect(of({ phase: "done" }, WANDER_AFTER)).toEqual(["about", "idle", "done", null]);
    expect(of({ phase: "idle" })).toEqual(["desk", "relax", null, null]);
    expect(of({ phase: "ended" })).toEqual(["about", "idle", null, null]);
    // A new console whose session hasn't said anything yet.
    expect(of({ phase: null })).toEqual(["desk", "relax", null, null]);
  });
});

/** An office driven like the page: snapshots seated, the sim stepped. */
function office$(rooms: Record<string, "demiurge" | "tinywizard"> = {}) {
  const world = createWorld(office);
  const staff = testStaff({ rooms });
  let ms = 0;
  const seat = (list: RemoteInstance[]) => seatSessions(office, world, staff, snapshot(list), ms, () => 0);
  seat([]);
  return {
    world,
    staff,
    seat,
    /** Runs the sim for `ms`. */
    run(span: number) {
      for (const end = ms + span; ms < end; ) {
        stepWalkers(world, office, (ms += 100));
        behave(office, world, staff, ms);
      }
    },
    now: () => ms,
    of: (id: string): WorkerEntity => world.workers.find((w) => w.worker.id === staff.seating.get(id)?.worker)!,
  };
}

const at = (w: { x: number; y: number }) => ({ x: w.x, y: w.y });
const still = (world: World) => world.workers.every((w) => !w.walk);

describe("workers doing what their session is doing", () => {
  it("puts everyone straight in place on the first snapshot, needs you and all", () => {
    const world = createWorld(office);
    const staff = testStaff({ rooms: EVERY_STATE_ROOMS });
    seatSessions(office, world, staff, snapshot(EVERY_STATE), 0, () => 0);
    expect(still(world)).toBe(true);
    const by = (id: string) => world.workers.find((w) => w.worker.id === staff.seating.get(id)!.worker)!;
    const needs = by("needs");
    expect([at(needs), needs.dir, needs.anim, needs.bubble?.text]).toEqual([landing(office, besideDesk(office.seats[needs.home])), "down", "wave", "!"]);
    expect(world.screens[staff.seating.get("needs")!.desk!]).toBe("alert");
    expect([at(by("bash")), by("bash").anim]).toEqual([at(spot("rack")), "tinker"]);
    expect(by("compacting").anim).toBe("file");
    expect([by("web").anim, by("read").anim, by("stuck").anim, by("done").anim]).toEqual(["newspaper", "document", "sleep", "coffee"]);
    expect(by("escalated").bubble).toEqual({ text: "!", tone: "alert", pulse: true });
    // Two contractors at the extra desks, one with the bubble.
    expect(world.contractors.map((c) => c.bubble?.text ?? null)).toEqual([null, "!"]);
  });

  it("gets up to wave when the session needs you, and sits back down once answered", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    const desk = o.staff.seating.get("a")!.desk!;
    expect([w.seat, w.anim, o.world.screens[desk]]).toEqual([desk, "type", "code"]);
    o.seat([instance("a", "misc", { phase: "needs_you" })]);
    o.run(3000);
    expect([at(w), w.dir, w.anim, w.bubble?.text, o.world.screens[desk]]).toEqual([landing(office, besideDesk(office.seats[desk])), "down", "wave", "!", "alert"]);
    o.seat([instance("a", "misc")]);
    o.run(3000);
    expect([w.seat, w.anim, w.bubble]).toEqual([desk, "type", null]);
  });

  it("goes to the rack for a command that lasts, not one that flicks past", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    const desk = w.seat;
    o.seat([instance("a", "misc", { activity: "bash" })]);
    o.run(SETTLE - 500);
    o.seat([instance("a", "misc", { activity: "edit" })]);
    o.run(SETTLE + 500);
    expect([w.seat, w.walk]).toEqual([desk, null]);

    o.seat([instance("a", "misc", { activity: "bash" })]);
    o.run(SETTLE + 15_000);
    expect([at(w), w.dir, w.anim, o.staff.spots.get(w.worker.id)]).toEqual([{ x: spot("rack").x, y: spot("rack").y }, "up", "tinker", "rack"]);
    // The monitor keeps running while they're away from it.
    expect(o.world.screens[desk!]).toBe("code");
  });

  it("stays at a station a while after getting there before going back to the desk", () => {
    const o = office$();
    o.seat([instance("a", "misc", { activity: "test" })]);
    const w = o.of("a");
    while (w.anim !== "board") o.run(100);
    const arrived = o.now();
    o.seat([instance("a", "misc", { activity: "edit" })]);
    o.run(SETTLE + 200);
    expect(w.walk).toBeNull();
    while (!w.walk) o.run(100);
    expect(o.now() - arrived).toBeGreaterThanOrEqual(STAY);
    expect(w.walk?.then).toEqual({ kind: "sit", seat: w.home });
    o.run(20_000);
    expect([w.seat, w.anim, o.staff.spots.has(w.worker.id)]).toEqual([w.home, "type", false]);
  });

  it("shares the stations: the second tester takes the other whiteboard, a third stays at the desk", () => {
    const o = office$();
    const list = ["a", "b", "c"].map((id) => instance(id, "misc", { activity: "test" }));
    o.seat(list);
    o.run(40_000);
    const boards = ["a", "b", "c"].map((id) => o.staff.spots.get(o.of(id).worker.id) ?? null);
    expect([...boards].sort()).toEqual(["board-demiurge", "pitch-board", null].sort());
    const third = o.of(list[boards.indexOf(null)].id);
    expect([third.seat, third.anim]).toEqual([third.home, "type"]);
  });

  it("leans back when done, wanders off after ten minutes, and comes back for the next turn", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    o.seat([instance("a", "misc", { phase: "done" })]);
    o.run(1000);
    expect([w.seat, w.anim, w.overhead]).toEqual([w.home, "coffee", "done"]);
    o.run(WANDER_AFTER);
    o.run(30_000);
    const held = spot(o.staff.spots.get(w.worker.id)!);
    expect([at(w), w.seat, w.overhead]).toEqual([{ x: held.x, y: held.y }, null, "done"]);
    o.seat([instance("a", "misc")]);
    o.run(30_000);
    expect([w.seat, w.anim]).toEqual([w.home, "type"]);
  });

  it("goes off to the kitchen when the session ends, never out of the office, and back for the next", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    o.seat([instance("a", "misc", { phase: "ended" })]);
    o.run(30_000);
    const held = spot(o.staff.spots.get(w.worker.id)!);
    expect([w.away, at(w), w.tag, o.world.screens[w.home]]).toEqual([false, { x: held.x, y: held.y }, "ended", "off"]);
    o.seat([instance("a", "misc")]);
    o.run(30_000);
    expect([w.seat, w.anim]).toEqual([w.home, "type"]);
  });

  it("sits at the desk for a console whose session hasn't started yet", () => {
    const o = office$();
    o.seat([instance("a", "misc", { phase: null })]);
    o.run(20_000);
    const w = o.of("a");
    expect([w.away, w.seat, w.anim, w.tag]).toEqual([false, w.home, "relax", "idle"]);
  });

  it("shows the working icon only away from the desk", () => {
    const o = office$();
    o.seat([instance("a", "misc", { activity: "edit" })]);
    o.run(20_000);
    const w = o.of("a");
    expect([w.seat, w.overhead]).toEqual([w.home, null]);
    o.seat([instance("a", "misc", { activity: "bash" })]);
    o.run(SETTLE + 20_000);
    expect([w.seat, w.anim, w.overhead]).toEqual([null, "tinker", "working"]);
  });

  it("leaves someone a debug click moved alone till a moment after they get there", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    const to = landing(office, { x: 200, y: 180 });
    debugClick(office, o.world, w.worker.id, to.x, to.y, o.now(), (m) => o.staff.loose.set(m.worker.id, o.now()));
    o.run(100);
    while (w.walk) o.run(100);
    o.run(LOOSE_FOR - 200);
    expect([at(w), w.walk]).toEqual([to, null]);
    o.run(30_000);
    expect([w.seat, w.anim]).toEqual([w.home, "type"]);
  });

  it("says when a step changed the picture", () => {
    const world = createWorld(office);
    const staff: Staff = testStaff();
    seatSessions(office, world, staff, snapshot([instance("a", "misc")]), 0);
    // The first step may start a group (people put straight onto the sofa); a second at
    // the same moment has nothing new.
    behave(office, world, staff, 100);
    expect(behave(office, world, staff, 100)).toBe(false);
    staff.jobs.get(staff.seating.get("a")!.worker!)!.instance = instance("a", "misc", { phase: "needs_you" });
    expect(behave(office, world, staff, 200)).toBe(true);
  });
});
