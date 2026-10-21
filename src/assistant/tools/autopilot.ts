// Duck's autopilot tools (steps P1, P2): run a session through a plan step by step,
// reviewing each turn, and stop when something needs the user, or by the run's own
// bounds (steps, "until done", a daily window, an end time). The loop is the
// autopilot manager's (`../autopilot.ts`); these tools check their input and say
// what happened.
//
// All `reversible`: the user asks for the run, it only sends the prompts they would
// (permission prompts stay under the trust policy), and pausing or stopping it is
// one call.

import { z } from "zod";

import {
  clock,
  clockAt,
  COMPACT_POLICIES,
  MAX_STEPS,
  nextAt,
  type Autopilot,
  type AutopilotManager,
  type RunWindow,
} from "../autopilot";
import { compact, findSession, projectArg, sessionArg, when } from "./read";
import { defineTool, type ToolContext } from "./registry";

/** Step log lines `autopilot_status` shows. */
const LOG_LINES = 12;
/** Decisions it shows, newest. */
const DECISION_LINES = 20;

function manager(ctx: ToolContext): AutopilotManager {
  if (!ctx.autopilot) throw new Error("Autopilot isn't available here.");
  return ctx.autopilot;
}

const sessionArgs = { session: sessionArg, project: projectArg.optional() };

