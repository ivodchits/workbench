// Worker tasks (step D1): Duck hands a heavy task to a Claude Code session on your
// subscription and gets a reliable result back.
//
// A task is a folder in Duck's workspace (`tasks/<date>-<slug>/brief.md`, made by the
// backend) and a session working on it: in the workspace (project "Duck", mode
// `dontAsk` with the workspace's allow list), or for code in the target project's
// worktree. Its tier picks the model and effort. The worker finishes by writing
// `result.json` + `result.md` in the folder; Duck reads those, not the scrollback.
//
// - At most `maxWorkers` run at once; the rest wait in order and start as one ends.
// - A turn that ends without a fresh, valid `result.json` gets one nudge ("write the
//   result files"); after that the last reply stands in for the result.
// - Every outcome is posted into the thread that asked, as a Workbench event, so Duck
//   reports without being asked. So is a worker waiting on a prompt: workers don't
//   ping you (`setDuckTask`), Duck does.
// - Records persist in duck.db (`assistant_tasks`); a task that was running when the
//   app quit is checked again at start.
// - Subscription limits (step D2): a task is about to start while the 5-hour window
//   is at 70% or the week at 80%, so it runs as an **API worker** instead
//   (`apiWorker.ts`): the same brief and result files, on Duck's credits, its cost on
//   the card. Code tasks still take a session (an API worker has no files to work
//   on), with a word to the thread. Past Duck's own API soft limit too, the task
//   waits until the window that's over resets.
// - Headless (step D4, on by default): a session's worker is `claude -p` over
//   stream-json, with no terminal. Everything above works on it as on a terminal
//   session: the port routes its prompts, answers and interrupts over the protocol.
// - Tidying up (2026-10-20), checked every minute (`tidy`):
//   - A finished task's worker process is stopped once it has been idle for
//     `workerIdleStopMinutes` (default 30). Idle is counted from the later of the
//     result and the session's last activity, so a worker you talk to yourself isn't
//     stopped under you. A follow-up then resumes its session.
//   - After `closeFinishedHours` (default 24) the task is closed. Its session leaves
//     the rail, except one with a worktree, which would be left on disk. Its folder,
//     result and transcript stay, and the tasks view still lists it.
//   - A task that is blocked or needs a decision is left alone: it's waiting on you.

import { z } from "zod";

import {
  taskFolder,
  taskList,
  taskPut,
  taskResult,
  taskWriteResult,
  workspacePrepare,
  type TaskResultFiles,
} from "../ipc/assistant";
import { runApiWorker, type ApiWorkerOutcome } from "./apiWorker";
import { choiceLine } from "./tools/read";
import type { Mandate, PromptDelivery, SessionPhase, WorkbenchPort } from "./port";
import type { DuckSettings, Tier } from "./settings";
import type { Level } from "./announce";

