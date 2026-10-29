import { describe, expect, it } from "vitest";

import type { StandupReport, StandupResult } from "../../remote/standup";
import { buildOffice } from "../map/build";
import { ROSTER } from "../roster";
import { behave } from "./behave";
import { createWorld, type World } from "./entities";
import { instance, snapshot, testStaff } from "./fixtures";
import { stepWalkers } from "./move";
import { seatSessions, type Staff } from "./sessions";
import { ANSWER_MAX, GATHER_MAX, STANDUP_KIND, callStandup, presenterFor, standupTable } from "./standup";

const office = buildOffice();
const places = new Set(office.spots.filter((s) => s.kind === STANDUP_KIND).map((s) => s.id));

const report = (projectId: string, done: string[], next: string | null = null): StandupReport => ({ projectId, project: projectId, sessions: 1, done, next });
const result = (reports: StandupReport[]): StandupResult => ({ day: "2026-10-27", when: "yesterday", reports });

/** An office with sessions `ids` working on `misc`, and the projects' rooms. */
function setUp(ids: string[], rooms: Staff["rooms"] = {}) {
  const world = createWorld(office);
  const staff = testStaff({ rooms });
  const snap = snapshot(ids.map((id) => instance(id, "misc")));
  seatSessions(office, world, staff, snap, 0, () => 0);
  behave(office, world, staff, 0, true);
  return { world, staff, snap };
}

/** Steps the office from `ms` till the standup is over (or `until`): what each worker
 *  and Duck said, in order, as "who: text". */
function run(world: World, staff: Staff, ms: number, until = ms + 10 * 60_000, each?: (ms: number) => void) {
  const said: string[] = [];
  const last = new Map<string, string | undefined>();
  const note = (who: string, text: string | undefined) => {
    if (text && last.get(who) !== text) said.push(`${who}: ${text}`);
    last.set(who, text);
  };
  while (staff.standup && ms < until) {
    stepWalkers(world, office, (ms += 100));
    behave(office, world, staff, ms);
    each?.(ms);
    for (const w of world.workers) note(w.worker.id, w.bubble?.tone === "say" ? w.bubble.text : undefined);
    note("duck", world.duck.bubble?.tone === "say" ? world.duck.bubble.text : undefined);
  }
  return { said, ms };
}

describe("calling the standup", () => {
  it("is done at the table in Duck's office", () => {
    const t = standupTable(office)!;
    expect(t).toMatchObject({ id: "meetingTable", x: 272, y: 140 });
  });

  it("gives every free worker a place at the table, and nobody busy", () => {
    const { world, staff } = setUp(["a", "b", "c", "d", "e"]);
    const s = callStandup(office, world, staff, 1000)!;
    const busy = new Set(staff.jobs.keys());
    expect(s.seats.size).toBe(7);
    expect([...s.seats.keys()].some((id) => busy.has(id))).toBe(false);
    expect(new Set(s.seats.values()).size).toBe(7);
    expect([...s.seats.values()].every((p) => places.has(p))).toBe(true);
    // Duck calls them over.
    expect(s.duck?.text).toMatch(/standup/i);
  });

  it("seats eight at most, and needs someone free", () => {
    expect(callStandup(office, setUp([]).world, setUp([]).staff, 0)).not.toBeNull();
    const few = setUp(["a", "b"]);
    expect(callStandup(office, few.world, few.staff, 0)!.seats.size).toBe(8);
    const all = setUp(ROSTER.map((_, n) => `s${n}`));
    expect(callStandup(office, all.world, all.staff, 0)).toBeNull();
  });
});

describe("who reports a project", () => {
  const staff = testStaff({ rooms: { dem: "demiurge", twr: "tinywizard" } });
  const here = ["mira", "felix", "pip", "gus"];
  const none = new Map<string, Set<string>>();

  it("is one who had its sessions, else its room's team, else anyone", () => {
    expect(presenterFor(report("dem", ["x"]), here, staff, new Map([["dem", new Set(["gus"])]]), new Map())).toBe("gus");
    expect(presenterFor(report("dem", ["x"]), here, staff, none, new Map())).toBe("felix");
    expect(presenterFor(report("twr", ["x"]), here, staff, none, new Map())).toBe("pip");
    expect(presenterFor(report("misc", ["x"]), here, staff, none, new Map())).toBe("mira");
    expect(presenterFor(report("twr", ["x"]), ["mira", "felix"], staff, none, new Map())).toBe("mira");
    expect(presenterFor(report("x", ["x"]), [], staff, none, new Map())).toBeNull();
  });

  it("is, among those as good, whoever has reported least", () => {
    expect(presenterFor(report("misc", ["x"]), here, staff, none, new Map([["mira", 1]]))).toBe("gus");
  });
});

