// Sessions into the office (office plan O1.3): each snapshot's live sessions are seated
// by assign.ts, and behave.ts moves people to match — a newly seated worker walks to
// their desk (in through the door if they're out) and does what their session is
// doing; one whose session ended packs up and goes to the kitchen; whoever has nothing
// to do stands about the kitchen and the lounge. On the first snapshot everyone is
// simply where they belong, nobody walks. A contractor's desk gets a laptop.

import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import type { TagGlyph } from "../art/labels";
import type { Who } from "../describe";
import type { OfficeMap } from "../map/build";
import { ROSTER, type Team } from "../roster";
import { assign, type Seating } from "./assign";
import { behave, doing, type Plan } from "./behave";
import type { World } from "./entities";

/** The rail's glyph for a session's phase. */
const TAG: Record<string, TagGlyph> = { working: "working", needs_you: "needs", done: "done", idle: "idle", ended: "ended" };

/** A live console with no status yet (a session that hasn't sent its first hook) is idle. */
export function tagFor(i: RemoteInstance): TagGlyph {
  return (i.phase && TAG[i.phase]) || "idle";
}

/** A busy worker's session and desk. */
export interface Job {
  instance: RemoteInstance;
  desk: number;
  tag: TagGlyph;
}

export interface Staff {
  seating: Map<string, Seating>;
  /** Instance → the worker it had last (saved). */
  sticky: Record<string, string>;
  /** Project → room (saved). */
  rooms: Record<string, Team>;
  /** By worker id. */
  jobs: Map<string, Job>;
  /** The live sessions, by instance id. */
  instances: Map<string, RemoteInstance>;
  /** The spot each worker holds, by worker id: an idle spot, or a station for work. */
  spots: Map<string, string>;
  /** What each busy worker is doing, by worker id. */
  plans: Map<string, Plan>;
  /** When each live instance's phase last changed (sim ms). */
  phases: Map<string, { phase: RemoteInstance["phase"]; at: number }>;
  /** Busy workers who've been to their desk: their screen is on. */
  settled: Set<string>;
  /** Workers a debug click sent somewhere, left alone till a moment after they arrive. */
  loose: Map<string, number>;
  /** Whether a snapshot has been seated yet: the first one places people outright. */
  started: boolean;
}

export function createStaff(saved: { sticky?: Record<string, string>; rooms?: Record<string, Team> } = {}): Staff {
  return {
    seating: new Map(),
    sticky: { ...saved.sticky },
    rooms: { ...saved.rooms },
    jobs: new Map(),
    instances: new Map(),
    spots: new Map(),
    plans: new Map(),
    phases: new Map(),
    settled: new Set(),
    loose: new Map(),
    started: false,
  };
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

  const phases = new Map<string, { phase: RemoteInstance["phase"]; at: number }>();
  for (const i of live) {
    const was = staff.phases.get(i.id);
    phases.set(i.id, was && was.phase === i.phase ? was : { phase: i.phase, at: ms });
  }
  staff.phases = phases;

  const instances = new Map(live.map((i) => [i.id, i]));
  const jobs = new Map<string, Job>();
  for (const [id, s] of seating) {
    if (s.worker && s.desk !== null) jobs.set(s.worker, { instance: instances.get(id)!, desk: s.desk, tag: tagFor(instances.get(id)!) });
  }
  // A worker on another session (or none) starts afresh.
  for (const w of staff.jobs.keys()) {
    if (jobs.get(w)?.instance.id === staff.jobs.get(w)?.instance.id) continue;
    staff.settled.delete(w);
    staff.plans.delete(w);
  }
  staff.jobs = jobs;
  staff.instances = instances;

  world.contractors = [...seating]
    .filter(([, s]) => !s.worker && s.desk !== null)
    .map(([id, s]) => ({ desk: s.desk!, tag: tagFor(instances.get(id)!), bubble: doing(instances.get(id)!).bubble }));
  behave(office, world, staff, ms, instant);
  return stickyChanged;
}

/** Who `id` is — a worker's id, or a contractor's desk as `desk:<index>` — and the
 *  session they're on; null for nobody (a desk with no contractor at it). */
export function whoIs(staff: Staff, id: string): Who | null {
  const since = (i: RemoteInstance | null) => (i && staff.phases.get(i.id)?.at) ?? null;
  if (id.startsWith("desk:")) {
    const desk = Number(id.slice("desk:".length));
    const seated = [...staff.seating].find(([, s]) => !s.worker && s.desk === desk);
    const instance = seated ? staff.instances.get(seated[0]) : undefined;
    return instance ? { worker: null, instance, since: since(instance) } : null;
  }
  const worker = ROSTER.find((w) => w.id === id);
  if (!worker) return null;
  const instance = staff.jobs.get(id)?.instance ?? null;
  return { worker, instance, since: since(instance) };
}
