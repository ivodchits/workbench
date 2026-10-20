// Duck's worker tools (step D1): hand a heavy task to a Claude Code session on the
// subscription, follow it, and close it. The work is the task manager's
// (`../tasks.ts`); these tools only check their input and say what happened.
//
// Starting, following up and closing a task are `reversible`: the worker runs in
// Duck's own workspace under `dontAsk` (or, for code, in a worktree under the
// project's own mode and the trust policy), and closing keeps everything on disk.

import { z } from "zod";

import { SESSION_MODELS, EFFORTS } from "../../util/models";
import { TIERS } from "../settings";
import { isFinished, TASK_KINDS, TASK_STATES, type Task, type TaskManager } from "../tasks";
import { compact, findProject, projectArg } from "./read";
import { defineTool, type ToolContext } from "./registry";

/** How much of a running worker's last reply `task_status` shows. */
const PROGRESS_CHARS = 1500;

function manager(ctx: ToolContext): TaskManager {
  if (!ctx.tasks) throw new Error("Worker tasks aren't available here.");
  return ctx.tasks;
}

const taskArg = z.string().trim().min(1).describe("The task's id from run_task or list_tasks (or its exact title).");

function findTask(tasks: TaskManager, ref: string): Task {
  const byId = tasks.get(ref);
  if (byId) return byId;
  const named = tasks.list().filter((t) => t.title.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0];
  throw new Error(
    named.length > 1
      ? `${named.length} tasks are called "${ref}": give the id (list_tasks).`
      : `There is no task "${ref}". list_tasks shows them.`,
  );
}

const minutes = (from: number | null, to: number | null) =>
  from === null ? null : Math.max(0, Math.round(((to ?? Date.now()) - from) / 60_000));

/** A task as the model reads it. */
function view(t: Task) {
  return compact({
    id: t.id,
    title: t.title,
    state: t.state,
    kind: t.kind,
    worker: `${t.model} · ${t.effort} (${t.tier})`,
    session: t.instanceId,
    folder: t.folder,
    minutes: minutes(t.started, t.finished),
    headline: t.headline,
    question: t.question,
    from: t.resultFrom === "reply" ? "its last reply (no result files)" : null,
    error: t.error,
  });
}

export const runTask = defineTool({
  name: "run_task",
  description: [
    "Hand a heavy task to a worker: a Claude Code session on the user's subscription (no API cost), in Duck's own workspace, or for code in the project's own git worktree. Use it for research needing more than one or two lookups, comparisons, analyses, plans, reviews, writing longer than a few paragraphs, browser chores, and anything that produces code or a professional deliverable.",
    "It returns at once with a task id and shows a card in the thread; when the worker finishes you get a <workbench_event> with its headline, and then you tell the user. Don't wait or poll.",
    "Write `brief` as a complete brief for someone who hasn't seen this conversation: the goal, what to look at, constraints, and what a good answer contains.",
    "Tier: `standard` (the default: single-topic research, short write-ups, chores), `involved` (multi-source comparisons, longer documents, analysis over several inputs), `serious` (high-stakes decisions, architecture, code, anything the user calls important or deep). \"quick\" moves one tier down; \"thoroughly\" / «подробно» one up; \"this is serious\" / «это важно» means serious. Pass `model` / `effort` only when the user names them.",
    "`kind`: research, writing, analysis, browser (keeps the user's Firefox tools), or code (needs `project`). A few run at once; more wait for a free worker.",
  ].join(" "),
  schema: z.object({
    title: z.string().trim().min(1).max(80).describe("A short name for the task, shown on its card."),
    brief: z.string().trim().min(1).max(20_000),
    kind: z.enum(TASK_KINDS),
    tier: z.enum(TIERS).default("standard"),
    project: projectArg.optional().describe("The project a code task works in."),
    model: z.enum(SESSION_MODELS).optional(),
    effort: z.enum(EFFORTS).optional(),
  }),
  tier: "reversible",
  // Making the folder and starting the console; the work itself is reported later.
  timeoutMs: 30_000,
  describe({ title, kind, tier }) {
    return `Start a ${tier} ${kind} worker: ${title}`;
  },
  trust: (input, port) => ({
    projectId: input.kind === "code" && input.project ? findProject(port, input.project).id : null,
    texts: [input.title, input.brief],
  }),
  async run({ title, brief, kind, tier, project, model, effort }, ctx) {
    const tasks = manager(ctx);
    if (kind === "code" && !project) throw new Error("A code task needs `project`.");
    const projectId = kind === "code" && project ? findProject(ctx.port, project).id : undefined;
    const t = await tasks.run({
      threadId: ctx.threadId,
      title,
      brief,
      kind,
      tier,
      model,
      effort,
      projectId,
      mandate: ctx.request ? { text: ctx.request, threadId: ctx.threadId } : undefined,
    });
    await ctx.notice({ kind: "task", text: `Task: ${t.title}`, task: { id: t.id } });
    const running = tasks.list().filter((x) => x.state === "running").length;
    return {
      ...view(t),
      next:
        t.state === "queued"
          ? `waiting for a free worker (${running} running); it starts by itself`
          : t.state === "running"
            ? "started; you'll get a <workbench_event> when it's done"
            : `it didn't start: ${t.error ?? t.state}`,
    };
  },
});

