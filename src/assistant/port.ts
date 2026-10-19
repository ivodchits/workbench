// `WorkbenchPort` (step A2): the only way Duck touches the app (design → Separable,
// not separate, boundary 1). Duck's tools call this interface, never the stores, so
// lifting Duck out of Workbench later means writing a `port.remote.ts` over the
// remote API and nothing else.
//
// `port.local.ts` is the one implementation today and the only file under
// `src/assistant/` allowed to import `src/state/**` or `src/panels/**`; ESLint
// enforces that (`eslint.config.js`). Each later step adds the members its tools need
// (W1: status, pending choices, transcripts, git, notes, limits; W2: prompts,
// sessions, notes writes; …).

import type { Spend } from "../ipc/assistant";
import type { Branches, Commit, StatusEntry } from "../ipc/git";
import type { Note, NoteMeta } from "../ipc/notes";
import type { TranscriptPage } from "../ipc/transcript";
import type { RateLimits } from "../ipc/usageLimits";

export interface ProjectRef {
  id: string;
  name: string;
  rootPath: string;
  /** The rail group's name; null when ungrouped. */
  group: string | null;
  /** An SSH project: its sessions run on another machine. */
  remote: boolean;
}

/** A session's live phase, or `offline` when no session is running. */
export type SessionPhase =
  "idle" | "working" | "needs_you" | "done" | "ended" | "offline";

/** The prompt a session is waiting on (`pendingChoice.ts`). */
export interface ChoiceRef {
  kind: "permission" | "question" | "plan";
  toolName: string;
  input: Record<string, unknown>;
  /** When it opened, epoch ms. */
  at: number;
  questions: {
    header: string;
    question: string;
    multiSelect: boolean;
    options: { label: string; description: string }[];
  }[];
  options: { key: number; label: string; detail: string; typed: boolean }[];
  /** Why it can only be answered in the terminal; null when the app can answer. */
  terminalOnly: string | null;
  /** An answer sent from the app that the session hasn't taken yet. */
  sent: string | null;
}

export interface SessionRef {
  id: string;
  projectId: string;
  title: string;
  taskNote: string;
  phase: SessionPhase;
  compacting: boolean;
  /** Subagents running. */
  subagents: number;
  /** The worktree's branch; null when the session works in the project root. */
  worktreeBranch: string | null;
  /** The model it launches on (its own, else the project's default); null for
   *  Claude Code's default. */
  model: string | null;
  workingDir: string;
  /** Last activity, epoch seconds (the live status, else the stored one). */
  lastActivity: number | null;
  choice: ChoiceRef | null;
}

/** A repo as the git panel reads it. */
export interface GitSnapshot {
  root: string;
  branches: Branches;
  status: StatusEntry[];
  log: Commit[];
  /** A merge / rebase / … in progress, or null. */
  operation: string | null;
}

export interface WorkbenchPort {
  listProjects(): ProjectRef[];
  listSessions(projectId?: string): SessionRef[];
  /** A page of the session's transcript ending at `before` (the end when
   *  omitted), as `readTranscriptBack`. */
  readTranscriptBack(
    instanceId: string,
    before?: number,
  ): Promise<TranscriptPage>;
  /** The Claude Code subscription's limits, or null until a session reports them. */
  usageLimits(): Promise<RateLimits | null>;
  /** The repo at `dir` (a project root or a session's worktree): `log` holds the
   *  newest `commits` commits, only those after `since` (git's date syntax) when
   *  given. */
  git(
    dir: string,
    opts: { commits: number; since?: string },
  ): Promise<GitSnapshot>;
  listNotes(projectId: string): Promise<NoteMeta[]>;
  readNote(projectId: string, name: string): Promise<Note>;
  /** Duck's own API spend. */
  spend(): Promise<Spend>;
}
