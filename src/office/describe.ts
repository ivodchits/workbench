// What the office says about a worker in words (office plan O1.5): the hover tooltip
// and the sidebar's header. Pure, so the tests pin the wording down.

import type { RemoteInstance } from "../remote/protocol";
import type { Activity } from "../state/activity";
import { TEAM_NAMES, type Worker } from "./roster";

/** Whoever is under the pointer or picked: a worker (with their session, if they have
 *  one) or a remote contractor (always with one). */
export interface Who {
  worker: Worker | null;
  instance: RemoteInstance | null;
  /** When the session's phase last changed (sim ms); null when unknown. */
  since: number | null;
}

const DOING: Record<Activity, string> = {
  edit: "editing",
  bash: "running a command",
  test: "running tests",
  web: "on the web",
  read: "reading",
  task: "delegating",
  other: "working",
};

const ASKS: Record<string, string> = { permission: "wants permission", question: "has a question", plan: "has a plan ready" };

/** "12 s", "4 min", "2 h 5 min". */
export function howLong(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** What the session is doing, in a few words: "editing", "needs you: wants permission". */
export function phaseText(i: RemoteInstance): string {
  if (i.phase === "ended") return "session ended";
  if (i.phase === "needs_you") {
    const asks = i.choice ? ASKS[i.choice.kind] : null;
    return `${i.escalated ? "really needs you" : "needs you"}${asks ? `: ${asks}` : ""}`;
  }
  if (i.phase === "working") {
    if (i.compacting) return "compacting";
    if (i.stuck) return "stuck";
    const doing = i.activity ? DOING[i.activity] : "working";
    return i.subagents > 0 ? `${doing}, ${i.subagents} subagent${i.subagents === 1 ? "" : "s"} out` : doing;
  }
  if (i.phase === "done") return "done";
  return "idle";
}

/** Who they are: "Felix · Demiurge", or "Remote contractor". */
export function whoText(who: Who): string {
  return who.worker ? `${who.worker.name} · ${TEAM_NAMES[who.worker.team]}` : "Remote contractor";
}

/** The session's title, as the rail shows it. */
export function titleOf(i: RemoteInstance): string {
  return i.title || i.taskNote || "untitled";
}

/** The tooltip's lines: who, the session, and what it's doing for how long. */
export function tooltipLines(who: Who, now: number): string[] {
  const lines = [whoText(who)];
  const i = who.instance;
  if (!i) return [...lines, "free"];
  lines.push(`${i.projectName} · ${titleOf(i)}`);
  const state = phaseText(i);
  lines.push(who.since === null ? state : `${state} · ${howLong(now - who.since)}`);
  return lines;
}
