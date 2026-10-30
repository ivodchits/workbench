// The composer's queue against the real status store (`promptDelivery.test.ts`
// mocks it): a prompt queued while a session works or compacts goes in at the
// turn's end, typed as into a session at rest, and the periodic look sends one
// whose moment was missed.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { HookEnvelope, HookEvent } from "../ipc/hooks";

const subscribers: ((env: HookEnvelope) => void)[] = [];
const typed: { id: string; text: string; midTurn: boolean }[] = [];

vi.mock("../ipc/hooks", () => ({
  onHookEvent: vi.fn((cb: (env: HookEnvelope) => void) => {
    subscribers.push(cb);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("./terminalPool", () => ({ readScreen: () => null }));
vi.mock("../state/promptOutbox", () => ({
  typePrompt: (id: string, text: string, midTurn: boolean) => {
    typed.push({ id, text, midTurn });
    return Promise.resolve({ ok: true });
  },
}));

const status = await import("../state/status");
const { getQueued, setQueued } = await import("../state/queue");
const { initQueueDelivery, lookAtQueue, sendOrQueue } = await import("./promptDelivery");

status.initStatusEngine();

function hook(id: string, name: string, extra: Partial<HookEvent> = {}): void {
  const env = {
    instanceId: id,
    receivedAt: Math.floor(Date.now() / 1000),
    event: { session_id: `s-${id}`, hook_event_name: name, transcript_path: null, cwd: null, permission_mode: null, tool_name: null, ...extra },
  } as HookEnvelope;
  for (const s of subscribers) s(env);
}

beforeAll(() => vi.useFakeTimers());
afterAll(() => vi.useRealTimers());

describe("the composer's queue", () => {
  it("sends a prompt queued during a /compact at PostCompact, as into a session at rest", () => {
    const stop = initQueueDelivery();
    hook("c1", "UserPromptSubmit");
    hook("c1", "Stop");
    hook("c1", "PreCompact", { trigger: "manual" });
    expect(sendOrQueue("c1", "carry on")).toBe("queued");
    hook("c1", "PostCompact", { trigger: "manual" });
    // It used to go in as "mid-turn" (the store read before the overlay lifted),
    // so a box still holding it could be taken as sent.
    expect(typed).toEqual([{ id: "c1", text: "carry on", midTurn: false }]);
    expect(getQueued("c1")).toBeUndefined();
    stop();
  });

  it("sends a prompt queued mid-turn at the turn's end, not mid-turn", () => {
    typed.length = 0;
    const stop = initQueueDelivery();
    hook("c2", "UserPromptSubmit");
    expect(sendOrQueue("c2", "next")).toBe("queued");
    hook("c2", "Stop");
    expect(typed).toEqual([{ id: "c2", text: "next", midTurn: false }]);
    stop();
  });

  it("sends a prompt whose moment was missed once its session has sat at rest", () => {
    typed.length = 0;
    hook("c3", "Stop");
    setQueued("c3", "stranded"); // queued with no transition left to send it
    const restSince = new Map<string, number>();
    lookAtQueue(restSince, 0);
    expect(typed).toEqual([]);
    lookAtQueue(restSince, 2_000);
    expect(typed).toEqual([{ id: "c3", text: "stranded", midTurn: false }]);

    // Never while the session works or compacts.
    typed.length = 0;
    hook("c4", "UserPromptSubmit");
    setQueued("c4", "later");
    lookAtQueue(restSince, 10_000);
    lookAtQueue(restSince, 20_000);
    hook("c5", "Stop");
    hook("c5", "PreCompact", { trigger: "auto" });
    setQueued("c5", "later");
    lookAtQueue(restSince, 30_000);
    lookAtQueue(restSince, 40_000);
    expect(typed).toEqual([]);
  });
});