export const TASK_KINDS = ["research", "writing", "browser", "analysis", "code"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** `queued` waits for a slot; `running` has a session working on it; the rest are
 *  outcomes (`done` / `blocked` / `needs_decision` from the result, `failed` when it
 *  couldn't start or its session ended without one, `closed` by Duck or you). */
export const TASK_STATES = [
  "queued",
  "running",
  "done",
  "blocked",
  "needs_decision",
  "failed",
  "closed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const Task = z.object({
  id: z.string(),
  threadId: z.string(),
  title: z.string(),
  kind: z.enum(TASK_KINDS),
  tier: z.enum(["standard", "involved", "serious"]),
  model: z.string(),
  effort: z.string(),
  /** Where it runs: the Duck project, or the target project for code. Null until
   *  it starts (except code, which names it from the start). */
  projectId: z.string().nullable(),
  workspace: z.string(),
  folder: z.string(),
  instanceId: z.string().nullable(),
  state: z.enum(TASK_STATES),
  created: z.number(),
  started: z.number().nullable(),
  /** When the current run began (the first prompt, or the latest follow-up): an
   *  older `result.json` is a previous run's. */
  runStarted: z.number().nullable(),
  finished: z.number().nullable(),
  headline: z.string().nullable(),
  question: z.string().nullable(),
  /** Where the outcome came from: the result file, or the last reply. */
  resultFrom: z.enum(["file", "reply"]).nullable(),
  nudged: z.boolean(),
  error: z.string().nullable(),
  /** The user's request in the thread (the session's mandate, for T2's judge). */
  mandate: z.string().nullable(),
  // Step D2 (records from before it get the defaults).
  /** The brief as Duck wrote it (also in `brief.md`): an API worker's input, and a
   *  re-run's. */
  brief: z.string().default(""),
  /** What it runs on: a Claude Code session, or the API (over the subscription's
   *  limits). */
  runner: z.enum(["session", "api"]).default("session"),
  /** Why it runs there or waits ("weekly limit at 85%"); null for the usual. */
  why: z.string().nullable().default(null),
  /** An API worker's cost so far, by the card's estimate. */
  costUsd: z.number().nullable().default(null),
  /** A queued task waiting for a limit to reset doesn't start before this. */
  notBefore: z.number().nullable().default(null),
  /** Its worker runs headless (step D4), so a relaunch (a follow-up after a
   *  restart) is headless too. */
  headless: z.boolean().default(false),
  /** The worker's questions Duck answered, and why (step D2). */
  answers: z
    .array(z.object({ question: z.string(), answer: z.string(), reason: z.string(), at: z.number() }))
    .default([]),
});
export type Task = z.infer<typeof Task>;

/** The subscription's use (percent) past which a task runs as an API worker. */
export const LIMITS = { fiveHour: 70, sevenDay: 80 };
/** How long a task waiting on limits waits before they're read again, when the
 *  reset time isn't known (or is further off). */
export const LIMIT_RECHECK_MS = 15 * 60_000;

/** The worker's `result.json`. */
export const TaskResult = z.object({
  status: z.enum(["done", "blocked", "needs_decision"]),
  headline: z.string().trim().min(1).max(2000),
  question: z.string().max(4000).nullish(),
});

export interface TaskBackend {
  /** Make the workspace (`dir`, else the default); returns its path. */
  prepare(dir: string | null): Promise<string>;
  newFolder(workspace: string, date: string, title: string, brief: string): Promise<string>;
  result(workspace: string, folder: string): Promise<TaskResultFiles>;
  writeResult(workspace: string, folder: string, md: string, json: string): Promise<void>;
  put(task: Task): Promise<void>;
  list(): Promise<Task[]>;
}

/** How many records are loaded at start. */
const LOAD_LIMIT = 200;

export const ipcTaskBackend: TaskBackend = {
  prepare: workspacePrepare,
  newFolder: taskFolder,
  result: taskResult,
  writeResult: taskWriteResult,
  put: (t) => taskPut(t.id, JSON.stringify(t)),
  async list() {
    const rows = await taskList(LOAD_LIMIT);
    return rows.flatMap((r) => {
      try {
        const t = Task.safeParse(JSON.parse(r));
        return t.success ? [t.data] : [];
      } catch {
        return [];
      }
    });
  },
};

export interface RunRequest {
  threadId: string;
  title: string;
  brief: string;
  kind: TaskKind;
  tier: Tier;
  /** Override the tier's. */
  model?: string;
  effort?: string;
  /** The project a code task works in. */
  projectId?: string;
  mandate?: Mandate;
}

/** How often finished tasks are checked for tidying up. */
export const TIDY_EVERY_MS = 60_000;

export interface TaskManager {
  /** Read the stored tasks and pick up the ones that were running. */
  load(): Promise<void>;
  /** Stop idle finished workers and close old finished tasks (every minute; the
   *  tests call it). */
  tidy(): Promise<void>;
  run(req: RunRequest): Promise<Task>;
  /** A follow-up prompt into the task's session; it runs again until its next
   *  result. */
  followup(id: string, prompt: string): Promise<PromptDelivery>;
  /** Close the task's console (everything stays on disk); a queued task never
   *  starts. */
  close(id: string): Promise<Task>;
  /** Run the task again from its brief as a new task at `tier` (one up when
   *  absent), and close this one. */
  rerun(id: string, tier?: Tier): Promise<Task>;
  /** The task whose worker runs in this session, if any. */
  byInstance(instanceId: string): Task | undefined;
  /** Record Duck's answer to its worker's question, for the card. */
  noteAnswer(instanceId: string, a: { question: string; answer: string; reason: string }): void;
  get(id: string): Task | undefined;
  /** Newest first. */
  list(): Task[];
  /** Hear every change to any task; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

export interface TaskDeps {
  port: WorkbenchPort;
  backend: TaskBackend;
  settings: () => DuckSettings;
  /** Post a Workbench event into a thread (it starts a turn there); `level` is how
   *  its news is announced (V5), report when absent. */
  tell: (threadId: string, text: string, level?: Level) => void;
  now?: () => number;
  newId?: () => string;
  /** Local date `YYYY-MM-DD`, for the folder name. */
  today?: () => string;
  /** Run a task on the API (`runApiWorker`); fakes in tests. */
  apiWorker?: (t: Task, brief: string, signal: AbortSignal, onCost: (usd: number) => void) => Promise<ApiWorkerOutcome>;
}

/** The tier above `t` (serious stays serious). */
export const tierUp = (t: Tier): Tier => (t === "standard" ? "involved" : "serious");

/** The prompt that asks for the result files again (once). */
export const NUDGE =
  "You haven't written the result files yet. Write result.md and result.json in the task folder now, as the brief says, even if the task is unfinished (use status \"blocked\" or \"needs_decision\" then).";

const CONTRACT = (folder: string) => `When you're done, write two files in ${folder}:
1. result.md: a one-line headline first, then the findings, sources (URLs or file paths), open questions and a suggested next step.
2. result.json, exactly: {"status": "done" | "blocked" | "needs_decision", "headline": "<one sentence>", "question": "<for the user>" or null}. "blocked" when something outside your control stopped you; "needs_decision" when the user has to choose first.
Don't ask the user anything interactively: put questions in result.json.`;

/** The worker's first prompt: where the brief is, and the result contract. */
export function firstPrompt(t: Pick<Task, "folder" | "kind">): string {
  const where =
    t.kind === "code"
      ? "Work in this project (a git worktree of its own). Commit nothing unless the brief asks, and never push."
      : "Work only inside this workspace.";
  return `Read ${t.folder}\\brief.md and do the task it describes. ${where}\n\n${CONTRACT(t.folder)}`;
}

/** The text of `brief.md`. */
export function briefText(r: Pick<RunRequest, "title" | "brief" | "kind">, tier: string): string {
  return `# ${r.title}\n\n_${r.kind} · ${tier} · from Duck_\n\n${r.brief.trim()}\n`;
}

/** A task's model and effort: its tier's, unless the request names them. */
export function tierOf(settings: DuckSettings, tier: Tier, model?: string, effort?: string) {
  const t = settings.tiers[tier];
  return { model: model ?? t.model, effort: effort ?? t.effort };
}

const localDate = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A result file written during the current run (a second of slack for clocks). */
const fresh = (files: TaskResultFiles, t: Task) =>
  files.json !== null && (files.jsonModified ?? 0) >= (t.runStarted ?? 0) - 1000;

/** Parse `result.json`; null when it isn't one. */
export function parseResult(json: string | null): z.infer<typeof TaskResult> | null {
  if (!json) return null;
  try {
    const r = TaskResult.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A reply's first line with text, cut for a headline. */
function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>*\s-]+/, "").trim()).find(Boolean) ?? "";
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

