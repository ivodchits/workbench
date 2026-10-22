import { describe, expect, it } from "vitest";

import type { StoredMessage } from "../ipc/assistant";
import type { DuckEvent } from "./protocol";
import { createTurnClock, GAP_MS, statLine, timingStats, type TurnTiming } from "./timings";

function clock(opts: { five?: () => number | null; cost?: () => number } = {}) {
  let t = 1_000;
  const kept: TurnTiming[] = [];
  const c = createTurnClock({
    now: () => t,
    fiveHour: async () => opts.five?.() ?? null,
    cost: () => opts.cost?.() ?? 0,
    subscriptionModel: (mode) => (mode === "duck" ? "opus" : "sonnet"),
    keep: (r) => kept.push(r),
  });
  const at = (ms: number) => void (t = ms);
  return { c, kept, at };
}

const user = (threadId: string, source: string): DuckEvent => ({
  type: "message",
  message: { threadId, seq: 1, ts: 0, role: "user", content: [{ type: "text", text: "hi" }], source } as StoredMessage,
});
const state = (threadId: string, s: "thinking" | "streaming" | "idle" | "waiting"): DuckEvent => ({ type: "turnState", threadId, state: s, queued: 0 });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the turn clock (D3)", () => {
  it("times a spoken turn on the subscription: first words, first sentence, the whole reply, the window", async () => {
    let five = 10;
    const { c, kept, at } = clock({ five: () => five });
    c.event(state("t", "thinking"));
    c.event({ type: "routing", threadId: "t", mode: "duck", brain: "sonnet", effort: "high", backend: "subscription" });
    c.event(user("t", "voice"));
    at(2_200);
    c.event({ type: "delta", threadId: "t", text: "So the clock" });
    at(2_900);
    c.event({ type: "delta", threadId: "t", text: " drifts. What then" });
    at(4_000);
    five = 11;
    c.event(state("t", "idle"));
    await settle();
    expect(kept).toEqual([
      {
        at: 1_000,
        threadId: "t",
        mode: "duck",
        backend: "subscription",
        model: "opus",
        voice: true,
        firstTextMs: 1_200,
        firstSentenceMs: 1_900,
        totalMs: 3_000,
        costUsd: null,
        fiveHourBefore: 10,
        fiveHourAfter: 11,
      },
    ]);
  });

  it("keeps only your own turns that said something, and an API turn's cost", async () => {
    let cost = 0.5;
    const { c, kept, at } = clock({ cost: () => cost });
    // A Workbench event.
    c.event(state("t", "thinking"));
    c.event({ type: "routing", threadId: "t", mode: "assistant", brain: "sonnet", effort: "medium" });
    c.event(user("t", "event"));
    c.event({ type: "delta", threadId: "t", text: "News." });
    c.event(state("t", "idle"));
    // A provisional turn you talked over: nothing kept, nothing said.
    c.event(state("t", "thinking"));
    c.event({ type: "routing", threadId: "t", mode: "assistant", brain: "sonnet", effort: "medium" });
    c.event(state("t", "idle"));
    // Yours, typed; the reply has no sentence end.
    c.event(state("t", "thinking"));
    c.event({ type: "routing", threadId: "t", mode: "assistant", brain: "haiku", effort: "medium" });
    c.event(user("t", "desktop"));
    at(1_500);
    c.event({ type: "delta", threadId: "t", text: "Done" });
    cost = 0.52;
    at(1_800);
    c.event(state("t", "idle"));
    await settle();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ backend: "api", model: "haiku", voice: false, firstSentenceMs: 500, totalMs: 800 });
    expect(kept[0].costUsd).toBeCloseTo(0.02);
  });

  it("starts a queued turn at its routing", async () => {
    const { c, kept, at } = clock();
    c.event(state("t", "thinking"));
    c.event({ type: "routing", threadId: "t", mode: "chat", brain: "sonnet", effort: "medium" });
    c.event(user("t", "desktop"));
    at(1_400);
    c.event({ type: "delta", threadId: "t", text: "One. " });
    at(2_000);
    c.event({ type: "routing", threadId: "t", mode: "chat", brain: "sonnet", effort: "medium" });
    c.event(user("t", "desktop"));
    at(2_300);
    c.event({ type: "delta", threadId: "t", text: "Two. " });
    at(2_500);
    c.event(state("t", "idle"));
    await settle();
    expect(kept.map((k) => [k.at, k.totalMs])).toEqual([
      [1_000, 1_000],
      [2_000, 500],
    ]);
  });
});

const row = (p: Partial<TurnTiming>): TurnTiming => ({
  at: 0,
  threadId: "t",
  mode: "duck",
  backend: "api",
  model: "sonnet",
  voice: true,
  firstTextMs: 800,
  firstSentenceMs: 1_500,
  totalMs: 4_000,
  costUsd: 0.01,
  fiveHourBefore: null,
  fiveHourAfter: null,
  ...p,
});

describe("the readout (D3)", () => {
  it("gives medians per mode and brain, and the rates over long conversations only", () => {
    const min = 60_000;
    const rows = [
      // A 12-minute duck conversation on the API, turns 3 minutes apart.
      ...[0, 3, 6, 9, 12].map((m, i) => row({ at: m * min, firstSentenceMs: 1_000 + i * 100, costUsd: 0.02 })),
      // A lone turn in another thread: in the medians, not the rates.
      row({ threadId: "u", at: 0, firstSentenceMs: 9_000, costUsd: 5 }),
      // On the subscription: 20 minutes, the window 10% → 14%; then 6 minutes
      // across a reset, which says nothing of the rate.
      ...[0, 10 * min, 20 * min - 4_000].map((at, i) =>
        row({ backend: "subscription", model: "opus", at, costUsd: null, fiveHourBefore: 10 + 2 * i, fiveHourAfter: 10 + 2 * i + (i === 2 ? 0 : 1) }),
      ),
      row({ backend: "subscription", model: "opus", threadId: "v", at: 0, costUsd: null, fiveHourBefore: 90, fiveHourAfter: 95 }),
      row({ backend: "subscription", model: "opus", threadId: "v", at: 6 * min, costUsd: null, fiveHourBefore: 1, fiveHourAfter: 2 }),
      // Further apart than the gap: two conversations, neither long.
      row({ backend: "subscription", model: "opus", threadId: "w", at: 0, costUsd: null, fiveHourBefore: 0, fiveHourAfter: 50 }),
      row({ backend: "subscription", model: "opus", threadId: "w", at: GAP_MS + 5_000, costUsd: null, fiveHourBefore: 50, fiveHourAfter: 99 }),
    ];
    const [api, sub] = timingStats(rows);
    expect(api).toMatchObject({ mode: "duck", backend: "api", turns: 6, firstSentenceMs: 1_250, usdPerHour: expect.any(Number) });
    // $0.10 over 12 minutes and 4 seconds.
    expect(api.usdPerHour).toBeCloseTo(0.1 / ((12 * min + 4_000) / 3_600_000), 5);
    // +4% over 20 minutes.
    expect(sub).toMatchObject({ backend: "subscription", model: "opus", turns: 7, usdPerHour: null, fiveHourPerHour: 12 });
    expect(statLine(sub)).toBe(
      "duck on your subscription (opus): first sentence in 1.5 s, the whole reply 4.0 s (medians of 7 turns, 7 spoken); the 5-hour window +12.0% an hour of conversation",
    );
  });
});
