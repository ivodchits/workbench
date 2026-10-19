// A `WorkbenchPort` over fixture data, for the engine's and the tools' tests.
// Everything not given is empty; `git` and the notes answer from the maps given.

import type { Spend } from "../ipc/assistant";
import type { Note, NoteMeta } from "../ipc/notes";
import type { TranscriptPage } from "../ipc/transcript";
import type { RateLimits } from "../ipc/usageLimits";
import type {
  GitSnapshot,
  ProjectRef,
  SessionRef,
  WorkbenchPort,
} from "./port";

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
    workingDir: `C:/src/${s.projectId}`,
    lastActivity: null,
    choice: null,
    ...s,
  };
}

export function fakePort(
  data: FakePortData = {},
): WorkbenchPort & { reads: number } {
  const port = {
    reads: 0,
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
  };
  return port;
}
