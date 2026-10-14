// The dashboard's wording and ordering rules, apart from the DOM so they can be
// tested on their own.

import type { RemoteInstance } from "../remote/protocol";

/** What a card shows for a phase: its glyph and the class that colours it. */
const GLYPH: Record<string, [glyph: string, cls: string]> = {
  working: ["◐", "working"],
  needs_you: ["●", "needs"],
  done: ["○", "done"],
  idle: ["▸", "idle"],
  ended: ["✗", "ended"],
};

/** The live phase, else the persisted status, of an instance. */
export function phaseOf(it: RemoteInstance): string {
  return it.phase || it.status || "idle";
}

export function glyphOf(it: RemoteInstance): [glyph: string, cls: string] {
  return GLYPH[phaseOf(it)] ?? GLYPH.idle;
}

const ORDER: Record<string, number> = { needs_you: 0, working: 1, done: 2, idle: 3, ended: 4 };

/** Needs-you first, then working, then the rest — the ordering that makes a small
 *  screen useful. Instances in the same phase keep the order they came in. */
export function byAttention(instances: RemoteInstance[]): RemoteInstance[] {
  return instances
    .slice()
    .sort((a, b) => (ORDER[phaseOf(a)] ?? 9) - (ORDER[phaseOf(b)] ?? 9));
}

/** Whole minutes a needs-you has been waiting, from its epoch-seconds start. */
export function waitMins(since: number | null, nowSecs: number): number | null {
  if (!since) return null;
  return Math.max(0, Math.floor((nowSecs - since) / 60));
}

/** Compact "in 2h 13m" / "in 3d 4h" countdown to an epoch-seconds instant. */
export function countdown(epoch: number, nowSecs: number): string {
  let s = epoch - Math.floor(nowSecs);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return "in " + (d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`);
}

/** The small print under a card: project, branch, context size and overlays. */
export function metaLine(it: RemoteInstance): string {
  const sub = it.subagents ? ` · ${it.subagents} subagent(s)` : "";
  const cmp = it.compacting ? " · compacting…" : "";
  const ctx = it.ctxTokens ? ` · ctx ${Math.round(it.ctxTokens / 1000)}k` : "";
  const rmt = it.remote ? " · ⇄ remote" : "";
  return (
    (it.projectName || "") +
    (it.branch ? " · " + it.branch : "") +
    ctx +
    rmt +
    sub +
    cmp +
    (it.live ? "" : " · (not running)")
  );
}

/** The banner line for how many agents are waiting, or null when none is. */
export function attentionLine(instances: RemoteInstance[]): string | null {
  const waiting = instances.filter((it) => phaseOf(it) === "needs_you");
  const needs = waiting.length;
  if (needs === 0) return null;
  const esc = waiting.filter((it) => it.escalated).length;
  return (
    `${needs} agent${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you` +
    (esc > 0 ? ` · ${esc} escalated` : "")
  );
}
