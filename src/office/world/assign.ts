// Who works on which session (office plan O1.3, "Assignment"). Pure: the live sessions,
// the room each project belongs to, the saved sticky map and the seating so far in;
// the new seating and sticky map out. world/sessions.ts walks people to match.
//
// - Seating already given stays put while its session is live: nobody is moved off a
//   session to make room.
// - A new session goes to its room's team: its sticky worker if they're free (and,
//   when they're from another team, only if the room's team has nobody free), else a
//   random free worker of the team, preferring ones no other session has a claim on.
// - A team with nobody free borrows: from the open space first, then the other main
//   team. A worker at their own team's session sits at their home desk; a borrowed one
//   takes a free desk nearest the room, the open space's spare desks first.
// - With all twelve busy, a session gets a contractor: a desk without a worker (a
//   laptop on it), or no desk at all once those run out too.
// - A session started from the office (O3.2, `hire.ts`) has its desk and worker held
//   for it while it's on its way: nobody else is given them.

import type { Point, Seat } from "../map/build";
import { ROSTER, type Team, type Worker } from "../roster";
import { homeDesks } from "./entities";

export interface Session {
  id: string;
  projectId: string;
}

/** Where a session sits: its worker (null for a contractor) and their desk (null for
 *  a contractor with no desk left). */
export interface Seating {
  worker: string | null;
  desk: number | null;
}

export interface AssignInput {
  seats: readonly Seat[];
  /** Live sessions, in the rail's order: the first ones choose first. */
  sessions: readonly Session[];
  /** Project → room; the open space when missing. */
  rooms: Readonly<Record<string, Team>>;
  /** Instance → the worker it had last. */
  sticky: Readonly<Record<string, string>>;
  /** The seating so far, by instance. */
  current: ReadonlyMap<string, Seating>;
  /** Every instance Workbench still has, live or not: sticky entries for the rest go. */
  known: ReadonlySet<string>;
  /** Desks and workers held for sessions on their way. */
  held?: readonly Seating[];
  random?: () => number;
}

export interface Assignment {
  seating: Map<string, Seating>;
  sticky: Record<string, string>;
}

/** Whom a team borrows from, in order. */
const LENDERS: Record<Team, readonly Team[]> = {
  demiurge: ["open", "tinywizard"],
  tinywizard: ["open", "demiurge"],
  open: ["demiurge", "tinywizard"],
};

const centreOf = (seats: readonly Seat[]): Point => ({
  x: seats.reduce((n, s) => n + s.desk.x, 0) / seats.length,
  y: seats.reduce((n, s) => n + s.desk.y, 0) / seats.length,
});

export function assign(input: AssignInput): Assignment {
  const { seats, sessions, rooms, current, known, random = Math.random } = input;
  const homeOf = new Map<string, number>();
  for (const [desk, w] of homeDesks(seats)) homeOf.set(w.id, desk);
  const byId = new Map(ROSTER.map((w) => [w.id, w]));

  const sticky: Record<string, string> = {};
  for (const [id, worker] of Object.entries(input.sticky)) if (known.has(id) && byId.has(worker)) sticky[id] = worker;
  const live = new Set(sessions.map((s) => s.id));
  // Workers a session that isn't live now would want back.
  const claimed = new Set(Object.entries(sticky).filter(([id]) => !live.has(id)).map(([, w]) => w));

  const seating = new Map<string, Seating>();
  const busy = new Set<string>();
  const used = new Set<number>();
  const take = (id: string, worker: string | null, desk: number | null) => {
    seating.set(id, { worker, desk });
    if (worker) busy.add(worker);
    if (desk !== null) used.add(desk);
  };

  for (const s of sessions) {
    const was = current.get(s.id);
    if (was?.worker) take(s.id, was.worker, was.desk);
  }
  for (const h of input.held ?? []) {
    if (h.worker) busy.add(h.worker);
    if (h.desk !== null) used.add(h.desk);
  }

  /** Free, and not the home desk of someone free (they'll want it). */
  const deskFree = (d: number) => {
    if (used.has(d)) return false;
    const home = ROSTER.find((w) => homeOf.get(w.id) === d);
    return !home || busy.has(home.id);
  };
  const spare = (s: Seat) => s.room === "open" && ![...homeOf.values()].includes(s.index);
  /** The free desk nearest `team`'s room: the open space's spare ones first. */
  const nearDesk = (team: Team): number | null => {
    const c = centreOf(seats.filter((s) => s.room === team));
    const d = (s: Seat) => Math.hypot(s.desk.x - c.x, s.desk.y - c.y);
    const free = seats.filter((s) => deskFree(s.index)).sort((a, b) => Number(spare(b)) - Number(spare(a)) || d(a) - d(b));
    return free[0]?.index ?? null;
  };
  const freeIn = (team: Team) => ROSTER.filter((w) => w.team === team && !busy.has(w.id));
  const pickFrom = (pool: Worker[]): Worker => {
    const open = pool.filter((w) => !claimed.has(w.id));
    const from = open.length ? open : pool;
    return from[Math.min(from.length - 1, Math.floor(random() * from.length))];
  };

  for (const s of sessions) {
    if (seating.has(s.id)) continue;
    const team = rooms[s.projectId] ?? "open";
    const mine = freeIn(team);
    const st = byId.get(sticky[s.id]);
    let worker: Worker | undefined;
    if (st && !busy.has(st.id) && (st.team === team || !mine.length)) worker = st;
    else if (mine.length) worker = pickFrom(mine);
    else {
      const lender = LENDERS[team].find((t) => freeIn(t).length);
      if (lender) worker = pickFrom(freeIn(lender));
    }

    if (!worker) {
      const was = current.get(s.id);
      const desk = was && was.desk !== null && deskFree(was.desk) ? was.desk : nearDesk(team);
      take(s.id, null, desk);
      continue;
    }
    const home = homeOf.get(worker.id)!;
    // Taken first: their home desk is no longer kept for them.
    busy.add(worker.id);
    const desk = worker.team === team && !used.has(home) ? home : nearDesk(team);
    take(s.id, worker.id, desk);
    sticky[s.id] = worker.id;
  }
  return { seating, sticky };
}
