// The dashboard's wording and ordering rules, apart from the DOM so they can be
// tested on their own.

import type {
  RemoteChoice,
  RemoteCreated,
  RemoteInstance,
  RemoteProject,
  RemoteSnapshot,
} from "../remote/protocol";

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

/** A project as the new-session picker lists it: its group first, if any. */
export function projectLabel(p: RemoteProject): string {
  return (p.group ? `${p.group} / ` : "") + p.name + (p.remote ? " (ssh)" : "");
}

/** Projects with no session on the dashboard yet, in the snapshot's (rail) order —
 *  the ones a card's "+" can't reach. */
export function unusedProjects(snap: Pick<RemoteSnapshot, "instances" | "projects">): RemoteProject[] {
  const used = new Set((snap.instances ?? []).map((it) => it.projectId));
  return (snap.projects ?? []).filter((p) => !used.has(p.id));
}

/** What the new-session sheet says about its request. */
export function createStatus(rec: RemoteCreated): string {
  switch (rec.state) {
    case "creating":
      return "creating the session…";
    case "starting":
      return rec.message ?? "starting — the first prompt goes in when Claude is ready…";
    case "started":
      return rec.message ?? "started";
    case "sent":
      return rec.message ?? "started, first prompt sent";
    case "queued":
    case "failed":
      return rec.message ?? (rec.state === "failed" ? "could not create the session" : "first prompt queued");
  }
}

/** A request id unique enough for one phone. `crypto.randomUUID` needs a secure
 *  context, which plain HTTP on a tailnet address is not. */
export function newRequestId(now = Date.now(), rand = Math.random): string {
  return `${now.toString(36)}-${Math.floor(rand() * 2 ** 32).toString(36)}`;
}

/** What a dashboard card says about where its session is, at a glance:
 *  - `tool` — the call it is on, one monospace line;
 *  - `ask` — what it waits on you for;
 *  - `reply` — the start of its last answer;
 *  - `prompt` — what it was asked, before its first tool call;
 *  - `quiet` — a plain word when there is nothing better. */
export interface CardStatus {
  /** The phase in words. */
  label: string;
  /** The class that colours it (as `glyphOf`). */
  cls: string;
  kind: "tool" | "ask" | "reply" | "prompt" | "quiet";
  /** A tool call's title ("Bash", "Edit"), for `tool` and a permission `ask`. */
  name: string;
  text: string;
}

const LABEL: Record<string, string> = {
  working: "working",
  needs_you: "needs you",
  done: "done",
  idle: "idle",
  ended: "ended",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One line on what a pending prompt asks. */
export function askLine(c: RemoteChoice): { name: string; text: string } {
  if (c.kind === "question") {
    const more = c.questions.length > 1 ? ` (+${c.questions.length - 1} more)` : "";
    return { name: "", text: (c.questions[0]?.question ?? "a question") + more };
  }
  if (c.kind === "plan") return { name: "", text: "its plan is ready for review" };
  const i = c.input;
  const target =
    c.toolName === "Bash"
      ? str(i.description) || str(i.command).split("\n")[0]
      : str(i.file_path) || str(i.path) || str(i.url) || str(i.pattern) || str(i.query);
  return { name: c.toolName, text: target };
}

export function cardStatus(it: RemoteInstance): CardStatus {
  const phase = phaseOf(it);
  const [, cls] = glyphOf(it);
  const label = LABEL[phase] ?? "idle";
  const last = it.latest;
  const is = (kind: CardStatus["kind"], text: string, name = ""): CardStatus => ({ label, cls, kind, name, text });

  if (phase === "needs_you") {
    if (it.choice) {
      const a = askLine(it.choice);
      return is("ask", a.text, a.name);
    }
    if (last?.tool) return is("ask", last.tool.target, last.tool.name);
    return is("ask", "waiting on a prompt in its terminal");
  }
  if (phase === "working") {
    if (it.compacting) return is("quiet", "compacting the conversation…");
    if (last?.tool) return is("tool", last.tool.target, last.tool.name);
    if (last?.prompt) return is("prompt", last.prompt);
    return is("quiet", "thinking…");
  }
  if (last?.reply) return is("reply", last.reply);
  if (phase === "done") return is("quiet", "finished its turn");
  if (phase === "ended" || !it.live) return is("quiet", "not running");
  return is("quiet", "ready for a prompt");
}

/** "now", "40s", "12m", "3h", "2d" since an epoch-seconds instant. */
export function sinceText(at: number | null | undefined, nowSecs: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.floor(nowSecs - at));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
