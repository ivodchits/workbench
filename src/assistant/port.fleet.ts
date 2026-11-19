// Every Workbench machine as one port (fleet plan F3.1): what Duck's tools get at
// the main. Projects and sessions are listed from all of them, each with its
// machine's name, and a call goes to the machine that has the session or project
// it names (ids are unique across machines). Anything else is this machine's.
//
// So the Workbench tools didn't change to reach the laptop: "start a session in
// workbench on the laptop" finds the laptop's project, and every call on that
// session goes there. The machine is in what `list_projects` and `list_sessions`
// say, and a project's name can carry it (`workbench@laptop`, `read.ts`).
//
// The members that take the engine's callbacks (holds, the done summary, plugin
// drafts, task ends) and the ones about this machine (spend, limits, ensuring a
// project) stay local.

import type { PhaseListener, ProjectRef, SessionPhase, SessionRef, WorkbenchPort } from "./port";
import type { PortEvent, RemotePort } from "./port.remote";
import type { Remotes } from "./remotes";

export interface FleetPort extends WorkbenchPort {
  /** Hand out an event another machine passed on (`createRemotePort`'s `events`). */
  dispatch(name: PortEvent, args: unknown[]): void;
}

/** `remotes()`: the other machines connected now. `localName()`: this machine's
 *  name, once there are others to tell it from. */
