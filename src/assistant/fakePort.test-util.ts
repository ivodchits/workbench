// A `WorkbenchPort` over fixture data, for the engine's and the tools' tests.
// Everything not given is empty; `git` and the notes answer from the maps given.
// Actions are recorded in `calls` (notes writes also change the notes, with the
// revision check); `phase()` fires the `onPhase` listeners.

import type { Spend } from "../ipc/assistant";
import type { Note, NoteMeta } from "../ipc/notes";
import type { PluginFile, Problem } from "../ipc/plugins";
import type { TranscriptPage } from "../ipc/transcript";
import type { RateLimits } from "../ipc/usageLimits";
import type {
  ChoiceRef,
  GitSnapshot,
  ProjectRef,
  SessionRef,
  PhaseListener,
  PromptDelivery,
  SessionContext,
  SessionPhase,
  TaskEnd,
  TaskRun,
  WorkbenchPort,
} from "./port";
import type { Notice } from "./protocol";
import { DEFAULT_SETTINGS, type DuckSettings } from "./settings";
import type { ToolContext } from "./tools/registry";
import type { Summarizer } from "./summarize";
import type { TaskManager } from "./tasks";

export interface FakePortData {
  projects?: ProjectRef[];
  sessions?: SessionRef[];
  /** Transcript lines per session id, paged `pageLines` at a time. */
  transcripts?: Record<string, string[]>;
  pageLines?: number;
  limits?: RateLimits | null;
  /** Repos by directory. */
  git?: Record<string, Omit<GitSnapshot, "root">>;
  notes?: Record<string, (NoteMeta & { content: string })[]>;
  spend?: Spend;
  /** What `sendPrompt` reports. */
  delivery?: PromptDelivery;
  /** Plugin files by project id (`file` is the text parsed, `null` when it has
   *  problems); the revision counts writes. */
  plugins?: Record<string, FakePlugins>;
  /** Scripts by `projectId/name`. */
  scripts?: Record<string, string>;
  /** Toolbar drafts by project id. */
  drafts?: Record<string, { text: string | null; scripts: { name: string; text: string }[] }>;
  /** What `sessionContext` answers, per session id. */
  contexts?: Record<string, Partial<SessionContext>>;
  /** What `lastResponse` answers, per session id. */
  replies?: Record<string, string | null>;
  /** Terminal screens per session id (`readScreen`); a session without one has no
   *  terminal in this window. `pressKeys` may change them through `onKeys`. */
  screens?: Record<string, string[]>;
  onKeys?: (instanceId: string, keys: string[]) => void;
}

export interface FakePlugins {
  text: string | null;
  rev: number;
  values?: Record<string, Record<string, string>>;
  runs?: Record<string, TaskRun>;
}

/** The fake's parse: JSON with a `version` and a `plugins` array. */
export function fakeCheck(text: string): Problem[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return [{ path: "", message: `not valid JSON: ${(e as Error).message}` }];
  }
  const o = v as { version?: unknown; plugins?: unknown };
  const out: Problem[] = [];
  if (o.version !== 1) out.push({ path: "version", message: "missing; write \"version\": 1" });
  if (!Array.isArray(o.plugins)) out.push({ path: "plugins", message: "missing" });
  return out;
}

export interface FakePort extends WorkbenchPort {
  reads: number;
  calls: { name: string; args: unknown[] }[];
  /** Fire a phase change at the `onPhase` listeners. */
  phase(instanceId: string, phase: SessionPhase, prev?: SessionPhase): void;
  /** End a task run, for its `onTaskEnd` listeners. */
  endTask(taskId: string, end: Partial<TaskEnd>): void;
  /** Set a session's open prompt (null closes it) and tell the `onChoices`
   *  listeners. */
  setChoice(instanceId: string, choice: ChoiceRef | null): void;
  /** The registered needs-you hold. */
  hold: ((instanceId: string) => Promise<boolean>) | null;
  /** What `noteSession` showed. */
  lines: { id: string; text: string; acted: boolean }[];
}

export function project(p: Partial<ProjectRef> & { id: string }): ProjectRef {
  return {
    name: p.id,
    rootPath: `C:/src/${p.id}`,
    group: null,
    remote: false,
    ...p,
  };
}

