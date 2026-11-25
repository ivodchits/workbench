import { describe, expect, it } from "vitest";

import type { RemoteInstance } from "../../remote/protocol";
import { buildOffice } from "../map/build";
import { LOOSE_FOR, SETTLE, WANDER_AFTER, behave, besideDesk, doing } from "./behave";
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
    return [d.place.kind, d.anim, d.overhead, d.bubble && `${d.bubble.text} ${d.bubble.tone}`];
  };

  it("works seated at the desk whatever the tool: typing, or with something to read", () => {
    expect(of({ activity: "edit" })).toEqual(["desk", "type", "working", null]);
    expect(of({ activity: null })).toEqual(["desk", "type", "working", null]);
    expect(of({ activity: "task", subagents: 1 })).toEqual(["desk", "typeFast", "working", null]);
    expect(of({ activity: "bash" })).toEqual(["desk", "type", "working", null]);
    expect(of({ activity: "test" })).toEqual(["desk", "document", "working", null]);
    expect(of({ activity: "web" })).toEqual(["desk", "newspaper", "working", null]);
    expect(of({ activity: "read" })).toEqual(["desk", "document", "working", null]);
    expect(of({ activity: "edit", compacting: true })).toEqual(["desk", "document", "working", null]);
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
    expect([by("bash").seat, by("bash").anim]).toEqual([by("bash").home, "type"]);
    expect([by("compacting").seat, by("compacting").anim]).toEqual([by("compacting").home, "document"]);
    expect([by("web").anim, by("read").anim, by("stuck").anim, by("done").anim]).toEqual(["newspaper", "document", "sleep", "coffee"]);
    expect(by("escalated").bubble).toEqual({ text: "!", tone: "alert", pulse: true });
    // Only the other machine's worker has its mark (fleet plan F9.3).
    expect([by("web").elsewhere, by("read").elsewhere]).toEqual(["laptop", null]);
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

  it("stays at the desk for commands, tests and compacting, never off to the rack or a whiteboard", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    const desk = w.seat;
    for (const over of [{ activity: "bash" }, { activity: "test" }, { activity: "edit", compacting: true }] as const) {
      o.seat([instance("a", "misc", over)]);
      for (let t = 0; t < SETTLE + 15_000; t += 100) {
        o.run(100);
        expect([w.seat, w.walk]).toEqual([desk, null]);
      }
      expect([w.anim, o.staff.spots.has(w.worker.id), o.world.screens[desk!]]).toEqual([over.activity === "bash" ? "type" : "document", false, "code"]);
    }
  });

  it("changes pose only once a new tool has held for a moment", () => {
    const o = office$();
    o.seat([instance("a", "misc")]);
    o.run(20_000);
    const w = o.of("a");
    o.seat([instance("a", "misc", { activity: "test" })]);
    o.run(SETTLE - 500);
    expect(w.anim).toBe("type");
    o.run(1000);
    expect(w.anim).toBe("document");
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
    const w = o.of("a");
    o.run(500);
    expect([w.seat, w.overhead]).toEqual([null, "working"]);
    o.run(20_000);
    expect([w.seat, w.overhead]).toEqual([w.home, null]);
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
