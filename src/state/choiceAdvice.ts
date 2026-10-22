// Choice advice (step T3): Duck's word on a session's open question or plan, a
// suggested answer or a plan review, shown on its choice card while that prompt is
// open. One per session, the latest; ephemeral, like the trust lines.

import { useSyncExternalStore } from "react";

import type { ChoiceAdvice } from "../assistant/port";

let advice: ReadonlyMap<string, ChoiceAdvice> = new Map();
const listeners = new Set<() => void>();

export function setChoiceAdvice(instanceId: string, a: ChoiceAdvice): void {
  const next = new Map(advice);
  next.set(instanceId, a);
  advice = next;
  for (const l of listeners) l();
}

/** The advice on the prompt `choiceId`, if that's what it is about. */
export function useChoiceAdvice(instanceId: string, choiceId: string): ChoiceAdvice | null {
  const a = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => advice.get(instanceId) ?? null,
  );
  return a && a.choiceId === choiceId ? a : null;
}
