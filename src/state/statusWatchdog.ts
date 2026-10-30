// The status watchdog: a card's live status comes from hooks, and a hook that
// never arrives (the app restarted mid-turn, a POST that failed, an event Claude
// Code doesn't send) used to leave it "working" or "compacting" for good. Then
// nothing that waits for the turn's end ever went: a queued prompt, the autopilot,
// a wait_for_session.
//
// So every few seconds each card that is working or compacting is checked against
// its terminal screen. When the screen has shown Claude Code at rest (its prompt
// box, no spinner) for a while, with no hook from the session meanwhile, the card
// is settled (`reconcileStatus`) as its missing hook would have. A working session
// always shows its spinner (thinking, a tool, a subagent, a compaction), so a quiet
// screen with no spinner is a finished turn. A console this window holds no
// terminal for is left to its hooks.
//
// State layer that reads terminals, as `promptOutbox.ts` does.

import { readScreen } from "../panels/terminalPool";
import { screenAtRest } from "./remoteCreate";
import { getLiveStatuses, reconcileStatus, type LiveStatus } from "./status";

/** How often the cards are looked at. */
const CHECK_MS = 5_000;
/** How long the screen has to have shown the session at rest, without a break. */
export const AT_REST_MS = 20_000;
/** How long since the session's last hook: a working session that is quiet on
 *  screen but still sending hooks is left alone. */
export const QUIET_MS = 30_000;

/** Whether a card's hooks may have gone missing: it says working or compacting. */
const unsettled = (live: LiveStatus) => live.phase === "working" || live.compacting;

/**
 * One look at every card (exported for tests). `restSince` keeps, per card, when
 * its screen was first seen at rest in the current run of looks.
 */
export function checkCards(
  restSince: Map<string, number>,
  read: (instanceId: string) => string[] | null,
  now: number,
): string[] {
  const settled: string[] = [];
  const seen = new Set<string>();
  for (const [id, live] of getLiveStatuses()) {
    if (!unsettled(live)) continue;
    const screen = read(id);
    if (!screen || !screenAtRest(screen)) continue;
    seen.add(id);
    const since = restSince.get(id) ?? now;
    restSince.set(id, since);
    if (now - since < AT_REST_MS || now - live.updatedAt * 1000 < QUIET_MS) continue;
    if (reconcileStatus(id, Math.floor(now / 1000))) {
      console.warn(`status: settled ${id}: its screen is at rest, but its ${live.compacting ? "PostCompact" : "Stop"} hook never came`);
      settled.push(id);
    }
  }
  // A card that's busy again (or settled) starts its next run of looks afresh.
  for (const id of [...restSince.keys()]) if (!seen.has(id) || settled.includes(id)) restSince.delete(id);
  return settled;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the watchdog. Idempotent; lasts for the window's life, like the status
 *  engine's own subscription. */
export function initStatusWatchdog(): void {
  if (timer) return;
  const restSince = new Map<string, number>();
  timer = setInterval(() => checkCards(restSince, readScreen, Date.now()), CHECK_MS);
}
