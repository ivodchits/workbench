// The in-process `WorkbenchPort` (step A2): Duck's view of the app, over the existing
// stores. The only file under `src/assistant/` that may import `src/state/**` or
// `src/panels/**` (ESLint enforces it).

import { homeDir } from "@tauri-apps/api/path";

import { getSpend, mandateGet, mandateSet, workerRegister } from "../ipc/assistant";
import {
  gitBranches,
  gitLog,
  gitRepoState,
  gitStatusEntries,
} from "../ipc/git";
import {
  notesCreateWith,
  notesDelete,
  notesList,
  notesRead,
  notesWrite,
} from "../ipc/notes";
import {
  pluginsCheck,
  pluginsDraftClear,
  pluginsDraftRead,
  pluginsDraftStart,
  pluginsPreview,
  pluginsScriptRead,
  pluginsScriptWrite,
  pluginsText,
  pluginsWrite,
} from "../ipc/plugins";
import { ptyWrite } from "../ipc/pty";
import type { Instance } from "../ipc/registry";
import { answerPermission, holdPermissions } from "../ipc/hooks";
import { readTranscript, readTranscriptBack } from "../ipc/transcript";
import { readLastResponse } from "../transcript/feed";
import { getSessionContext, getUsageLimits } from "../ipc/usageLimits";
import { startPluginRunFor } from "../panels/pluginRun";
import { deliverPrompt } from "../state/promptOutbox";
import { lastTypedAt, readScreen, readTail, release, submitPrompt } from "../panels/terminalPool";
import { setAutopilotBadge } from "../state/autopilotBadges";
import { alertAbout } from "../state/notifications";
import { atRest } from "../state/queue";
import { setActiveProject } from "../state/activeProject";
import {
  closeConsole,
  getOpenConsoles,
  openConsole,
  resumeConsole,
} from "../state/consoles";
import { closeDiff, diffIdFor, openDiff } from "../state/diffs";
import { activatePanel } from "../state/dock";
import { openGit } from "../state/git";
import { openNotes } from "../state/notes";
import { fillForDisplay, runValues, type FieldValue } from "../state/pluginModel";
import { getPluginsView, loadPlugins, storedValues } from "../state/plugins";
import {
  getPendingChoice,
  markChoiceSent,
  onChoicesChanged,
  takeHold,
  type PendingChoice,
} from "../state/pendingChoice";
import { isHeadless, markHeadless } from "../state/headless";
import { setPromptHold, shouldTell } from "../state/promptHold";
import { setDoneSummary } from "../state/notifications";
import { duckTask, setDuckOwned } from "../state/duckOwned";
import { addProject, deleteInstance, getRegistry, loadRegistry, renumberInstances } from "../state/registry";
import {
  answerChoice,
  answerChoiceText,
  deliverWhenReady,
  interruptSession as interruptConsole,
  startNewSession,
} from "../state/remoteActions";
import {
  getLiveStatuses,
  markInterrupted,
  onCompactionEnd,
  onStatusTransition,
} from "../state/status";
import { getOpenTasks, getTask, isLive, onTasksChange } from "../state/tasks";
import { setTrustLine } from "../state/trustLines";
import { createTranscript } from "../transcript/model";
import { effectiveModel } from "../util/models";
import type {
  ChoiceRef,
  Mandate,
  SessionContext,
  TaskEnd,
  TaskRun,
  WorkbenchPort,
} from "./port";

function choiceRef(p: PendingChoice): ChoiceRef {
  return {
    id: p.id,
    kind: p.kind,
    toolName: p.toolName,
    input: p.input,
    at: p.at,
    questions: p.questions,
    options: p.options,
    terminalOnly: p.terminalOnly,
    sent: p.sent?.label ?? null,
    optionsFrom: p.source,
    held: p.held !== null,
  };
}

function instance(id: string): Instance {
  const i = getRegistry().instances.find((x) => x.id === id);
  if (!i) throw new Error(`no session with id ${id}`);
  return i;
}

const running = (id: string) =>
  getOpenConsoles().some((c) => c.instanceId === id && c.status === "running");

