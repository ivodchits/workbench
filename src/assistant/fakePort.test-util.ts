// A `WorkbenchPort` over fixture data, for the engine's and the tools' tests.
// Everything not given is empty; `git` and the notes answer from the maps given.
// Actions are recorded in `calls` (notes writes also change the notes, with the
// revision check); `phase()` fires the `onPhase` listeners.

import type { Spend } from "../ipc/assistant";
import type { Note, NoteMeta } from "../ipc/notes";
import type { TranscriptPage } from "../ipc/transcript";
import type { RateLimits } from "../ipc/usageLimits";
import type {
  GitSnapshot,
  ProjectRef,
  SessionRef,
  PhaseListener,
  PromptDelivery,
  SessionPhase,
  WorkbenchPort,
} from "./port";
import type { Notice } from "./protocol";
import { DEFAULT_SETTINGS, type DuckSettings } from "./settings";
import type { ToolContext } from "./tools/registry";

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
}

export interface FakePort extends WorkbenchPort {
  reads: number;
  calls: { name: string; args: unknown[] }[];
  /** Fire a phase change at the `onPhase` listeners. */
  phase(instanceId: string, phase: SessionPhase, prev?: SessionPhase): void;
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
    workingDir: `C:/src/${s.projectId}`,
    lastActivity: null,
    choice: null,
    ...s,
  };
}

export function fakePort(data: FakePortData = {}): FakePort {
  const listeners = new Set<PhaseListener>();
  const notes = (projectId: string) =>
    ((data.notes ??= {})[projectId] ??= []);
  const sessionOf = (id: string) => {
    const s = data.sessions?.find((x) => x.id === id);
    if (!s) throw new Error(`no session with id ${id}`);
    return s;
  };
  const record = (name: string, ...args: unknown[]) =>
    port.calls.push({ name, args });
  const port: FakePort = {
    reads: 0,
    calls: [],
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
      return Promise.resolve({
        id: "new-1",
        title: opts.title ?? "1",
        message: null,
      });
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
  };
  return port;
}

/** A tool context over `port` that records what the tool shows and schedules. */
export function toolCtx(
  port: WorkbenchPort,
  settings: Partial<DuckSettings> = {},
): ToolContext & { notices: Notice[]; posted: string[] } {
  const ctx = {
    port,
    threadId: "t",
    signal: new AbortController().signal,
    settings: { ...DEFAULT_SETTINGS, ...settings },
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
