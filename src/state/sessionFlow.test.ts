// The status store, Duck's prompt delivery and the status watchdog together, fed
// simulated hook streams. Unlike `promptOutbox.test.ts`, the status store here is
// the real one: its listeners run before its repaint, which is where the queue
// used to read a just-finished turn as still working.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HookEnvelope, HookEvent } from "../ipc/hooks";

const subscribers: ((env: HookEnvelope) => void)[] = [];
const screens = new Map<string, string[]>();

vi.mock("../ipc/pty", () => ({ ENTER_KEY: new Uint8Array([13]), ptyWrite: vi.fn(() => Promise.resolve()) }));
vi.mock("../ipc/hooks", () => ({
  onHookEvent: vi.fn((cb: (env: HookEnvelope) => void) => {
    subscribers.push(cb);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../panels/terminalPool", () => ({
  readScreen: (id: string) => screens.get(id) ?? null,
  submitPrompt: vi.fn(),
}));
vi.mock("./headless", () => ({ isHeadless: () => false, sendHeadless: () => Promise.resolve() }));

const { ptyWrite } = await import("../ipc/pty");
const { submitPrompt } = await import("../panels/terminalPool");
const status = await import("./status");
const { deliverPrompt, promptPending } = await import("./promptOutbox");
const { checkCards, AT_REST_MS, QUIET_MS } = await import("./statusWatchdog");

status.initStatusEngine();

const RULE = "─".repeat(60);
/** Claude Code at rest: a finished turn's line, then the empty prompt box. */
const restScreen = (input = "") => ["✻ Crunched for 1m 51s · done 1:28 PM", "", RULE, `❯ ${input}`, RULE, "  Opus 5.5 · $1.00"];
/** Claude Code busy: its spinner row above the box. */
const busyScreen = (verb = "Compacting conversation") => [`✽ ${verb}… (15s · ↓ 1.0k tokens)`, "", RULE, "❯ ", RULE];

/** Claude Code POSTs a hook for `id`; every subscriber hears it, the status engine first. */
function hook(id: string, name: string, extra: Partial<HookEvent> = {}): void {
  const env = {
    instanceId: id,
    receivedAt: Math.floor(Date.now() / 1000),
    event: { session_id: `s-${id}`, hook_event_name: name, transcript_path: null, cwd: null, permission_mode: null, tool_name: null, ...extra },
  } as HookEnvelope;
  for (const s of subscribers) s(env);
}

let n = 0;
function target() {
  const id = `f${++n}`;
  return { id, target: { instanceId: id, running: () => true, launch: () => {} } };
}
const typed = () => vi.mocked(submitPrompt).mock.calls.map((c) => c[1]);

// One fake clock for the file: the delivery's own timers outlive a test.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T18:00:00Z"));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  screens.clear();
  vi.mocked(submitPrompt).mockClear();
  vi.mocked(ptyWrite).mockClear();
});

describe("the status store's listeners", () => {
  it("read the state of the event they hear, not the one before it", () => {
    const { id } = target();
    const seen: string[] = [];
    const off = status.onStatusTransition((x, phase) => {
      if (x === id) seen.push(`${phase}:${status.getLiveStatuses().get(id)?.phase}`);
    });
    hook(id, "UserPromptSubmit");
    hook(id, "PreToolUse", { tool_name: "Bash" });
    hook(id, "Stop");
    off();
    expect(seen).toEqual(["working:working", "done:done"]);
  });

  it("see a /compact from rest end at PostCompact, with no Stop", () => {
    const { id } = target();
    const ends: boolean[] = [];
    const off = status.onCompactionEnd((x) => {
      if (x === id) ends.push(status.getLiveStatuses().get(id)!.compacting);
    });
    hook(id, "UserPromptSubmit");
    hook(id, "Stop");
    hook(id, "PreCompact", { trigger: "manual" });
    expect(status.getLiveStatuses().get(id)).toMatchObject({ phase: "done", compacting: true });
    hook(id, "PostCompact", { trigger: "manual" });
    off();
    expect(ends).toEqual([false]);
    expect(status.getLiveStatuses().get(id)).toMatchObject({ phase: "done", compacting: false });
  });
});

