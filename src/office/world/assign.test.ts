import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { ROSTER, type Team } from "../roster";
import { assign, type AssignInput, type Seating, type Session } from "./assign";
import { homeDesks } from "./entities";

const { seats } = buildOffice();
const teamOf = (id: string | null) => ROSTER.find((w) => w.id === id)?.team;
const homeOf = (id: string) => [...homeDesks(seats)].find(([, w]) => w.id === id)![0];
const spares = seats.filter((s) => s.room === "open" && !homeDesks(seats).has(s.index)).map((s) => s.index);

const ROOMS: Record<string, Team> = { dem: "demiurge", twr: "tinywizard" };
const sessions = (projectId: string, n: number, from = 0): Session[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${projectId}-${from + i}`, projectId }));

/** Assigns `list` on top of `prev`, as successive snapshots would. */
function run(list: Session[], prev: Partial<AssignInput> = {}) {
  return assign({
    seats,
    sessions: list,
    rooms: ROOMS,
    sticky: {},
    current: new Map(),
    known: new Set([...list.map((s) => s.id), ...Object.keys(prev.sticky ?? {})]),
    random: () => 0,
    ...prev,
  });
}

const workers = (seating: Map<string, Seating>) => [...seating.values()].map((s) => s.worker);

describe("assignment", () => {
  it("seats a session's worker from its project's room, at their home desk", () => {
    const { seating } = run([...sessions("dem", 1), ...sessions("twr", 1), ...sessions("misc", 1)]);
    const [d, t, o] = [...seating.values()];
    expect([teamOf(d.worker), teamOf(t.worker), teamOf(o.worker)]).toEqual(["demiurge", "tinywizard", "open"]);
    for (const s of [d, t, o]) expect(s.desk).toBe(homeOf(s.worker!));
  });

  it("keeps everyone where they are while their session lives", () => {
    const first = run(sessions("dem", 2));
    const next = run(sessions("dem", 3), { current: first.seating, sticky: first.sticky, random: () => 0.99 });
    for (const [id, s] of first.seating) expect(next.seating.get(id)).toEqual(s);
  });

  it("gives a returning session the same worker, when they're free", () => {
    const first = run(sessions("dem", 1));
    const [id] = first.seating.keys();
    const worker = first.seating.get(id)!.worker;
    const gone = run([], { sticky: first.sticky, current: first.seating, known: new Set([id]) });
    expect(gone.seating.size).toBe(0);
    // Another session comes and goes meanwhile: it doesn't take the one kept for `id`.
    const other = run(sessions("dem", 1, 5), { sticky: gone.sticky, known: new Set([id, "dem-5"]) });
    expect(workers(other.seating)).not.toContain(worker);
    const back = run(sessions("dem", 1), { sticky: other.sticky });
    expect(back.seating.get(id)!.worker).toBe(worker);
  });

  it("forgets sticky workers for instances Workbench no longer has", () => {
    const first = run(sessions("dem", 1));
    expect(run([], { sticky: first.sticky, known: new Set() }).sticky).toEqual({});
  });

  it("doesn't borrow a sticky worker from another team while the room's team has someone free", () => {
    const busy = run(sessions("dem", 5));
    const borrowed = [...busy.seating].find(([, s]) => teamOf(s.worker) !== "demiurge")!;
    const later = run(sessions("dem", 1, 4), { sticky: busy.sticky, known: new Set(busy.seating.keys()) });
    expect(later.seating.get(borrowed[0])!.worker).not.toBe(borrowed[1].worker);
    expect(teamOf(later.seating.get(borrowed[0])!.worker)).toBe("demiurge");
  });

  it("borrows from the open space first, then the other main team, onto the spare desks", () => {
    const twr = run(sessions("twr", 3));
    const third = [...twr.seating.values()][2];
    expect(teamOf(third.worker)).toBe("open");
    expect(spares).toContain(third.desk);

    // The open space busy too: TinyWizardRoyale borrows from Demiurge.
    const open = run([...sessions("misc", 6), ...sessions("twr", 3)]);
    const lent = [...open.seating.values()][8];
    expect(teamOf(lent.worker)).toBe("demiurge");
    expect(spares).toContain(lent.desk);
  });

  it("puts a borrowed worker at the spare desk nearest the room", () => {
    const desk = (team: string) => [...run(sessions(team, team === "dem" ? 5 : 3)).seating.values()].pop()!.desk!;
    const at = (d: number) => seats[d].desk;
    // Demiurge is up on the left, TinyWizardRoyale on the right.
    expect(at(desk("dem")).x).toBeLessThan(at(desk("twr")).x);
  });

  it("frees a worker when their session ends, and a borrowed one goes home to their team", () => {
    const first = run(sessions("dem", 5));
    const [, , , , last] = first.seating.keys();
    const borrowed = first.seating.get(last)!.worker!;
    const after = run(sessions("dem", 4), { current: first.seating, sticky: first.sticky });
    expect(workers(after.seating)).not.toContain(borrowed);
    // Free again: the open space's next session can have them, at their own desk.
    const open = run([...sessions("dem", 4), { id: "o", projectId: "misc" }], { current: after.seating, sticky: after.sticky, random: () => 0 });
    const o = open.seating.get("o")!;
    expect(o.desk).toBe(homeOf(o.worker!));
  });

  it("seats twelve sessions, then contractors at the free desks, then contractors with none", () => {
    const list = [...sessions("dem", 6), ...sessions("twr", 4), ...sessions("misc", 6)];
    const { seating } = run(list);
    const all = [...seating.values()];
    expect(new Set(all.filter((s) => s.worker).map((s) => s.worker)).size).toBe(12);
    const contractors = all.filter((s) => !s.worker);
    expect(contractors.length).toBe(4);
    expect(contractors.filter((s) => s.desk !== null).length).toBe(seats.length - 12);
    const desks = all.map((s) => s.desk).filter((d) => d !== null);
    expect(new Set(desks).size).toBe(desks.length);
  });

  it("gives a contractor's session a worker once one is free", () => {
    const list = [...sessions("misc", 12), ...sessions("misc", 1, 12)];
    const full = run(list);
    expect(full.seating.get("misc-12")!.worker).toBeNull();
    const fewer = run(list.slice(1), { current: full.seating, sticky: full.sticky });
    expect(fewer.seating.get("misc-12")!.worker).not.toBeNull();
  });

  it("never seats two sessions at one desk, however they come and go", () => {
    let current = new Map<string, Seating>();
    let sticky: Record<string, string> = {};
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pool = [...sessions("dem", 6), ...sessions("twr", 4), ...sessions("misc", 8)];
    const known = new Set(pool.map((s) => s.id));
    for (let round = 0; round < 200; round++) {
      const list = pool.filter(() => random() < 0.6);
      const before = current;
      ({ seating: current, sticky } = run(list, { current, sticky, known, random }));
      const desks = [...current.values()].map((s) => s.desk).filter((d) => d !== null);
      expect(new Set(desks).size).toBe(desks.length);
      const ws = workers(current).filter(Boolean);
      expect(new Set(ws).size).toBe(ws.length);
      // Contractors only with everyone busy; nobody newly seated in a free worker's
      // home desk (seating already given stays, even if its desk's owner is back).
      for (const s of current.values()) if (!s.worker) expect(ws.length).toBe(12);
      for (const [id, s] of current) {
        const home = s.desk === null ? undefined : homeDesks(seats).get(s.desk);
        if (home && !before.has(id)) expect(ws).toContain(home.id);
      }
    }
  });
});
