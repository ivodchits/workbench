// The sidebar's activity log (office plan O1.6): what changed between two snapshots,
// in plain words, by the worker it happened to. Pure, so the tests pin the wording.

import type { RemoteInstance, RemoteSnapshot } from "../remote/protocol";
import { titleOf } from "./describe";

/** The kinds tint the log's lines. */
export type LogKind = "sit" | "work" | "needs" | "done" | "leave" | "commit";

export interface LogEntry {
  /** Epoch ms. */
  at: number;
  kind: LogKind;
  text: string;
}

/** Lines kept. */
export const LOG_MAX = 8;

const ASKS: Record<string, string> = { permission: "wants permission", question: "has a question", plan: "has a plan ready" };

/** What happened from `prev` to `next`; `nameOf` names whoever has (or had) an
 *  instance. Nothing for the first snapshot: what was already so isn't news. */
export function logEvents(prev: RemoteSnapshot | null, next: RemoteSnapshot, nameOf: (instanceId: string) => string, at: number): LogEntry[] {
  if (!prev) return [];
  const out: LogEntry[] = [];
  const add = (kind: LogKind, text: string) => out.push({ at, kind, text });
  const was = new Map(prev.instances.map((i) => [i.id, i]));
  for (const i of next.instances) {
    const p = was.get(i.id);
    const who = nameOf(i.id);
    const what = `${i.projectName} · ${titleOf(i)}`;
    if (!p?.live && i.live) add("sit", `${who} sat down to ${what}`);
    else if (p?.live && !i.live) add("leave", `${who} is done with ${what}: console closed`);
    if (!i.live || !p?.live || p.phase === i.phase) continue;
    if (i.phase === "working") add("work", `${who} got to work on ${titleOf(i)}`);
    else if (i.phase === "needs_you") add("needs", `${who} needs you${needsWhat(i)}`);
    else if (i.phase === "done" && p.phase === "working") add("done", `${who} finished ${titleOf(i)}`);
    else if (i.phase === "ended") add("leave", `${who}'s session ended`);
  }
  const before = new Map(prev.projects.map((p) => [p.id, p.commitsToday]));
  for (const p of next.projects) {
    const n = (p.commitsToday ?? 0) - (before.get(p.id) ?? p.commitsToday ?? 0);
    // Fewer is a new day, not news.
    if (n > 0) add("commit", `${n} new commit${n === 1 ? "" : "s"} in ${p.name}`);
  }
  return out;
}

function needsWhat(i: RemoteInstance): string {
  const asks = i.choice ? ASKS[i.choice.kind] : null;
  return asks ? `: ${asks}` : "";
}

/** `log` with `entries` added, newest first, at most [`LOG_MAX`]. */
export function addToLog(log: readonly LogEntry[], entries: readonly LogEntry[]): LogEntry[] {
  return [...[...entries].reverse(), ...log].slice(0, LOG_MAX);
}