function requireRunning(i: Instance): void {
  if (!running(i.id)) throw new Error(`"${i.title}" isn't running.`);
}

/** A running console that is Claude Code's (not a shell). */
function requireClaude(i: Instance): void {
  requireRunning(i);
  if (isHeadless(i.id))
    throw new Error(
      `"${i.title}" is one of your headless workers: it has no screen or keys. Answer its prompts with answer_choice, and send it prompts or interrupt it as usual.`,
    );
  if (getOpenConsoles().some((c) => c.instanceId === i.id && c.kind !== "claude"))
    throw new Error(`"${i.title}"'s console is a shell, not Claude Code.`);
}

/** How long after your last keystroke in a console Duck's keys are refused. */
const TYPING_QUIET_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many of a task's last lines Duck's report carries. */
const TAIL_LINES = 15;
/** The PTY's exit can come just before its last output reaches the terminal. */
const TAIL_SETTLE_MS = 300;
/** How long `/compact` gets to start compacting, and to finish. */
const COMPACT_START_MS = 30_000;
const COMPACT_MAX_MS = 15 * 60_000;
const COMPACT_POLL_MS = 250;

// ── mandates (T2) ──

/** instance id → its mandate (null: none stored), as read or written this run. */
const mandates = new Map<string, Mandate | null>();
/** `instance:session` → that conversation's first prompt. */
const firstPrompts = new Map<string, string | null>();
/** How much of a transcript's start is read for its first prompt. */
const FIRST_PAGE_BYTES = 256 * 1024;
let home: Promise<string | null> | null = null;

function rememberMandate(instanceId: string, m: Mandate): void {
  mandates.set(instanceId, m);
  void mandateSet(instanceId, JSON.stringify(m)).catch((e: unknown) =>
    console.warn("duck: a session's mandate wasn't stored", e),
  );
}

function forgetMandate(instanceId: string): void {
  mandates.set(instanceId, null);
  void mandateSet(instanceId, null).catch(() => {});
}

async function storedMandate(instanceId: string): Promise<Mandate | null> {
  const known = mandates.get(instanceId);
  if (known !== undefined) return known;
  let m: Mandate | null = null;
  try {
    const raw = await mandateGet(instanceId);
    const v = raw ? (JSON.parse(raw) as Partial<Mandate>) : null;
    if (v && typeof v.text === "string" && typeof v.threadId === "string")
      m = { text: v.text, threadId: v.threadId };
  } catch {
    // unreadable: treated as none
  }
  if (!mandates.has(instanceId)) mandates.set(instanceId, m);
  return mandates.get(instanceId) ?? null;
}

/** The user prompts on a page of transcript lines, in order. */
function userPrompts(lines: string[]): string[] {
  const t = createTranscript();
  t.append(lines);
  return t.items.flatMap((item) => (item.kind === "user" && item.text.trim() ? [item.text] : []));
}

/** Show a session's console as the rail does: its project, its panel focused. */
const isRemote = (i: Instance) =>
  !!getRegistry().projects.find((p) => p.id === i.projectId)?.remoteSshDest;

/** Start a session that isn't running, continuing its last conversation (a fresh
 *  one when it has none). A worker (D1) starts out of your way, like the first
 *  time; a session of yours is shown. Any dead console is replaced. */
function relaunch(i: Instance): void {
  if (duckTask(i.id)) {
    resumeConsole(i, undefined, { background: true });
    return;
  }
  setActiveProject(i.projectId);
  resumeConsole(i);
  activatePanel(i.id);
}

function show(i: Instance): void {
  setActiveProject(i.projectId);
  openConsole(i);
  activatePanel(i.id);
}

