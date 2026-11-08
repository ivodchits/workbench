import { invoke } from "@tauri-apps/api/core";

/** How often the main page tells the backend it's alive. The backend's renderer
 *  watchdog (`src-tauri/src/renderer_watchdog.rs`) restarts the page after 45 s of
 *  silence while the window is shown. */
const BEAT_MS = 5000;

/** Start the heartbeat. Main window only: torn-off windows and the voice overlay
 *  aren't watched. */
export function startHeartbeat(): void {
  const beat = () => void invoke("ui_heartbeat").catch(() => {});
  beat();
  window.setInterval(beat, BEAT_MS);
}