/** A path relative to the session's folder made absolute. */
export function planPathFor(path: string, workingDir: string): string {
  const p = path.trim();
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return p;
  const sep = workingDir.includes("\\") ? "\\" : "/";
  return `${workingDir.replace(/[\\/]+$/, "")}${sep}${p.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep)}`;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "22:00" as minutes after midnight. */
export function minutesOf(text: string): number {
  const m = TIME.exec(text.trim());
  if (!m) throw new Error(`"${text}" isn't a time like 07:30 or 22:00.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "22:00-07:00" as a daily window. */
export function windowOf(text: string): RunWindow {
  const parts = text.split(/\s*[-–—]\s*|\s+to\s+/);
  if (parts.length !== 2) throw new Error(`"${text}" isn't a window like 22:00-07:00.`);
  const w = { from: minutesOf(parts[0]), to: minutesOf(parts[1]) };
  if (w.from === w.to) throw new Error("The window starts and ends at the same time.");
  return w;
}

/** An autopilot as the model reads it. */
function view(a: Autopilot, title: string, now = Date.now()) {
  return compact({
    session: title,
    id: a.instanceId,
    state: a.state,
    doing: a.state === "running" ? a.doing : null,
    plan: a.planPath,
    steps: a.untilDone ? `${a.stepsDone} done, until the plan is done` : `${a.stepsDone} done of at most ${a.maxSteps}`,
    window: a.window ? `${clock(a.window.from)}-${clock(a.window.to)}` : null,
    until: a.endsAt !== null ? clockAt(a.endsAt, now) : null,
    resumes: a.state === "paused" && a.resumeAt !== null ? clockAt(a.resumeAt, now) : null,
    checklist: a.checklist,
    onStep: a.step,
    lastStep: a.lastStep,
    why: a.why,
    question: a.question,
    compact: a.compactPolicy,
    prompts: a.situational ? `${a.continuePrompts.join(" / ")}, or the review's own` : a.continuePrompts.join(" / "),
    decisions: a.decisions.length
      ? a.decisions.slice(-DECISION_LINES).map((d) => `${d.stepId ? `[${d.stepId}] ` : ""}${d.question} → ${d.decision} (${d.why})${d.reported ? "" : " · not reported yet"}`)
      : null,
    log: a.log.slice(-LOG_LINES).map((e) => `${when(e.at, now)} · ${e.kind}${e.stepId ? ` ${e.stepId}` : ""}: ${e.summary}${e.prompt ? ` → "${e.prompt}"` : ""}`),
  });
}

const titleOf = (ctx: ToolContext, id: string) => ctx.port.listSessions().find((s) => s.id === id)?.title ?? id;

export const startAutopilot = defineTool({
  name: "start_autopilot",
  description: [
    "Put one of the user's sessions on autopilot through a written plan: each time it finishes a turn, the turn is reviewed against the plan; a finished step is followed by /compact (when due) and the user's \"continue the implementation\" / \"proceed to the next step\" (or a situational prompt). Small questions (the session's, or left open by a turn) are settled on their own, each recorded and announced to the user, so the work isn't blocked; only a serious one pauses the run with a question. It stops when the plan is done or the step limit is reached. You're told in a <workbench_event> when it pauses or stops, and when the user comes back, with the decisions made without them; each step shows in this thread.",
    "`plan` is the plan file's path (absolute, or relative to the session's folder). When the user didn't name it, find it first (read_session shows the session's recent prompts; plans are usually Markdown under documentation/ or docs/), and confirm it with the user before starting.",
    "Bounds: `max_steps`, or `until_done`; `window` keeps it to a daily window (\"overnight only\": 22:00-07:00; started outside it, it waits for the start), and `until` ends it at a time; at either end it stops after the turn in progress. It also pauses on its own when the same step fails twice, when a turn runs far longer than usual and looks stuck, and near the subscription's limits (it carries on by itself after the reset). When the user comes back after a while away, you get one summary of every run.",
    "The checklist a finished step must meet is read from the plan's format (its Done when, tracker, As built notes, commits) unless `checklist` names one; a missed item is sent back to the session once.",
    "Permission prompts in the session stay under the trust policy; the project should be in live mode for the run to keep moving.",
  ].join(" "),
  schema: z.object({
    ...sessionArgs,
    plan: z.string().trim().min(1).max(1_000),
    max_steps: z.number().int().min(1).max(MAX_STEPS).optional().describe("Steps before it stops (default 5)."),
    until_done: z.boolean().optional().describe("Run until the plan is done, however many steps."),
    window: z.string().trim().max(40).optional().describe("A daily window to run in, local time, e.g. \"22:00-07:00\"."),
    until: z.string().trim().max(10).optional().describe("Stop at this local time, e.g. \"18:00\" (the next time the clock reads it)."),
    checklist: z
      .array(z.string().trim().min(1).max(300))
      .max(10)
      .optional()
      .describe("What a finished step must include, when the user names it."),
    compact: z
      .enum(COMPACT_POLICIES)
      .optional()
      .describe("`review` (default): the review decides per step; `always` after every step; `never`."),
    fixed_prompts: z.boolean().optional().describe("Only ever the user's own phrasing, never a prompt the review writes."),
    prompts: z.array(z.string().trim().min(1).max(500)).max(5).optional().describe("The user's phrasings, when they give their own."),
    notify_decisions: z
      .boolean()
      .optional()
      .describe("Alert the user at each small decision made without them (default true); off, they hear them only in the digests."),
  }),
  tier: "reversible",
  timeoutMs: 15_000,
  describe({ session, project, plan }, port) {
    return `Run "${findSession(port, session, project).title}" on autopilot through ${plan}`;
  },
  trust: ({ session, project }, port) => ({ projectId: findSession(port, session, project).projectId }),
  async run(
    { session, project, plan, max_steps, until_done, window, until, checklist, compact: policy, fixed_prompts, prompts, notify_decisions },
    ctx,
  ) {
    const s = findSession(ctx.port, session, project);
    const at = Date.now();
    const a = await manager(ctx).start({
      instanceId: s.id,
      threadId: ctx.threadId,
      planPath: planPathFor(plan, s.workingDir),
      maxSteps: max_steps,
      compactPolicy: policy,
      situational: fixed_prompts === undefined ? undefined : !fixed_prompts,
      continuePrompts: prompts,
      notifyDecisions: notify_decisions,
      untilDone: until_done,
      window: window ? windowOf(window) : null,
      endsAt: until ? nextAt(minutesOf(until), at) : null,
      checklist,
    });
    return {
      ...view(a, s.title),
      next:
        a.state === "paused"
          ? (a.why ?? "it waits")
          : a.doing === "reviewing"
            ? "it's between turns, so its last turn is being reviewed now"
            : "the current turn's end is reviewed first",
    };
  },
});

export const autopilotStatus = defineTool({
  name: "autopilot_status",
  description:
    "The autopilot on a session (or every autopilot, without `session`): its state, the step it's on, why it paused or stopped, and its step log.",
  schema: z.object({ session: sessionArg.optional(), project: projectArg.optional() }),
  tier: "read",
  run({ session, project }, ctx) {
    const m = manager(ctx);
    if (!session) return { autopilots: m.list().map((a) => view(a, titleOf(ctx, a.instanceId))) };
    const s = findSession(ctx.port, session, project);
    const a = m.get(s.id);
    if (!a) return { session: s.title, autopilot: "none" };
    return view(a, s.title);
  },
});

export const pauseAutopilot = defineTool({
  name: "pause_autopilot",
  description:
    "Pause a session's autopilot: the current turn finishes, and nothing more is sent until it's resumed. A run waiting for a limit or its window stops waiting.",
  schema: z.object(sessionArgs),
  tier: "reversible",
  run({ session, project }, ctx) {
    const s = findSession(ctx.port, session, project);
    return view(manager(ctx).pause(s.id), s.title);
  },
});

export const resumeAutopilot = defineTool({
  name: "resume_autopilot",
  description:
    "Resume a paused autopilot. Pass the user's answer to its question as `prompt` and it goes into the session as the next turn; without one, a run waiting for the limits sends what it held back (if they allow it now), and otherwise the session's last turn is reviewed again (after the user sorted things out themselves). `steps` allows that many more steps from here.",
  schema: z.object({
    ...sessionArgs,
    prompt: z.string().trim().min(1).max(20_000).optional(),
    steps: z.number().int().min(1).max(MAX_STEPS).optional(),
  }),
  tier: "reversible",
  trust: (input, port) => ({
    projectId: findSession(port, input.session, input.project).projectId,
    texts: input.prompt ? [input.prompt] : [],
  }),
  async run({ session, project, prompt, steps }, ctx) {
    const s = findSession(ctx.port, session, project);
    return view(await manager(ctx).resume(s.id, { prompt, steps }), s.title);
  },
});

export const stopAutopilot = defineTool({
  name: "stop_autopilot",
  description: "Stop a session's autopilot for good (the session itself keeps running). Start a new run with start_autopilot.",
  schema: z.object(sessionArgs),
  tier: "reversible",
  run({ session, project }, ctx) {
    const s = findSession(ctx.port, session, project);
    return view(manager(ctx).stop(s.id), s.title);
  },
});

export const AUTOPILOT_TOOLS = [startAutopilot, autopilotStatus, pauseAutopilot, resumeAutopilot, stopAutopilot];
