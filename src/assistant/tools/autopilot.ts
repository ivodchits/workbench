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
import { generatedPlanText, MAX_PLAN_STEPS } from "../generatedPlan";
import { compact, findSession, projectArg, sessionArg, when } from "./read";
import { defineTool, type ToolContext } from "./registry";

/** Step log lines `autopilot_status` shows. */
const LOG_LINES = 12;
/** Decisions it shows, newest. */
const DECISION_LINES = 20;
/** Lines of the decisions log `show_autopilot_decisions` returns, newest. */
const LOG_FILE_LINES = 40;

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
    plan: a.planSource ? `${a.planPath} (Duck's, from ${a.planSource === "user" ? "the user's description" : "the session's work"}; outside the project)` : a.planPath,
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
    "Put one of the user's sessions on autopilot through a plan: each time it finishes a turn, the turn is reviewed against the plan; a finished step is followed by /compact (when due) and the user's \"continue the implementation\" / \"proceed to the next step\" (or a situational prompt). Small questions (the session's, or left open by a turn) are settled on their own, each recorded and announced to the user, so the work isn't blocked; only a serious one pauses the run with a question. It stops when the plan is done or the step limit is reached. You're told in a <workbench_event> when it pauses or stops, and when the user comes back, with the decisions made without them; each step shows in this thread.",
    "The plan is one of two: `plan`, a plan file's path (absolute, or relative to the session's folder); or `steps`, the steps themselves, from which you get a plan file of your own (marked as generated, kept in your data folder, never in the project; the run sends each step's text with its prompt and ticks the plan's progress itself). Give `steps` when the user describes the steps in words (`steps_from: user`), or when you worked them out from what the session is doing (`steps_from: session`). When the user didn't say where the steps come from, in this order: (1) look for a plan file (read_session shows the session's recent prompts; plans are usually Markdown under documentation/ or docs/); (2) else work out the steps the session is on from its transcript (read_session, summarize_session), its open todos and its recent commits (git_overview); (3) else, or when that's a guess, ask the user to name a plan file or describe the steps. Either way, confirm before starting: the file's path, or the steps you'll pass, each in a line.",
    "Bounds: `max_steps`, or `until_done`; `window` keeps it to a daily window (\"overnight only\": 22:00-07:00; started outside it, it waits for the start), and `until` ends it at a time; at either end it stops after the turn in progress. It also pauses on its own when the same step fails twice, when a turn runs far longer than usual and looks stuck, and near the subscription's limits (it carries on by itself after the reset). When the user comes back after a while away, you get one summary of every run.",
    "The checklist a finished step must meet is read from the plan's format (its Done when, tracker, As built notes, commits) unless `checklist` names one; a missed item is sent back to the session once.",
    "Permission prompts in the session stay under the trust policy; the project should be in live mode for the run to keep moving.",
  ].join(" "),
  schema: z.object({
    ...sessionArgs,
    plan: z.string().trim().min(1).max(1_000).optional().describe("The plan file's path; or give `steps` instead."),
    steps: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          details: z.string().trim().max(4_000).optional().describe("What the step involves, in the user's words where they gave them."),
          done_when: z.string().trim().max(500).optional().describe("How to tell it's done, when known."),
        }),
      )
      .min(1)
      .max(MAX_PLAN_STEPS)
      .optional()
      .describe("The plan's steps in order, when there's no plan file: you get a plan of your own from them."),
    plan_title: z.string().trim().max(120).optional().describe("A short title for a plan from `steps`."),
    steps_from: z
      .enum(["user", "session"])
      .optional()
      .describe("Where `steps` came from: `user` (default), the user's description; `session`, your reading of what the session is on."),
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
  describe({ session, project, plan, steps }, port) {
    const through = plan ?? `a plan of ${steps?.length ?? 0} step(s) Duck writes from ${steps?.length ? steps.map((s) => s.title).join("; ") : "nothing"}`;
    return `Run "${findSession(port, session, project).title}" on autopilot through ${through}`;
  },
  trust: ({ session, project }, port) => ({ projectId: findSession(port, session, project).projectId }),
  async run(
    {
      session,
      project,
      plan,
      steps,
      plan_title,
      steps_from,
      max_steps,
      until_done,
      window,
      until,
      checklist,
      compact: policy,
      fixed_prompts,
      prompts,
      notify_decisions,
    },
    ctx,
  ) {
    if (!plan === !steps?.length)
      throw new Error("Give `plan` (a plan file) or `steps` (the steps to make one from), one of the two.");
    const s = findSession(ctx.port, session, project);
    const at = Date.now();
    const generated = steps?.length
      ? {
          text: generatedPlanText({
            title: plan_title || `Autopilot plan for ${s.title}`,
            steps: steps.map((x) => ({ title: x.title, details: x.details, doneWhen: x.done_when })),
            source: steps_from ?? "user",
            session: s.title,
            at,
          }),
          source: steps_from ?? "user",
        }
      : undefined;
    const a = await manager(ctx).start({
      instanceId: s.id,
      threadId: ctx.threadId,
      planPath: plan ? planPathFor(plan, s.workingDir) : undefined,
      generated,
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

export const showAutopilotDecisions = defineTool({
  name: "show_autopilot_decisions",
  description:
    "Open a session's decisions log beside its console, for the user: every question, plan and permission prompt settled without them while the session was on autopilot (or handed to you), and each one left to them. Use it when the user asks what got decided on autopilot (\"show me what got decided\"), and offer it when you report a run's decisions. Without `session`, the session on autopilot (when there is one). `open: false` only reads it. Returns the log's latest lines.",
  schema: z.object({
    session: sessionArg.optional(),
    project: projectArg.optional(),
    open: z.boolean().optional().describe("Open the view for the user (default true); false only reads the log."),
  }),
  tier: "reversible",
  async run({ session, project, open }, ctx) {
    if (!ctx.decisions) throw new Error("The decisions log isn't available here.");
    let id: string;
    if (session) id = findSession(ctx.port, session, project).id;
    else {
      const all = ctx.autopilot?.list() ?? [];
      const live = all.filter((a) => a.state !== "stopped");
      if (live.length > 1)
        throw new Error(`${live.length} sessions are on autopilot: name one (${live.map((a) => `"${titleOf(ctx, a.instanceId)}"`).join(", ")}).`);
      const a = live[0] ?? all[0];
      if (!a) throw new Error("No session has been on autopilot: name the session.");
      id = a.instanceId;
    }
    const text = await ctx.decisions.read(id);
    const opened = open !== false;
    if (opened) ctx.port.openDecisionsLog(id);
    const lines = (text ?? "").split(/\r?\n/).filter((l) => l.startsWith("- ") || l.startsWith("## "));
    return compact({
      session: titleOf(ctx, id),
      opened,
      entries: lines.length ? lines.slice(-LOG_FILE_LINES) : "nothing logged for this session yet",
      earlier: lines.length > LOG_FILE_LINES ? `${lines.length - LOG_FILE_LINES} earlier line(s) are in the view` : null,
    });
  },
});

export const AUTOPILOT_TOOLS = [startAutopilot, autopilotStatus, pauseAutopilot, resumeAutopilot, stopAutopilot, showAutopilotDecisions];