describe("Duck's prompt delivery", () => {
  it("sends a prompt queued mid-turn when the turn ends (it used to wait for the next prompt)", () => {
    const { id, target: t } = target();
    hook(id, "UserPromptSubmit");
    const d = deliverPrompt(t, "write the plan file");
    expect(d.state).toBe("queued");
    expect(promptPending(id)).toBe(true);
    hook(id, "PostToolUse", { tool_name: "Bash" });
    expect(typed()).toEqual([]);
    hook(id, "Stop");
    expect(typed()).toEqual(["write the plan file"]);
  });

  it("counts a /compact as taken when compaction starts, and holds the next prompt until it ends", async () => {
    const { id, target: t } = target();
    hook(id, "UserPromptSubmit");
    hook(id, "Stop");
    const c = deliverPrompt(t, "/compact");
    expect(c.state).toBe("sent");
    hook(id, "PreCompact", { trigger: "manual" });
    await expect(c.done).resolves.toEqual({ ok: true });

    const next = deliverPrompt(t, "continue with R1");
    expect(next.state).toBe("queued");
    expect(typed()).toEqual(["/compact"]);
    hook(id, "PostCompact", { trigger: "manual" });
    expect(typed()).toEqual(["/compact", "continue with R1"]);
  });

  it("counts a command as taken once it leaves the box, and doesn't let it hold the line", async () => {
    const { id, target: t } = target();
    hook(id, "Stop");
    screens.set(id, restScreen("/model"));
    const c = deliverPrompt(t, "/model");
    screens.set(id, restScreen()); // gone from the box; no hook comes for a command
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(c.done).resolves.toEqual({ ok: true });

    // The next prompt waits a moment for a turn the command never started, then goes.
    const next = deliverPrompt(t, "hello");
    expect(next.state).toBe("queued");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(typed()).toEqual(["/model", "hello"]);
  });

  it("re-sends the Enter with no screen to read while the session is still at rest", async () => {
    const { id, target: t } = target();
    hook(id, "Stop");
    const d = deliverPrompt(t, "hello");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.mocked(ptyWrite).mock.calls.filter((c) => c[0] === id)).toHaveLength(1);
    hook(id, "UserPromptSubmit");
    await expect(d.done).resolves.toEqual({ ok: true });
  });
});

describe("the status watchdog", () => {
  const settle = (restSince: Map<string, number>) => checkCards(restSince, (id) => screens.get(id) ?? null, Date.now());

  it("settles a turn whose Stop never came, and the prompt waiting for it goes in", () => {
    const { id, target: t } = target();
    hook(id, "UserPromptSubmit");
    expect(deliverPrompt(t, "next step").state).toBe("queued");
    const restSince = new Map<string, number>();

    // Still working on screen: left alone, however long.
    screens.set(id, busyScreen("Running tests"));
    vi.advanceTimersByTime(QUIET_MS + AT_REST_MS);
    expect(settle(restSince)).toEqual([]);

    // At rest on screen: settled once it has stayed so for AT_REST_MS.
    screens.set(id, restScreen());
    expect(settle(restSince)).toEqual([]);
    vi.advanceTimersByTime(AT_REST_MS);
    expect(settle(restSince)).toEqual([id]);
    expect(status.getLiveStatuses().get(id)).toMatchObject({ phase: "done", reason: "reconciled" });
    expect(typed()).toEqual(["next step"]);
  });

  it("lifts a compaction whose PostCompact never came, back to the phase it had", () => {
    const { id } = target();
    hook(id, "Stop");
    hook(id, "PreCompact", { trigger: "manual" });
    const ends: string[] = [];
    const off = status.onCompactionEnd((x, live) => x === id && ends.push(live.phase));
    const restSince = new Map<string, number>();
    screens.set(id, busyScreen());
    vi.advanceTimersByTime(QUIET_MS + AT_REST_MS);
    expect(settle(restSince)).toEqual([]);
    screens.set(id, restScreen());
    settle(restSince);
    vi.advanceTimersByTime(AT_REST_MS);
    expect(settle(restSince)).toEqual([id]);
    off();
    expect(ends).toEqual(["done"]);
    expect(status.getLiveStatuses().get(id)).toMatchObject({ phase: "done", compacting: false });
  });

  it("leaves a session alone while its hooks keep coming, or when it can't see it", () => {
    const { id } = target();
    hook(id, "UserPromptSubmit");
    const restSince = new Map<string, number>();
    screens.set(id, restScreen());
    settle(restSince);
    vi.advanceTimersByTime(AT_REST_MS);
    hook(id, "PostToolUse", { tool_name: "Read" }); // a hook just now: not quiet
    expect(settle(restSince)).toEqual([]);

    screens.delete(id);
    vi.advanceTimersByTime(QUIET_MS + AT_REST_MS);
    expect(settle(restSince)).toEqual([]);
    expect(status.getLiveStatuses().get(id)?.phase).toBe("working");
  });

  it("never touches a resting or waiting card", () => {
    const { id } = target();
    hook(id, "PermissionRequest", { tool_name: "Bash" });
    screens.set(id, restScreen());
    const restSince = new Map<string, number>();
    settle(restSince);
    vi.advanceTimersByTime(QUIET_MS + AT_REST_MS);
    expect(settle(restSince)).toEqual([]);
    expect(status.reconcileStatus(id)).toBe(false);
    expect(status.getLiveStatuses().get(id)?.phase).toBe("needs_you");
  });
});
