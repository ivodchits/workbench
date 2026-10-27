// The sidebar with nobody picked (office plan O1.6): the sessions by phase, the usage
// limits, the fullest contexts, today's sessions and commits, what Workbench costs
// (O0.4), and the activity log. Rebuilt on every snapshot and every few seconds; it
// holds nothing a rebuild would lose.

import type { RateWindow } from "../ipc/usageLimits";
import type { RemoteInstance, RemoteSnapshot } from "../remote/protocol";
import { el } from "../pwa/dom";
import { formatCountdown, formatTokens } from "../util/format";
import { titleOf } from "./describe";
import type { LogEntry } from "./log";
import type { Cost, Usage } from "./net";

/** Contexts listed. */
const CONTEXTS_MAX = 5;

export interface Stats {
  snapshot: RemoteSnapshot;
  cost: Cost | null;
  log: readonly LogEntry[];
  /** Sessions that worked today. */
  workedToday: number;
  /** Who has an instance: a worker's name, or "a contractor". */
  nameOf: (instanceId: string) => string;
}

export type PhaseCounts = Record<"working" | "needs_you" | "done" | "idle", number>;

/** The live sessions by phase; a console with no status yet is idle, and an ended one
 *  is about to close, so it's left out. */
export function phaseCounts(instances: readonly RemoteInstance[]): PhaseCounts {
  const counts: PhaseCounts = { working: 0, needs_you: 0, done: 0, idle: 0 };
  for (const i of instances) {
    if (!i.live || i.phase === "ended") continue;
    const phase = i.phase && i.phase in counts ? (i.phase as keyof PhaseCounts) : "idle";
    counts[phase]++;
  }
  return counts;
}

/** The live sessions with the fullest contexts, fullest first. */
export function fullest(instances: readonly RemoteInstance[], max = CONTEXTS_MAX): RemoteInstance[] {
  return instances.filter((i) => i.live && i.ctxTokens > 0).sort((a, b) => b.ctxTokens - a.ctxTokens).slice(0, max);
}

/** Today's commits across the projects; null when no project knows yet. */
export function commitsToday(snapshot: RemoteSnapshot): number | null {
  const known = snapshot.projects.map((p) => p.commitsToday).filter((n): n is number => n !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** A bar `share` (0–1) full. */
function bar(share: number, className = ""): HTMLElement {
  const outer = el("span", `bar ${className}`);
  const inner = el("span");
  inner.style.width = `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
  outer.append(inner);
  return outer;
}

function row(label: string, value: string | HTMLElement, ...rest: HTMLElement[]): HTMLElement {
  const r = el("div", "row");
  r.append(el("span", "label", label), typeof value === "string" ? el("span", "value", value) : value, ...rest);
  return r;
}

function limit(label: string, w: RateWindow | null): HTMLElement {
  if (!w) return row(label, el("span", "value muted", "—"));
  const pct = Math.round(w.usedPercentage);
  const tone = pct >= 90 ? "high" : pct >= 70 ? "mid" : "";
  return row(label, bar(w.usedPercentage / 100, tone), el("span", "value", `${pct}%`), el("span", "muted", `resets ${formatCountdown(w.resetsAt)}`));
}

function usage(label: string, u: Usage): HTMLElement {
  return row(label, el("span", "value", `${u.cpu.toFixed(1)}% CPU · ${Math.round(u.ramMb)} MB`), el("span", "muted", `${u.processes} proc`));
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function showStats(root: HTMLElement, s: Stats): void {
  const parts: HTMLElement[] = [];
  const head = (text: string) => parts.push(el("h2", "", text));

  head("Sessions");
  const c = phaseCounts(s.snapshot.instances);
  const phases = el("div", "phases");
  for (const [phase, glyph, label] of [
    ["working", "◐", "working"],
    ["needs_you", "●", "need you"],
    ["done", "○", "done"],
    ["idle", "·", "idle"],
  ] as const) {
    const cell = el("span", `phase-${phase}${c[phase] ? "" : " none"}`);
    cell.append(el("b", "", `${glyph} ${c[phase]}`), el("span", "", label));
    phases.append(cell);
  }
  parts.push(phases);
  const today = commitsToday(s.snapshot);
  parts.push(row("today", `${s.workedToday} session${s.workedToday === 1 ? "" : "s"} · ${today ?? "?"} commit${today === 1 ? "" : "s"}`));

  head("Usage limits");
  const limits = s.snapshot.usageLimits;
  parts.push(limit("5 hours", limits?.fiveHour ?? null), limit("7 days", limits?.sevenDay ?? null));

  const ctx = fullest(s.snapshot.instances);
  if (ctx.length) {
    head("Contexts");
    const top = ctx[0].ctxTokens;
    for (const i of ctx) {
      const r = row(s.nameOf(i.id), bar(i.ctxTokens / top), el("span", "value", formatTokens(i.ctxTokens)));
      r.title = `${i.projectName} · ${titleOf(i)}`;
      parts.push(r);
    }
  }

  head("Workbench costs");
  if (s.cost) parts.push(usage("app", s.cost.workbench), usage("sessions", s.cost.sessions));
  else parts.push(el("p", "muted", "Measuring…"));

  head("Lately");
  if (!s.log.length) parts.push(el("p", "muted", "Nothing yet since the office opened."));
  else {
    const list = el("ul", "log");
    for (const e of s.log) {
      const li = el("li", `log-${e.kind}`);
      li.append(el("span", "muted", clock(e.at)), el("span", "", e.text));
      list.append(li);
    }
    parts.push(list);
  }
  root.replaceChildren(...parts);
}
