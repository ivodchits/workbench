import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Instance } from "../ipc/registry";

type Msg = Record<string, unknown>;
const ipc = vi.hoisted(() => ({
  onEvent: null as ((id: string, msg: Msg) => void) | null,
  onExit: null as ((id: string, code: number | null, stderr: string) => void) | null,
  calls: [] as unknown[][],
}));

vi.mock("../ipc/headless", () => ({
  headlessSpawn: vi.fn(async (...a: unknown[]) => {
    ipc.calls.push(["spawn", ...a]);
    return { sessionId: "sid-1", cwd: a[1] };
  }),
  headlessSend: vi.fn(async (...a: unknown[]) => void ipc.calls.push(["send", ...a])),
  headlessInterrupt: vi.fn(async (...a: unknown[]) => void ipc.calls.push(["interrupt", ...a])),
  headlessAnswer: vi.fn(async (...a: unknown[]) => void ipc.calls.push(["answer", ...a])),
  headlessKill: vi.fn(async (...a: unknown[]) => void ipc.calls.push(["kill", ...a])),
  onHeadlessEvent: vi.fn(async (cb: (id: string, msg: Msg) => void) => {
    ipc.onEvent = cb;
    return () => {};
  }),
  onHeadlessExited: vi.fn(async (cb: (id: string, code: number | null, stderr: string) => void) => {
    ipc.onExit = cb;
    return () => {};
  }),
}));
vi.mock("../ipc/hooks", () => ({ onHookEvent: vi.fn(async () => () => {}) }));
vi.mock("../panels/terminalPool", () => ({ release: vi.fn() }));
vi.mock("./registry", () => ({
  getRegistry: () => ({ projects: [], instances: [worker] }),
  applyInstanceUsage: vi.fn(),
  updateInstance: vi.fn(async () => {}),
}));
vi.mock("./activeProject", () => ({ setActiveProject: vi.fn() }));
vi.mock("./dock", () => ({ activatePanel: vi.fn() }));

const worker = { id: "w1", projectId: "duck", title: "research", workingDir: "C:/Duck", lastSessionId: null } as unknown as Instance;

import { closeConsole, getOpenConsoles, openConsole } from "./consoles";
import { answerHeadless, initHeadless, isHeadless, markHeadless, takeOverHeadless } from "./headless";
import { setLaunchPrompt } from "./launchPrompt";
import { getPendingChoice, ingestChoiceEvent } from "./pendingChoice";
import { getLiveStatuses, ingestHookEvent } from "./status";

const settle = () => new Promise((r) => setTimeout(r, 0));
const hook = (event: Msg) =>
  ingestHookEvent({ instanceId: "w1", receivedAt: 1, event: { session_id: "sid-1", ...event } as never });
const choice = (event: Msg) =>
  ingestChoiceEvent({ instanceId: "w1", receivedAt: 1, event: { session_id: "sid-1", ...event } as never });
const canUse = (requestId: string, tool: string, input: Msg) =>
  ipc.onEvent!("w1", {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: `tu-${requestId}` },
  });
const answers = () => ipc.calls.filter((c) => c[0] === "answer");

const QUESTION = {
  questions: [
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "" },
        { label: "SQLite", description: "" },
      ],
    },
  ],
};

async function start() {
  markHeadless("w1", true);
  setLaunchPrompt("w1", "Read brief.md");
  openConsole(worker, { background: true });
  await settle();
  await settle();
}

