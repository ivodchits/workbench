import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Instance, Project } from "../ipc/registry";

const RULE = "─".repeat(60);
const READY = [RULE, "❯ ", RULE];

const calls: string[] = [];
let screen: string[] | null = null;
let projects: Project[] = [];
let instances: Instance[] = [];
let worktreeError: Error | null = null;

vi.mock("../ipc/pty", () => ({
  ENTER_KEY: new Uint8Array([13]),
  INTERRUPT_KEY: new Uint8Array([27]),
  ptyWrite: vi.fn(),
}));
vi.mock("../ipc/remote", () => ({ onRemoteAction: vi.fn() }));
vi.mock("./status", () => ({ markInterrupted: vi.fn() }));
vi.mock("./activeProject", () => ({ setActiveProject: (id: string) => calls.push(`project ${id}`) }));
vi.mock("./dock", () => ({ activatePanel: (id: string) => calls.push(`activate ${id}`) }));
vi.mock("./consoles", () => ({
  openConsole: (i: Instance) => calls.push(`open ${i.id} ${i.workingDir}`),
  closeConsole: vi.fn(),
}));
vi.mock("./worktree", () => ({
  provisionWorktree: async (i: Instance) => {
    if (worktreeError) throw worktreeError;
    instances = instances.map((x) => (x.id === i.id ? { ...x, worktreeOn: true, workingDir: "/wt" } : x));
    return { skipped: true, copiedEnv: [], command: null, output: "", exitCode: null, failed: false };
  },
}));
vi.mock("../panels/terminalPool", () => ({
  readScreen: () => screen,
  submitPrompt: (id: string, text: string) => calls.push(`send ${id} ${text}`),
  submitToTerminal: vi.fn(),
  release: vi.fn(),
}));
vi.mock("./registry", () => ({
  getRegistry: () => ({ projects, instances }),
  nextInstanceTitle: () => "3",
  addInstance: async (input: { projectId: string; title: string }) => {
    const row = {
      id: `i${instances.length + 1}`,
      projectId: input.projectId,
      title: input.title,
      workingDir: "/root",
    } as Instance;
    instances = [...instances, row];
    calls.push(`add ${row.id} ${input.title}`);
    return row;
  },
  deleteInstance: async (id: string) => {
    instances = instances.filter((i) => i.id !== id);
    calls.push(`delete ${id}`);
  },
}));

import { ptyWrite } from "../ipc/pty";
import type { HookEvent } from "../ipc/hooks";
import { handleRemoteAction } from "./remoteActions";
import { clearPendingChoice, getPendingChoice, ingestChoiceEvent, setTerminalOptions } from "./pendingChoice";
import { cancelQueued, getQueued } from "./queue";
import { getCreated, resetCreated } from "./remoteCreate";