describe("a standup", () => {
  it("gathers them at the table, then each project is called on and reported, and Duck thanks them", () => {
    const { world, staff, snap } = setUp(["a"], { dem: "demiurge" });
    staff.sticky = { ...staff.sticky, old: "kenji" };
    const old = instance("old", "dem", { live: false, phase: "ended" });
    staff.standup = callStandup(office, world, staff, 1000, [...snap.instances, old]);
    staff.standup!.result = result([report("dem", ["We fixed the login.", "We added tests."], "the settings page"), report("misc", ["We tidied the docs."])]);
    let seatedAtFirst = false;
    const { said } = run(world, staff, 1000, undefined, () => {
      if (seatedAtFirst || !staff.standup?.script) return;
      seatedAtFirst = [...staff.standup.seats].every(([id, spot]) => {
        const w = world.workers.find((x) => x.worker.id === id)!;
        const p = office.spots.find((x) => x.id === spot)!;
        return !w.walk && Math.hypot(w.x - p.x, w.y - p.y) <= 8;
      });
    });
    expect(seatedAtFirst).toBe(true);
    const duck = said.filter((l) => l.startsWith("duck: "));
    expect(duck[0]).toMatch(/gather/i);
    expect(duck).toContain("duck: What got done yesterday?");
    expect(duck).toContain("duck: Kenji, dem?");
    expect(duck[duck.length - 1]).toBe("duck: Thanks, team!");
    // Kenji had dem's session; misc goes to someone else, in its order.
    const at = (l: string) => said.indexOf(l);
    expect(at("kenji: We fixed the login.")).toBeGreaterThan(at("duck: Kenji, dem?"));
    expect(at("kenji: We added tests.")).toBeGreaterThan(at("kenji: We fixed the login."));
    expect(at("kenji: Next: the settings page")).toBeGreaterThan(at("kenji: We added tests."));
    const misc = said.find((l) => l.endsWith(": We tidied the docs."))!;
    expect(misc).not.toMatch(/^kenji/);
    expect(at(misc)).toBeGreaterThan(at("kenji: Next: the settings page"));
    expect(staff.standup).toBeNull();
    expect(staff.events.some((e) => e.text.startsWith("Standup in Duck's office: "))).toBe(true);
  });

  it("waits for the reports, and gives up on them in the end", () => {
    const { world, staff } = setUp([]);
    staff.standup = callStandup(office, world, staff, 0);
    run(world, staff, 0, GATHER_MAX + 5000);
    expect(staff.standup!.script).toBeNull();
    const { said, ms } = run(world, staff, GATHER_MAX + 5000);
    expect(ms).toBeGreaterThan(ANSWER_MAX);
    expect(said).toContain("duck: Lost my notes. Another day!");
  });

  it("says so when there's nothing to report", () => {
    const { world, staff } = setUp([]);
    staff.standup = callStandup(office, world, staff, 0);
    staff.standup!.result = { day: null, when: "", reports: [] };
    expect(run(world, staff, 0).said).toContain("duck: A quiet week. Back to work!");
  });

  it("starts without someone still on their way, after a while", () => {
    const { world, staff } = setUp([]);
    staff.standup = callStandup(office, world, staff, 0);
    staff.standup!.result = result([report("misc", ["We did it."])]);
    // One of them is held up by the debug click, standing where they are.
    const late = world.workers.find((w) => staff.standup!.seats.has(w.worker.id))!;
    staff.loose.set(late.worker.id, 0);
    let began = -1;
    run(world, staff, 0, 120_000, (ms) => {
      staff.loose.set(late.worker.id, ms);
      if (began < 0 && staff.standup?.script) began = ms;
    });
    expect(began).toBeGreaterThanOrEqual(GATHER_MAX);
    expect(began).toBeLessThan(GATHER_MAX + 1000);
  });

  it("lets someone given a session go, and another says their lines", () => {
    const { world, staff } = setUp([], { dem: "demiurge" });
    staff.standup = callStandup(office, world, staff, 0);
    staff.standup!.result = result([report("dem", ["We fixed the login.", "We shipped it.", "We celebrated."])]);
    let left: string | null = null;
    const { said } = run(world, staff, 0, undefined, (ms) => {
      const s = staff.standup;
      if (left || !s?.script || s.script.length > 2) return;
      // Mid-report, a session wants the one reporting: it was theirs before.
      left = s.reported[0].by;
      staff.sticky.new = left;
      seatSessions(office, world, staff, snapshot([instance("new", "dem")]), ms, () => 0);
      expect(staff.jobs.has(left)).toBe(true);
    });
    expect(left).not.toBeNull();
    expect(said).toContain("duck: Thanks, team!");
    const by = (text: string) => said.find((l) => l.endsWith(`: ${text}`))?.split(":")[0];
    expect(by("We fixed the login.")).toBe(left);
    expect(by("We celebrated.")).toBeDefined();
    expect(by("We celebrated.")).not.toBe(left);
    expect(by("We celebrated.")).not.toBe("duck");
  });

  it("ends when everyone has gone", () => {
    const { world, staff } = setUp(ROSTER.slice(1).map((_, n) => `s${n}`));
    staff.standup = callStandup(office, world, staff, 0);
    expect(staff.standup!.seats.size).toBe(1);
    seatSessions(office, world, staff, snapshot(ROSTER.map((_, n) => instance(`s${n}`, "misc"))), 100, () => 0);
    behave(office, world, staff, 200);
    expect(staff.standup).toBeNull();
  });
});
