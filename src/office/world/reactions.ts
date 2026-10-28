// Reactions (office plan O2.3): what a snapshot brings that's worth a moment of
// someone's time. A new commit in a project has the worker on it get up and cheer;
// Duck's autopilot moving a session on (the next step sent, a compaction started, a
// question answered) brings Duck waddling over to that desk for a word, then back
// behind the boss desk. The other two reactions live with the session's behaviour: a
// needs-you kept waiting sweats (`fret`, O1.4), and an ended session sends its worker
// off to the kitchen (behave.ts).
//
// The snapshot only says which sessions an autopilot drives, not who acted, so a
// session on autopilot that you move on yourself brings Duck over too.

import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import type { OfficeMap, Point, Seat } from "../map/build";
import { DUCK_H, DUCK_W } from "../art/duck";
import { seatedAt, setDuckAnim, type DuckEntity, type World } from "./entities";
import { waddleTo } from "./move";
import type { Staff } from "./sessions";

/** How long a commit's cheer lasts, getting up included. */
export const CHEER_LASTS = 5000;
/** How long Duck stays at the desk. */
export const VISIT_FOR = 6000;

export const DUCK_LINES = ["Quack.", "Carry on.", "Next step.", "Looks good.", "Onward."];

/** Duck's trip to a session's desk: called, on the way, there (until when), back. */
export type DuckTrip =
  | { leg: "called"; instance: string }
  | { leg: "out"; instance: string; desk: number }
  | { leg: "there"; instance: string; until: number }
  | { leg: "back" };

/** Compares `next` with what the staff knew (`before`, the live sessions by id) and
 *  sets off the reactions. Nothing on the first snapshot: what was already so isn't
 *  news. Call once the new seating is in. */
export function react(staff: Staff, before: ReadonlyMap<string, RemoteInstance>, next: RemoteSnapshot, ms: number, first: boolean): void {
  for (const p of next.projects) {
    if (p.commitsToday === null) continue;
    const was = staff.commits.get(p.id);
    staff.commits.set(p.id, p.commitsToday);
    // Fewer is a new day, not news.
    if (first || was === undefined || p.commitsToday <= was) continue;
    const who = committer(staff, p.id);
    if (who) staff.cheers.set(who, ms + CHEER_LASTS);
  }
  if (first || staff.trip) return;
  const piloted = new Set(next.duck.autopilots);
  for (const i of next.instances) {
    const p = before.get(i.id);
    if (!i.live || !p || !piloted.has(i.id)) continue;
    if ((p.phase !== "working" && i.phase === "working") || (!p.compacting && i.compacting)) {
      staff.trip = { leg: "called", instance: i.id };
      return;
    }
  }
}

/** Who on project `projectId` most likely made the commit: one running a command (a
 *  `git commit` is one), else one working, else anyone on it. */
function committer(staff: Staff, projectId: string): string | null {
  const on = [...staff.jobs].filter(([, j]) => j.instance.projectId === projectId);
  const rank = ([, j]: (typeof on)[number]) => (j.instance.activity === "bash" ? 0 : j.instance.phase === "working" ? 1 : 2);
  on.sort((a, b) => rank(a) - rank(b));
  return on[0]?.[0] ?? null;
}

/** Where Duck stands to talk to whoever is at `seat`: left of the desk, level with
 *  the chair. */
export function besideForDuck(seat: Seat): Point {
  return { x: seat.desk.x - DUCK_W / 2 + 4, y: seatedAt(seat).y };
}

/** Behind the boss desk, where Duck lives. */
const homeOf = (office: OfficeMap): Point => ({ x: office.duck.x + DUCK_W / 2, y: office.duck.y + DUCK_H });

/** Moves Duck's trip along; true when the picture changed. */
export function duckRounds(office: OfficeMap, world: World, staff: Staff, ms: number): boolean {
  const d = world.duck;
  const t = staff.trip;
  if (!t || d.walk) return false;
  switch (t.leg) {
    case "called": {
      const desk = staff.seating.get(t.instance)?.desk;
      if (desk === null || desk === undefined || !waddleTo(office, d, besideForDuck(office.seats[desk]), ms)) {
        staff.trip = null;
        return false;
      }
      // What it was doing at the desk (`boss.ts`) stays there.
      d.bubble = null;
      staff.trip = { leg: "out", instance: t.instance, desk };
      return true;
    }
    case "out": {
      const seat = office.seats[t.desk];
      d.view = d.x < seat.desk.x + 16 ? "right" : "left";
      setDuckAnim(d, "speak", ms);
      d.bubble = { text: DUCK_LINES[Math.floor(staff.random() * DUCK_LINES.length)], tone: "say" };
      staff.trip = { leg: "there", instance: t.instance, until: ms + VISIT_FOR };
      return true;
    }
    case "there": {
      if (ms < t.until) return false;
      d.bubble = null;
      goHome(office, d, ms);
      staff.trip = { leg: "back" };
      return true;
    }
    case "back": {
      d.view = "down";
      setDuckAnim(d, "idle", ms);
      staff.trip = null;
      return true;
    }
  }
}

function goHome(office: OfficeMap, d: DuckEntity, ms: number): void {
  const home = homeOf(office);
  if (waddleTo(office, d, home, ms, true)) return;
  // No way back: just be there.
  Object.assign(d, { ...home, prev: { ...home }, walk: null });
}
