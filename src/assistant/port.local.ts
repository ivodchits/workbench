// The in-process `WorkbenchPort` (step A2): Duck's view of the app, over the existing
// stores. The only file under `src/assistant/` that may import `src/state/**` or
// `src/panels/**` (ESLint enforces it).

import { getSpend } from "../ipc/assistant";
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
import { INTERRUPT_KEY, ptyWrite } from "../ipc/pty";
import type { Instance } from "../ipc/registry";
import { readTranscriptBack } from "../ipc/transcript";
import { getUsageLimits } from "../ipc/usageLimits";
import { sendOrQueue } from "../panels/promptDelivery";
import { release } from "../panels/terminalPool";
import { setActiveProject } from "../state/activeProject";
import {
  closeConsole,
  getOpenConsoles,
  openConsole,
  resumeConsole,
} from "../state/consoles";
import { openDiff } from "../state/diffs";
import { activatePanel } from "../state/dock";
import { openGit } from "../state/git";
import { openNotes } from "../state/notes";
import {
  getPendingChoice,
  markChoiceSent,
  type PendingChoice,
} from "../state/pendingChoice";
import { getRegistry } from "../state/registry";
import {
  answerChoice,
  answerChoiceText,
  deliverWhenReady,
  startNewSession,
} from "../state/remoteActions";
import {
  getLiveStatuses,
  markInterrupted,
  onStatusTransition,
} from "../state/status";
import { effectiveModel } from "../util/models";
import type { ChoiceRef, WorkbenchPort } from "./port";

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

/** Show a session's console as the rail does: its project, its panel focused. */
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

  async sendPrompt(id, text) {
    const i = instance(id);
    if (running(id)) return sendOrQueue(id, text);
    show(i);
    deliverWhenReady(id, text);
    return "starting";
  },
  async createSession({ projectId, title, prompt, worktree, model }) {
    const project = getRegistry().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`no project with id ${projectId}`);
    const { instance: i, message } = await startNewSession(project, {
      title,
      worktree,
      model,
    });
    if (prompt?.trim()) deliverWhenReady(i.id, prompt.trim());
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
    void ptyWrite(id, INTERRUPT_KEY);
    markInterrupted(id); // interrupting fires no hook — update the dot ourselves
  },
  stopSession(id) {
    instance(id);
    // The rail's kill path: close the panel, then end the process.
    closeConsole(id);
    release(id);
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
  onPhase: (cb) => onStatusTransition(cb),
};
