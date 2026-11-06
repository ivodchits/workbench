// The autopilot decisions log: one Markdown file per session (in the app's data
// folder, `decisions_log.rs`) with a short line for everything Duck settled for a
// session on autopilot or one handed to it (`delegated`), and for each thing it left
// to you instead. The step log and the digests say the same in passing; this file is
// the one place to read it all afterwards.
//
// Written from:
// - `autopilot.ts`: the run's start and end, the questions it settled (mid-turn, or
//   left open by a turn and settled by the review), a question asked in plain text at
//   the end of a turn that the run went on past, a plan approval or a question it
//   can't answer (put to you), and every pause;
// - `index.ts`: the trust store's decision rows for those sessions (permission
//   prompts the trust watcher approved or refused, and T3's delegated answers and
//   plan approvals), through `trustEntry`;
// - `answer_choice` (`tools/act.ts`): an answer Duck gave in its thread.
//
// Shown by the console header's "decisions" button and `show_autopilot_decisions`.
// The weekly housekeeping removes a file once it hasn't changed for a week.

import type { DecisionRow } from "../ipc/assistant";
import { decisionsLogAppend, decisionsLogPrune, decisionsLogRead } from "../ipc/assistant";

export type DecisionKind =
  /** A question the session asked (AskUserQuestion). */
  | "question"
  /** A small question a turn left open, settled by the autopilot's review. */
  | "open question"
  /** A question in the text at the end of a turn, which the run went on past. */
  | "turn-end question"
  | "plan"
  | "permission"
  /** Put to the user (or to Duck's thread) instead of decided. */
  | "left to you"
  /** The run itself: paused, stopped. */
  | "run";

export interface LoggedDecision {
  instanceId: string;
  /** The session's title, for the file's header. */
  session: string;
  kind: DecisionKind;
  /** The plan's step, when an autopilot knows it. */
  step?: string | null;
  asked: string;
  decided: string;
  why?: string | null;
}

export interface DecisionsLogBackend {
  append(instanceId: string, header: string, text: string): Promise<void>;
  read(instanceId: string): Promise<string | null>;
  prune(): Promise<number>;
}

export const ipcDecisionsLogBackend: DecisionsLogBackend = {
  append: decisionsLogAppend,
  read: decisionsLogRead,
  prune: decisionsLogPrune,
};

export interface DecisionsLog {
  /** One line in the session's log. */
  record(e: LoggedDecision): Promise<void>;
  /** A heading in the session's log (an autopilot run starting). */
  heading(instanceId: string, session: string, text: string): Promise<void>;
  read(instanceId: string): Promise<string | null>;
  /** Remove the logs unchanged for a week; how many went. */
  prune(): Promise<number>;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-06 14:20", local. */
export function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function headerFor(session: string, instanceId: string): string {
  return `# Decisions on "${oneLine(session, 120)}"\n\nSession ${instanceId}. What Duck settled without you while the session was on autopilot or handed to it, and what it left to you.`;
}

/** The entry's line: when, what kind, what was asked, what was decided, why. */
export function entryLine(e: LoggedDecision, at: number): string {
  const step = e.step?.trim() ? `[${oneLine(e.step, 40)}] ` : "";
  const why = e.why?.trim() ? ` (${oneLine(e.why, 300).replace(/\.$/, "")})` : "";
  return `- ${stamp(at)} · ${e.kind} · ${step}${oneLine(e.asked, 400)} → **${oneLine(e.decided, 200)}**${why}`;
}

export function createDecisionsLog(deps: {
  backend: DecisionsLogBackend;
  now?: () => number;
  /** A session's log changed (the open panel reads it again). */
  changed?: (instanceId: string) => void;
}): DecisionsLog {
  const now = deps.now ?? Date.now;
  /** Writes per session, in order. */
  const queue = new Map<string, Promise<void>>();

  function write(instanceId: string, session: string, text: string): Promise<void> {
    const prev = queue.get(instanceId) ?? Promise.resolve();
    const next = prev
      .then(() => deps.backend.append(instanceId, headerFor(session, instanceId), text))
      .then(() => deps.changed?.(instanceId))
      .catch((e: unknown) => console.warn("duck: a line of the decisions log wasn't written", e));
    queue.set(instanceId, next);
    void next.finally(() => {
      if (queue.get(instanceId) === next) queue.delete(instanceId);
    });
    return next;
  }

  return {
    record: (e) => write(e.instanceId, e.session, entryLine(e, now())),
    heading: (instanceId, session, text) => write(instanceId, session, `\n## ${stamp(now())} · ${oneLine(text, 300)}\n`),
    read: (id) => deps.backend.read(id),
    prune: () => deps.backend.prune(),
  };
}

/** The session a trust row is about (`session:<id>`), or null for one of Duck's own
 *  tool calls. */
export function sessionOfRow(row: Pick<DecisionRow, "threadId">): string | null {
  return row.threadId.startsWith("session:") ? row.threadId.slice("session:".length) : null;
}

/**
 * A trust row (T2's permission prompts, T3's delegated answers and plan reviews) as
 * a log entry, or null when it isn't one: only logged ("shadow"), or closed before
 * the decision landed ("superseded"). An `ask` is a prompt left to you.
 */
export function trustEntry(row: Omit<DecisionRow, "id">, session: string): LoggedDecision | null {
  const instanceId = sessionOfRow(row);
  if (!instanceId || row.shadow || row.layer === "superseded") return null;
  // The row's summary is "<title> · <what>".
  const what = row.summary.startsWith(`${session} · `) ? row.summary.slice(session.length + 3) : row.summary;
  const base = { instanceId, session, why: row.reason };
  if (row.layer === "delegated") {
    const [asked, answer] = what.replace(/^asks: /, "").split(" → ");
    return row.decision === "ask"
      ? { ...base, kind: "left to you", asked, decided: "left to you" }
      : { ...base, kind: "question", asked, decided: answer ?? "answered" };
  }
  if (row.layer === "plan-review")
    return row.decision === "ask"
      ? { ...base, kind: "left to you", asked: "approve its plan", decided: "left to you" }
      : { ...base, kind: "plan", asked: "approve its plan", decided: "approved (edits still ask)" };
  if (row.decision === "ask") return { ...base, kind: "left to you", asked: what, decided: "left to you" };
  return { ...base, kind: "permission", asked: what, decided: row.decision === "allow" ? "allowed" : "refused" };
}
