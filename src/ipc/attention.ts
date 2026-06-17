// Attention IPC (step 2.3) — notify the Rust side of needs-you transitions
// and badge count changes. Calls are fire-and-forget: failures are logged but
// never surface to the user (the tray/notification are purely informational).

import { invoke } from "@tauri-apps/api/core";

/** Fire an OS toast notification for one instance that just entered needs-you.
 *  The Rust side throttles repeated calls for the same agent by design (the
 *  frontend only calls this on fresh `→ needs_you` transitions). */
export function notifyNeedsYou(
  projectName: string,
  instanceTitle: string,
  taskNote?: string,
): Promise<void> {
  return invoke("notify_needs_you", {
    projectName,
    instanceTitle,
    taskNote: taskNote ?? null,
  });
}

/** Fire a generic OS toast with a composed title/body (step 4.6) — used for
 *  escalation re-pings ("still waiting") and stuck-working flags, which need
 *  different wording from the fixed `notifyNeedsYou` headline. Fire-and-forget. */
export function notifyAlert(title: string, body: string): Promise<void> {
  return invoke("notify_alert", { title, body });
}

/** Update the tray icon tooltip to reflect the current needs-you count.
 *  Pass 0 to clear the badge (tooltip reverts to "Workbench"). */
export function updateTrayBadge(count: number): Promise<void> {
  return invoke("update_tray_badge", { count });
}

/** Update the tray tooltip's account-wide usage clause (step 3.2). Either window may
 *  be null (absent / not reported yet); both null clears the clause. */
export function updateTrayUsage(
  fiveHourPct: number | null,
  weeklyPct: number | null,
): Promise<void> {
  return invoke("update_tray_usage", { fiveHourPct, weeklyPct });
}
