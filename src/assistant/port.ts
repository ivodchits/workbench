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
  /** Unique per prompt: an answer names it, so it can't land on a newer one. */
  id: string;
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

/** Where a prompt went: into the session now, into its queue (sent when its turn
 *  ends), or to a console just started for it (sent once its prompt box shows). */
export type PromptDelivery = "sent" | "queued" | "starting";

export type PanelKind = "console" | "git" | "diff" | "notes";

/** A phase change of one session (the status engine's transitions). */
export type PhaseListener = (
  instanceId: string,
  phase: SessionPhase,
  prev: SessionPhase | null,
) => void;

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

  // ── actions (W2). Each throws an Error saying why when it can't be done. ──

  /** Send a prompt as the prompt queue does: now if the session is between turns,
   *  else queued; a session that isn't running is started first. */
  sendPrompt(instanceId: string, text: string): Promise<PromptDelivery>;
  /** A new session, as the rail's "new instance" (focused, console open). With a
   *  `prompt`, it goes in once the prompt box shows. */
  createSession(opts: {
    projectId: string;
    title?: string;
    prompt?: string;
    worktree?: boolean;
    model?: string | null;
  }): Promise<{ id: string; title: string; message: string | null }>;
  /** Open (or focus) a session's console, starting a fresh Claude Code session if
   *  none is running. */
  startSession(instanceId: string): void;
  /** Relaunch the console on a past session: `sessionId`, else its last one. */
  resumeSession(instanceId: string, sessionId?: string): void;
  /** Answer the prompt `choiceId` with one of its options, with free text (a
   *  single question's "Type something"), or dismiss it. Refused when that prompt
   *  is no longer the open one. Returns what was answered. */
  answerChoice(
    instanceId: string,
    choiceId: string,
    answer: number | "deny" | { text: string },
  ): string;
  /** Esc: stop the session's current turn. */
  interruptSession(instanceId: string): void;
  /** Close the console and end its process. */
  stopSession(instanceId: string): void;
  /** Open (or focus) a panel. `diff` and `console` need a session. */
  openPanel(projectId: string, kind: PanelKind, instanceId?: string): void;
  /** Write a note. `baseRevision` is the revision it was read at; the write is
   *  refused (`stale:`) if it moved since. Returns the new revision. */
  writeNote(
    projectId: string,
    name: string,
    content: string,
    baseRevision: string,
  ): Promise<string>;
  /** Make a note; a taken name gets " 2", " 3", …. */
  createNote(projectId: string, name: string, content: string): Promise<Note>;
  deleteNote(projectId: string, name: string): Promise<void>;
  /** Hear every session phase change; returns the unsubscribe. */
  onPhase(cb: PhaseListener): () => void;
}
