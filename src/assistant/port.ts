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
import type { PermissionDecision } from "../ipc/hooks";
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
  /** Its hook response is held for Duck (T4): no menu is drawn until it's answered
   *  with `answerHeld`. */
  held: boolean;
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
  /** Its worktree was made by Workbench for it (and goes with it); false for an
   *  existing worktree it was opened in, which is never removed with it. */
  worktreeOwned: boolean;
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

/** Where a prompt went: taken by the session now, waiting for its turn (or for a
 *  prompt ahead of it), to a console just started with it, or typed but not taken. */
export type PromptDelivery = "sent" | "queued" | "starting" | "unsent";

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

  /** Send a prompt: now if the session is between turns, else when its turn ends
   *  (everything waiting then goes in as one prompt); with `now`, into the running
   *  turn instead (never into a prompt waiting on the user). A session that isn't
   *  running is started with it, continuing its last conversation. `onFailed` hears
   *  a queued or starting prompt that Claude Code never took. */
  sendPrompt(
    instanceId: string,
    text: string,
    opts?: { now?: boolean; onFailed?: (why: string) => void },
  ): Promise<PromptDelivery>;
  /** A new session, as the rail's "new instance" (focused, console open). With a
   *  `prompt`, it goes in once the prompt box shows. */
  createSession(opts: {
    projectId: string;
    title?: string;
    prompt?: string;
    worktree?: boolean;
    /** Open it in this existing worktree of the project (its folder or branch)
     *  instead of the root or a new one. Refused for a worktree another running
     *  session works in, unless `shareWorktree`. */
    existingWorktree?: string;
    shareWorktree?: boolean;
    /** With `existingWorktree`: continue its newest conversation there. */
    resume?: boolean;
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
    /** Run it headless (step D4): `claude -p` over stream-json, no terminal. */
    headless?: boolean;
  }): Promise<{ id: string; title: string; message: string | null }>;
  /** Open (or focus) a session's console, starting a fresh Claude Code session if
   *  none is running. */
  startSession(instanceId: string): void;
  /** Relaunch the console on a past session: `sessionId`, else its last one.
   *  Refused when `sessionId` is a conversation of another folder of the project
   *  (Claude Code finds conversations per folder), naming that folder. */
  resumeSession(instanceId: string, sessionId?: string): Promise<void>;
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
  /** The session's terminal screen as text, one string per row (step W6); null when
   *  this window holds no terminal for it. Throws for a session whose Claude Code
   *  console isn't running. */
  readScreen(instanceId: string): string[] | null;
  /** Write keys into the session's terminal, each its own write `gapMs` apart (a
   *  burst would be read as a paste). Refused while the user has typed there in the
   *  last few seconds. */
  pressKeys(instanceId: string, keys: string[], gapMs: number): Promise<void>;
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
  /** Hear each session's compaction end, with the phase it's back in. A `/compact`
   *  from rest ends with no phase change (and no `Stop`), so `onPhase` never hears
   *  it: whatever waits for the session to be at rest needs this too. */
  onCompactionEnd(cb: (instanceId: string, phase: SessionPhase) => void): () => void;
  /** True while Duck's delivery still holds a prompt for the session: being typed
   *  in, or waiting for its turn to end. Its phase doesn't show it yet. */
  promptPending(instanceId: string): boolean;
  /** Hear each new session the user starts (the rail, the phone), not Duck's own
   *  (step H8: the project's reminders come up). */
  onSessionYouStarted(cb: (instanceId: string, projectId: string) => void): () => void;

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
  /** Hold permission prompts' hook responses for Duck (T4) while `on`. */
  holdPermissions(on: boolean): void;
  /** Answer the held prompt `choiceId` as data: a decision, or null to show its
   *  menu. False when it isn't held any more (someone answered first, or it timed
   *  out and the menu is drawn). */
  answerHeld(instanceId: string, choiceId: string, decision: PermissionDecision | null): Promise<boolean>;
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
  /** Duck's word on a session's open question or plan (step T3), shown on its
   *  choice card while that prompt is open. */
  adviseChoice(instanceId: string, advice: ChoiceAdvice): void;

  // ── worker sessions (D1) ──

  /** The project at `rootPath` (same folder, any slash style or case), made with
   *  `name` when there is none. */
  ensureProject(name: string, rootPath: string): Promise<ProjectRef>;
  /** The session's last reply in its transcript; null when there is none. */
  lastResponse(instanceId: string): Promise<string | null>;
  /** Mark a session as Duck's worker on `task` (null: yours again): its card says
   *  so, and its alerts go to Duck instead of you. */
  setDuckTask(instanceId: string, task: string | null): void;
  /** Whether the session's next launches are headless (step D4). */
  setHeadless(instanceId: string, on: boolean): void;

  // ── Duck's own changes (L3) ──

  /** What a session's worktree changed against the project's current branch:
   *  its branch, that base, and the files (committed or not). Throws for a session
   *  without a worktree. */
  worktreeChanges(instanceId: string): Promise<WorktreeChanges>;
  /** What removing the session's worktree would lose (`dispose_worktree`): commits
   *  not in the project's main branch, and uncommitted or untracked files. Throws
   *  for a session without a worktree or in a remote project. */
  worktreeLoss(instanceId: string): Promise<WorktreeLoss>;
  /** End the session, remove its worktree and delete its branch, and take it off
   *  the rail. git checks again first: refused, naming what would be lost, unless
   *  nothing would be or `force`. Returns the check it went on. */
  disposeWorktree(instanceId: string, force: boolean): Promise<WorktreeLoss>;
  /** The rail's "merge and remove the worktree": its branch is merged into the
   *  project's current branch, the worktree and branch go, and the session works
   *  in the project root again. Throws git's message on a conflict or a dirty
   *  tree, leaving everything as it was. Returns the branch merged into. */
  mergeWorktree(instanceId: string): Promise<string>;
  /** The project's git worktrees besides its own folder, with the sessions in each
   *  and its past conversations. Throws for a remote project or one without git. */
  listWorktrees(projectId: string): Promise<WorktreeRef[]>;
  /** The project's worktree `target` names (its folder or its branch); throws for
   *  one that isn't the project's, for its own folder and for one gone from disk. */
  findWorktree(projectId: string, target: string): Promise<WorktreeRef>;
  /** Point a session at an existing worktree of its project (`target`: folder or
   *  branch), so it works and finds its conversations there; the worktree is never
   *  removed with it. Refused for a worktree another running session works in,
   *  unless `share`. With `resume`, continues the newest conversation there. A
   *  running session restarts there. */
  attachWorktree(
    instanceId: string,
    target: string,
    opts: { share?: boolean; resume?: boolean },
  ): Promise<{ worktree: WorktreeRef; resumed: string | null }>;
  /** A new shell in the project's root, running `command` once it's up. */
  runInShell(projectId: string, command: string, label: string): Promise<void>;

  // ── plan autopilot (P1) ──

  /** Run `/compact` (with a focus line) in a session between turns, and resolve when
   *  the compaction ends. Throws when it's mid-turn, didn't start compacting, or
   *  ended meanwhile. */
  compactSession(instanceId: string, focus: string | null): Promise<void>;
  /** How full the session's context is (percent), as its statusline last said;
   *  null when unknown. */
  contextUsed(instanceId: string): Promise<number | null>;
  /** The autopilot line under the session's card (null: none). A session on a
   *  running autopilot gets no done alerts. */
  setAutopilotBadge(instanceId: string, badge: AutopilotBadgeRef | null): void;
  /** A desktop toast and phone push about a session, on the user's routes. */
  alertUser(instanceId: string, title: string, body: string): void;
  /** Hear the user come back to the app after a while away (the window regains
   *  focus), with when they left (epoch ms); returns the unsubscribe. */
  onUserBack(cb: (since: number) => void): () => void;

  // ── summaries (W3) ──

  /** Give the app's done alerts a body maker (the turn's summary headline; null keeps
   *  the last line), or take it back with null. */
  setDoneSummary(fn: ((instanceId: string, reply: string) => Promise<string | null>) | null): void;
}

