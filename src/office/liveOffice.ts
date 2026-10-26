// The office page's office (office plan O1.3): workers driven by Workbench's sessions.
// Snapshots seat sessions (world/sessions.ts); the settings that make that sticky — the
// room each project sits in, the worker each instance had — load from Workbench before
// the first seating and are saved back when they change. The debug click from O1.2
// still works: the next snapshot sends a moved worker back to their desk.

import type { RemoteSnapshot } from "../remote/protocol";
import { buildOffice } from "./map/build";
import type { Link } from "./net";
import { TEAM_NAMES, type Team } from "./roster";
import { debugClick, deskAt } from "./world/debug";
import { createWorld, workerAt as hit } from "./world/entities";
import { stepWalkers } from "./world/move";
import { OFFICE_H, OFFICE_W, createRenderer, type View } from "./world/render";
import { createStaff, seatSessions, showScreens, type Staff } from "./world/sessions";

export { OFFICE_H, OFFICE_W };

/** How long to gather changes to the sticky map before saving it. */
const SAVE_AFTER = 1000;

const office = buildOffice();
const world = createWorld(office);
const renderer = createRenderer(office);
let staff: Staff = createStaff();
const EMPTY: RemoteSnapshot = { updatedAt: 0, usageLimits: null, instances: [], projects: [], duck: { state: "idle", autopilots: [] }, created: [] };

/** Nobody's sessions known yet: everyone stands about, and the first snapshot puts
 *  each worker straight at their desk. */
function standAbout(): void {
  seatSessions(office, world, staff, EMPTY, performance.now());
  staff.started = false;
}
standAbout();

let link: Link | null = null;
let latest: RemoteSnapshot | null = null;
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let onChange = () => {};

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void link?.savePrefs({ rooms: staff.rooms, sticky: staff.sticky }), SAVE_AFTER);
}

function seat(): void {
  if (!loaded || !latest) return;
  if (seatSessions(office, world, staff, latest, performance.now())) save();
  onChange();
}

const isTeam = (t: unknown): t is Team => typeof t === "string" && t in TEAM_NAMES;

/** Loads the saved settings, then seats sessions as snapshots come. `changed` is called
 *  when the office changed by itself (a snapshot was seated). */
export function startOffice(l: Link, changed: () => void): void {
  link = l;
  onChange = changed;
  void l.prefs().then((saved) => {
    const rooms = Object.fromEntries(Object.entries((saved?.rooms ?? {}) as Record<string, unknown>).filter(([, t]) => isTeam(t))) as Record<string, Team>;
    const sticky = Object.fromEntries(Object.entries((saved?.sticky ?? {}) as Record<string, unknown>).filter(([, w]) => typeof w === "string")) as Record<string, string>;
    staff = createStaff({ rooms, sticky });
    standAbout();
    loaded = true;
    seat();
  });
}

export function officeSnapshot(snapshot: RemoteSnapshot): void {
  latest = snapshot;
  seat();
}

/** The room each project sits in. */
export const roomOf = (projectId: string): Team => staff.rooms[projectId] ?? "open";

/** Moves `projectId` to `team`'s room: its live sessions get workers from there. */
export function setRoom(projectId: string, team: Team): void {
  if (roomOf(projectId) === team) return;
  if (team === "open") delete staff.rooms[projectId];
  else staff.rooms[projectId] = team;
  for (const i of latest?.instances ?? []) {
    if (i.projectId !== projectId) continue;
    staff.seating.delete(i.id);
    delete staff.sticky[i.id];
  }
  seat();
  save();
}

/** One sim step at `ms`; true when the picture changed. */
export function stepOffice(ms: number): boolean {
  const changed = stepWalkers(world, office, ms);
  if (changed) showScreens(office, world, staff);
  return changed;
}

export const clickOffice = (picked: string | null, x: number, y: number, ms: number): string | null => debugClick(office, world, picked, x, y, ms);

/** What's at (x, y) in office pixels, for hover: a worker's id, or a contractor's desk
 *  as `desk:<index>`. */
export function workerAt(x: number, y: number): string | null {
  const w = hit(world, x, y);
  if (w) return w.worker.id;
  const desk = deskAt(office, { x, y });
  return desk !== undefined && world.contractors.some((c) => c.desk === desk) ? `desk:${desk}` : null;
}

export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, view: View = {}): number {
  return renderer.draw(ctx, world, ms, view);
}
