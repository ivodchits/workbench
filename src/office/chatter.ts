// Chatter, the page's side (office plan O4.1): asks Workbench for a scene for workers
// who meet (`remote/chatter.ts`), and knows when not to. Off, it asks nothing at all;
// with the hour's calls spent it waits a few minutes, with the day's tokens spent
// until the next day; it never asks while the page is hidden. Whenever it gets no
// scene the caller plays canned lines.

import type { RemoteSnapshot } from "../remote/protocol";
import type { ChatterAnswer, ChatterRequest, ChatterSettings, ChatterSpeaker, ChatterUsage, Scene } from "../remote/chatter";
import type { Who } from "./describe";
import { phaseText, titleOf } from "./describe";
import type { Link } from "./net";
import { TEAM_NAMES, type Team } from "./roster";

export interface ChatterState {
  settings: ChatterSettings;
  usage: ChatterUsage;
}

/** After the hour's calls are spent, ask again no sooner than this. */
const HOUR_WAIT = 5 * 60_000;
/** After a failed call. */
const ERROR_WAIT = 60_000;
/** Projects a request names, at most. */
const PROJECTS_MAX = 4;

export interface Chatter {
  /** Settings and usage, null until Workbench has said. */
  readonly state: ChatterState | null;
  /** Read them again. */
  refresh(): Promise<void>;
  /** Change some settings. */
  set(patch: Partial<ChatterSettings>): Promise<void>;
  /** A scene, or null: chatter is off, over budget or busy, the page is hidden, or
   *  the call failed (`lastError` says why). A failure holds off the next minute's
   *  asking, except one the user asked for (`manual`). */
  scene(req: ChatterRequest, manual?: boolean): Promise<Scene | null>;
  readonly lastError: string | null;
}

/** The local date, `YYYY-MM-DD`. */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Wednesday 14:05". */
export function timeOf(d: Date): string {
  return `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** What a worker is up to, for the scene. */
export function doingOf(who: Who | null): string {
  const i = who?.instance;
  if (!i) return "free, between sessions";
  return `${phaseText(i)} on ${i.projectName || "a project"} · ${titleOf(i)}`;
}

/** The projects worth talking about for these workers: their sessions' first, then
 *  their rooms', the latest committed to first. */
export function projectsFor(whos: readonly (Who | null)[], snapshot: RemoteSnapshot | null, roomOf: (projectId: string) => Team): string[] {
  const out: string[] = [];
  const add = (id: string) => out.length < PROJECTS_MAX && !out.includes(id) && out.push(id);
  for (const w of whos) if (w?.instance) add(w.instance.projectId);
  const teams = new Set(whos.flatMap((w) => (w?.worker ? [w.worker.team] : [])));
  const byCommit = [...(snapshot?.projects ?? [])].sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
  for (const p of byCommit) if (teams.has(roomOf(p.id))) add(p.id);
  return out;
}

/** A request for `ids` meeting at `place`. */
export function sceneRequest(
  ids: readonly string[],
  place: string,
  who: (id: string) => Who | null,
  snapshot: RemoteSnapshot | null,
  roomOf: (projectId: string) => Team,
  now: Date,
  lines = 4,
): ChatterRequest {
  const whos = ids.map(who);
  const speakers: ChatterSpeaker[] = ids.map((id, n) => {
    const w = whos[n];
    const team = w?.worker ? ` (${TEAM_NAMES[w.worker.team]})` : "";
    return { id, doing: `${doingOf(w)}${team}` };
  });
  return { day: dayOf(now), time: timeOf(now), place, speakers, projects: projectsFor(whos, snapshot, roomOf), lines };
}

export function createChatter(link: Link, changed: () => void): Chatter {
  let state: ChatterState | null = null;
  let lastError: string | null = null;
  /** No asking before these (epoch ms: the hour's calls spent, a failure), or on this
   *  day (the day's tokens spent). */
  let waitUntil = 0;
  let errorUntil = 0;
  let spentDay: string | null = null;

  const take = (s: ChatterState | null) => {
    if (!s) return;
    state = s;
    changed();
  };

  return {
    get state() {
      return state;
    },
    get lastError() {
      return lastError;
    },
    async refresh() {
      take(await link.chatter());
    },
    async set(patch) {
      const s = await link.setChatter(patch);
      // New limits may let it ask again at once.
      waitUntil = 0;
      spentDay = null;
      take(s);
    },
    async scene(req, manual = false) {
      if (!state?.settings.on || document.hidden || spentDay === req.day) return null;
      if (Date.now() < waitUntil || (!manual && Date.now() < errorUntil)) return null;
      const a: ChatterAnswer | null = await link.askScene(req);
      if (!a) {
        lastError = "Workbench can't be reached";
        errorUntil = Date.now() + ERROR_WAIT;
        changed();
        return null;
      }
      if (a.usage) state = { settings: state.settings, usage: a.usage };
      if (a.status === "off") state = { ...state, settings: { ...state.settings, on: false } };
      if (a.status === "hour") waitUntil = Date.now() + HOUR_WAIT;
      if (a.status === "day") spentDay = req.day;
      if (a.status === "error") {
        lastError = a.message;
        errorUntil = Date.now() + ERROR_WAIT;
      }
      if (a.status === "ok") lastError = null;
      changed();
      return a.status === "ok" ? a.scene : null;
    },
  };
}
