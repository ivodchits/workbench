// Another machine's Workbench, over the fleet's link (fleet plan F3.1). The design
// foresaw this file (`port.ts`): the `WorkbenchPort` of another Workbench machine,
// so Duck at the main starts, prompts, reads and answers sessions on the laptop.
//
// - **The host side** (`serveWorkbench`, on the other machine) serves its own port:
//   it runs the calls it's sent and pushes its projects and sessions (with their
//   waiting prompts) whenever they change, and the events Duck follows (phases,
//   compactions, sessions you started, prompts changing).
// - **The main's side** (`createRemotePort`) keeps that mirror, so the port's
//   synchronous reads (`listSessions`, `choiceOf`, …) answer at once, and sends
//   every other call over. `port.fleet.ts` puts the machines together.
//
// Only data travels. The members that take a callback for the engine (the T4
// holds, the done summary, plugin drafts and task ends) stay this machine's own:
// a call of one for another machine fails with a plain reason. A prompt's
// `onFailed` comes back as an event.

import type { ProjectRef, SessionRef, WorkbenchPort } from "./port";

/** The main to a machine's Workbench. */
export type PortDown =
  | { type: "port.call"; id: string; method: string; args: unknown[] }
  /** Say hello and the state again (the main's Duck restarted). */
  | { type: "port.resync" };

/** A machine's Workbench to the main. */
export type PortUp =
  | { type: "port.hello"; name: string }
  | { type: "port.state"; projects: ProjectRef[]; sessions: SessionRef[]; pending: string[] }
  | { type: "port.event"; name: PortEvent; args: unknown[] }
  | { type: "port.result"; id: string; ok: boolean; output: unknown };

/** The port's events another machine passes on. */
export type PortEvent = "phase" | "compactionEnd" | "sessionYouStarted" | "choices" | "promptFailed";

/** The members another machine runs when asked: plain data in and out. */
export const REMOTE_METHODS = new Set<string>([
  "readTranscriptBack",
  "git",
  "listNotes",
  "readNote",
  "sendPrompt",
  "createSession",
  "startSession",
  "resumeSession",
  "answerChoice",
  "interruptSession",
  "readScreen",
  "pressKeys",
  "stopSession",
  "killSession",
  "openPanel",
  "writeNote",
  "createNote",
  "deleteNote",
  "listPlugins",
  "pluginsText",
  "writePlugins",
  "readScript",
  "writeScript",
  "readPluginsDraft",
  "clearPluginsDraft",
  "answerHeld",
  "sessionContext",
  "noteSession",
  "adviseChoice",
  "lastResponse",
  "setDuckTask",
  "setHeadless",
  "worktreeChanges",
  "worktreeLoss",
  "disposeWorktree",
  "mergeWorktree",
  "listWorktrees",
  "findWorktree",
  "attachWorktree",
  "runInShell",
  "compactSession",
  "contextUsed",
  "setAutopilotBadge",
  "openDecisionsLog",
  "decisionsLogged",
  "alertUser",
]);

/** How often the host side looks for changes besides the events. */
const STATE_EVERY_MS = 3000;

/** A call that takes longer than this fails (a session start can take a while). */
const CALL_TIMEOUT_MS = 60_000;

/** The host side: serve `port` to the main over `send`. Stop it when the link to
 *  the main goes. */
