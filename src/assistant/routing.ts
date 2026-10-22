// Per-message routing (step M2): which model and effort a turn runs at. No
// classifier call: a few rules over the message and the thread.
//
// Effort: the thread's mode's (`modes.ts`: `medium`, `high` for a rubber duck),
// and `high` for "think hard" and its Russian and Spanish forms, and for a message
// that asks for research, a plan, a comparison or a browser chore. A Workbench
// event runs at `medium`.
//
// Model: Sonnet, except past the budget's soft limit, when turns run on Haiku for
// the rest of the month. There, "think hard" (said, or the drawer's toggle) sends
// that one message on Sonnet. It goes out as a per-message effort system message,
// so the cache stays; a model change re-reads the thread once on the other model.

import type { Backend } from "./brain/policy";
import { modeOf } from "./modes";
import type { Effort, Source } from "./protocol";
import { MAIN_MODEL, PRIMITIVE_MODEL } from "./prompt";

export type Brain = "sonnet" | "haiku";

export const MODELS: Record<Brain, string> = {
  sonnet: MAIN_MODEL,
  haiku: PRIMITIVE_MODEL,
};

/** "Think hard": raise the effort, and on Haiku, go to Sonnet for this message. */
const THINK_HARD = [
  /\bthink (?:it )?(?:hard(?:er)?|through|carefully|deeply)\b/i,
  /\b(?:take|have) a (?:hard|careful|deep) (?:look|think)\b/i,
  /\bultrathink\b/i,
  /подумай(?:те)? (?:как следует|хорошенько|внимательно|тщательно|серь[её]зно)/i,
  /\bpiénsa(?:lo|telo) (?:bien|con cuidado)\b/i,
];

/** Work that pays for more thinking: research, plans, comparisons, analysis,
 *  long write-ups, browser chores. */
const INVOLVED = [
  /\b(?:compare|comparison|versus|vs\.?|pros and cons|trade-?offs?)\b/i,
  /\b(?:research|investigate|look into|dig into)\b/i,
  /\b(?:analy[sz]e|analysis|evaluate|assess|review the)\b/i,
  /\b(?:make|draft|write|come up with|put together) (?:a |an |the )?(?:plan|strategy|proposal|roadmap)\b/i,
  /\bplan (?:out|for|how)\b|\bplanning\b/i,
  /\bwrite (?:it |this |that )?up\b|\bwrite-?up\b/i,
  /\b(?:browse|browser|firefox|web ?page|website|search the web|google it)\b/i,
  /сравни|сравнение|исследуй|изучи|разбер(?:и|ись)|проанализируй|анализ|составь план|спланируй|браузер|сайт/i,
  /\b(?:compara|comparación|investiga|analiza|análisis|planifica|navegador)\b/i,
];

export function asksHard(text: string): boolean {
  return THINK_HARD.some((r) => r.test(text));
}

/** The effort a message asks for, by its words and its thread's mode. */
export function pickEffort(text: string, mode: string | undefined, source: Source): Effort {
  // Events are Workbench's: "a task finished, tell the user". Their words are
  // results and transcripts, not the user asking for depth.
  if (source === "event") return "medium";
  if (asksHard(text) || INVOLVED.some((r) => r.test(text))) return "high";
  return modeOf(mode).effort;
}

export interface Route {
  brain: Brain;
  effort: Effort;
  /** The subscription brain answers instead (step M3); the API when absent. */
  backend?: Backend;
}

/**
 * Where a message runs. `effort`/`brain` are what the surface asked for (the
 * toggle); `degraded` is the budget past its soft limit.
 */
export function route(input: {
  text: string;
  source: Source;
  mode?: string;
  effort?: Effort;
  brain?: Brain;
  degraded: boolean;
}): Route {
  const effort = input.effort ?? pickEffort(input.text, input.mode, input.source);
  if (input.brain) return { brain: input.brain, effort };
  if (!input.degraded) return { brain: "sonnet", effort };
  // Past the soft limit: Sonnet only when asked for by name or by "think hard".
  const hard = input.source !== "event" && (input.effort === "high" || asksHard(input.text));
  return { brain: hard ? "sonnet" : "haiku", effort };
}
