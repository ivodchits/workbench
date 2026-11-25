// Two machines' Duck sides wired back to back, as the fleet's link carries them
// (fleet plan F3.1): the laptop serves its pc and Workbench to the desktop's Duck.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetHub, serveFleet, type FleetServing } from "./fleetHosts";
import { connectLocal, createHosts } from "./hosts";
import type { ChoiceRef, ProjectRef, SessionRef, WorkbenchPort } from "./port";
import { createFleetPort } from "./port.fleet";
import { toolCtx } from "./fakePort.test-util";
import { clearWatches, waitForSession } from "./tools/act";

const project = (id: string, name: string, root: string): ProjectRef => ({ id, name, rootPath: root, group: null, remote: false });

const session = (id: string, projectId: string, extra: Partial<SessionRef> = {}): SessionRef => ({
  id,
  projectId,
  title: id,
  taskNote: "",
  phase: "idle",
  compacting: false,
  subagents: 0,
  worktreeBranch: null,
  worktreeOwned: false,
  model: null,
  permissionMode: null,
  duckTask: null,
  workingDir: "/",
  lastActivity: null,
  choice: null,
  ...extra,
});

/** A machine's Workbench, enough for the tests: projects, sessions, phases. */
function fakePort(projects: ProjectRef[], sessions: SessionRef[]) {
  const phase = new Set<(id: string, p: SessionRef["phase"], prev: SessionRef["phase"] | null) => void>();
  const noop = () => () => {};
  const calls: string[] = [];
  const port = {
    async tellNeedsYou(id: string) {
      calls.push(`hold ${id}`);
      return true;
    },
    listProjects: () => projects,
    listSessions: (pid?: string) => (pid ? sessions.filter((s) => s.projectId === pid) : sessions),
    promptPending: () => false,
    onPhase: (cb: never) => (phase.add(cb), () => phase.delete(cb)),
    onCompactionEnd: noop,
    onSessionYouStarted: noop,
    onChoices: noop,
    async createSession(opts: { projectId: string; title?: string }) {
      calls.push(`create ${opts.projectId}`);
      const s = session(`new-${opts.projectId}`, opts.projectId, { title: opts.title ?? "new" });
      sessions.push(s);
      return { id: s.id, title: s.title, message: null };
    },
    async sendPrompt(id: string, text: string, opts?: { onFailed?: (why: string) => void }) {
      calls.push(`prompt ${id} ${text}`);
      if (text === "fail") setTimeout(() => opts?.onFailed?.("it didn't take"), 0);
      return "sent";
    },
    async lastResponse(id: string) {
      return `the summary of ${id}`;
    },
    answerChoice(id: string, choiceId: string, answer: unknown) {
      calls.push(`answer ${id} ${choiceId} ${JSON.stringify(answer)}`);
      return "Yes";
    },
    choiceOf: (id: string) => sessions.find((s) => s.id === id)?.choice ?? null,
    async startPluginsDraft() {
      return { id: "x", title: "x", draftDir: "x" };
    },
    git: async (dir: string) => ({ root: dir }),
  };
  return {
    port: port as unknown as WorkbenchPort,
    calls,
    /** Its prompt changes, with no event (as a lost one). */
    setChoice(id: string, c: ChoiceRef | null) {
      sessions.find((x) => x.id === id)!.choice = c;
    },
    setPhase(id: string, p: SessionRef["phase"]) {
      const s = sessions.find((x) => x.id === id)!;
      const prev = s.phase;
      s.phase = p;
      phase.forEach((l) => l(id, p, prev));
    },
  };
}

const choice: ChoiceRef = {
  id: "c1",
  kind: "permission",
  toolName: "Bash",
  input: { command: "npm test" },
  at: 0,
  questions: [],
  options: [{ key: 1, label: "Yes", detail: "", typed: false }],
  terminalOnly: null,
  sent: null,
  optionsFrom: "terminal",
  held: false,
};

let serving: FleetServing | null = null;
afterEach(() => {
  serving?.stop();
  serving = null;
  clearWatches();
  vi.useRealTimers();
});

