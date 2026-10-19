// The confirmation policy (step W2): which tool calls run at once and which wait for
// a card. Consequential calls always ask; with "always confirm prompts" on, so does
// every prompt Duck sends to a session. Track T's trust engine replaces this behind
// the same `Gate` interface.

import type { Gate } from "./engine";
import type { DuckSettings } from "./settings";

/** Whether the call puts text in front of a coding session. */
function sendsPrompt(name: string, input: unknown): boolean {
  if (name === "send_prompt") return true;
  const prompt = (input as { prompt?: unknown } | null)?.prompt;
  return name === "create_session" && typeof prompt === "string" && !!prompt.trim();
}

export function createPolicy(settings: () => DuckSettings): Gate {
  return ({ name, input, tier }) => {
    if (tier === "consequential") return "ask";
    if (settings().confirmPrompts && sendsPrompt(name, input)) return "ask";
    return "run";
  };
}
