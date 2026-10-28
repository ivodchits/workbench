// Sessions into the office (office plan O1.3): each snapshot's live sessions are seated
// by assign.ts, and behave.ts moves people to match — a newly seated worker walks to
// their desk (in through the door if they're out) and does what their session is
// doing; one whose session ended packs up and goes to the kitchen; whoever has nothing
// to do stands about the kitchen and the lounge. On the first snapshot everyone is
// simply where they belong, nobody walks. A contractor's desk gets a laptop. What
// changed since the last snapshot can set off a reaction (reactions.ts). A session
// started from the office goes to the desk and worker it was asked for (hire.ts).

import type { Anim, Dir } from "../art/characters";
import { noGames, type Games, type GroupEvent, type SceneWriter } from "./groups";
import type { RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import type { TagGlyph } from "../art/labels";
import type { Who } from "../describe";
import type { OfficeMap } from "../map/build";
import { ROSTER, type Team } from "../roster";
import { officeTime } from "./ambience";
import { assign, type Seating } from "./assign";
import { behave, doing, type Plan } from "./behave";
import { react, type DuckTrip } from "./reactions";
import type { DuckDoing } from "./boss";
import { bindHires, type Hire } from "./hire";
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
  /** What each worker with nothing to do is up to (`idle.ts`), by worker id. */
  idle: Map<string, IdleState>;
  /** What each worker did idle last, so it isn't picked twice running. */
  lastIdle: Map<string, string>;
  /** The hour of the day now (0–23), and the dice: both swapped in tests. */
  hour: () => number;
  random: () => number;
  /** What idle workers are doing together (`groups.ts`). */
  games: Games;
  /** Poses the group activities ask of their players, by worker id. */
  groupPose: Map<string, Anim>;
  /** Which way they ask them to face (a chat: toward the others), by worker id. */
  groupFace: Map<string, Dir>;
  /** Writes a scene for workers who meet (chatter, O4.1); null plays canned lines. */
  writer: SceneWriter | null;
  /** When each bubble a group put up comes down, by worker id. */
  saying: Map<string, number>;
  /** What happened worth a line in the activity log, until the page takes it; a
   *  scene's lines (`chat`) gather under one entry by `key`. */
  events: GroupEvent[];
  /** Each project's commits today, as last seen (`reactions.ts`). */
  commits: Map<string, number>;
  /** Workers cheering a commit, till when, by worker id. */
  cheers: Map<string, number>;
  /** Duck's trip to a desk, if it's on one. */
  trip: DuckTrip | null;
  /** What Duck is doing (`boss.ts`): the snapshot's word, and the office chat's turn. */
  duckDoing: DuckDoing;
  /** Sessions started from the office, on their way to their desks. */
  hires: Hire[];
  /** Since when you've been playing on the TV (sim ms); null when you aren't. */
  watching: number | null;
}

/** An idle worker's activity: where, and until when once they got there. */
export interface IdleState {
  /** The activity's id; empty while waiting for somewhere to come free. */
  activity: string;
  /** The spot id, or `home` for their own desk. */
  place: string;
  /** When it was picked. */
  since: number;
  lasts: number;
  /** When they move on: set once they're there. */
  until: number | null;
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
    idle: new Map(),
    lastIdle: new Map(),
    hour: () => officeTime().getHours(),
    random: Math.random,
    games: noGames(),
    groupPose: new Map(),
    groupFace: new Map(),
    writer: null,
    saying: new Map(),
    events: [],
    commits: new Map(),
    cheers: new Map(),
    trip: null,
    duckDoing: { state: "idle", chat: "idle" },
    hires: [],
    watching: null,
  };
}

/** Seats `snapshot`'s live sessions and sends people where they now belong. True when
 *  the sticky map changed (worth saving). */
export function seatSessions(office: OfficeMap, world: World, staff: Staff, snapshot: RemoteSnapshot, ms: number, random?: () => number): boolean {
  const live = snapshot.instances.filter((i) => i.live);
  const stickyBefore = JSON.stringify(staff.sticky);
  const held = bindHires(staff, snapshot, ms);
  const { seating, sticky } = assign({
    seats: office.seats,
    sessions: live,
    rooms: staff.rooms,
    sticky: staff.sticky,
    current: staff.seating,
    known: new Set(snapshot.instances.map((i) => i.id)),
    held,
    random,
  });
  const stickyChanged = JSON.stringify(sticky) !== stickyBefore;
  const instant = !staff.started;
  staff.started = true;
  staff.duckDoing = { ...staff.duckDoing, state: snapshot.duck.state };
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
  const before = staff.instances;
  staff.instances = instances;
  react(staff, before, snapshot, ms, instant);

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
