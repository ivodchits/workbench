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
import type { ShellDescriptor } from "./shells";
import type { EditorDescriptor } from "./editors";
import type { DiffDescriptor } from "./diffs";
import type { McpDescriptor } from "./mcp";

/**
 * The workspace key the MVP persists under. Layout is global for now; the schema
 * is keyed so a later step can save one tree per project (design §3) by passing
 * the project id here instead.
 */
export const WORKSPACE_KEY = "__global__";

/** Bump if the saved-payload shape changes incompatibly. (v2 added `shells`;
 *  v3 made shells project-scoped; v4 added `editors`.) `diffs` (step 2.7) and
 *  `mcps` (step 3.7) were added without a bump — every reader defaults them to
 *  `[]` when absent, so old and new blobs interoperate. Exported because layout
 *  presets (step 3.3) stamp the same version onto the `SavedLayout` snapshots
 *  they store. */
export const SCHEMA_VERSION = 4;

export interface SavedLayout {
  version: number;
  tree: SerializedDockview;
  /** Instance ids that had a Console panel — restored as dormant placeholders. */
  consoleInstanceIds: string[];
  /** Shell panels (id + target dir + label) — restored as dormant placeholders. */
  shells: ShellDescriptor[];
  /** Editor panels (id + root + label + open tabs) — tabs re-read from disk. */
  editors: EditorDescriptor[];
  /** Diff/Review panels (instance binding) — re-fetched from git on restore. */
  diffs: DiffDescriptor[];
  /** MCP Server Manager panels (project binding) — re-fetched on restore. */
  mcps: McpDescriptor[];
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
      shells: Array.isArray(parsed.shells) ? parsed.shells : [],
      editors: Array.isArray(parsed.editors) ? parsed.editors : [],
      diffs: Array.isArray(parsed.diffs) ? parsed.diffs : [],
      mcps: Array.isArray(parsed.mcps) ? parsed.mcps : [],
    };
  } catch {
    return null; // corrupt blob — start from an empty workspace
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function write(
  key: string,
  tree: SerializedDockview,
  consoleInstanceIds: string[],
  shells: ShellDescriptor[],
  editors: EditorDescriptor[],
  diffs: DiffDescriptor[],
  mcps: McpDescriptor[],
): Promise<void> {
  const payload: SavedLayout = {
    version: SCHEMA_VERSION,
    tree,
    consoleInstanceIds,
    shells,
    editors,
    diffs,
    mcps,
  };
  return setLayout(key, JSON.stringify(payload)).catch(() => {
    // Persisting layout is best-effort; a failed write just means the next
    // launch falls back to the last good layout (or empty).
  });
}

/**
 * Persist `tree` + console / shell / editor panels for `key`, debounced. Repeated
 * calls (e.g. while dragging a splitter) collapse into one write after the layout
 * settles.
 */
export function saveLayoutDebounced(
  tree: SerializedDockview,
  consoleInstanceIds: string[],
  shells: ShellDescriptor[],
  editors: EditorDescriptor[],
  diffs: DiffDescriptor[],
  mcps: McpDescriptor[],
  key: string = WORKSPACE_KEY,
  delayMs = 400,
): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void write(key, tree, consoleInstanceIds, shells, editors, diffs, mcps);
  }, delayMs);
}

/**
 * Persist immediately, cancelling any pending debounced write. Used when swapping
 * away from a project (design §3 per-project layout): the outgoing project's tree
 * must be flushed before the dock is cleared and the next project loaded.
 */
export function saveLayoutNow(
  tree: SerializedDockview,
  consoleInstanceIds: string[],
  shells: ShellDescriptor[],
  editors: EditorDescriptor[],
  diffs: DiffDescriptor[],
  mcps: McpDescriptor[],
  key: string,
): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void write(key, tree, consoleInstanceIds, shells, editors, diffs, mcps);
}
