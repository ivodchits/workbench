// Sessions into the office (office plan O1.3): each snapshot's live sessions are seated
// by assign.ts, and people walk to match. A newly seated worker walks to their desk (in
// through the door if they're out); one whose session ended packs up and goes to the
// kitchen; whoever has nothing to do stands about the kitchen and the lounge. On the
// first snapshot everyone is simply where they belong, nobody walks. Screens follow
// who's at a desk, and a contractor's desk gets a laptop.

import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import type { TagGlyph } from "../art/labels";
import type { OfficeMap } from "../map/build";
import type { SpotKind, SpotSpec } from "../map/office";
import type { Team } from "../roster";
import { assign, type Seating } from "./assign";
import { seatedAt, setAnim, type Screen, type WorkerEntity, type World } from "./entities";
import { enter, walkTo } from "./move";

/** Where people with nothing to do stand, in the order they fill. Released workers
 *  go to the kitchen's first. */
const IDLE_KINDS: readonly SpotKind[] = ["drink", "chat", "play", "dnd", "window"];
const KITCHEN_KINDS: readonly SpotKind[] = ["drink", "chat"];

/** The rail's glyph for a session's phase. */
const TAG: Record<string, TagGlyph> = { working: "working", needs_you: "needs", done: "done", idle: "idle" };

export function tagFor(i: RemoteInstance): TagGlyph {
  return i.phase ? (TAG[i.phase] ?? "idle") : "ended";
}

export interface Staff {
  seating: Map<string, Seating>;
  /** Instance → the worker it had last (saved). */
  sticky: Record<string, string>;
  /** Project → room (saved). */
  rooms: Record<string, Team>;
  /** The idle spot each free worker has, by worker id. */
  spots: Map<string, string>;
  /** Whether a snapshot has been seated yet: the first one places people outright. */
  started: boolean;
}

export function createStaff(saved: { sticky?: Record<string, string>; rooms?: Record<string, Team> } = {}): Staff {
  return { seating: new Map(), sticky: { ...saved.sticky }, rooms: { ...saved.rooms }, spots: new Map(), started: false };
}

/** Seats `snapshot`'s live sessions and sends people where they now belong. True when
 *  the sticky map changed (worth saving). */
export function seatSessions(office: OfficeMap, world: World, staff: Staff, snapshot: RemoteSnapshot, ms: number, random?: () => number): boolean {
  const live = snapshot.instances.filter((i) => i.live);
  const { seating, sticky } = assign({
    seats: office.seats,
    sessions: live,
    rooms: staff.rooms,
    sticky: staff.sticky,
    current: staff.seating,
    known: new Set(snapshot.instances.map((i) => i.id)),
    random,
  });
  const stickyChanged = JSON.stringify(sticky) !== JSON.stringify(staff.sticky);
  const instant = !staff.started;
  staff.started = true;
  staff.seating = seating;
  staff.sticky = sticky;

  const byWorker = new Map<string, { instance: RemoteInstance; desk: number | null }>();
  const instances = new Map(live.map((i) => [i.id, i]));
  for (const [id, s] of seating) if (s.worker) byWorker.set(s.worker, { instance: instances.get(id)!, desk: s.desk });

  for (const w of world.workers) {
    const job = byWorker.get(w.worker.id);
    if (job && job.desk !== null) {
      staff.spots.delete(w.worker.id);
      w.tag = tagFor(job.instance);
      if (instant) sitNow(office, w, job.desk, ms);
      else toDesk(office, w, job.desk, ms);
    } else {
      w.tag = null;
      if (!staff.spots.has(w.worker.id)) toSpot(office, staff, w, ms, instant);
    }
  }

  world.contractors = [...seating]
    .filter(([, s]) => !s.worker && s.desk !== null)
    .map(([id, s]) => ({ desk: s.desk!, tag: tagFor(instances.get(id)!) }));
  showScreens(office, world, staff);
  return stickyChanged;
}

/** Monitors on for the desks whose worker is sitting at them, laptops on the
 *  contractors' desks, the rest dark. */
export function showScreens(office: OfficeMap, world: World, staff: Staff): void {
  const screens = office.seats.map((): Screen => "off");
  for (const s of staff.seating.values()) {
    if (s.desk === null) continue;
    if (!s.worker) screens[s.desk] = "laptop";
    else if (world.workers.some((w) => w.worker.id === s.worker && w.seat === s.desk)) screens[s.desk] = "code";
  }
  world.screens = screens;
}

function sitNow(office: OfficeMap, w: WorkerEntity, desk: number, ms: number): void {
  const at = seatedAt(office.seats[desk]);
  Object.assign(w, { ...at, prev: at, seat: desk, dir: "up", walk: null, away: false });
  setAnim(w, "type", ms);
}

/** Sends `w` to sit at `desk`, unless they're there or on their way. */
function toDesk(office: OfficeMap, w: WorkerEntity, desk: number, ms: number): void {
  if (w.seat === desk) return;
  if (w.walk?.then.kind === "sit" && w.walk.then.seat === desk) return;
  const then = { kind: "sit", seat: desk } as const;
  if (w.away) enter(office, w, office.seats[desk].stand, ms, then);
  else walkTo(office, w, office.seats[desk].stand, ms, then);
}

/** Gives a free worker an idle spot nobody has: walked to, or (on the first snapshot)
 *  put there. Someone just released goes to the kitchen if it has room. */
function toSpot(office: OfficeMap, staff: Staff, w: WorkerEntity, ms: number, instant: boolean): void {
  const taken = new Set(staff.spots.values());
  const free = (kinds: readonly SpotKind[]) => kinds.flatMap((k) => office.spots.filter((s) => s.kind === k && !taken.has(s.id)));
  const spot: SpotSpec | undefined = instant ? free(IDLE_KINDS)[0] : (free(KITCHEN_KINDS)[0] ?? free(IDLE_KINDS)[0]);
  if (!spot) return;
  staff.spots.set(w.worker.id, spot.id);
  if (instant) {
    Object.assign(w, { x: spot.x, y: spot.y, prev: { x: spot.x, y: spot.y }, seat: null, dir: spot.dir, walk: null, away: false });
    setAnim(w, "idle", ms);
    return;
  }
  const then = { kind: "stand", face: spot.dir } as const;
  if (w.away) enter(office, w, spot, ms, then);
  else walkTo(office, w, spot, ms, then);
}