const OUTCOMES: TaskState[] = ["done", "blocked", "needs_decision", "failed", "closed"];
export const isFinished = (s: TaskState) => OUTCOMES.includes(s);

export function createTaskManager(deps: TaskDeps): TaskManager {
  const { port, backend } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const today = deps.today ?? localDate;
  const tasks = new Map<string, Task>();
  const listeners = new Set<() => void>();
  /** Prompts already reported per task, so one prompt is told once. */
  const told = new Map<string, string>();
  /** Tasks whose turn end is being checked (a second `done` waits for it). */
  const checking = new Set<string>();

  const changed = () => {
    for (const l of listeners) l();
  };

  function save(t: Task): Task {
    tasks.set(t.id, t);
    void backend.put(t).catch((e: unknown) => console.warn("duck: a task wasn't stored", e));
    changed();
    return t;
  }

  const update = (id: string, patch: Partial<Task>): Task => {
    const t = tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    return save({ ...t, ...patch });
  };

  const byInstance = (instanceId: string) => [...tasks.values()].find((t) => t.instanceId === instanceId);
  const label = (t: Task) => `"${t.title}" (task ${t.id})`;

  // ── the queue ──

  /** Each task's start while its session is being made. */
  const starting = new Map<string, Promise<void>>();

  /** Start queued tasks while slots are free. `start` takes its slot before its
   *  first await, so this never starts more than the limit; resolves once these
   *  starts are done. */
  function pump(): Promise<void> {
    const started: Promise<void>[] = [];
    for (;;) {
      const all = [...tasks.values()];
      if (all.filter((t) => t.state === "running").length >= deps.settings().maxWorkers) break;
      const ready = (t: Task) => t.state === "queued" && (t.notBefore ?? 0) <= now();
      const next = all.filter(ready).sort((a, b) => a.created - b.created)[0];
      if (!next) break;
      const p = start(next).finally(() => starting.delete(next.id));
      starting.set(next.id, p);
      started.push(p);
    }
    return Promise.all(started).then(() => {});
  }

  /** The Duck project, made once even when workers start side by side. */
  let duckProject: Promise<string> | null = null;
  const duckProjectId = (workspace: string) => {
    duckProject ??= port.ensureProject("Duck", workspace).then(
      (p) => p.id,
      (e: unknown) => {
        duckProject = null;
        throw e;
      },
    );
    return duckProject;
  };

  /** The timer that starts tasks waiting on a limit, when it may have reset. */
  let wake: ReturnType<typeof setTimeout> | null = null;
  function wakeAt(at: number): void {
    const next = [...tasks.values()].filter((t) => t.state === "queued" && t.notBefore);
    const soonest = Math.min(at, ...next.map((t) => t.notBefore!));
    if (wake) clearTimeout(wake);
    wake = setTimeout(() => {
      wake = null;
      void pump();
    }, Math.max(0, soonest - now()));
  }

  /** Where a task about to start runs: a session, the API, or nowhere yet (and
   *  until when). */
  async function route(t: Task): Promise<{ runner: "session" | "api"; why: string | null } | { until: number; why: string }> {
    const l = await port.usageLimits().catch(() => null);
    const over: string[] = [];
    const resets: number[] = [];
    if (l?.fiveHour && l.fiveHour.usedPercentage >= LIMITS.fiveHour) {
      over.push(`the 5-hour limit is at ${Math.round(l.fiveHour.usedPercentage)}%`);
      resets.push(l.fiveHour.resetsAt * 1000);
    }
    if (l?.sevenDay && l.sevenDay.usedPercentage >= LIMITS.sevenDay) {
      over.push(`the weekly limit is at ${Math.round(l.sevenDay.usedPercentage)}%`);
      resets.push(l.sevenDay.resetsAt * 1000);
    }
    if (over.length === 0) return { runner: "session", why: null };
    const why = over.join(" and ");
    if (t.kind === "code") return { runner: "session", why };
    const spend = await port.spend().catch(() => null);
    if (spend?.softReached || spend?.capReached) {
      // The latest reset of the windows that are over, but read again within a while.
      const until = Math.min(Math.max(...resets), now() + LIMIT_RECHECK_MS);
      return { until: Math.max(until, now() + 60_000), why: `${why}, and Duck's API budget is past its soft limit` };
    }
    return { runner: "api", why };
  }

  /** Abort handles of API workers running. */
  const apiRuns = new Map<string, AbortController>();
  const apiWorker = deps.apiWorker ?? ((t, brief, signal, onCost) => runApiWorker(t, brief, undefined, signal, onCost));

  /** Run a task as an API worker on `brief`. */
  function startApi(id: string, brief: string, why: string | null): void {
    const t = update(id, { runner: "api", why, runStarted: now(), costUsd: tasks.get(id)?.costUsd ?? 0 });
    const ctl = new AbortController();
    apiRuns.get(id)?.abort();
    apiRuns.set(id, ctl);
    const base = t.costUsd ?? 0;
    void apiWorker(t, brief, ctl.signal, (usd) => {
      if (!ctl.signal.aborted) update(id, { costUsd: base + usd });
    })
      .then(async (o) => {
        if (ctl.signal.aborted || tasks.get(id)?.state !== "running") return;
        const r = o.result;
        await backend.writeResult(t.workspace, t.folder, r.markdown, JSON.stringify({ status: r.status, headline: r.headline, question: r.question }));
        finish(id, { state: r.status, headline: r.headline, question: r.question, resultFrom: "file", costUsd: base + o.costUsd });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted || tasks.get(id)?.state !== "running") return;
        finish(id, { state: "failed", error: `The API worker failed: ${errorText(e)}.` });
      })
      .finally(() => {
        if (apiRuns.get(id) === ctl) apiRuns.delete(id);
      });
  }

  async function start(t: Task): Promise<void> {
    // Running before the await, so the slot is taken while the session starts.
    update(t.id, { state: "running", started: now(), runStarted: now(), notBefore: null });
    const where = await route(t);
    if ("until" in where) {
      const first = tasks.get(t.id)?.why !== where.why;
      update(t.id, { state: "queued", started: null, runStarted: null, notBefore: where.until, why: where.why });
      if (first)
        deps.tell(
          t.threadId,
          `Task ${label(t)} is waiting: ${where.why}. It starts by itself once there's room (checked again ${new Date(where.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}). Tell the user.`,
          "info",
        );
      wakeAt(where.until);
      return;
    }
    if (where.runner === "api") {
      startApi(t.id, t.brief, `over subscription limit: ${where.why}`);
      return;
    }
    const headless = deps.settings().headlessWorkers;
    update(t.id, { runner: "session", why: where.why, headless });
    if (where.why)
      deps.tell(t.threadId, `Task ${label(t)} is a code task, so it runs in a session although ${where.why}. Mention it to the user.`, "info");
    try {
      const projectId = t.kind === "code" ? t.projectId! : await duckProjectId(t.workspace);
      const made = await port.createSession({
        projectId,
        title: t.title,
        prompt: firstPrompt(t),
        worktree: t.kind === "code",
        model: t.model,
        mandate: t.mandate ? { text: t.mandate, threadId: t.threadId } : undefined,
        worker: { workspace: t.workspace, folder: t.folder, effort: t.effort, kind: t.kind },
        // Duck made the workspace; a project of yours was trusted when you added it.
        trustFolder: t.kind !== "code",
        headless,
      });
      port.setDuckTask(made.id, t.title);
      // The clock starts once the prompt is on its way.
      update(t.id, { instanceId: made.id, projectId, runStarted: now() });
      if (made.message) deps.tell(t.threadId, `Task ${label(t)} started with a warning: ${made.message}`, "info");
    } catch (e) {
      finish(t.id, { state: "failed", error: `It couldn't start: ${errorText(e)}` });
    }
  }

  /** Record an outcome, tell the thread, and start the next task. */
  function finish(id: string, patch: Partial<Task> & { state: TaskState }): void {
    const t = update(id, { finished: now(), ...patch });
    if (t.state !== "closed")
      deps.tell(t.threadId, report(t), t.state === "needs_decision" || t.state === "blocked" ? "needs_you" : "report");
    void pump();
  }

  function report(t: Task): string {
    const where = `${t.folder}\\result.md`;
    const api = t.runner === "api" ? ` It ran on the API (${t.why ?? "over subscription limit"}), costing $${(t.costUsd ?? 0).toFixed(2)}.` : "";
    return reportText(t, where) + api;
  }

  function reportText(t: Task, where: string): string {
    // The worker's sentences without their own full stop: the report adds one.
    const said = (x: string | null) => (x ?? "").replace(/\.\s*$/, "");
    switch (t.state) {
      case "failed":
        return `Task ${label(t)} failed. ${t.error ?? ""} Tell the user.`;
      case "needs_decision":
        return `Task ${label(t)} needs a decision: ${said(t.question ?? t.headline)}. Headline: ${said(t.headline)}. Details in ${where}. Put the question to the user; their answer can go to the worker with task_followup.`;
      case "blocked":
        return `Task ${label(t)} is blocked: ${said(t.headline)}. Details in ${where}. Tell the user what stopped it.`;
      default:
        return t.resultFrom === "reply"
          ? `Task ${label(t)} finished without its result files; its last reply begins: "${t.headline}". Tell the user the outcome; the full reply is in its session.`
          : `Task ${label(t)} is done. Headline: ${said(t.headline)}${t.question ? ` (open question: ${said(t.question)})` : ""}. The full result is in ${where}. Tell the user the headline, and offer the details.`;
    }
  }

  // ── a worker's turn ended ──

  async function turnEnded(t: Task, ended: boolean): Promise<void> {
    if (checking.has(t.id)) return;
    checking.add(t.id);
    try {
      const files = await backend.result(t.workspace, t.folder).catch(() => null);
      const r = files && fresh(files, t) ? parseResult(files.json) : null;
      const cur = tasks.get(t.id);
      if (!cur || cur.state !== "running") return;
      if (r) {
        finish(t.id, {
          state: r.status,
          headline: r.headline,
          question: r.question ?? null,
          resultFrom: "file",
        });
        return;
      }
      if (!ended && !cur.nudged && cur.instanceId) {
        update(t.id, { nudged: true });
        await port.sendPrompt(cur.instanceId, NUDGE).catch(() => {});
        return;
      }
      const reply = cur.instanceId ? await port.lastResponse(cur.instanceId).catch(() => null) : null;
      if (reply?.trim())
        finish(t.id, { state: "done", headline: firstLine(reply), question: null, resultFrom: "reply" });
      else
        finish(t.id, {
          state: "failed",
          error: ended ? "Its session ended before it wrote a result." : "It wrote no result and no reply.",
        });
    } finally {
      checking.delete(t.id);
    }
  }

  function needsYou(t: Task): void {
    if (!t.instanceId) return;
    const choice = port.choiceOf(t.instanceId);
    const key = choice?.id ?? "?";
    if (told.get(t.id) === key) return;
    told.set(t.id, key);
    const what = choice ? choiceLine(choice) : "a prompt";
    const worker = `Task ${label(t)}'s worker (session id ${t.instanceId})`;
    if (choice?.kind === "question" && !choice.terminalOnly) {
      // Duck is the worker's user: it answers what the brief or the thread settles.
      const options = choice.options.map((o) => `${o.key}. ${o.label}${o.detail ? ` (${o.detail})` : ""}`).join("; ");
      deps.tell(
        t.threadId,
        `${worker} asks: ${choice.questions[0]?.question ?? "?"} Options: ${options}. You are its user. If the brief or this conversation settles it, answer it yourself with answer_choice (choiceId ${choice.id}), giving \`reason\` (what settles it, e.g. "you said earlier you want Postgres"), and tell the user in a sentence what you picked. If they don't settle it, put the question to the user and answer with what they say.`,
        "info",
      );
      return;
    }
    const where =
      choice?.kind === "question"
        ? ` It can only be answered in its console (${choice.terminalOnly}); or give the answer to the worker with task_followup.`
        : choice?.kind === "plan"
          ? " Plan approvals in workers are the user's."
          : "";
    deps.tell(
      t.threadId,
      `${worker} is waiting on ${what}.${where} Tell the user; they can answer it in its console, or tell you what to answer.`,
      "needs_you",
    );
  }

  // ── tidying up ──

  /** Finished on its own: a result came back (or it failed). Blocked and
   *  needs-a-decision tasks wait on the user, closed ones are done with. */
  const tidyable = (t: Task) => t.state === "done" || t.state === "failed";

  let tidying = false;
  async function tidy(): Promise<void> {
    if (tidying) return;
    tidying = true;
    try {
      const s = deps.settings();
      for (const t of [...tasks.values()]) {
        if (!tidyable(t) || t.finished === null || !t.instanceId) continue;
        const session = port.listSessions().find((x) => x.id === t.instanceId);
        const quietSince = Math.max(t.finished, (session?.lastActivity ?? 0) * 1000);
        const idle = now() - quietSince;
        if (s.closeFinishedHours > 0 && idle >= s.closeFinishedHours * 3_600_000) {
          await closeAndRemove(t, session?.worktreeBranch ?? null);
          continue;
        }
        const live = session && session.phase !== "offline" && session.phase !== "ended";
        const resting = session && (session.phase === "idle" || session.phase === "done");
        if (s.workerIdleStopMinutes > 0 && live && resting && idle >= s.workerIdleStopMinutes * 60_000)
          port.stopSession(t.instanceId);
      }
    } finally {
      tidying = false;
    }
  }

  /** Close it, and take its session off the rail unless a worktree holds it. */
  async function closeAndRemove(t: Task, worktree: string | null): Promise<void> {
    const id = t.instanceId;
    await manager.close(t.id);
    if (!id || worktree || !port.listSessions().some((x) => x.id === id)) return;
    await port.killSession(id).catch((e: unknown) => console.warn(`duck: task ${t.id}'s session stays on the rail`, e));
  }

  const tidyTimer = setInterval(() => void tidy(), TIDY_EVERY_MS);

  const offPhase = port.onPhase((id, phase: SessionPhase) => {
    const t = byInstance(id);
    if (!t || t.state !== "running") return;
    if (phase === "done") void turnEnded(t, false);
    else if (phase === "ended") void turnEnded(t, true);
    else if (phase === "needs_you") needsYou(t);
  });

  const manager: TaskManager = {
    tidy,
    async load() {
      const stored = await backend.list();
      for (const t of stored) {
        tasks.set(t.id, t);
        // Still Duck's until closed: a follow-up may come.
        if (t.instanceId && t.state !== "closed") {
          port.setDuckTask(t.instanceId, t.title);
          if (t.headless) port.setHeadless(t.instanceId, true);
        }
      }
      changed();
      // A task that was running when the app quit: its console went with the app, so
      // it's settled from its result files, or failed with a word on how to go on.
      for (const t of stored) {
        if (t.state !== "running") continue;
        const files = await backend.result(t.workspace, t.folder).catch(() => null);
        const r = files && fresh(files, t) ? parseResult(files.json) : null;
        if (r) finish(t.id, { state: r.status, headline: r.headline, question: r.question ?? null, resultFrom: "file" });
        else
          finish(t.id, {
            state: "failed",
            error:
              t.runner === "api"
                ? "Workbench closed while it ran on the API. A follow-up runs it again."
                : "Workbench closed while it ran. A follow-up starts its worker again (in a fresh conversation), or resume its session from the rail.",
          });
      }
      await pump();
      const waiting = [...tasks.values()].filter((t) => t.state === "queued" && t.notBefore);
      if (waiting.length) wakeAt(Math.min(...waiting.map((t) => t.notBefore!)));
    },

    async run(req) {
      const s = deps.settings();
      if (req.kind === "code") {
        const p = port.listProjects().find((x) => x.id === req.projectId);
        if (!p) throw new Error("A code task needs the project it works in.");
        if (p.remote) throw new Error(`${p.name} is a remote project: workers run on this machine only.`);
      }
      const { model, effort } = tierOf(s, req.tier, req.model, req.effort);
      const workspace = await backend.prepare(s.workspace);
      const folder = await backend.newFolder(workspace, today(), req.title, briefText(req, req.tier));
      const t = save({
        id: newId().slice(0, 8),
        threadId: req.threadId,
        title: req.title.trim(),
        kind: req.kind,
        tier: req.tier,
        model,
        effort,
        projectId: req.kind === "code" ? req.projectId! : null,
        workspace,
        folder,
        instanceId: null,
        state: "queued",
        created: now(),
        started: null,
        runStarted: null,
        finished: null,
        headline: null,
        question: null,
        resultFrom: null,
        nudged: false,
        error: null,
        mandate: req.mandate?.text ?? null,
        brief: req.brief.trim(),
        runner: "session",
        why: null,
        costUsd: null,
        notBefore: null,
        headless: false,
        answers: [],
      });
      void pump();
      await starting.get(t.id);
      return tasks.get(t.id) ?? t;
    },

    async followup(id, prompt) {
      const t = tasks.get(id);
      if (!t) throw new Error(`There is no task ${id}.`);
      if (t.runner === "api") {
        if (t.state === "running") throw new Error("It's still running on the API; wait for its result.");
        const prev = await backend.result(t.workspace, t.folder).catch(() => null);
        update(id, { state: "running", finished: null, error: null });
        startApi(
          id,
          `${t.brief}\n\n## Your previous result\n\n${prev?.md ?? "(none)"}\n\n## Follow-up\n\n${prompt.trim()}\n\nSubmit the whole updated result.`,
          t.why,
        );
        return "sent";
      }
      if (!t.instanceId)
        throw new Error(t.state === "queued" ? "It hasn't started yet: it's waiting for a free worker." : "It never started.");
      if (!port.listSessions().some((s) => s.id === t.instanceId))
        throw new Error("Its session is gone from the rail; start a new task instead.");
      update(id, {
        state: "running",
        runStarted: now(),
        finished: null,
        nudged: false,
        error: null,
      });
      port.setDuckTask(t.instanceId, t.title);
      return port.sendPrompt(
        t.instanceId,
        `${prompt.trim()}\n\n(The task's brief is ${t.folder}\\brief.md.) When you're done, update result.md and result.json there, in the same format.`,
      );
    },

    async close(id) {
      const t = tasks.get(id);
      if (!t) throw new Error(`There is no task ${id}.`);
      apiRuns.get(id)?.abort();
      if (t.instanceId) {
        const s = port.listSessions().find((x) => x.id === t.instanceId);
        if (s && s.phase !== "offline" && s.phase !== "ended") port.stopSession(t.instanceId);
        // Resumed from the rail after this, it's your session, in a terminal.
        port.setDuckTask(t.instanceId, null);
        port.setHeadless(t.instanceId, false);
      }
      // An unfinished one frees its slot; a finished one keeps its headline.
      if (!isFinished(t.state)) finish(id, { state: "closed" });
      else update(id, { state: "closed" });
      return tasks.get(id)!;
    },

    async rerun(id, tier) {
      const t = tasks.get(id);
      if (!t) throw new Error(`There is no task ${id}.`);
      if (!t.brief.trim()) throw new Error("Its brief wasn't kept (an older task): start a new one with run_task.");
      const up = tier ?? tierUp(t.tier);
      const next = await this.run({
        threadId: t.threadId,
        title: t.title,
        brief: t.brief,
        kind: t.kind,
        tier: up,
        projectId: t.projectId ?? undefined,
        mandate: t.mandate ? { text: t.mandate, threadId: t.threadId } : undefined,
      });
      if (t.state !== "closed") await this.close(id);
      return next;
    },

    byInstance,
    noteAnswer(instanceId, a) {
      const t = byInstance(instanceId);
      if (t) update(t.id, { answers: [...t.answers, { ...a, at: now() }] });
    },

    get: (id) => tasks.get(id),
    // Newest first; two made in the same millisecond, the later one first.
    list: () => [...tasks.values()].reverse().sort((a, b) => b.created - a.created),
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      offPhase();
      clearInterval(tidyTimer);
      if (wake) clearTimeout(wake);
      for (const c of apiRuns.values()) c.abort();
      listeners.clear();
    },
  };
  return manager;
}
