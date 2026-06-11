// Usage engine (step 3.1) — consumes the backend's transcript-tailing stream
// (`usage-updated`) and folds live token figures onto the registry store, so the
// rail card and console header tick up as an agent works. Mirrors the status
// engine's permanent, idempotent subscription: the stream lives for the whole app
// session, and a stored promise (rather than a boolean) sidesteps React
// StrictMode's double mount.

import { onUsageUpdate } from "../ipc/transcript";
import { applyInstanceUsage } from "./registry";

let subscription: Promise<unknown> | null = null;

/** Start folding token updates into the registry store. Idempotent; never torn
 *  down. Swallows a non-Tauri host (e.g. plain-browser preview) or a tailer that
 *  never starts — tokens just won't update, the app still works. */
export function initUsageEngine(): void {
  if (subscription) return;
  subscription = onUsageUpdate(applyInstanceUsage).catch(() => {});
}