/** The desktop (main) and the laptop, their messages passed straight across. */
function pair() {
  const desktop = fakePort([project("pd", "workbench", "C:/w")], [session("sd", "pd")]);
  const laptop = fakePort([project("pl", "workbench", "D:/code/workbench")], [session("sl", "pl", { choice, workingDir: "D:/code/workbench" })]);
  const hosts = createHosts(() => new Set(["media_control"]), () => ({ id: "D", name: "desktop" }));
  connectLocal(hosts, "pc", { media_control: () => "desktop paused" });
  const fleet = createFleetPort(desktop.port, () => "desktop", () => hub.ports());
  const hub = createFleetHub({
    hosts,
    send: (_to, text) => queueMicrotask(() => serving?.receive(text)),
    events: (n, a) => fleet.dispatch(n, a),
  });
  serving = serveFleet({
    main: "D",
    name: "laptop",
    pc: { media_control: () => "laptop paused" },
    port: laptop.port,
    send: (_to, text) => queueMicrotask(() => hub.receive("L", text)),
  });
  return { desktop, laptop, hosts, fleet, hub };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Duck's hosts across the fleet", () => {
  it("lists both machines' projects and sessions, each with its machine", async () => {
    const { fleet } = pair();
    await tick();
    expect(fleet.listProjects().map((p) => `${p.name}@${p.machine}`)).toEqual(["workbench@desktop", "workbench@laptop"]);
    expect(fleet.listSessions("pl").map((s) => s.id)).toEqual(["sl"]);
    expect(fleet.choiceOf("sl")?.id).toBe("c1");
  });

  it("starts, prompts, reads and answers a session on the laptop", async () => {
    const { fleet, laptop, desktop } = pair();
    await tick();
    const made = await fleet.createSession({ projectId: "pl", title: "fix it" });
    expect(made.id).toBe("new-pl");
    expect(laptop.calls).toContain("create pl");
    // The new session is in the mirror once the answer arrived.
    expect(fleet.listSessions().some((s) => s.id === "new-pl" && s.machine === "laptop")).toBe(true);
    expect(await fleet.sendPrompt("new-pl", "go")).toBe("sent");
    expect(await fleet.lastResponse("new-pl")).toBe("the summary of new-pl");
    expect(fleet.answerChoice("sl", "c1", 1)).toBe("Yes");
    await tick();
    expect(laptop.calls).toContain('answer sl c1 1');
    expect(desktop.calls).toEqual([]);
    // A prompt's failure comes back.
    const failed = new Promise<string>((resolve) => void fleet.sendPrompt("sl", "fail", { onFailed: resolve }));
    expect(await failed).toBe("it didn't take");
  });

  it("hears the laptop's phases, and routes git by folder", async () => {
    const { fleet, laptop } = pair();
    await tick();
    const seen: string[] = [];
    fleet.onPhase((id, p) => seen.push(`${id} ${p}`));
    laptop.setPhase("sl", "working");
    await tick();
    expect(seen).toEqual(["sl working"]);
    expect(fleet.listSessions().find((s) => s.id === "sl")?.phase).toBe("working");
    expect(await fleet.git("D:/code/workbench/src", { commits: 1 })).toEqual({ root: "D:/code/workbench/src" });
  });

  it("keeps the engine's own members local, and says so", async () => {
    const { fleet } = pair();
    await tick();
    await expect(fleet.startPluginsDraft({ projectId: "pl", title: "t", model: null, prompt: () => "" })).rejects.toThrow(
      /only on the machine Duck runs on, not on laptop/,
    );
    await expect(fleet.startPluginsDraft({ projectId: "pd", title: "t", model: null, prompt: () => "" })).resolves.toBeTruthy();
  });

  it("pauses the laptop's music by name, and forgets the laptop when it goes", async () => {
    const { hosts, hub, fleet } = pair();
    await tick();
    const signal = new AbortController().signal;
    expect(await hosts.call("pc", "media_control", {}, signal, "laptop")).toBe("laptop paused");
    expect(await hosts.call("pc", "media_control", {}, signal)).toBe("desktop paused");
    hub.gone("L");
    await expect(hosts.call("pc", "media_control", {}, signal, "laptop")).rejects.toThrow(/isn't connected/);
    expect(fleet.listProjects().map((p) => p.id)).toEqual(["pd"]);
  });

  it("tells a watch every prompt on the laptop, the second one with no event at all", async () => {
    vi.useFakeTimers();
    const { fleet, laptop, desktop } = pair();
    await vi.advanceTimersByTimeAsync(0);
    const ctx = toolCtx(fleet);
    laptop.setPhase("sl", "working");
    await vi.advanceTimersByTimeAsync(0);
    expect(await waitForSession.run(waitForSession.schema.parse({ session: "sl" }), ctx)).toMatchObject({ watching: "either" });
    laptop.setPhase("sl", "needs_you"); // its prompt c1 is open
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0]).toMatch(/is now needs_you: .*npm test/);
    // Answered there and straight into the next prompt: the phase never moves.
    laptop.setChoice("sl", { ...choice, id: "c2", input: { command: "npm run tauri build" } });
    await vi.advanceTimersByTimeAsync(8_000); // the laptop's state push, then the watch's look
    expect(ctx.posted).toHaveLength(2);
    expect(ctx.posted[1]).toMatch(/npm run tauri build/);
    // The main's trust hold was asked about both.
    expect(desktop.calls.filter((c) => c === "hold sl")).toHaveLength(2);
  });
});
