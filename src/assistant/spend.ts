// What a turn cost (step A3). The proxy meters every call and reports it as an
// `assistant-usage` event (model, purpose, cost), but not which thread it was for.
// A thread call is billed to the turn that is running, so the meter follows the
// engine's turn states: a turn starts when a thread leaves `idle`, and a `thread`
// call is added to it when exactly one turn is streaming (a thread parked on a
// confirmation makes no calls). With two running at once the call is left out
// rather than guessed. Primitives (titles and the like) aren't part of a turn.

import { THREAD_PURPOSE } from "./client";
import type { TurnState } from "./protocol";

export interface TurnMeter {
  /** Follow a thread's turn state (from `turnState` events). */
  state(threadId: string, state: TurnState): void;
  /** Bill a metered call; returns the thread it went to, if any. */
  usage(purpose: string, costUsd: number): string | null;
  /** Each thread's latest turn cost. */
  turns(): Record<string, number>;
}

export function createTurnMeter(): TurnMeter {
  const states = new Map<string, TurnState>();
  const costs = new Map<string, number>();
  return {
    state(threadId, state) {
      const was = states.get(threadId) ?? "idle";
      if (was === "idle" && state !== "idle") costs.set(threadId, 0);
      if (state === "idle") states.delete(threadId);
      else states.set(threadId, state);
    },
    usage(purpose, costUsd) {
      if (purpose !== THREAD_PURPOSE) return null;
      const calling = [...states].filter(([, s]) => s !== "waiting");
      if (calling.length !== 1) return null;
      const [threadId] = calling[0];
      costs.set(threadId, (costs.get(threadId) ?? 0) + costUsd);
      return threadId;
    },
    turns: () => Object.fromEntries(costs),
  };
}