export function session(
  s: Partial<SessionRef> & { id: string; projectId: string },
): SessionRef {
  return {
    title: s.id,
    taskNote: "",
    phase: "idle",
    compacting: false,
    subagents: 0,
    worktreeBranch: null,
    model: null,
    permissionMode: null,
    duckTask: null,
    workingDir: `C:/src/${s.projectId}`,
    lastActivity: null,
    choice: null,
    ...s,
  };
}

export function fakePort(data: FakePortData = {}): FakePort {
  const listeners = new Set<PhaseListener>();
  const choiceListeners = new Set<() => void>();
  const taskEnds = new Map<string, (end: TaskEnd) => void>();
  const pluginsOf = (projectId: string) => (data.plugins ??= {})[projectId];
  const revOf = (f: FakePlugins | undefined) => (f?.text != null ? `p-${f.rev}` : null);
  const parsed = (f: FakePlugins | undefined): PluginFile | null =>
    f?.text != null && fakeCheck(f.text).length === 0 ? (JSON.parse(f.text) as PluginFile) : null;
  const notes = (projectId: string) =>
    ((data.notes ??= {})[projectId] ??= []);
  const sessionOf = (id: string) => {
    const s = data.sessions?.find((x) => x.id === id);
    if (!s) throw new Error(`no session with id ${id}`);
    return s;
  };
  const record = (name: string, ...args: unknown[]) =>
    port.calls.push({ name, args });
  let made = 0;
  const port: FakePort = {
    reads: 0,
    calls: [],
    hold: null,
    lines: [],
    listProjects: () => data.projects ?? [],
    listSessions: (projectId?: string) =>
      (data.sessions ?? []).filter(
        (s) => !projectId || s.projectId === projectId,
      ),
    readTranscriptBack(
      instanceId: string,
      before?: number,
    ): Promise<TranscriptPage> {
      port.reads++;
      const lines = data.transcripts?.[instanceId] ?? [];
      const end = before ?? lines.length;
      const start = Math.max(0, end - (data.pageLines ?? 1000));
      return Promise.resolve({
        sessionId: lines.length ? `s-${instanceId}` : null,
        lines: lines.slice(start, end),
        offset: start,
        nextOffset: end,
        end: lines.length,
      });
    },
    usageLimits: () => Promise.resolve(data.limits ?? null),
    git(dir: string): Promise<GitSnapshot> {
      const g = data.git?.[dir];
      return g
        ? Promise.resolve({ root: dir, ...g })
        : Promise.reject(new Error(`not a git repo: ${dir}`));
    },
    listNotes: (projectId: string) =>
      Promise.resolve(
        (data.notes?.[projectId] ?? []).map(({ id, modified, size }) => ({
          id,
          modified,
          size,
        })),
      ),
    readNote(projectId: string, name: string): Promise<Note> {
      const n = data.notes?.[projectId]?.find((x) => x.id === name);
      return n
        ? Promise.resolve({
            id: n.id,
            content: n.content,
            revision: `r-${n.modified}`,
            path: `notes/${n.id}.md`,
          })
        : Promise.reject(new Error(`no note ${name}`));
    },
    spend(): Promise<Spend> {
      return data.spend
        ? Promise.resolve(data.spend)
        : Promise.reject(new Error("no spend"));
    },

    sendPrompt(id, text) {
      sessionOf(id);
      record("sendPrompt", id, text);
      return Promise.resolve(data.delivery ?? "sent");
    },
    createSession(opts) {
      if (!data.projects?.some((p) => p.id === opts.projectId))
        return Promise.reject(new Error(`no project with id ${opts.projectId}`));
      record("createSession", opts);
      const id = `new-${++made}`;
      // A worker is looked up again later, so it joins the sessions.
      if (opts.worker)
        (data.sessions ??= []).push(session({ id, projectId: opts.projectId, title: opts.title ?? id, phase: "offline" }));
      return Promise.resolve({ id, title: opts.title ?? "1", message: null });
    },
    startSession(id) {
      sessionOf(id);
      record("startSession", id);
    },
    resumeSession(id, sessionId) {
      sessionOf(id);
      record("resumeSession", id, sessionId);
    },
    answerChoice(id, choiceId, answer) {
      const c = sessionOf(id).choice;
      if (!c || c.id !== choiceId) throw new Error("That prompt is no longer open.");
      record("answerChoice", id, choiceId, answer);
      if (answer === "deny") return "deny";
      if (typeof answer === "object") return answer.text;
      const o = c.options.find((x) => x.key === answer);
      if (!o) throw new Error(`There is no option ${answer}.`);
      return o.label;
    },
    interruptSession(id) {
      sessionOf(id);
      record("interruptSession", id);
    },
    readScreen(id) {
      sessionOf(id);
      return data.screens?.[id] ?? null;
    },
    async pressKeys(id, keys, gapMs) {
      sessionOf(id);
      record("pressKeys", id, keys, gapMs);
      data.onKeys?.(id, keys);
    },
    stopSession(id) {
      sessionOf(id);
      record("stopSession", id);
    },
    async killSession(id) {
      const s = sessionOf(id);
      if (s.worktreeBranch) throw new Error(`"${s.title}" has a worktree`);
      record("killSession", id);
      data.sessions = data.sessions?.filter((x) => x.id !== id);
    },
    openPanel(projectId, kind, instanceId) {
      record("openPanel", projectId, kind, instanceId);
    },
    writeNote(projectId, name, content, baseRevision) {
      const n = notes(projectId).find((x) => x.id === name);
      if (!n || `r-${n.modified}` !== baseRevision)
        // As the backend refuses it: a plain string (`isStale` reads its start).
        return Promise.reject("stale: the note changed");
      record("writeNote", projectId, name, content, baseRevision);
      n.content = content;
      n.modified += 1;
      n.size = content.length;
      return Promise.resolve(`r-${n.modified}`);
    },
    createNote(projectId, name, content) {
      const list = notes(projectId);
      let id = name;
      for (let k = 2; list.some((x) => x.id === id); k++) id = `${name} ${k}`;
      record("createNote", projectId, id, content);
      list.push({ id, modified: 1, size: content.length, content });
      return Promise.resolve({
        id,
        content,
        revision: "r-1",
        path: `notes/${id}.md`,
      });
    },
    deleteNote(projectId, name) {
      const list = notes(projectId);
      const i = list.findIndex((x) => x.id === name);
      if (i < 0) return Promise.reject(new Error(`no note ${name}`));
      record("deleteNote", projectId, name);
      list.splice(i, 1);
      return Promise.resolve();
    },
    onPhase(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    phase(id, phase, prev) {
      for (const l of [...listeners]) l(id, phase, prev ?? null);
    },

    listPlugins(projectId) {
      const f = pluginsOf(projectId);
      return Promise.resolve({
        path: `notes/${projectId}/plugins.json`,
        revision: revOf(f),
        file: parsed(f),
        problems: f?.text != null ? fakeCheck(f.text) : [],
        values: f?.values ?? {},
        runs: f?.runs ?? {},
      });
    },
    pluginsText(projectId) {
      const f = pluginsOf(projectId);
      return Promise.resolve({
        path: `notes/${projectId}/plugins.json`,
        revision: revOf(f),
        text: f?.text ?? null,
      });
    },
    checkPlugins: (text) => Promise.resolve(fakeCheck(text)),
    writePlugins(projectId, text, baseRevision) {
      const f = ((data.plugins ??= {})[projectId] ??= { text: null, rev: 0 });
      if (baseRevision !== null && revOf(f) !== baseRevision)
        return Promise.reject("stale: plugins.json changed since it was read");
      const problems = fakeCheck(text);
      if (problems.length)
        return Promise.reject(
          `not saved, the file has problems:\n${problems.map((p) => `${p.path}: ${p.message}`).join("\n")}`,
        );
      record("writePlugins", projectId, text, baseRevision);
      f.text = text;
      f.rev += 1;
      return Promise.resolve(`p-${f.rev}`);
    },
    readScript: (projectId, name) => Promise.resolve(data.scripts?.[`${projectId}/${name}`] ?? null),
    writeScript(projectId, name, text) {
      record("writeScript", projectId, name, text);
      (data.scripts ??= {})[`${projectId}/${name}`] = text;
      return Promise.resolve();
    },
    previewPluginAction(req) {
      const f = pluginsOf(req.projectId);
      if (revOf(f) !== req.revision) return Promise.reject("stale: plugins.json changed since this action was shown");
      const action = parsed(f)
        ?.plugins.find((p) => p.id === req.pluginId)
        ?.actions.find((a) => a.id === req.actionId);
      if (!action) return Promise.reject(`no action ${req.pluginId}:${req.actionId}`);
      const fill = (t: string) => t.replace(/\{([A-Za-z][\w-]*)\}/g, (m, k: string) => req.values[k] ?? m);
      return Promise.resolve({
        argv: action.run.map(fill),
        cwd: `C:/src/${req.projectId}`,
        confirm: action.confirm ? fill(action.confirm) : null,
      });
    },
    runPluginAction(req) {
      record("runPluginAction", req);
      return Promise.resolve({
        taskId: `task:${req.projectId}:${req.pluginId}:${req.actionId}`,
        label: `${req.pluginId}: ${req.actionId}`,
      });
    },
    onTaskEnd(taskId, cb) {
      taskEnds.set(taskId, cb);
      return () => {
        if (taskEnds.get(taskId) === cb) taskEnds.delete(taskId);
      };
    },
    startPluginsDraft(opts) {
      if (!data.projects?.some((p) => p.id === opts.projectId))
        return Promise.reject(new Error(`no project with id ${opts.projectId}`));
      const draftDir = `drafts/${opts.projectId}`;
      record("startPluginsDraft", { ...opts, prompt: opts.prompt(draftDir) });
      (data.drafts ??= {})[opts.projectId] = { text: pluginsOf(opts.projectId)?.text ?? null, scripts: [] };
      (data.sessions ??= []).push(session({ id: "draft-1", projectId: opts.projectId, title: opts.title, phase: "offline" }));
      return Promise.resolve({ id: "draft-1", title: opts.title, draftDir });
    },
    readPluginsDraft(projectId) {
      const d = data.drafts?.[projectId];
      return Promise.resolve({ path: `drafts/${projectId}`, text: d?.text ?? null, scripts: d?.scripts ?? [] });
    },
    clearPluginsDraft(projectId) {
      record("clearPluginsDraft", projectId);
      delete data.drafts?.[projectId];
      return Promise.resolve();
    },
    endTask(taskId, end) {
      const cb = taskEnds.get(taskId);
      taskEnds.delete(taskId);
      cb?.({ status: "exited", code: 0, error: null, tail: [], ms: 1000, ...end });
    },
    choiceOf: (id) => data.sessions?.find((x) => x.id === id)?.choice ?? null,
    onChoices(cb) {
      choiceListeners.add(cb);
      return () => {
        choiceListeners.delete(cb);
      };
    },
    setChoice(id, choice) {
      sessionOf(id).choice = choice;
      for (const l of [...choiceListeners]) l();
    },
    holdNeedsYou(hold) {
      port.hold = hold;
      return () => {
        if (port.hold === hold) port.hold = null;
      };
    },
    sessionContext(id) {
      sessionOf(id);
      return Promise.resolve({
        mandate: null,
        from: null,
        threadId: null,
        lastPrompt: null,
        home: null,
        ...data.contexts?.[id],
      });
    },
    noteSession(id, line) {
      port.lines.push({ id, ...line });
    },
    ensureProject(name, rootPath) {
      const same = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      let p = data.projects?.find((x) => same(x.rootPath) === same(rootPath));
      if (!p) {
        p = project({ id: `p-${name.toLowerCase()}`, name, rootPath });
        (data.projects ??= []).push(p);
        record("ensureProject", name, rootPath);
      }
      return Promise.resolve(p);
    },
    lastResponse(id) {
      return Promise.resolve(data.replies?.[id] ?? null);
    },
    setDoneSummary() {},
    setDuckTask(id, task) {
      record("setDuckTask", id, task);
      const s = data.sessions?.find((x) => x.id === id);
      if (s) s.duckTask = task;
    },
  };
  return port;
}

/** A tool context over `port` that records what the tool shows and schedules. */
export function toolCtx(
  port: WorkbenchPort,
  settings: Partial<DuckSettings> = {},
): ToolContext & { prepared: undefined; notices: Notice[]; posted: string[] } {
  const ctx = {
    port,
    prepared: undefined,
    threadId: "t",
    signal: new AbortController().signal,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    request: null as string | null,
    tasks: null as TaskManager | null,
    summaries: null as Summarizer | null,
    notices: [] as Notice[],
    posted: [] as string[],
    notice(n: Notice) {
      ctx.notices.push(n);
      return Promise.resolve();
    },
    later(text: string) {
      ctx.posted.push(text);
    },
  };
  return ctx;
}