export const taskStatus = defineTool({
  name: "task_status",
  description:
    "How a worker task is going: its state, how long it has run, and its outcome once it has one. With `progress`, also the start of the worker's latest reply, to say what it's doing (read it and summarize; don't paste it).",
  schema: z.object({ task: taskArg, progress: z.boolean().default(false) }),
  tier: "read",
  async run({ task, progress }, ctx) {
    const t = findTask(manager(ctx), task);
    const s = t.instanceId ? ctx.port.listSessions().find((x) => x.id === t.instanceId) : undefined;
    let latest: string | null = null;
    if (progress && t.instanceId) {
      const reply = await ctx.port.lastResponse(t.instanceId).catch(() => null);
      latest = reply ? (reply.length > PROGRESS_CHARS ? `${reply.slice(0, PROGRESS_CHARS)}…` : reply) : null;
    }
    return compact({ ...view(t), sessionPhase: s?.phase ?? null, latestReply: latest });
  },
});

export const taskFollowup = defineTool({
  name: "task_followup",
  description:
    "Send a follow-up into a worker task's own session (it keeps its context): \"dig into option 2\", the answer to its question, or a re-run one tier up (\"go deeper, at high effort\"). The task runs again and you're told when its result is updated.",
  schema: z.object({ task: taskArg, prompt: z.string().trim().min(1).max(20_000) }),
  tier: "reversible",
  trust: (input) => ({ projectId: null, texts: [input.prompt] }),
  async run({ task, prompt }, ctx) {
    const tasks = manager(ctx);
    const t = findTask(tasks, task);
    const delivery = await tasks.followup(t.id, prompt);
    return { ...view(tasks.get(t.id)!), delivery };
  },
});

export const taskClose = defineTool({
  name: "task_close",
  description:
    "Close a worker task: its console closes, and its folder, result and transcript stay (the session can be resumed from the rail). A task still waiting for a worker never starts. Use it when the user is done with a task.",
  schema: z.object({ task: taskArg }),
  tier: "reversible",
  async run({ task }, ctx) {
    const tasks = manager(ctx);
    return view(await tasks.close(findTask(tasks, task).id));
  },
});

export const listTasks = defineTool({
  name: "list_tasks",
  description: "Duck's worker tasks, newest first: running, waiting, and finished ones with their headlines.",
  schema: z.object({
    state: z.enum([...TASK_STATES, "open"]).optional().describe("Only these; `open` = queued or running."),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  tier: "read",
  run({ state, limit }, ctx) {
    const all = manager(ctx).list();
    const kept = all.filter((t) => !state || (state === "open" ? !isFinished(t.state) : t.state === state));
    return { tasks: kept.slice(0, limit).map(view), more: Math.max(0, kept.length - limit) };
  },
});

export const TASK_TOOLS = [runTask, taskStatus, taskFollowup, taskClose, listTasks];
