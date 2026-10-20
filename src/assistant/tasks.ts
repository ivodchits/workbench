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

import { z } from "zod";

import {
  taskFolder,
  taskList,
  taskPut,
  taskResult,
  workspacePrepare,
  type TaskResultFiles,
} from "../ipc/assistant";
import { choiceLine } from "./tools/read";
import type { Mandate, PromptDelivery, SessionPhase, WorkbenchPort } from "./port";
import type { DuckSettings, Tier } from "./settings";

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
});
export type Task = z.infer<typeof Task>;

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
  put(task: Task): Promise<void>;
  list(): Promise<Task[]>;
}

/** How many records are loaded at start. */
const LOAD_LIMIT = 200;

export const ipcTaskBackend: TaskBackend = {
  prepare: workspacePrepare,
  newFolder: taskFolder,
  result: taskResult,
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

export interface TaskManager {
  /** Read the stored tasks and pick up the ones that were running. */
  load(): Promise<void>;
  run(req: RunRequest): Promise<Task>;
  /** A follow-up prompt into the task's session; it runs again until its next
   *  result. */
  followup(id: string, prompt: string): Promise<PromptDelivery>;
  /** Close the task's console (everything stays on disk); a queued task never
   *  starts. */
  close(id: string): Promise<Task>;
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
  /** Post a Workbench event into a thread (it starts a turn there). */
  tell: (threadId: string, text: string) => void;
  now?: () => number;
  newId?: () => string;
  /** Local date `YYYY-MM-DD`, for the folder name. */
  today?: () => string;
}

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
      const next = all.filter((t) => t.state === "queued").sort((a, b) => a.created - b.created)[0];
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

  async function start(t: Task): Promise<void> {
    // Running before the await, so the slot is taken while the session starts.
    update(t.id, { state: "running", started: now(), runStarted: now() });
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
      });
      port.setDuckTask(made.id, t.title);
      // The clock starts once the prompt is on its way.
      update(t.id, { instanceId: made.id, projectId, runStarted: now() });
      if (made.message) deps.tell(t.threadId, `Task ${label(t)} started with a warning: ${made.message}`);
    } catch (e) {
      finish(t.id, { state: "failed", error: `It couldn't start: ${errorText(e)}` });
    }
  }

  /** Record an outcome, tell the thread, and start the next task. */
  function finish(id: string, patch: Partial<Task> & { state: TaskState }): void {
    const t = update(id, { finished: now(), ...patch });
    if (t.state !== "closed") deps.tell(t.threadId, report(t));
    void pump();
  }

  function report(t: Task): string {
    const where = `${t.folder}\\result.md`;
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
    deps.tell(
      t.threadId,
      `Task ${label(t)}'s worker (session id ${t.instanceId}) is waiting on ${what}. Tell the user; they can answer it in its console, or tell you what to answer.`,
    );
  }

  const offPhase = port.onPhase((id, phase: SessionPhase) => {
    const t = byInstance(id);
    if (!t || t.state !== "running") return;
    if (phase === "done") void turnEnded(t, false);
    else if (phase === "ended") void turnEnded(t, true);
    else if (phase === "needs_you") needsYou(t);
  });

  return {
    async load() {
      const stored = await backend.list();
      for (const t of stored) {
        tasks.set(t.id, t);
        // Still Duck's until closed: a follow-up may come.
        if (t.instanceId && t.state !== "closed") port.setDuckTask(t.instanceId, t.title);
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
              "Workbench closed while it ran. A follow-up starts its worker again (in a fresh conversation), or resume its session from the rail.",
          });
      }
      await pump();
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
      });
      void pump();
      await starting.get(t.id);
      return tasks.get(t.id) ?? t;
    },

    async followup(id, prompt) {
      const t = tasks.get(id);
      if (!t) throw new Error(`There is no task ${id}.`);
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
      if (t.instanceId) {
        const s = port.listSessions().find((x) => x.id === t.instanceId);
        if (s && s.phase !== "offline" && s.phase !== "ended") port.stopSession(t.instanceId);
        // Resumed from the rail after this, it's your session.
        port.setDuckTask(t.instanceId, null);
      }
      // An unfinished one frees its slot; a finished one keeps its headline.
      if (!isFinished(t.state)) finish(id, { state: "closed" });
      else update(id, { state: "closed" });
      return tasks.get(id)!;
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
      listeners.clear();
    },
  };
}