export function createFleetPort(
  local: WorkbenchPort,
  localName: () => string,
  remotes: () => readonly RemotePort[],
  gitRemotes?: Remotes,
): FleetPort {
  const live = () => remotes().filter((r) => !r.closed);
  const bySession = (id: string) => live().find((r) => r.sessions().some((s) => s.id === id)) ?? null;
  const byProject = (id: string) => live().find((r) => r.projects().some((p) => p.id === id)) ?? null;
  /** The machine whose project or session folder `dir` is in. */
  const byDir = (dir: string) => {
    const d = dir.replace(/\\/g, "/").toLowerCase();
    const under = (root: string) => {
      const r = root.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
      return d === r || d.startsWith(r + "/");
    };
    return live().find((r) => r.sessions().some((s) => under(s.workingDir)) || r.projects().some((p) => under(p.rootPath))) ?? null;
  };
  const tag = <T extends { machine?: string }>(list: T[], machine: string): T[] => list.map((x) => ({ ...x, machine }));

  const phase = new Set<PhaseListener>();
  const compaction = new Set<(id: string, phase: SessionPhase) => void>();
  const started = new Set<(id: string, projectId: string) => void>();
  const choices = new Set<() => void>();
  const on = <F>(set: Set<F>, cb: F) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  local.onPhase((id, p, prev) => phase.forEach((l) => l(id, p, prev)));
  local.onCompactionEnd((id, p) => compaction.forEach((l) => l(id, p)));
  local.onSessionYouStarted((id, pid) => started.forEach((l) => l(id, pid)));
  local.onChoices(() => choices.forEach((l) => l()));

  /** Run there when `r` is another machine, else here. */
  function route<T>(r: RemotePort | null, method: string, args: unknown[], mine: () => T): T | Promise<T> {
    return r ? (r.call(method, args) as Promise<T>) : mine();
  }
  /** A member with no answer: fire and forget there. */
  function fire(r: RemotePort | null, method: string, args: unknown[], mine: () => void): void {
    if (!r) return mine();
    void r.call(method, args).catch((e: unknown) => console.warn(`duck: ${method} on ${r.name} failed`, e));
  }
  const localOnly = (what: string, r: RemotePort | null) => {
    if (r) throw new Error(`${what} works only on the machine Duck runs on, not on ${r.name}`);
  };

  const port: FleetPort = {
    dispatch(name, args) {
      switch (name) {
        case "phase": {
          const [id, p, prev] = args as [string, SessionPhase, SessionPhase | null];
          phase.forEach((l) => l(id, p, prev));
          return;
        }
        case "compactionEnd": {
          const [id, p] = args as [string, SessionPhase];
          compaction.forEach((l) => l(id, p));
          return;
        }
        case "sessionYouStarted": {
          const [id, pid] = args as [string, string];
          started.forEach((l) => l(id, pid));
          return;
        }
        case "choices":
          choices.forEach((l) => l());
      }
    },

    listProjects(): ProjectRef[] {
      const others = live();
      const mine = gitRemotes ? gitRemotes.attach(local.listProjects()) : local.listProjects();
      if (!others.length) return mine;
      return [...tag(mine, localName()), ...others.flatMap((r) => tag(r.projects(), r.name))];
    },
    listSessions(projectId?: string): SessionRef[] {
      const others = live();
      const mine = local.listSessions(projectId);
      if (!others.length) return mine;
      const theirs = others.flatMap((r) =>
        tag(projectId ? r.sessions().filter((s) => s.projectId === projectId) : r.sessions(), r.name),
      );
      return [...tag(mine, localName()), ...theirs];
    },
    readTranscriptBack: (id, before) => route(bySession(id), "readTranscriptBack", [id, before], () => local.readTranscriptBack(id, before)) as never,
    usageLimits: () => local.usageLimits(),
    git: (dir, opts) => route(byDir(dir), "git", [dir, opts], () => local.git(dir, opts)) as never,
    listNotes: (pid) => route(byProject(pid), "listNotes", [pid], () => local.listNotes(pid)) as never,
    readNote: (pid, n) => route(byProject(pid), "readNote", [pid, n], () => local.readNote(pid, n)) as never,
    spend: () => local.spend(),
    sendPrompt(id, text, opts) {
      const r = bySession(id);
      return (r ? r.sendPrompt(id, text, opts) : local.sendPrompt(id, text, opts)) as never;
    },
    createSession: (opts) => route(byProject(opts.projectId), "createSession", [opts], () => local.createSession(opts)) as never,
    startSession: (id) => fire(bySession(id), "startSession", [id], () => local.startSession(id)),
    resumeSession: (id, sid) => route(bySession(id), "resumeSession", [id, sid], () => local.resumeSession(id, sid)) as never,
    answerChoice(id, choiceId, answer) {
      const r = bySession(id);
      if (!r) return local.answerChoice(id, choiceId, answer);
      // The label as the machine will say it, from its mirror.
      const c = r.sessions().find((s) => s.id === id)?.choice;
      if (!c || c.id !== choiceId) throw new Error("that prompt is no longer the one waiting");
      void r.call("answerChoice", [id, choiceId, answer]).catch((e: unknown) => console.warn(`duck: an answer on ${r.name} failed`, e));
      if (answer === "deny") return c.kind === "permission" ? "deny" : "cancel";
      if (typeof answer === "number") return c.options.find((o) => o.key === answer)?.label ?? String(answer);
      return answer.text;
    },
    interruptSession: (id) => fire(bySession(id), "interruptSession", [id], () => local.interruptSession(id)),
    readScreen: (id) => (bySession(id) ? null : local.readScreen(id)),
    pressKeys: (id, keys, gap) => route(bySession(id), "pressKeys", [id, keys, gap], () => local.pressKeys(id, keys, gap)) as never,
    stopSession: (id) => fire(bySession(id), "stopSession", [id], () => local.stopSession(id)),
    killSession: (id) => route(bySession(id), "killSession", [id], () => local.killSession(id)) as never,
    openPanel: (pid, kind, id) => fire(byProject(pid), "openPanel", [pid, kind, id], () => local.openPanel(pid, kind, id)),
    writeNote: (pid, n, c, rev) => route(byProject(pid), "writeNote", [pid, n, c, rev], () => local.writeNote(pid, n, c, rev)) as never,
    createNote: (pid, n, c) => route(byProject(pid), "createNote", [pid, n, c], () => local.createNote(pid, n, c)) as never,
    deleteNote: (pid, n) => route(byProject(pid), "deleteNote", [pid, n], () => local.deleteNote(pid, n)) as never,
    onPhase: (cb) => on(phase, cb),
    onCompactionEnd: (cb) => on(compaction, cb),
    promptPending: (id) => bySession(id)?.promptPending(id) ?? local.promptPending(id),
    onSessionYouStarted: (cb) => on(started, cb),

    listPlugins: (pid) => route(byProject(pid), "listPlugins", [pid], () => local.listPlugins(pid)) as never,
    pluginsText: (pid) => route(byProject(pid), "pluginsText", [pid], () => local.pluginsText(pid)) as never,
    checkPlugins: (text) => local.checkPlugins(text),
    writePlugins: (pid, t, rev) => route(byProject(pid), "writePlugins", [pid, t, rev], () => local.writePlugins(pid, t, rev)) as never,
    readScript: (pid, n) => route(byProject(pid), "readScript", [pid, n], () => local.readScript(pid, n)) as never,
    writeScript: (pid, n, t) => route(byProject(pid), "writeScript", [pid, n, t], () => local.writeScript(pid, n, t)) as never,
    async previewPluginAction(req) {
      localOnly("A plugin action", byProject(req.projectId));
      return local.previewPluginAction(req);
    },
    async runPluginAction(req) {
      localOnly("A plugin action", byProject(req.projectId));
      return local.runPluginAction(req);
    },
    onTaskEnd: (taskId, cb) => local.onTaskEnd(taskId, cb),
    async startPluginsDraft(opts) {
      localOnly("Drafting plugins", byProject(opts.projectId));
      return local.startPluginsDraft(opts);
    },
    readPluginsDraft: (pid) => route(byProject(pid), "readPluginsDraft", [pid], () => local.readPluginsDraft(pid)) as never,
    clearPluginsDraft: (pid) => route(byProject(pid), "clearPluginsDraft", [pid], () => local.clearPluginsDraft(pid)) as never,

    choiceOf: (id) => {
      const r = bySession(id);
      return r ? (r.sessions().find((s) => s.id === id)?.choice ?? null) : local.choiceOf(id);
    },
    holdPermissions: (onOff) => local.holdPermissions(onOff),
    answerHeld: (id, cid, d) => route(bySession(id), "answerHeld", [id, cid, d], () => local.answerHeld(id, cid, d)) as never,
    onChoices: (cb) => on(choices, cb),
    holdNeedsYou: (hold) => local.holdNeedsYou(hold),
    sessionContext: (id) => route(bySession(id), "sessionContext", [id], () => local.sessionContext(id)) as never,
    noteSession: (id, line) => fire(bySession(id), "noteSession", [id, line], () => local.noteSession(id, line)),
    adviseChoice: (id, advice) => fire(bySession(id), "adviseChoice", [id, advice], () => local.adviseChoice(id, advice)),

    ensureProject: (n, root) => local.ensureProject(n, root),
    lastResponse: (id) => route(bySession(id), "lastResponse", [id], () => local.lastResponse(id)) as never,
    setDuckTask: (id, task) => fire(bySession(id), "setDuckTask", [id, task], () => local.setDuckTask(id, task)),
    setHeadless: (id, onOff) => fire(bySession(id), "setHeadless", [id, onOff], () => local.setHeadless(id, onOff)),

    worktreeChanges: (id) => route(bySession(id), "worktreeChanges", [id], () => local.worktreeChanges(id)) as never,
    worktreeLoss: (id) => route(bySession(id), "worktreeLoss", [id], () => local.worktreeLoss(id)) as never,
    disposeWorktree: (id, force) => route(bySession(id), "disposeWorktree", [id, force], () => local.disposeWorktree(id, force)) as never,
    mergeWorktree: (id) => route(bySession(id), "mergeWorktree", [id], () => local.mergeWorktree(id)) as never,
    listWorktrees: (pid) => route(byProject(pid), "listWorktrees", [pid], () => local.listWorktrees(pid)) as never,
    findWorktree: (pid, t) => route(byProject(pid), "findWorktree", [pid, t], () => local.findWorktree(pid, t)) as never,
    attachWorktree: (id, t, opts) => route(bySession(id), "attachWorktree", [id, t, opts], () => local.attachWorktree(id, t, opts)) as never,
    runInShell: (pid, cmd, label) => route(byProject(pid), "runInShell", [pid, cmd, label], () => local.runInShell(pid, cmd, label)) as never,

    compactSession: (id, focus) => route(bySession(id), "compactSession", [id, focus], () => local.compactSession(id, focus)) as never,
    contextUsed: (id) => route(bySession(id), "contextUsed", [id], () => local.contextUsed(id)) as never,
    setAutopilotBadge: (id, b) => fire(bySession(id), "setAutopilotBadge", [id, b], () => local.setAutopilotBadge(id, b)),
    openDecisionsLog: (id) => fire(bySession(id), "openDecisionsLog", [id], () => local.openDecisionsLog(id)),
    decisionsLogged: (id) => fire(bySession(id), "decisionsLogged", [id], () => local.decisionsLogged(id)),
    alertUser: (id, title, body) => fire(bySession(id), "alertUser", [id, title, body], () => local.alertUser(id, title, body)),
    onUserBack: (cb) => local.onUserBack(cb),

    setDoneSummary: (fn) => local.setDoneSummary(fn),
  };
  return port;
}
