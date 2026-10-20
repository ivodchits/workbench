// The trust engine's decision (step T1; design → Trust policy): may this call of
// one of Duck's own tools run without a card? Layers in order, the first that
// answers wins:
//
//   1. kill switch   trust paused: W2's cards (consequential calls ask)
//      mode         the project is `off`: the same
//      rate guard   too many automatic approvals in this thread: the same
//   2. floor        always ask (`floor.ts`, or the tool says so), whatever the rules say
//      setting      "ask before every prompt" is on and this sends one
//   3. rules        deny / ask / allow (`rules.ts`)
//   4. mandate      the user's own words in this thread allow it (`mandate.ts`)
//   5. judge        T2; answers nothing yet
//      default      the tier: reversible runs, consequential asks
//
// A project in `shadow` mode gets the decision logged and the W2 card anyway.

import type { Tier } from "../tools/registry";
import { floorHit } from "./floor";
import { evaluate, type Rule } from "./rules";

export type Mode = "off" | "shadow" | "live";

export type Layer =
  | "paused"
  | "mode"
  | "rate"
  | "floor"
  | "setting"
  | "rule"
  | "mandate"
  | "default";

/** What a tool says about one of its calls, for the rules and the floor. */
export interface TrustFacts {
  projectId: string | null;
  /** Matched by a rule's specifier: `assistant:answer_choice(question)`. */
  specifier?: string;
  /** Text the floor reads: a prompt Duck sends, a typed answer. */
  texts?: string[];
  /** The Claude Code call a permission answer would let through. */
  call?: { tool: string; input: Record<string, unknown> };
  /** The user's words the call quotes as their permission. */
  grant?: string;
  /** Why this call always asks, whatever the rules say (a plugin action whose
   *  file asks to confirm it). Treated as the floor. */
  asks?: string;
}

export interface TrustConfig {
  paused: boolean;
  rules: readonly Rule[];
  /** A project's mode when it isn't the default, `live`. */
  modes: Readonly<Record<string, Mode>>;
  floorOff: readonly string[];
  /** Threads the rate guard paused. */
  tripped: readonly string[];
}

export interface TrustRequest {
  /** `assistant:<tool>`. */
  tool: string;
  tier: Tier;
  threadId: string;
  facts: TrustFacts;
  /** "Ask before every prompt" covers this call. */
  settingAsks: boolean;
}

export type Outcome = "allow" | "ask" | "deny";

export interface Decision {
  outcome: Outcome;
  layer: Layer;
  reason: string;
  ruleId?: string;
  /** The message that granted it (mandate). */
  grantSeq?: number;
  /** The project's mode is shadow: logged, but W2's answer is what happens. */
  shadow: boolean;
}

export interface DecideDeps {
  /** The user's message in this thread that the quote comes from, or null. */
  grant(threadId: string, quote: string): { seq: number } | null;
}

/** What W2's policy did: consequential calls and, with the setting, prompts ask. */
export function baseline(req: Pick<TrustRequest, "tier" | "settingAsks">): Outcome {
  return req.tier === "consequential" || req.settingAsks ? "ask" : "allow";
}

/** The text of a Claude Code call the floor reads. */
function callTexts(call: TrustFacts["call"]): string[] {
  if (!call) return [];
  const i = call.input;
  const out = [call.tool];
  for (const k of ["command", "file_path", "path", "notebook_path", "url", "pattern"])
    if (typeof i[k] === "string") out.push(i[k] as string);
  return out;
}

export function decide(req: TrustRequest, cfg: TrustConfig, deps: DecideDeps): Decision {
  const base = baseline(req);
  const mode = (req.facts.projectId && cfg.modes[req.facts.projectId]) || "live";
  const fallback = (layer: Layer, reason: string): Decision => ({
    outcome: base,
    layer,
    reason,
    shadow: false,
  });
  if (cfg.paused) return fallback("paused", "trust is paused");
  if (mode === "off") return fallback("mode", "trust is off for this project");
  if (cfg.tripped.includes(req.threadId))
    return fallback("rate", "the rate guard paused trust for this thread");

  const shadow = mode === "shadow";
  const out = (d: Omit<Decision, "shadow">): Decision => ({ ...d, shadow });

  const floor = floorHit(
    [...(req.facts.texts ?? []), ...callTexts(req.facts.call)],
    cfg.floorOff,
  );
  if (floor) return out({ outcome: "ask", layer: "floor", reason: `floor: ${floor.label}` });
  if (req.facts.asks) return out({ outcome: "ask", layer: "floor", reason: req.facts.asks });
  if (req.settingAsks)
    return out({ outcome: "ask", layer: "setting", reason: "you asked to confirm every prompt" });

  const hit = evaluate(cfg.rules, {
    tool: req.tool,
    projectId: req.facts.projectId,
    specifier: req.facts.specifier,
  });
  if (hit)
    return out({
      outcome: hit.effect,
      layer: "rule",
      reason: `${hit.effect} ${hit.rule.pattern}${hit.rule.projectId ? " (this project)" : ""}`,
      ruleId: hit.rule.id,
    });

  if (req.facts.grant && req.tier === "consequential") {
    const g = deps.grant(req.threadId, req.facts.grant);
    if (g)
      return out({
        outcome: "allow",
        layer: "mandate",
        reason: `you said: "${req.facts.grant.trim().slice(0, 160)}"`,
        grantSeq: g.seq,
      });
    return out({
      outcome: "ask",
      layer: "mandate",
      reason: "the permission it quoted isn't in your messages",
    });
  }

  return out({
    outcome: req.tier === "consequential" ? "ask" : "allow",
    layer: "default",
    reason: req.tier === "consequential" ? "no rule allows it" : "reversible",
  });
}
