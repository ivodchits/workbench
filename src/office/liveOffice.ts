// The office page's office (office plans O1.3, O1.4): workers driven by Workbench's
// sessions. Snapshots seat sessions (world/sessions.ts) and every sim step has people
// do what their session is doing (world/behave.ts); the settings that make seating
// sticky — the room each project sits in, the worker each instance had — load from
// Workbench before the first seating and are saved back when they change. The debug
// click from O1.2 still works: a moved worker goes back to work a moment after
// getting there. Each snapshot also adds to the activity log and to today's count of
// sessions that worked (O1.6), which is saved with the settings so a reload keeps it.
// Sessions started from the office (O3.2) are held at their desk with their worker
// (world/hire.ts) till they show up.

import type { RemoteSnapshot } from "../remote/protocol";
import { buildOffice } from "./map/build";
import type { Link } from "./net";
import { addToLog, logEvents, type LogEntry } from "./log";
import { ROSTER, TEAM_NAMES, type Team } from "./roster";
import { debugClick, deskAt } from "./world/debug";
import { createWorld, onDuck, workerAt as hit } from "./world/entities";
import type { TurnState } from "../assistant/protocol";
import { stepWalkers } from "./world/move";
import { OFFICE_H, OFFICE_W, createRenderer, type AskBubble, type View } from "./world/render";
import { budgetOf, officeTime } from "./world/ambience";
import type { ChatterRequest } from "../remote/chatter";
import { sceneRequest } from "./chatter";
import { behave } from "./world/behave";
import { createStaff, seatSessions, whoIs, type Staff } from "./world/sessions";
import { deskFree, isFree, workerFor } from "./world/hire";
import type { Who } from "./describe";

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

/** The sessions that worked on `day` (local, `YYYY-MM-DD`), by instance id. */
let today = { day: "", ids: [] as string[] };
let log: LogEntry[] = [];
/** The snapshot the log last compared against. */
let logged: RemoteSnapshot | null = null;

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void link?.savePrefs({ rooms: staff.rooms, sticky: staff.sticky, today }), SAVE_AFTER);
}

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Counts `snapshot`'s working sessions into today's; true when that changed. */
function countToday(snapshot: RemoteSnapshot): boolean {
  const day = dayOf(Date.now());
  if (today.day !== day) today = { day, ids: [] };
  const fresh = snapshot.instances.filter((i) => i.live && i.phase === "working" && !today.ids.includes(i.id));
  today.ids.push(...fresh.map((i) => i.id));
  return fresh.length > 0;
}

/** Who has `instanceId` as seated now: a worker's name, "A contractor", or "Someone". */
function nameIn(seating: Staff["seating"], instanceId: string): string | null {
  const s = seating.get(instanceId);
  if (!s) return null;
  return s.worker ? (ROSTER.find((w) => w.id === s.worker)?.name ?? s.worker) : "A contractor";
}

function seat(): void {
  if (!loaded || !latest) return;
  const before = staff.seating;
  let changed = seatSessions(office, world, staff, latest, performance.now());
  // Someone who just left is named by where they sat before.
  const name = (id: string) => nameIn(staff.seating, id) ?? nameIn(before, id) ?? "Someone";
  if (latest !== logged) log = addToLog(log, logEvents(logged, latest, name, Date.now()));
  logged = latest;
  changed = countToday(latest) || changed;
  if (changed) save();
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
    staff = { ...createStaff({ rooms, sticky }), duckDoing: staff.duckDoing };
    // A bubble up now would never come down: the old staff kept its time.
    for (const w of world.workers) if (w.bubble?.tone === "say") w.bubble = null;
    const t = saved?.today as { day?: unknown; ids?: unknown } | undefined;
    if (typeof t?.day === "string" && Array.isArray(t.ids)) today = { day: t.day, ids: t.ids.filter((id): id is string => typeof id === "string") };
    standAbout();
    loaded = true;
    seat();
  });
}

export function officeSnapshot(snapshot: RemoteSnapshot): void {
  latest = snapshot;
  world.budget = budgetOf(snapshot.usageLimits, Date.now() / 1000);
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
  const walked = stepWalkers(world, office, ms);
  const changed = (loaded && behave(office, world, staff, ms)) || walked;
  // What idle workers got up to together goes in the log.
  if (staff.events.length) {
    log = addToLog(log, staff.events.map((e) => ({ at: Date.now(), ...e })));
    staff.events.length = 0;
  }
  return changed;
}

/** The activity log, newest first. */
export const officeLog = (): readonly LogEntry[] => log;

