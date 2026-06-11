// Typed access to the account-wide usage-limit meter (step 3.2). The managed
// statusline (installed by the Rust backend at user level) forwards Claude Code's
// statusline JSON to the local server, which extracts the `rate_limits` object and
// keeps one account-global snapshot — every session reports the same figures, so the
// newest POST wins. The backend emits `usage-limits-updated` as it changes and serves
// the current snapshot via the `usage_limits` command.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One rolling usage window: percentage of the account's allowance consumed, and the
 *  epoch-seconds instant it resets (so the UI can show a live countdown). */
export interface RateWindow {
  usedPercentage: number;
  resetsAt: number;
}

/** The account-wide rate-limit snapshot. Both windows are optional: they appear only
 *  after the first API response in a session, and on Pro/Max plans only. */
export interface RateLimits {
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  /** When Workbench received this snapshot (epoch seconds). */
  receivedAt: number;
}

/** Read the current account-wide limits, or `null` until the first statusline POST. */
export function getUsageLimits(): Promise<RateLimits | null> {
  return invoke("usage_limits");
}

/** Subscribe to account-wide limit updates. Returns an unlisten function. */
export function onUsageLimits(cb: (limits: RateLimits) => void): Promise<UnlistenFn> {
  return listen<RateLimits>("usage-limits-updated", (event) => cb(event.payload));
}
