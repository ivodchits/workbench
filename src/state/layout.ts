// Layout persistence (step 1.6) — the bridge between dockview's serialized tree
// and SQLite (via `ipc/layout`). The dock arrangement (splits / tabs / floats /
// sizes) is saved on change and restored on launch (design §5, §4.6).
//
// We persist two things together: dockview's own `SerializedDockview` tree, and
// the list of instance ids that had a Console panel. On restore those become
// *dormant* console placeholders (the panel reappears in place, offering a
// relaunch) — live consoles aren't auto-respawned here because that means
// launching `claude`, which is session-restore (step 3.8). Writes are debounced
// so a drag-resize doesn't hammer the database.

import type { SerializedDockview } from "dockview";
import { getLayout, setLayout } from "../ipc/layout";

/**
 * The workspace key the MVP persists under. Layout is global for now; the schema
 * is keyed so a later step can save one tree per project (design §3) by passing
 * the project id here instead.
 */
export const WORKSPACE_KEY = "__global__";

/** Bump if the saved-payload shape changes incompatibly. */
const SCHEMA_VERSION = 1;

export interface SavedLayout {
  version: number;
  tree: SerializedDockview;
  /** Instance ids that had a Console panel — restored as dormant placeholders. */
  consoleInstanceIds: string[];
}

/** Load and validate the saved layout for `key`; null when absent or unreadable. */
export async function loadLayout(key: string = WORKSPACE_KEY): Promise<SavedLayout | null> {
  let raw: string | null;
  try {
    raw = await getLayout(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedLayout;
    if (parsed.version !== SCHEMA_VERSION || !parsed.tree) return null;
    return {
      version: parsed.version,
      tree: parsed.tree,
      consoleInstanceIds: Array.isArray(parsed.consoleInstanceIds)
        ? parsed.consoleInstanceIds
        : [],
    };
  } catch {
    return null; // corrupt blob — start from an empty workspace
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Persist `tree` + `consoleInstanceIds` for `key`, debounced. Repeated calls
 * (e.g. while dragging a splitter) collapse into one write after the layout
 * settles.
 */
export function saveLayoutDebounced(
  tree: SerializedDockview,
  consoleInstanceIds: string[],
  key: string = WORKSPACE_KEY,
  delayMs = 400,
): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload: SavedLayout = { version: SCHEMA_VERSION, tree, consoleInstanceIds };
    void setLayout(key, JSON.stringify(payload)).catch(() => {
      // Persisting layout is best-effort; a failed write just means the next
      // launch falls back to the last good layout (or empty).
    });
  }, delayMs);
}
