// The gate the engine asks before each tool call (step W2, the trust engine since
// T1): run it now, ask on a card, or refuse it. A thin adapter: the decision is
// `trust/decide.ts`'s, over the rules and switches in the trust store; this adds the
// rate guard and writes the decision log. Without a trust store (it failed to
// load), it falls back to W2's cards: consequential calls ask, and with "always
// confirm prompts" on, so does every prompt Duck sends to a session.

import type { StoredMessage } from "../ipc/assistant";
import type { Gate } from "./engine";
import type { DuckSettings } from "./settings";
import { baseline, decide, type Decision, type TrustRequest } from "./trust/decide";
import { findGrant } from "./trust/mandate";
import { RATE_LIMIT, type TrustStore } from "./trust/store";

/** Whether the call puts text in front of a coding session. */
function sendsPrompt(name: string, input: unknown): boolean {
  if (name === "send_prompt") return true;
  const prompt = (input as { prompt?: unknown } | null)?.prompt;
  return name === "create_session" && typeof prompt === "string" && !!prompt.trim();
}

export interface PolicyDeps {
  settings: () => DuckSettings;
  trust?: TrustStore | null;
  /** A thread's messages, for checking a quoted permission. */
  messages?: (threadId: string) => readonly StoredMessage[];
  now?: () => number;
}

/** Calls that ran as they would have under W2 aren't worth a log row. */
const quiet = (d: Decision, base: string) =>
  d.layer === "paused" || d.layer === "mode" || (d.outcome === "allow" && base === "allow");

export function createPolicy(deps: PolicyDeps): Gate {
  const now = deps.now ?? Date.now;
  return (call) => {
    if (call.tier === "read") return "run";
    const req: TrustRequest = {
      tool: `assistant:${call.name}`,
      tier: call.tier,
      threadId: call.threadId,
      facts: call.facts ?? { projectId: null },
      settingAsks: deps.settings().confirmPrompts && sendsPrompt(call.name, call.input),
    };
    const base = baseline(req);
    const trust = deps.trust;
    if (!trust) return base === "ask" ? "ask" : "run";

    let d = decide(req, trust.config(), {
      grant: (threadId, quote) => findGrant(deps.messages?.(threadId) ?? [], quote, now()),
    });
    let notice: string | undefined;
    if (!d.shadow && d.outcome === "allow" && base === "ask" && trust.approved(call.threadId, now())) {
      d = { ...d, outcome: "ask", layer: "rate", reason: `more than ${RATE_LIMIT} automatic approvals in 10 minutes` };
      notice = `Trust is paused for this thread: Duck approved more than ${RATE_LIMIT} calls on its own in 10 minutes, so it asks again. Pause and resume trust to reset it.`;
    }
    if (!quiet(d, base))
      void trust
        .log({
          ts: now(),
          threadId: call.threadId,
          toolUseId: call.toolUseId,
          projectId: req.facts.projectId,
          tool: req.tool,
          summary: call.summary ?? call.name,
          input: call.input,
          decision: d.outcome,
          layer: d.layer,
          reason: d.grantSeq !== undefined ? `${d.reason} (message ${d.grantSeq})` : d.reason,
          ruleId: d.ruleId ?? null,
          shadow: d.shadow,
        })
        .catch((e: unknown) => console.warn("duck: a trust decision wasn't logged", e));

    const outcome = d.shadow ? base : d.outcome;
    if (outcome === "deny")
      return {
        verdict: "deny",
        reason: `Not done: a trust rule refuses this call (${d.reason}). Don't retry it; tell the user if it matters.`,
      };
    return { verdict: outcome === "allow" ? "run" : "ask", notice };
  };
}
