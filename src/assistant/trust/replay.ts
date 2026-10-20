// The trust replay (step T2's done-when, in place of a day in shadow mode): the
// past week's Claude Code tool calls, read off the transcripts, through the policy
// for permission prompts, against what happened to them.
//
// A transcript doesn't say which calls prompted: most ran without asking under the
// permission mode or Claude Code's own rules. What it does say is which ones you
// rejected. So the report has two halves:
//   - every call you rejected, and what the policy would do with it: allowing one
//     is a disagreement, shown first;
//   - the calls that ran, and how many the policy would let through, ask about, or
//     refuse (a refusal of a call you let run is a rule to look at).
// The judge reads every rejected call and a sample of the rest, up to `judgeMax`
// calls (each ~$0.0005 on Haiku; a second opinion on Sonnet is rarer).

import type { ProjectRef } from "../port";
import type { Decision, TrustConfig } from "./decide";
import { judge, type JudgeCall } from "./judge";
import { decidePrompt, outside } from "./session";

/** One call, as `assistant_replay_calls` reads it. */
export interface ReplayCall {
  sessionId: string;
  cwd: string;
  ts: number;
  tool: string;
  input: Record<string, unknown>;
  outcome: "ran" | "rejected" | "denied" | "error" | "none";
  firstPrompt: string | null;
  lastPrompt: string | null;
  mode: string | null;
}

export type ReplayVerdict = "allow" | "ask" | "deny" | "unjudged";

export interface ReplayRow {
  call: ReplayCall;
  project: string | null;
  verdict: ReplayVerdict;
  layer: string;
  reason: string;
}

export interface ReplayReport {
  calls: number;
  /** Rows by what happened × what the policy would do. */
  counts: Record<"ran" | "rejected", Record<ReplayVerdict, number>>;
  judged: number;
  /** Rejected calls the policy would allow: the disagreements. */
  disagreements: ReplayRow[];
  /** Calls that ran which a rule would refuse. */
  refusedRan: ReplayRow[];
  /** Every rejected call, with the verdict. */
  rejected: ReplayRow[];
  /** A sample of the ran calls the policy would still ask about. */
  stillAsks: ReplayRow[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The project a session's folder is in (its root, or a worktree under it). */
export function projectOf(cwd: string, projects: readonly ProjectRef[]): ProjectRef | null {
  let best: ProjectRef | null = null;
  for (const p of projects) {
    if (p.remote || !p.rootPath) continue;
    if (outside(cwd, p.rootPath)) continue;
    if (!best || norm(p.rootPath).length > norm(best.rootPath).length) best = p;
  }
  return best;
}

/** Spread `n` picks evenly over `rows`. */
function sample<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)]);
}

export interface ReplayDeps {
  config: TrustConfig;
  projects: readonly ProjectRef[];
  judge: JudgeCall | null;
  judgeMax: number;
  home?: string;
  /** Hear progress (judged so far, of how many). */
  progress?: (done: number, of: number) => void;
}

export async function replay(calls: readonly ReplayCall[], deps: ReplayDeps): Promise<ReplayReport> {
  // Trust off or paused would decide nothing: replay the policy as if live.
  const config: TrustConfig = { ...deps.config, paused: false, modes: {}, tripped: [] };
  const rows: (ReplayRow & { pending: boolean })[] = [];
  for (const call of calls) {
    if (call.outcome !== "ran" && call.outcome !== "rejected") continue;
    const project = projectOf(call.cwd, deps.projects);
    const d = decidePrompt(
      {
        instanceId: call.sessionId,
        projectId: project?.id ?? "",
        tool: call.tool,
        input: call.input,
        // A live session's folder is its root (or worktree); the transcript's cwd
        // follows its `cd`s.
        root: project?.rootPath ?? call.cwd,
        home: deps.home,
      },
      config,
    ) as Decision | { outcome: "judge" };
    rows.push(
      d.outcome === "judge"
        ? { call, project: project?.name ?? null, verdict: "unjudged", layer: "judge", reason: "not judged", pending: true }
        : { call, project: project?.name ?? null, verdict: d.outcome, layer: d.layer, reason: d.reason, pending: false },
    );
  }

  const pending = rows.filter((r) => r.pending);
  const rejectedFirst = pending.filter((r) => r.call.outcome === "rejected");
  const toJudge = deps.judge
    ? [...rejectedFirst, ...sample(pending.filter((r) => r.call.outcome === "ran"), Math.max(0, deps.judgeMax - rejectedFirst.length))].slice(
        0,
        Math.max(deps.judgeMax, rejectedFirst.length),
      )
    : [];
  let judged = 0;
  for (const r of toJudge) {
    if (!r.call.firstPrompt && !r.call.lastPrompt) {
      Object.assign(r, { verdict: "ask", layer: "mandate", reason: "no prompt to judge it against" });
    } else {
      try {
        const j = await judge(
          {
            project: r.project ?? "(not a Workbench project)",
            root: r.call.cwd,
            mandate: r.call.firstPrompt ?? r.call.lastPrompt,
            lastPrompt: r.call.lastPrompt !== r.call.firstPrompt ? r.call.lastPrompt : null,
            tool: r.call.tool,
            input: r.call.input,
            nearby: [],
          },
          deps.judge!,
        );
        Object.assign(r, { verdict: j.outcome, reason: j.reason });
      } catch (e) {
        Object.assign(r, { verdict: "ask", reason: `the judge failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    judged++;
    deps.progress?.(judged, toJudge.length);
  }

  const counts: ReplayReport["counts"] = {
    ran: { allow: 0, ask: 0, deny: 0, unjudged: 0 },
    rejected: { allow: 0, ask: 0, deny: 0, unjudged: 0 },
  };
  for (const r of rows) counts[r.call.outcome as "ran" | "rejected"][r.verdict]++;
  const strip = (r: ReplayRow): ReplayRow => ({ call: r.call, project: r.project, verdict: r.verdict, layer: r.layer, reason: r.reason });
  const ran = rows.filter((r) => r.call.outcome === "ran");
  const rejected = rows.filter((r) => r.call.outcome === "rejected");
  return {
    calls: rows.length,
    counts,
    judged,
    disagreements: rejected.filter((r) => r.verdict === "allow").map(strip),
    refusedRan: ran.filter((r) => r.verdict === "deny").map(strip),
    rejected: rejected.map(strip),
    stillAsks: sample(ran.filter((r) => r.verdict === "ask"), 30).map(strip),
  };
}
