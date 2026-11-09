import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { ANYA_ID } from "../roster";
import { behave } from "./behave";
import { createWorld } from "./entities";
import { snapshot, testStaff } from "./fixtures";
import { isFree, workerFor } from "./hire";
import { stepWalkers } from "./move";
import { seatSessions } from "./sessions";

const office = buildOffice();

function start() {
  const world = createWorld(office);
  const staff = testStaff();
  seatSessions(office, world, staff, snapshot([]), 0, () => 0);
  const anya = world.workers.find((w) => w.worker.id === ANYA_ID)!;
  return { world, staff, anya };
}

describe("Anya, a guest", () => {
  it("is never given a session, nor offered for a desk", () => {
    const { world, staff } = start();
    expect(isFree(staff, ANYA_ID)).toBe(false);
    for (let desk = 0; desk < office.seats.length; desk++) expect(workerFor(office, world, staff, desk)).not.toBe(ANYA_ID);
  });

  it("spends a few hours about the office, lies on a free table now and then, and never sits at a desk", () => {
    const { world, staff, anya } = start();
    let ms = 0;
    let lay = 0;
    const did = new Set<string>();
    for (let i = 0; i < 4 * 36_000; i++) {
      stepWalkers(world, office, (ms += 100));
      behave(office, world, staff, ms);
      did.add(staff.idle.get(ANYA_ID)?.activity ?? "");
      expect(anya.seat).toBeNull();
      if (anya.anim === "lie") {
        lay++;
        expect(anya.lift, JSON.stringify({ i, x: anya.x, y: anya.y, walk: anya.walk, idle: staff.idle.get(ANYA_ID), dir: anya.dir })).toBeGreaterThan(0);
        expect(staff.idle.get(ANYA_ID)?.place.startsWith("lie-")).toBe(true);
      }
    }
    expect(lay).toBeGreaterThan(0);
    expect(did.has("desk")).toBe(false);
  }, 60_000);

  it("gets off a desk as soon as a session wants it", () => {
    const { world, staff, anya } = start();
    const desk = 9;
    staff.idle.set(ANYA_ID, { activity: "lie", place: `lie-desk-${desk}`, since: 0, lasts: 600_000, until: null });
    staff.spots.set(ANYA_ID, `desk:${desk}`);
    let ms = 0;
    for (let i = 0; i < 600 && anya.anim !== "lie"; i++) {
      stepWalkers(world, office, (ms += 100));
      behave(office, world, staff, ms);
    }
    expect([anya.anim, anya.x, anya.y]).toEqual(["lie", office.seats[desk].desk.x + 16, office.seats[desk].desk.y + 23]);
    // Nobody idle comes to sit at it while she's there.
    const owner = world.workers.find((w) => w.home === desk);
    if (owner) expect(owner.seat).not.toBe(desk);
    // A contractor's session takes the desk.
    staff.seating.set("c", { worker: null, desk });
    stepWalkers(world, office, (ms += 100));
    behave(office, world, staff, ms);
    expect(staff.idle.get(ANYA_ID)?.place).not.toBe(`lie-desk-${desk}`);
    expect(anya.lift).toBe(0);
  });
});