/** How many sessions worked today. */
export const workedToday = (): number => (today.day === dayOf(Date.now()) ? today.ids.length : 0);

/** Who has `instanceId`: a worker's name, "A contractor", or "Someone". */
export const nameOf = (instanceId: string): string => nameIn(staff.seating, instanceId) ?? "Someone";

/** Who `id` (from `workerAt`) is, and their session. */
export const whoAt = (id: string): Who | null => whoIs(staff, id);

export const clickOffice = (picked: string | null, x: number, y: number, ms: number): string | null =>
  debugClick(office, world, picked, x, y, ms, (w) => staff.loose.set(w.worker.id, ms));

/** The workers with no session now. */
export const freeWorkers = (): string[] => ROSTER.map((w) => w.id).filter(workerFree);

/** A chatter request (O4.1) for `ids` meeting at `place`, now by the office's clock. */
export const chatterRequest = (ids: readonly string[], place: string): ChatterRequest =>
  sceneRequest(ids, place, whoAt, latest, roomOf, officeTime());

/** A free desk at (x, y) in office pixels: nothing sits there, nor is on its way. */
export function freeDeskAt(x: number, y: number): number | null {
  const desk = deskAt(office, { x, y });
  return desk !== undefined && deskFree(staff, desk) ? desk : null;
}

/** Whether worker `id` has nothing to do (so can be given a session). */
export const workerFree = (id: string): boolean => world.workers.some((w) => w.worker.id === id) && isFree(staff, id);

/** Who'd take a session at `desk` (null for a contractor), and the room it's in. */
export function deskOffer(desk: number): { worker: string | null; room: Team } {
  const room = office.seats[desk].room;
  return { worker: workerFor(office, world, staff, desk), room: isTeam(room) ? room : "open" };
}

/** Holds `desk` and `worker` for the session `requestId` will start: they walk over. */
export function hire(requestId: string, worker: string | null, desk: number): void {
  staff.hires = [...staff.hires.filter((h) => h.requestId !== requestId), { requestId, worker, desk, at: performance.now() }];
  onChange();
}

/** The instance `requestId` started, once it's seated: who's on it, as `workerAt`
 *  names them (a worker's id, or `desk:<index>` for a contractor). */
export function hired(requestId: string): string | null {
  const id = latest?.created.find((c) => c.requestId === requestId)?.instanceId;
  const s = id ? staff.seating.get(id) : undefined;
  if (!s) return null;
  return s.worker ?? (s.desk !== null ? `desk:${s.desk}` : null);
}

/** Duck's id for `workerAt`. */
export const DUCK_ID = "duck";

/** The turn in the thread open in the office's Duck chat (O3.1): Duck shows it. */
export function duckChatTurn(state: TurnState): void {
  staff.duckDoing = { ...staff.duckDoing, chat: state };
}

/** What Duck is doing, in a word, for its tooltip. */
export const duckDoing = (): string => {
  const { state, chat } = staff.duckDoing;
  return chat === "waiting" ? "waiting for your answer" : chat !== "idle" ? "thinking" : state;
};

/** What's at (x, y) in office pixels, for hover: a worker's id, a contractor's desk
 *  as `desk:<index>`, or Duck (`DUCK_ID`). */
export function workerAt(x: number, y: number): string | null {
  const w = hit(world, x, y);
  if (w) return w.worker.id;
  if (onDuck(world, x, y)) return DUCK_ID;
  const desk = deskAt(office, { x, y });
  return desk !== undefined && world.contractors.some((c) => c.desk === desk) ? `desk:${desk}` : null;
}

/** Slack round a bubble for the pointer, in office pixels: they're small. */
const ASK_SLACK = 2;

/** The bubble asking for you (`!`, `?`) at (x, y) in office pixels, the front one, as
 *  last drawn. */
export function askAt(x: number, y: number): AskBubble | null {
  const asks = renderer.asks();
  for (let n = asks.length - 1; n >= 0; n--) {
    const a = asks[n];
    if (x >= a.x - ASK_SLACK && x < a.x + a.w + ASK_SLACK && y >= a.y - ASK_SLACK && y < a.y + a.h + ASK_SLACK) return a;
  }
  return null;
}

/** Where `id`'s bubble asking for you was last drawn, if it's up. */
export const askOf = (id: string): AskBubble | null => renderer.asks().find((a) => a.id === id) ?? null;

export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, view: View = {}): number {
  return renderer.draw(ctx, world, ms, view);
}
