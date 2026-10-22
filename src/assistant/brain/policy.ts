// Which brain answers a turn (step M3): the API (Sonnet, or Haiku past the soft
// limit, as M2 has it) or the subscription brain, a headless Claude Code on your
// subscription. Read per turn, so a new month's credits, or the subscription's
// windows filling up, move the next turn back without anyone deciding it.

import type { RateLimits } from "../../ipc/usageLimits";

export type Backend = "api" | "subscription";

/** `auto` switches on the budget; the other two pin a brain (for testing, or a
 *  month you'd rather spare the credits). */
export const BRAIN_POLICIES = ["auto", "api", "subscription"] as const;
export type BrainPolicy = (typeof BRAIN_POLICIES)[number];

/** The subscription takes Duck's turns only while both windows are under these
 *  (the worker tasks' thresholds, step D2). */
export const SUBSCRIPTION_LIMITS = { fiveHour: 70, sevenDay: 80 };

export interface BackendChoice {
  backend: Backend;
  /** Why, for the card a switch posts. */
  why: string;
}

/** The subscription's windows over their thresholds, in words; null when under
 *  (or unknown: no reading yet counts as room). */
export function subscriptionOver(l: RateLimits | null): string | null {
  const over: string[] = [];
  if (l?.fiveHour && l.fiveHour.usedPercentage >= SUBSCRIPTION_LIMITS.fiveHour)
    over.push(`its 5-hour limit is at ${Math.round(l.fiveHour.usedPercentage)}%`);
  if (l?.sevenDay && l.sevenDay.usedPercentage >= SUBSCRIPTION_LIMITS.sevenDay)
    over.push(`its weekly limit is at ${Math.round(l.sevenDay.usedPercentage)}%`);
  return over.length ? over.join(" and ") : null;
}

export function pickBackend(i: {
  policy: BrainPolicy;
  /** The API spend is past its soft limit for the month. */
  softReached: boolean;
  /** The API said the credit balance is too low (this month). */
  creditsOut: boolean;
  limits: RateLimits | null;
}): BackendChoice {
  if (i.policy === "api") return { backend: "api", why: "Duck's brain is set to the API" };
  if (i.policy === "subscription") return { backend: "subscription", why: "Duck's brain is set to your subscription" };
  if (!i.softReached && !i.creditsOut) return { backend: "api", why: "the API budget has room again" };
  const short = i.creditsOut ? "the API credit balance is too low" : "Duck's API spend is past its soft limit";
  const over = subscriptionOver(i.limits);
  if (over) return { backend: "api", why: `${short}, but your subscription is busy (${over})` };
  return { backend: "subscription", why: short };
}

/** The card on a thread's first turn on the other brain. */
export function switchCard(c: BackendChoice): string {
  return c.backend === "subscription" ? `Now answering on your subscription: ${c.why}.` : `Back on the API: ${c.why}.`;
}

/** An API error that says the credits are gone (not the budget's own cap, which
 *  the proxy enforces with its own message). */
export function creditsGone(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /credit balance is too low/i.test(msg);
}