/** A worktree's changes (L3). */
export interface WorktreeChanges {
  branch: string;
  /** The branch it's compared with (the project's current one). */
  base: string;
  /** Paths relative to the repo, forward-slashed. */
  files: string[];
  /** Files with changes not committed on the branch. */
  uncommitted: string[];
  insertions: number;
  deletions: number;
}

/** One of a project's git worktrees. */
export interface WorktreeRef {
  path: string;
  /** null on a detached HEAD. */
  branch: string | null;
  /** Its last commit, `<short sha> <subject>`. */
  lastCommit: string;
  /** When that was, epoch seconds. */
  committedAt: number | null;
  /** The sessions on the rail working in it. */
  sessions: { id: string; title: string; running: boolean }[];
  /** Past Claude Code conversations there, newest first (at most 5). */
  conversations: { sessionId: string; firstPrompt: string; modifiedAt: number }[];
  /** How many there are in all. */
  conversationCount: number;
}

/** What removing a worktree would lose. */
export interface WorktreeLoss {
  /** The worktree's folder. */
  worktree: string;
  branch: string;
  /** The project's main branch it's checked against. */
  base: string;
  /** Commits on the branch the main branch doesn't have. */
  unmerged: number;
  /** The newest of them (at most 10), `<short sha> <subject>`. */
  commits: string[];
  /** Uncommitted and untracked files in the worktree. */
  dirty: string[];
}

/** A session's autopilot as its card shows it. */
export interface AutopilotBadgeRef {
  state: "running" | "paused" | "stopped";
  text: string;
  why: string | null;
  threadId: string;
}

/** What a session was started for (step T2). */
export interface Mandate {
  /** The user's words. */
  text: string;
  /** Duck's thread the request came from. */
  threadId: string;
  /** The user handed the session over (step T3): Duck answers its questions. */
  delegated?: boolean;
}

/** Duck's word on an open question or plan (step T3). */
export interface ChoiceAdvice {
  /** The prompt it is about; shown only while that one is open. */
  choiceId: string;
  /** A suggested answer, the answer Duck gave, a question left to the user, or a
   *  plan review's verdict. */
  tone: "suggestion" | "answered" | "yours" | "pass" | "concerns";
  text: string;
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
  /** The user handed the session over (step T3). */
  delegated: boolean;
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