describe("headless workers", () => {
  beforeEach(async () => {
    initHeadless();
    closeConsole("w1");
    await settle();
    ipc.calls.length = 0;
  });

  it("starts the process when its console opens, with the launch prompt, and stops it when it closes", async () => {
    await start();
    expect(ipc.calls[0]).toEqual(["spawn", "w1", "C:/Duck", null, "Read brief.md"]);
    const c = getOpenConsoles().find((x) => x.instanceId === "w1");
    expect(c).toMatchObject({ headless: true, status: "running", sessionId: "sid-1" });
    // SessionStart doesn't fire headless: the card is idle all the same.
    expect(getLiveStatuses().get("w1")?.phase).toBe("idle");

    closeConsole("w1");
    await settle();
    expect(ipc.calls[ipc.calls.length - 1]).toEqual(["kill", "w1"]);
  });

  it("answers a question over the protocol, with its answer in the tool's input", async () => {
    await start();
    choice({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: QUESTION });
    canUse("r1", "AskUserQuestion", QUESTION);
    expect(answerHeadless("w1", { option: 2 }, "denied")).toBe(true);
    expect(answers()).toEqual([
      ["answer", "w1", "r1", { behavior: "allow", updatedInput: { ...QUESTION, answers: { "Which database?": "SQLite" } } }],
    ]);
    // Answered once: nothing left to answer.
    expect(answerHeadless("w1", { option: 1 }, "denied")).toBe(false);
  });

  it("takes a typed answer, allows a permission with its input, and denies as Esc would", async () => {
    await start();
    choice({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: QUESTION });
    canUse("r1", "AskUserQuestion", QUESTION);
    answerHeadless("w1", { text: "MySQL" }, "denied");
    expect((answers()[0][3] as { updatedInput: { answers: unknown } }).updatedInput.answers).toEqual({
      "Which database?": "MySQL",
    });

    choice({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    canUse("r2", "Bash", { command: "ls" });
    answerHeadless("w1", { option: 1 }, "denied");
    expect(answers()[1]).toEqual(["answer", "w1", "r2", { behavior: "allow", updatedInput: { command: "ls" } }]);

    hook({ hook_event_name: "UserPromptSubmit" });
    hook({ hook_event_name: "PermissionRequest" });
    canUse("r3", "Bash", { command: "rm x" });
    answerHeadless("w1", "deny", "The user denied this.");
    expect(answers()[2]).toEqual(["answer", "w1", "r3", { behavior: "deny", message: "The user denied this.", interrupt: true }]);
    expect(getLiveStatuses().get("w1")?.phase).toBe("done");
  });

  it("drops a request the hook answered first", async () => {
    await start();
    canUse("r1", "Bash", { command: "ls" });
    ipc.onEvent!("w1", { type: "control_cancel_request", request_id: "r1" });
    expect(answerHeadless("w1", { option: 1 }, "denied")).toBe(false);
  });

  it("ends the turn on its result, and the session when the process dies", async () => {
    await start();
    hook({ hook_event_name: "UserPromptSubmit" });
    expect(getLiveStatuses().get("w1")?.phase).toBe("working");
    ipc.onEvent!("w1", { type: "result", subtype: "success" });
    expect(getLiveStatuses().get("w1")?.phase).toBe("done");

    ipc.onExit!("w1", 1, "some log\nError: out of memory");
    expect(getLiveStatuses().get("w1")?.phase).toBe("ended");
    expect(getOpenConsoles().find((c) => c.instanceId === "w1")).toMatchObject({
      status: "error",
      error: "The worker's process ended (exit 1): Error: out of memory",
    });
  });

  it("offers a plan's approval, which a terminal reads off its menu", async () => {
    await start();
    choice({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "do it" } });
    expect(getPendingChoice("w1")).toMatchObject({ kind: "plan", terminalOnly: null });
    expect(getPendingChoice("w1")?.options.map((o) => o.label)).toEqual(["Yes, go ahead with the plan"]);
  });

  it("takes over: stops the worker and resumes its session in a terminal", async () => {
    await start();
    await takeOverHeadless("w1");
    expect(isHeadless("w1")).toBe(false);
    expect(ipc.calls.filter((c) => c[0] === "kill")).toHaveLength(1);
    expect(getOpenConsoles().find((c) => c.instanceId === "w1")).toMatchObject({
      headless: undefined,
      status: "spawning",
      resumeSessionId: "sid-1",
    });
    await settle();
    // No second process: the terminal is the console's now.
    expect(ipc.calls.filter((c) => c[0] === "spawn")).toHaveLength(1);
  });
});
