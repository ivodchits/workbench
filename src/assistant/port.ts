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

import type { Spend, WorkerSpec } from "../ipc/assistant";
import type { Branches, Commit, StatusEntry } from "../ipc/git";
import type { Note, NoteMeta } from "../ipc/notes";
import type { PluginsDraft, PluginsText, PluginsView, Problem } from "../ipc/plugins";
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
  /** Where `options` come from: the hook (a question's), the terminal screen, or
   *  neither yet (a permission prompt's placeholder Allow). */
  optionsFrom: "hook" | "terminal" | "generic";
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
  /** The permission mode it launches in (its own, else the project's); null for
   *  Claude Code's default. */
  permissionMode: string | null;
  /** The task it works on for Duck (step D1); null for a session of yours. */
  duckTask: string | null;
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
    /** What the session is for: the user's request in the thread that started it
     *  (T2's judge reads its prompts against this). */
    mandate?: Mandate;
    permissionMode?: string | null;
    /** A worker (step D1): registered before its first launch, so every launch
     *  gets its effort, mode, allow list and MCP flags. */
    worker?: WorkerSpec;
    /** Answer the folder-trust dialog (Duck's own workspace only). */
    trustFolder?: boolean;
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
  /** The rail's "kill instance": stop it, close its review panel, and remove it from
   *  the rail. Refused for a session with a worktree (it would be left on disk) and
   *  for a remote one whose tmux session needs the user's SSH password. */
  killSession(instanceId: string): Promise<void>;
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
  /** Hear every session phase change; returns the unsubscribe. A needs-you that
   *  Duck's trust watcher answers on its own is never reported, and one it leaves
   *  to the user is reported once it has decided (`holdNeedsYou`). */
  onPhase(cb: PhaseListener): () => void;

  // ── project toolbar plugins (W5) ──

  /** The project's plugin file as the toolbar reads it, each plugin's field values
   *  and each action's last run. */
  listPlugins(projectId: string): Promise<PluginsRef>;
  /** The file's raw text and revision (null when there is none). */
  pluginsText(projectId: string): Promise<PluginsText>;
  /** What's wrong with `text` as a plugin file; empty when it would save. */
  checkPlugins(text: string): Promise<Problem[]>;
  /** Replace the file (`baseRevision` null: there was none). Refused (`stale:`)
   *  when it moved on, or with the problems when it doesn't parse. */
  writePlugins(projectId: string, text: string, baseRevision: string | null): Promise<string>;
  /** A script in the project's `scripts/` folder; null when there is none. */
  readScript(projectId: string, name: string): Promise<string | null>;
  writeScript(projectId: string, name: string, text: string): Promise<void>;
  /** What running an action with these values would spawn, and its confirm
   *  question filled in. Refused (`stale:`) when the file isn't at `revision`. */
  previewPluginAction(req: PluginRunRequest): Promise<PluginPreview>;
  /** Run an action in its task panel, as its toolbar button does but without the
   *  confirm question (Duck's card asked). Refused while it is running. */
  runPluginAction(req: PluginRunRequest): Promise<{ taskId: string; label: string }>;
  /** Hear the end of the run just started in `taskId`, once; returns the
   *  unsubscribe. */
  onTaskEnd(taskId: string, cb: (end: TaskEnd) => void): () => void;
  /** A new session that drafts the project's toolbar (local projects only): a
   *  fresh draft (a copy of the live file and scripts) is made and the session is
   *  registered for it before its first launch, so it starts with the drafting
   *  skill and may edit the draft folder only. `prompt` gets the draft folder and
   *  goes in once the prompt box shows. */
  startPluginsDraft(opts: {
    projectId: string;
    title: string;
    model: string | null;
    prompt: (draftDir: string) => string;
    mandate?: Mandate;
  }): Promise<{ id: string; title: string; draftDir: string }>;
  /** The project's draft as its session left it. */
  readPluginsDraft(projectId: string): Promise<PluginsDraft>;
  /** Drop the draft; its sessions launch as ordinary ones from then on. */
  clearPluginsDraft(projectId: string): Promise<void>;

  // ── Claude Code permission prompts (T2) ──

  /** The session's open prompt, or null. */
  choiceOf(instanceId: string): ChoiceRef | null;
  /** Hear every change to any session's open prompt (it opened, its options were
   *  read off the screen, it closed); returns the unsubscribe. */
  onChoices(cb: () => void): () => void;
  /** Register the one hold on fresh needs-you alerts (the desktop toast, the
   *  phone push, Duck's session watches): it resolves false for a prompt it
   *  answered, true to tell the user. Returns the unregister. */
  holdNeedsYou(hold: (instanceId: string) => Promise<boolean>): () => void;
  /** What a session is for, for judging its prompts. */
  sessionContext(instanceId: string): Promise<SessionContext>;
  /** A line under the session's card in the rail ("auto-approved `npm test`"). */
  noteSession(instanceId: string, line: { text: string; acted: boolean }): void;

  // ── worker sessions (D1) ──

  /** The project at `rootPath` (same folder, any slash style or case), made with
   *  `name` when there is none. */
  ensureProject(name: string, rootPath: string): Promise<ProjectRef>;
  /** The session's last reply in its transcript; null when there is none. */
  lastResponse(instanceId: string): Promise<string | null>;
  /** Mark a session as Duck's worker on `task` (null: yours again): its card says
   *  so, and its alerts go to Duck instead of you. */
  setDuckTask(instanceId: string, task: string | null): void;

  // ── summaries (W3) ──

  /** Give the app's done alerts a body maker (the turn's summary headline; null keeps
   *  the last line), or take it back with null. */
  setDoneSummary(fn: ((instanceId: string, reply: string) => Promise<string | null>) | null): void;
}

/** What a session was started for (step T2). */
export interface Mandate {
  /** The user's words. */
  text: string;
  /** Duck's thread the request came from. */
  threadId: string;
}

export interface SessionContext {
  /** Duck's record when Duck started the session (`from: "duck"`), else the
   *  session's first prompt (`"first prompt"`); null when neither is known. */
  mandate: string | null;
  from: "duck" | "first prompt" | null;
  /** The thread to tell about it, when Duck started the session. */
  threadId: string | null;
  /** The user's latest prompt in the session, when it isn't the mandate. */
  lastPrompt: string | null;
  /** The user's home folder, for `~/` rules. */
  home: string | null;
}

export interface PluginRunRequest {
  projectId: string;
  pluginId: string;
  actionId: string;
  /** Every field's value, a checkbox's as "true"/"false". */
  values: Record<string, string>;
  revision: string;
}

export interface PluginPreview {
  argv: string[];
  cwd: string;
  /** The action's confirm question with the values filled in; null when none. */
  confirm: string | null;
}

/** An action's last run, as its task panel shows it. */
export interface TaskRun {
  status: "dormant" | "spawning" | "running" | "exited" | "stopped" | "error";
  code: number | null;
  endedAt: number | null;
  error: string | null;
}

export interface PluginsRef extends PluginsView {
  /** pluginId → controlId → the field's value as a run sends it. */
  values: Record<string, Record<string, string>>;
  /** `pluginId:actionId` → its last run, for actions that have a task panel. */
  runs: Record<string, TaskRun>;
}

export interface TaskEnd {
  /** `closed`: its panel was closed (which ends the run); `replaced`: it was run
   *  again before this run's end was seen. */
  status: "exited" | "stopped" | "error" | "closed" | "replaced";
  code: number | null;
  error: string | null;
  /** The last lines it printed; empty when there is no terminal to read. */
  tail: string[];
  /** How long it ran, ms. */
  ms: number;
}
