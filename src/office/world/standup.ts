// The morning standup (office plan O5.5): asked for, the workers with nothing to do
// gather round the table in Duck's office, Duck chairs from the boss desk, and each
// project worked on the day before is reported by one of them: what got done, in
// bubbles, and what's next. The reports come from Workbench (`remote/standup.ts`:
// Haiku over the day's transcripts); the page sets them on the standup when they're
// in. It starts once everyone's there (or has had long enough to get there) and the
// reports are in, and ends with Duck's thanks: they all go back to idling.
//
// A project goes to someone of its room's team, the one who last had one of its
// sessions first, else whoever has reported least; with more projects than people,
// some report twice. Anyone given a session meanwhile leaves for their desk, and
// someone else at the table says their lines.

import type { RemoteInstance } from "../../remote/protocol";
import type { StandupReport, StandupResult } from "../../remote/standup";
import type { OfficeMap } from "../map/build";
import type { SpotSpec } from "../map/office";
import { ROSTER } from "../roster";
import type { WorkerEntity, World } from "./entities";
import { lineFor, say } from "./groups";
import { isFree } from "./hire";
import type { Staff } from "./sessions";

/** The standup's places round the table. */
export const STANDUP_KIND = "meeting";
/** Talking starts this long after the call, whoever is still on their way. */
export const GATHER_MAX = 40_000;
/** The reports have this long to come in (Workbench gives up at two minutes). */
export const ANSWER_MAX = 150_000;
/** Between one line and the next. */
export const LINE_GAP = 500;
/** Within this of their place, someone has got there. */
const THERE_PX = 8;

/** Something said: by Duck, or by a worker (their id). */
export interface StandupLine {
  by: "duck" | string;
  text: string;
}

/** Who reported which project. */
export interface Reported {
  report: StandupReport;
  /** A worker's id. */
  by: string;
}

export interface Standup {
  /** When it was called (sim ms). */
  start: number;
  /** Who is at the table, and where: worker id → spot id. */
  seats: Map<string, string>;
  /** Who last had a session of each project, by project id. */
  had: Map<string, Set<string>>;
  /** The reports once they're in; `error` when they won't come. */
  result: StandupResult | null;
  error: string | null;
  /** What's to be said, in order, once it has begun; null till then. */
  script: StandupLine[] | null;
  /** Who reports what, once it has begun. */
  reported: Reported[];
  /** When the next line is due. */
  next: number;
  /** Duck's line: its text and when it comes down. */
  duck: { text: string; until: number } | null;
}