export const localPort: WorkbenchPort = {
  listProjects() {
    const { projects, groups } = getRegistry();
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      group: groups.find((g) => g.id === p.groupId)?.name ?? null,
      remote: p.remoteSshDest != null,
    }));
  },
  listSessions(projectId) {
    const live = getLiveStatuses();
    const { projects, instances } = getRegistry();
    return instances
      .filter((i) => !projectId || i.projectId === projectId)
      .map((i) => {
        const s = live.get(i.id);
        const choice = getPendingChoice(i.id);
        return {
          id: i.id,
          projectId: i.projectId,
          title: i.title,
          taskNote: i.taskNote,
          phase: s?.phase ?? "offline",
          compacting: s?.compacting ?? false,
          subagents: s?.subagents ?? 0,
          worktreeBranch: i.worktreeOn ? i.branch : null,
          model: effectiveModel(i, projects.find((p) => p.id === i.projectId)),
          permissionMode:
            i.permissionMode ?? projects.find((p) => p.id === i.projectId)?.defaultPermissionMode ?? null,
          duckTask: duckTask(i.id),
          workingDir: i.workingDir,
          lastActivity: s?.updatedAt ?? i.lastActivityAt,
          choice: choice ? choiceRef(choice) : null,
        };
      });
  },
  readTranscriptBack: (instanceId, before) =>
    readTranscriptBack(instanceId, before),
  usageLimits: getUsageLimits,
  async git(dir, { commits, since }) {
    const [branches, status, log, state] = await Promise.all([
      gitBranches(dir),
      gitStatusEntries(dir),
      gitLog(dir, { limit: commits, since: since ?? null }),
      gitRepoState(dir),
    ]);
    return { root: dir, branches, status, log, operation: state.operation };
  },
  listNotes: notesList,
  readNote: notesRead,
  spend: getSpend,

  async sendPrompt(id, text, opts = {}) {
    instance(id);
    const d = deliverPrompt(
      {
        instanceId: id,
        running: () => running(id),
        launch: () => relaunch(instance(id)),
        typedOnly: isRemote(instance(id)),
      },
      text,
      { now: opts.now },
    );
    // Typed in now: whether it was taken is known within seconds, so wait for it.
    if (d.state === "sent") return (await d.done).ok ? "sent" : "unsent";
    void d.done.then((o) => {
      if (!o.ok) opts.onFailed?.(o.why);
    });
    return d.state;
  },
  async createSession({ projectId, title, prompt, worktree, model, permissionMode, mandate, worker, trustFolder, headless }) {
    const project = getRegistry().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`no project with id ${projectId}`);
    const { instance: i, message } = await startNewSession(project, {
      title,
      worktree,
      model,
      permissionMode,
      beforeLaunch: async (inst) => {
        if (worker) await workerRegister(inst.id, worker);
        if (headless) markHeadless(inst.id, true);
        // Its console opens next: the first prompt goes on claude's command line.
        if (prompt?.trim())
          void deliverPrompt(
            { instanceId: inst.id, running: () => false, launch: () => {}, typedOnly: isRemote(inst), trustFolder },
            prompt.trim(),
          ).done.then((o) => {
            if (!o.ok) console.warn(`duck: the first prompt of "${inst.title}" wasn't taken: ${o.why}`);
          });
      },
      // A worker starts out of your way; you open it from its card or Duck's.
      background: !!worker,
    });
    if (mandate?.text.trim()) rememberMandate(i.id, mandate);
    return { id: i.id, title: i.title, message };
  },
  startSession(id) {
    show(instance(id));
  },
  resumeSession(id, sessionId) {
    const i = instance(id);
    if (!sessionId && !i.lastSessionId)
      throw new Error(`"${i.title}" has no past session to resume.`);
    setActiveProject(i.projectId);
    resumeConsole(i, sessionId);
    activatePanel(i.id);
  },
  answerChoice(id, choiceId, answer) {
    const i = instance(id);
    const p = getPendingChoice(id);
    if (!p || p.id !== choiceId)
      throw new Error(
        `That prompt in "${i.title}" is no longer open. Read the session again.`,
      );
    if (p.sent) throw new Error(`An answer was already sent: ${p.sent.label}.`);
    if (answer === "deny") {
      answerChoice(id, "deny");
      const label = p.kind === "permission" ? "deny" : "cancel";
      markChoiceSent(id, choiceId, label);
      return label;
    }
    if (p.terminalOnly)
      throw new Error(`It can only be answered in the terminal: ${p.terminalOnly}`);
    if (typeof answer === "object") {
      // A question's own options come from the hook; the TUI adds "Type
      // something" right after them.
      if (p.kind !== "question")
        throw new Error("Only a question takes a typed answer; pick one of its options.");
      const text = answer.text.replace(/\s+/g, " ").trim();
      if (!text) throw new Error("The typed answer is empty.");
      answerChoiceText(id, p.options.length + 1, text);
      markChoiceSent(id, choiceId, text);
      return text;
    }
    const picked = p.options.find((o) => o.key === answer);
    if (!picked)
      throw new Error(
        `There is no option ${answer}. Options: ${p.options.map((o) => `${o.key} ${o.label}`).join("; ")}.`,
      );
    if (picked.typed)
      throw new Error(`"${picked.label}" asks for typed text: answer it in the terminal.`);
    answerChoice(id, { option: picked.key });
    markChoiceSent(id, choiceId, picked.label);
    return picked.label;
  },
  interruptSession(id) {
    requireRunning(instance(id));
    interruptConsole(id);
  },
  readScreen(id) {
    requireClaude(instance(id));
    return readScreen(id);
  },
  async pressKeys(id, keys, gapMs) {
    const i = instance(id);
    requireClaude(i);
    const enc = new TextEncoder();
    for (let n = 0; n < keys.length; n++) {
      // Checked before every key: you may start typing halfway through.
      const typed = lastTypedAt(id);
      if (typed !== null && Date.now() - typed < TYPING_QUIET_MS)
        throw new Error(
          `The user is typing in "${i.title}"${n ? ` (stopped after ${n} of ${keys.length} keys)` : ""}; nothing more was sent. Try again once they've stopped, or ask them.`,
        );
      if (n > 0) await sleep(gapMs);
      await ptyWrite(id, enc.encode(keys[n]));
      // As a key typed in the console: Esc or Ctrl+C interrupts and fires no hook.
      if (keys[n] === "\x1b" || keys[n] === "\x03") markInterrupted(id);
    }
  },
  stopSession(id) {
    instance(id);
    // The rail's kill path: close the panel, then end the process.
    closeConsole(id);
    release(id);
  },
  async killSession(id) {
    const i = instance(id);
    if (i.worktreeOn)
      throw new Error(
        `"${i.title}" has a worktree, which killing it would leave on disk. Ask the user to remove the worktree from the rail first, or to kill it there.`,
      );
    const project = getRegistry().projects.find((p) => p.id === i.projectId);
    if (project?.remoteSshDest && i.remoteTmuxSession)
      throw new Error(
        `"${i.title}" runs in a tmux session on ${project.remoteSshDest}; ending it needs the user's SSH password. Ask them to kill it from the rail.`,
      );
    // The rail's kill path (KillConfirm), without the dialog.
    closeConsole(id);
    release(id);
    closeDiff(diffIdFor(id));
    await deleteInstance(id);
    forgetMandate(id);
    await renumberInstances(i.projectId);
  },
  openPanel(projectId, kind, instanceId) {
    const project = getRegistry().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`no project with id ${projectId}`);
    const i = instanceId ? instance(instanceId) : null;
    if (i && i.projectId !== projectId)
      throw new Error(`"${i.title}" isn't in ${project.name}.`);
    switch (kind) {
      case "console":
        if (!i) throw new Error("Opening a console needs a session.");
        show(i);
        return;
      case "diff":
        if (!i) throw new Error("A diff needs a session.");
        setActiveProject(projectId);
        openDiff({
          instanceId: i.id,
          projectId,
          repoRoot: project.rootPath,
          workingDir: i.workingDir,
          title: i.title,
        });
        return;
      case "git":
        setActiveProject(projectId);
        openGit({ projectId, repoRoot: project.rootPath, title: project.name });
        return;
      case "notes":
        setActiveProject(projectId);
        openNotes({ projectId, title: project.name });
        return;
    }
  },
  writeNote: notesWrite,
  createNote: notesCreateWith,
  deleteNote: notesDelete,
  onPhase: (cb) =>
    onStatusTransition((id, phase, prev) => {
      if (phase !== "needs_you" || prev === "needs_you") return cb(id, phase, prev);
      void shouldTell(id).then((tell) => {
        if (tell && getLiveStatuses().get(id)?.phase === "needs_you") cb(id, phase, prev);
      });
    }),

  async listPlugins(projectId) {
    await loadPlugins(projectId);
    const view = getPluginsView(projectId);
    if (!view) throw new Error("the plugin file couldn't be read");
    const values: Record<string, Record<string, string>> = {};
    for (const plugin of view.file?.plugins ?? [])
      values[plugin.id] = runValues(plugin, storedValues(projectId, plugin.id));
    const runs: Record<string, TaskRun> = {};
    for (const t of getOpenTasks())
      if (t.projectId === projectId)
        runs[`${t.pluginId}:${t.actionId}`] = {
          status: t.status,
          code: t.code,
          endedAt: t.endedAt,
          error: t.error,
        };
    return { ...view, values, runs };
  },
  pluginsText,
  checkPlugins: pluginsCheck,
  writePlugins: pluginsWrite,
  readScript: pluginsScriptRead,
  writeScript: pluginsScriptWrite,
  async previewPluginAction(req) {
    const t = await pluginsPreview(req);
    await loadPlugins(req.projectId);
    const plugin = getPluginsView(req.projectId)?.file?.plugins.find((p) => p.id === req.pluginId);
    const action = plugin?.actions.find((a) => a.id === req.actionId);
    let confirm: string | null = null;
    if (plugin && action?.confirm) {
      // The run's values as the toolbar stores them: a checkbox's as a flag.
      const shown: Record<string, FieldValue> = {};
      for (const c of plugin.controls)
        if (c.type !== "button" && c.id in req.values)
          shown[c.id] = c.type === "checkbox" ? req.values[c.id] === "true" : req.values[c.id];
      confirm = fillForDisplay(action.confirm, plugin, shown);
    }
    return { argv: t.argv, cwd: t.cwd, confirm };
  },
  async runPluginAction(req) {
    const r = await startPluginRunFor(req.projectId, req.pluginId, req.actionId, req.values, req.revision);
    return { taskId: r.taskId, label: r.label };
  },
  async startPluginsDraft({ projectId, title, model, prompt, mandate }) {
    const project = getRegistry().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`no project with id ${projectId}`);
    if (project.remoteSshDest)
      throw new Error(`${project.name} is a remote project: its sessions can't reach the draft on this machine.`);
    let draftDir = "";
    const { instance: i } = await startNewSession(project, {
      title,
      model,
      beforeLaunch: async (inst) => {
        draftDir = await pluginsDraftStart(projectId, inst.id);
      },
    });
    if (mandate?.text.trim()) rememberMandate(i.id, mandate);
    deliverWhenReady(i.id, prompt(draftDir));
    return { id: i.id, title: i.title, draftDir };
  },
  choiceOf(id) {
    const p = getPendingChoice(id);
    return p ? choiceRef(p) : null;
  },
  holdPermissions(on) {
    void holdPermissions(on).catch((e: unknown) => console.warn("duck: permission holds not switched", e));
  },
  async answerHeld(id, choiceId, decision) {
    const hold = takeHold(id, choiceId);
    if (hold === null) return false;
    const ok = await answerPermission(hold, decision).catch(() => false);
    if (ok && decision) markChoiceSent(id, choiceId, decision.behavior === "allow" ? "Yes" : "deny");
    return ok;
  },
  onChoices: (cb) => onChoicesChanged(cb),
  holdNeedsYou: (hold) => setPromptHold(hold),
  async sessionContext(id): Promise<SessionContext> {
    instance(id);
    const m = await storedMandate(id);
    const back = await readTranscriptBack(id).catch(() => null);
    const recent = back ? userPrompts(back.lines) : [];
    let first: string | null = null;
    if (!m && back?.sessionId) {
      const key = `${id}:${back.sessionId}`;
      if (!firstPrompts.has(key)) {
        // The page from the end may already start at the beginning.
        const page = back.offset === 0 ? back : await readTranscript(id, 0, FIRST_PAGE_BYTES).catch(() => null);
        firstPrompts.set(key, (page && userPrompts(page.lines)[0]) ?? null);
      }
      first = firstPrompts.get(key) ?? null;
    }
    const mandate = m?.text ?? first;
    const last = recent[recent.length - 1] ?? null;
    home ??= homeDir().catch(() => null);
    return {
      mandate,
      from: m ? "duck" : first ? "first prompt" : null,
      threadId: m?.threadId ?? null,
      lastPrompt: last && last.trim() !== mandate?.trim() ? last : null,
      home: await home,
    };
  },
  noteSession(id, line) {
    setTrustLine(id, { ...line, at: Date.now() });
  },
  async ensureProject(name, rootPath) {
    const same = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const find = () => localPort.listProjects().find((p) => !p.remote && same(p.rootPath) === same(rootPath));
    // Before the registry has loaded, every project would look missing.
    if (!getRegistry().loaded) await loadRegistry();
    const known = find();
    if (known) return known;
    await addProject({ name, rootPath });
    const made = find();
    if (!made) throw new Error(`Could not register ${rootPath} as a project: ${getRegistry().error ?? "unknown error"}`);
    return made;
  },
  lastResponse: (id) => readLastResponse((before) => readTranscriptBack(id, before)),
  setDuckTask: (id, task) => setDuckOwned(id, task),
  setHeadless: (id, on) => markHeadless(id, on),
  compactSession(id, focus) {
    const i = instance(id);
    requireRunning(i);
    if (isRemote(i)) return Promise.reject(new Error(`"${i.title}" is remote: its compaction can't be followed (no hooks).`));
    if (!atRest(getLiveStatuses().get(id)))
      return Promise.reject(new Error(`"${i.title}" is mid-turn or waiting on a prompt; compaction waits for a finished turn.`));
    const line = focus?.replace(/\s+/g, " ").trim();
    return new Promise<void>((resolve, reject) => {
      let started = false;
      const finish = (err: Error | null) => {
        off();
        clearInterval(poll);
        clearTimeout(startBy);
        clearTimeout(endBy);
        if (err) reject(err);
        else resolve();
      };
      const off = onCompactionEnd((x, live) => {
        if (x !== id) return;
        if (live.phase === "ended") finish(new Error(`"${i.title}" ended while it compacted.`));
        else finish(null);
      });
      // PreCompact and PostCompact paint at once; a poll is enough to see it began.
      const poll = setInterval(() => {
        if (getLiveStatuses().get(id)?.compacting) started = true;
      }, COMPACT_POLL_MS);
      const startBy = setTimeout(() => {
        if (!started) finish(new Error("Claude Code didn't start compacting"));
      }, COMPACT_START_MS);
      const endBy = setTimeout(() => finish(new Error("the compaction didn't finish in 15 minutes")), COMPACT_MAX_MS);
      submitPrompt(id, line ? `/compact ${line}` : "/compact");
    });
  },
  async contextUsed(id) {
    return (await getSessionContext(id))?.usedPercentage ?? null;
  },
  setAutopilotBadge,
  alertUser: alertAbout,
  setDoneSummary,
  readPluginsDraft: pluginsDraftRead,
  clearPluginsDraft: pluginsDraftClear,
  onTaskEnd(taskId, cb) {
    const run = getTask(taskId)?.run ?? 0;
    const started = Date.now();
    let done = false;
    const finish = (end: Omit<TaskEnd, "tail" | "ms">, tail: boolean) => {
      done = true;
      off();
      const report = () =>
        cb({ ...end, tail: (tail && readTail(taskId, TAIL_LINES)) || [], ms: Date.now() - started });
      if (tail) setTimeout(report, TAIL_SETTLE_MS);
      else report();
    };
    const check = () => {
      if (done) return;
      const t = getTask(taskId);
      if (!t) finish({ status: "closed", code: null, error: null }, false);
      else if (t.run !== run) finish({ status: "replaced", code: null, error: null }, false);
      else if (!isLive(t) && t.status !== "dormant")
        finish({ status: t.status as "exited" | "stopped" | "error", code: t.code, error: t.error }, true);
    };
    const off = onTasksChange(check);
    check();
    return () => {
      done = true;
      off();
    };
  },
};