export function serveWorkbench(
  port: WorkbenchPort,
  name: string,
  send: (msg: PortUp) => void,
  every = STATE_EVERY_MS,
): { receive(msg: PortDown): void; stop(): void } {
  let last = "";
  const pushState = () => {
    const sessions = port.listSessions();
    const state = {
      projects: port.listProjects(),
      sessions,
      pending: sessions.filter((s) => port.promptPending(s.id)).map((s) => s.id),
    };
    const text = JSON.stringify(state);
    if (text === last) return;
    last = text;
    send({ type: "port.state", ...state });
  };
  const event = (name: PortEvent, args: unknown[]) => {
    pushState(); // the state the event is about goes first
    send({ type: "port.event", name, args });
  };
  const offs = [
    port.onPhase((id, phase, prev) => event("phase", [id, phase, prev])),
    port.onCompactionEnd((id, phase) => event("compactionEnd", [id, phase])),
    port.onSessionYouStarted((id, projectId) => event("sessionYouStarted", [id, projectId])),
    port.onChoices(() => event("choices", [])),
  ];
  const timer = setInterval(pushState, every);
  const hello = () => {
    send({ type: "port.hello", name });
    last = "";
    pushState();
  };
  hello();

  const run = async (method: string, args: unknown[]): Promise<unknown> => {
    if (!REMOTE_METHODS.has(method)) throw new Error(`${method} only runs on its own machine`);
    if (method === "sendPrompt") {
      // `onFailed` can't travel: the main gave a token for it, said back as an event.
      const [id, text, opts] = args as [string, string, { now?: boolean; onFailed?: string } | undefined];
      const token = opts?.onFailed;
      return port.sendPrompt(id, text, {
        ...(opts?.now !== undefined && { now: opts.now }),
        ...(token && { onFailed: (why: string) => send({ type: "port.event", name: "promptFailed", args: [token, why] }) }),
      });
    }
    const f = (port as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    return f.apply(port, args);
  };

  return {
    receive(msg) {
      if (msg.type === "port.resync") return hello();
      if (msg.type !== "port.call") return;
      void Promise.resolve()
        .then(() => run(msg.method, msg.args))
        .then(
          (output) => ({ ok: true, output: output ?? null }),
          (e: unknown) => ({ ok: false, output: e instanceof Error ? e.message : String(e) }),
        )
        .then((r) => {
          pushState(); // what the call changed, before its answer
          send({ type: "port.result", id: msg.id, ...r });
        });
    },
    stop() {
      clearInterval(timer);
      for (const off of offs) off();
    },
  };
}

/** Another machine's Workbench, as the main holds it. */
export interface RemotePort {
  /** The machine's fleet id and name. */
  readonly id: string;
  readonly name: string;
  projects(): ProjectRef[];
  sessions(): SessionRef[];
  promptPending(instanceId: string): boolean;
  /** Run a member of its port there. */
  call(method: string, args: unknown[]): Promise<unknown>;
  /** A prompt sent there with a failure callback. */
  sendPrompt(id: string, text: string, opts?: { now?: boolean; onFailed?: (why: string) => void }): Promise<unknown>;
  receive(msg: PortUp): void;
  /** The link went: its open calls fail, the mirror empties. */
  close(): void;
  readonly closed: boolean;
}

/** The main's side of a machine's Workbench. `events` hears what the machine
 *  passes on (its sessions' phases, …) for the fleet port to hand out. */
export function createRemotePort(
  id: string,
  name: string,
  send: (msg: PortDown) => void,
  events: (name: PortEvent, args: unknown[]) => void,
  timeoutMs = CALL_TIMEOUT_MS,
): RemotePort {
  let projects: ProjectRef[] = [];
  let sessions: SessionRef[] = [];
  let pending = new Set<string>();
  let closed = false;
  let next = 0;
  let label = name;
  const calls = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const failed = new Map<string, (why: string) => void>();

  const call = (method: string, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(new Error(`${label} isn't connected`));
    const callId = `p${++next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(callId);
        reject(new Error(`${label} didn't answer in time`));
      }, timeoutMs);
      calls.set(callId, { resolve, reject, timer });
      send({ type: "port.call", id: callId, method, args });
    });
  };

  return {
    id,
    get name() {
      return label;
    },
    get closed() {
      return closed;
    },
    projects: () => projects,
    sessions: () => sessions,
    promptPending: (instanceId) => pending.has(instanceId),
    call,
    sendPrompt(instanceId, text, opts) {
      let token: string | undefined;
      if (opts?.onFailed) {
        token = `f${++next}`;
        failed.set(token, opts.onFailed);
      }
      return call("sendPrompt", [instanceId, text, { ...(opts?.now !== undefined && { now: opts.now }), ...(token && { onFailed: token }) }]);
    },
    receive(msg) {
      if (closed) return;
      switch (msg.type) {
        case "port.hello":
          label = msg.name || label;
          return;
        case "port.state":
          projects = msg.projects;
          sessions = msg.sessions;
          pending = new Set(msg.pending);
          return;
        case "port.event":
          if (msg.name === "promptFailed") {
            const [token, why] = msg.args as [string, string];
            const f = failed.get(token);
            failed.delete(token);
            f?.(why);
            return;
          }
          events(msg.name, msg.args);
          return;
        case "port.result": {
          const c = calls.get(msg.id);
          if (!c) return;
          calls.delete(msg.id);
          clearTimeout(c.timer);
          if (msg.ok) c.resolve(msg.output);
          else c.reject(new Error(typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output)));
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const c of calls.values()) {
        clearTimeout(c.timer);
        c.reject(new Error(`${label} disconnected`));
      }
      calls.clear();
      failed.clear();
      projects = [];
      sessions = [];
      pending = new Set();
    },
  };
}
