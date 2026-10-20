import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HookEnvelope } from "../ipc/hooks";
import type { StatusPhase } from "./status";

const hooks: ((env: HookEnvelope) => void)[] = [];
const transitions: ((id: string, phase: StatusPhase, prev: StatusPhase | null) => void)[] = [];
const live = new Map<string, { phase: StatusPhase; compacting: boolean }>();
let screen: string[] | null = null;

vi.mock("../ipc/pty", () => ({ ENTER_KEY: new Uint8Array([13]), ptyWrite: vi.fn(() => Promise.resolve()) }));
vi.mock("../ipc/hooks", () => ({
  onHookEvent: vi.fn((cb: (env: HookEnvelope) => void) => {
    hooks.push(cb);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../panels/terminalPool", () => ({
  readScreen: () => screen,
  submitPrompt: vi.fn(),
}));
vi.mock("./status", () => ({
  getLiveStatuses: () => live,
  onStatusTransition: (cb: (typeof transitions)[number]) => {
    transitions.push(cb);
    return () => {};
  },
  onCompactionEnd: () => () => {},
}));

const { ptyWrite } = await import("../ipc/pty");
const { submitPrompt } = await import("../panels/terminalPool");
const { deliverPrompt } = await import("./promptOutbox");
const { takeLaunchPrompt, LAUNCH_PROMPT_MAX } = await import("./launchPrompt");

const RULE = "─".repeat(40);
const box = (input = "") => [RULE, `❯ ${input}`, RULE];

function submitted(id: string) {
  for (const h of hooks) h({ instanceId: id, event: { hook_event_name: "UserPromptSubmit" } } as unknown as HookEnvelope);
}
function phase(id: string, p: StatusPhase) {
  live.set(id, { phase: p, compacting: false });
  for (const t of transitions) t(id, p, null);
}

let n = 0;
function target(running: boolean) {
  const id = `i${++n}`;
  const t = { instanceId: id, up: running, launches: 0 };
  return {
    t,
    target: {
      instanceId: id,
      running: () => t.up,
      launch: () => {
        t.launches++;
        t.up = true;
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  screen = null;
  vi.mocked(ptyWrite).mockClear();
  vi.mocked(submitPrompt).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("prompt outbox", () => {
  it("starts a stopped session with the prompt on its command line", async () => {
    const { t, target: tg } = target(false);
    const d = deliverPrompt(tg, "name three colors");
    expect(d.state).toBe("starting");
    expect(t.launches).toBe(1);
    expect(takeLaunchPrompt(t.instanceId)).toBe("name three colors");
    expect(submitPrompt).not.toHaveBeenCalled();
    submitted(t.instanceId);
    expect(await d.done).toEqual({ ok: true });
  });

  it("lines up a second prompt behind a starting one, then types it after that turn", async () => {
    const { t, target: tg } = target(false);
    const first = deliverPrompt(tg, "first");
    const second = deliverPrompt(tg, "second");
    expect(second.state).toBe("queued");
    expect(t.launches).toBe(1);
    submitted(t.instanceId);
    phase(t.instanceId, "working");
    await first.done;
    expect(submitPrompt).not.toHaveBeenCalled(); // still the first one's turn
    phase(t.instanceId, "done");
    expect(submitPrompt).toHaveBeenCalledWith(t.instanceId, "second");
    submitted(t.instanceId);
    expect(await second.done).toEqual({ ok: true });
  });

  it("presses Enter again while the box holds text, and reports a prompt never taken", async () => {
    const { t, target: tg } = target(true);
    phase(t.instanceId, "idle");
    screen = box("first second, run together");
    const d = deliverPrompt(tg, "hello");
    expect(submitPrompt).toHaveBeenCalledWith(t.instanceId, "hello");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    submitted(t.instanceId);
    expect(await d.done).toEqual({ ok: true });

    phase(t.instanceId, "done");
    const lost = deliverPrompt(tg, "again");
    await vi.advanceTimersByTimeAsync(7_000);
    expect(ptyWrite).toHaveBeenCalledTimes(3);
    expect(await lost.done).toMatchObject({ ok: false, why: expect.stringMatching(/didn't take it/) });
  });

  it("sends everything waiting for a turn's end as one prompt", async () => {
    const { t, target: tg } = target(true);
    phase(t.instanceId, "working");
    const ds = ["fix the test", "then commit", "and push"].map((p) => deliverPrompt(tg, p));
    expect(ds.map((d) => d.state)).toEqual(["queued", "queued", "queued"]);
    phase(t.instanceId, "done");
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledWith(t.instanceId, "fix the test\n\nthen commit\n\nand push");
    submitted(t.instanceId);
    for (const d of ds) expect(await d.done).toEqual({ ok: true });
  });

  it("puts a `now` prompt into the running turn, but never into a prompt waiting on the user", async () => {
    const { t, target: tg } = target(true);
    phase(t.instanceId, "working");
    const later = deliverPrompt(tg, "next task");
    screen = box();
    const now = deliverPrompt(tg, "use the other API", { now: true });
    expect(now.state).toBe("sent");
    expect(submitPrompt).toHaveBeenCalledWith(t.instanceId, "use the other API");
    // Mid-turn, the text leaving the box is the sign it was taken.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await now.done).toEqual({ ok: true });
    expect(later.state).toBe("queued");
    expect(submitPrompt).toHaveBeenCalledTimes(1);

    phase(t.instanceId, "needs_you");
    const held = deliverPrompt(tg, "also check the logs", { now: true });
    expect(held.state).toBe("queued");
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    phase(t.instanceId, "working"); // answered: the turn goes on
    expect(submitPrompt).toHaveBeenLastCalledWith(t.instanceId, "also check the logs");
    await vi.advanceTimersByTimeAsync(2_000);
    phase(t.instanceId, "done");
    expect(submitPrompt).toHaveBeenLastCalledWith(t.instanceId, "next task");
  });

  it("waits out a mid-turn session, and types a prompt too long for the command line", async () => {
    const busy = target(true);
    phase(busy.t.instanceId, "working");
    const d = deliverPrompt(busy.target, "after this turn");
    expect(d.state).toBe("queued");
    expect(submitPrompt).not.toHaveBeenCalled();
    phase(busy.t.instanceId, "done");
    expect(submitPrompt).toHaveBeenCalledWith(busy.t.instanceId, "after this turn");

    const long = target(false);
    const text = "x".repeat(LAUNCH_PROMPT_MAX + 1);
    const l = deliverPrompt(long.target, text);
    expect(takeLaunchPrompt(long.t.instanceId)).toBeNull();
    screen = box();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(submitPrompt).toHaveBeenCalledWith(long.t.instanceId, text);
    submitted(long.t.instanceId);
    expect(await l.done).toEqual({ ok: true });
  });
});