/** Let the awaited registry calls settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const sends = () => calls.filter((c) => c.startsWith("send"));

describe("create from the phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    screen = null;
    projects = [{ id: "p1", name: "proj", rootPath: "/root" } as Project];
    instances = [];
    worktreeError = null;
    resetCreated();
    cancelQueued("i1");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a session as the rail does and sends the first prompt once the box shows", async () => {
    handleRemoteAction({ type: "create", requestId: "r1", projectId: "p1", text: "hello" });
    await settle();
    expect(calls).toEqual(["add i1 3", "project p1", "open i1 /root", "activate i1"]);
    expect(getCreated()[0]).toMatchObject({ instanceId: "i1", state: "starting" });

    await vi.advanceTimersByTimeAsync(1000); // no terminal yet, then a blank one
    screen = ["", ""];
    await vi.advanceTimersByTimeAsync(1000);
    expect(sends()).toEqual([]);

    screen = READY;
    await vi.advanceTimersByTimeAsync(300);
    expect(sends()).toEqual(["send i1 hello"]);
    expect(getCreated()[0]).toMatchObject({ state: "sent" });
  });

  it("creates one session for a repeated request", async () => {
    const act = { type: "create", requestId: "r1", projectId: "p1", title: "x" } as const;
    handleRemoteAction(act);
    handleRemoteAction(act);
    await settle();
    handleRemoteAction(act);
    await settle();
    expect(calls.filter((c) => c.startsWith("add"))).toEqual(["add i1 x"]);
    expect(getCreated()).toEqual([{ requestId: "r1", instanceId: "i1", state: "started", message: null }]);
  });

  it("queues the first prompt when the box never shows", async () => {
    handleRemoteAction({ type: "create", requestId: "r1", projectId: "p1", text: "hello" });
    await settle();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sends()).toEqual([]);
    expect(getQueued("i1")?.text).toBe("hello");
    expect(getCreated()[0]).toMatchObject({ state: "queued" });
  });

  it("waits longer once an SSH login asks for a password", async () => {
    handleRemoteAction({ type: "create", requestId: "r1", projectId: "p1", text: "hello" });
    await settle();
    screen = ["dev@host's password:"];
    await vi.advanceTimersByTimeAsync(500);
    expect(getCreated()[0].message).toMatch(/password/);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(getQueued("i1")).toBeUndefined();
    screen = READY;
    await vi.advanceTimersByTimeAsync(300);
    expect(sends()).toEqual(["send i1 hello"]);
  });

  it("opens the console in the new worktree", async () => {
    handleRemoteAction({ type: "create", requestId: "r1", projectId: "p1", worktree: true });
    await settle();
    expect(calls).toContain("open i1 /wt");
  });

  it("removes the instance when the worktree can't be made", async () => {
    worktreeError = new Error("branch exists");
    handleRemoteAction({ type: "create", requestId: "r1", projectId: "p1", worktree: true });
    await settle();
    expect(calls).toEqual(["add i1 3", "delete i1"]);
    expect(instances).toEqual([]);
    expect(getCreated()[0]).toMatchObject({
      instanceId: null,
      state: "failed",
      message: expect.stringMatching(/branch exists/),
    });
  });

  it("refuses an unknown project", async () => {
    handleRemoteAction({ type: "create", requestId: "r1", projectId: "nope" });
    await settle();
    expect(calls).toEqual([]);
    expect(getCreated()[0]).toMatchObject({ state: "failed" });
  });
});

describe("answering a prompt from the phone", () => {
  const written = () =>
    vi.mocked(ptyWrite).mock.calls.map(([id, bytes]) => `${id} ${new TextDecoder().decode(bytes)}`);
  const ask = (event: Partial<HookEvent>) =>
    ingestChoiceEvent({ instanceId: "i1", event } as Parameters<typeof ingestChoiceEvent>[0]);
  const permission = () => {
    ask({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
    ask({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    const id = getPendingChoice("i1")!.id;
    setTerminalOptions("i1", id, [
      { key: 1, label: "Yes", detail: "", typed: false },
      { key: 2, label: "Yes, and don't ask again", detail: "", typed: false },
      { key: 3, label: "No", detail: "", typed: false },
    ]);
    return id;
  };

  beforeEach(() => {
    vi.mocked(ptyWrite).mockClear();
    clearPendingChoice("i1");
  });

  it("sends the option's digit for the prompt it was shown, once", () => {
    const id = permission();
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: id, option: 2 });
    expect(written()).toEqual(["i1 2"]);
    expect(getPendingChoice("i1")?.sent?.label).toBe("Yes, and don't ask again");
    // A second tap (or a second phone) while that answer is in flight does nothing.
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: id, option: 3 });
    expect(written()).toEqual(["i1 2"]);
  });

  it("ignores a tap on a prompt that has closed or been replaced", () => {
    const old = permission();
    clearPendingChoice("i1"); // answered in the terminal
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: old, option: 1 });
    vi.setSystemTime(Date.now() + 1000);
    permission(); // the next prompt
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: old, option: 1 });
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: old, option: "deny" });
    expect(written()).toEqual([]);
  });

  it("ignores an option the prompt doesn't offer, and answers deny with Esc", () => {
    const id = permission();
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: id, option: 7 });
    expect(written()).toEqual([]);
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: id, option: "deny" });
    expect(written()).toEqual(["i1 "]);
  });

  it("never answers a prompt that is answered in the terminal, nor approves a plan with Enter", () => {
    ask({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "x" } });
    const id = getPendingChoice("i1")!.id;
    handleRemoteAction({ type: "choose", instanceId: "i1", choiceId: id, option: 1 });
    handleRemoteAction({ type: "approve", instanceId: "i1" });
    expect(written()).toEqual([]);
  });
});
