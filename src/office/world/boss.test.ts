import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { duckAtDesk, mood } from "./boss";
import { createWorld } from "./entities";
import { testStaff } from "./fixtures";

const office = buildOffice();

describe("Duck at the boss desk", () => {
  it("speaks over everything, then waits on you, thinks, runs a routine, or bobs", () => {
    expect(mood({ state: "thinking", chat: "streaming" })).toEqual({ anim: "speak", bubble: null });
    expect(mood({ state: "speaking", chat: "idle" }).anim).toBe("speak");
    expect(mood({ state: "thinking", chat: "waiting" })).toEqual({ anim: "idle", bubble: { text: "?", tone: "needs" } });
    expect(mood({ state: "idle", chat: "tool" })).toEqual({ anim: "think", bubble: { text: "…", tone: "say" } });
    expect(mood({ state: "thinking", chat: "idle" }).anim).toBe("think");
    expect(mood({ state: "routine", chat: "idle" })).toEqual({ anim: "think", bubble: { text: "routine", tone: "say" } });
    expect(mood({ state: "idle", chat: "idle" })).toEqual({ anim: "idle", bubble: null });
  });

  it("shows it while home, once, and leaves it alone out on a trip", () => {
    const world = createWorld(office);
    const staff = testStaff();
    const d = world.duck;
    expect(duckAtDesk(world, staff, 0)).toBe(false);
    staff.duckDoing = { state: "thinking", chat: "idle" };
    expect(duckAtDesk(world, staff, 100)).toBe(true);
    expect([d.anim, d.bubble?.text]).toEqual(["think", "…"]);
    expect(duckAtDesk(world, staff, 200)).toBe(false);
    staff.trip = { leg: "back" };
    staff.duckDoing = { state: "idle", chat: "streaming" };
    expect(duckAtDesk(world, staff, 300)).toBe(false);
    expect(d.anim).toBe("think");
    staff.trip = null;
    expect(duckAtDesk(world, staff, 400)).toBe(true);
    expect([d.anim, d.bubble]).toEqual(["speak", null]);
  });
});