/** Text the pixel font can show. */
const drawable = (s: string) => s.replace(/[^A-Za-z0-9 !?.,'\-:/]/g, "").replace(/\s+/g, " ").trim();

const nameOf = (id: string) => ROSTER.find((w) => w.id === id)?.name ?? id;

/** The standup's places round the table. */
function places(office: OfficeMap): SpotSpec[] {
  return office.spots.filter((s) => s.kind === STANDUP_KIND);
}

/** The table the standup's places are round (in Duck's office). */
export function standupTable(office: OfficeMap): OfficeMap["props"][number] | undefined {
  const spots = places(office);
  const box = {
    x0: Math.min(...spots.map((s) => s.x)),
    x1: Math.max(...spots.map((s) => s.x)),
    y0: Math.min(...spots.map((s) => s.y)),
    y1: Math.max(...spots.map((s) => s.y)),
  };
  const mid = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  return office.props.find((p) => p.id === "meetingTable" && mid.x >= p.x && mid.x < p.x + p.prop.w && mid.y >= p.y - 16 && mid.y < p.y + p.prop.h + 16);
}

/** Calls a standup at `ms`: each free worker gets a place at the table, nearest
 *  first. `instances` are Workbench's, live or not: whose sessions were whose
 *  projects. Null when nobody is free. */
export function callStandup(office: OfficeMap, world: World, staff: Staff, ms: number, instances: readonly RemoteInstance[] = []): Standup | null {
  const free = world.workers.filter((w) => isFree(staff, w.worker.id) && !staff.loose.has(w.worker.id));
  const open = places(office);
  if (!free.length || !open.length) return null;
  const table = {
    x: open.reduce((n, s) => n + s.x, 0) / open.length,
    y: open.reduce((n, s) => n + s.y, 0) / open.length,
  };
  const far = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
  const seats = new Map<string, string>();
  for (const w of [...free].sort((a, b) => far(a, table) - far(b, table))) {
    if (!open.length) break;
    open.sort((a, b) => far(a, w) - far(b, w));
    seats.set(w.worker.id, open.shift()!.id);
  }
  const project = new Map(instances.map((i) => [i.id, i.projectId]));
  const had = new Map<string, Set<string>>();
  for (const [instance, worker] of Object.entries(staff.sticky)) {
    const p = project.get(instance);
    if (p) had.set(p, (had.get(p) ?? new Set()).add(worker));
  }
  return { start: ms, seats, had, result: null, error: null, script: null, reported: [], next: ms, duck: { text: "Standup! Gather round.", until: ms + 4000 } };
}

/** Who of `here` reports `report`: one who last had a session of its project (`had`),
 *  else one of its room's team, else anyone; the one who's reported least, in the
 *  order given. */
export function presenterFor(
  report: StandupReport,
  here: readonly string[],
  staff: Staff,
  had: ReadonlyMap<string, ReadonlySet<string>>,
  used: ReadonlyMap<string, number>,
): string | null {
  if (!here.length) return null;
  const room = staff.rooms[report.projectId] ?? "open";
  const knew = had.get(report.projectId) ?? new Set();
  const team = (id: string) => ROSTER.find((w) => w.id === id)?.team === room;
  const score = (id: string) => (knew.has(id) ? 0 : team(id) ? 1 : 2) * 100 + (used.get(id) ?? 0);
  return [...here].sort((a, b) => score(a) - score(b))[0];
}

/** What's said: Duck opens, calls on each project's reporter, who says what got done
 *  and what's next, and Duck thanks them. */
export function scriptFor(s: Standup, here: readonly string[], staff: Staff): { script: StandupLine[]; reported: Reported[] } {
  const duck = (text: string): StandupLine => ({ by: "duck", text });
  if (s.error || !s.result) return { script: [duck("Standup time!"), duck("Lost my notes. Another day!")], reported: [] };
  if (!s.result.day || !s.result.reports.length) return { script: [duck("Standup time!"), duck("A quiet week. Back to work!")], reported: [] };
  const script = [duck("Standup time!"), duck(`What got done ${s.result.when}?`)];
  const used = new Map<string, number>();
  const reported: Reported[] = [];
  for (const r of s.result.reports) {
    const by = presenterFor(r, here, staff, s.had, used);
    if (!by) continue;
    used.set(by, (used.get(by) ?? 0) + 1);
    reported.push({ report: r, by });
    script.push(duck(`${nameOf(by)}, ${drawable(r.project) || "your project"}?`));
    script.push(...r.done.map((text) => ({ by, text })));
    if (r.next) script.push({ by, text: `Next: ${r.next}` });
  }
  script.push(duck("Thanks, team!"));
  return { script, reported };
}

/** Whether `w` has got to their place at the table. */
function there(office: OfficeMap, w: WorkerEntity, spot: string): boolean {
  const p = office.spots.find((x) => x.id === spot);
  return !!p && !w.walk && !w.away && w.seat === null && Math.hypot(w.x - p.x, w.y - p.y) <= THERE_PX;
}

/** One sim step of the standup, if there is one; true when a bubble went up. Ends it
 *  (`staff.standup` null) once it's over or everyone has gone. */
export function playStandup(office: OfficeMap, world: World, staff: Staff, ms: number): boolean {
  const s = staff.standup;
  if (!s) return false;
  // Anyone given something to do goes to it.
  for (const id of [...s.seats.keys()]) if (!isFree(staff, id)) s.seats.delete(id);
  const byId = new Map(world.workers.map((w) => [w.worker.id, w]));
  const here = [...s.seats].filter(([id, spot]) => there(office, byId.get(id)!, spot)).map(([id]) => id);
  if (!s.seats.size) {
    staff.standup = null;
    return false;
  }
  if (!s.script) {
    if (!s.result && !s.error && ms - s.start >= ANSWER_MAX) s.error = "the reports didn't come";
    const gathered = here.length === s.seats.size || ms - s.start >= GATHER_MAX;
    if (!(s.result || s.error) || !gathered || !here.length) return false;
    const { script, reported } = scriptFor(s, here, staff);
    s.script = script;
    s.reported = reported;
    s.next = ms;
    staff.events.push({ kind: "fun", text: `Standup in Duck's office: ${names(here)}` });
  }
  if (ms < s.next) return false;
  const line = s.script.shift();
  if (!line) {
    staff.standup = null;
    return false;
  }
  const lasts = lineFor(line.text);
  s.next = ms + lasts + LINE_GAP;
  if (line.by === "duck") {
    s.duck = { text: line.text, until: ms + lasts };
    return true;
  }
  // Whoever it was has gone: someone else there says it.
  const by = here.includes(line.by) ? line.by : here[0];
  const w = by ? byId.get(by) : undefined;
  if (!w) {
    s.next = ms;
    return false;
  }
  say(staff, w, line.text, ms, lasts);
  return true;
}

const names = (ids: readonly string[]) => {
  const n = ids.map(nameOf);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n[0];
};

/** Duck's line at the standup, while it's up. */
export function duckLine(staff: Staff, ms: number): string | null {
  const d = staff.standup?.duck;
  return d && ms < d.until ? d.text : null;
}
