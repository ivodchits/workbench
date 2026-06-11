// Usage-limit engine (step 3.2) — holds the account-wide rate-limit snapshot fed by
// the managed statusline (`usage-limits-updated`) and exposes it to React. Unlike the
// per-instance usage engine (step 3.1) this is a single app-global value, so it's its
// own tiny store rather than folded onto registry rows. The subscription lives for the
// whole app session; a stored promise (not a boolean) sidesteps StrictMode's double
// mount, mirroring the status/usage engines.
//
// Each update is also mirrored into the tray tooltip so a backgrounded Workbench still
// shows how close you are to a limit.

import { useSyncExternalStore } from "react";
import { getUsageLimits, onUsageLimits, type RateLimits } from "../ipc/usageLimits";
import { updateTrayUsage } from "../ipc/attention";

let limits: RateLimits | null = null;
const listeners = new Set<() => void>();
let started: Promise<unknown> | null = null;

function set(next: RateLimits): void {
  limits = next;
  for (const l of listeners) l();
  // Keep the tray tooltip's usage line in step (best-effort; ignore non-Tauri hosts).
  void updateTrayUsage(
    next.fiveHour?.usedPercentage ?? null,
    next.sevenDay?.usedPercentage ?? null,
  ).catch(() => {});
}

/** Start tracking account-wide limits: seed from the current snapshot, then follow
 *  live updates. Idempotent; never torn down. Swallows a non-Tauri host or a server
 *  that never starts — the meter just stays "unknown", the app still works. */
export function initUsageLimits(): void {
  if (started) return;
  started = Promise.all([
    getUsageLimits()
      .then((l) => {
        if (l) set(l);
      })
      .catch(() => {}),
    onUsageLimits(set),
  ]).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RateLimits | null {
  return limits;
}

/** Subscribe a component to the account-wide usage limits (or `null` if unknown). */
export function useUsageLimits(): RateLimits | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
