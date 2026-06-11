// Layout presets (step 3.3) — named snapshots of a project's dock arrangement,
// recalled by number key (Ctrl+Shift+1..9) or from the presets bar (design §5,
// §7).
//
// A preset stores the *exact* `SavedLayout` payload — the same dock tree plus
// console/shell/editor/diff descriptors the per-project layout persists (see
// `state/layout`). It is therefore **project-scoped**: the saved tree references
// that project's panel ids, so a literal snapshot only faithfully reproduces
// within the project it was captured from. Number keys 1..9 recall the active
// project's presets in order.
//
// Persistence reuses the `layouts` table (via `ipc/layout`) under a
// `presets:<projectId>` key — one JSON blob per project holding all its presets —
// so no backend/schema change is needed.

import { useSyncExternalStore } from "react";
import { getLayout, setLayout } from "../ipc/layout";
import type { SavedLayout } from "./layout";
import { getActiveProject } from "./activeProject";

export interface LayoutPreset {
  id: string;
  name: string;
  layout: SavedLayout;
}

interface PresetsFile {
  version: number;
  presets: LayoutPreset[];
}

/** Bump if the on-disk presets blob shape changes incompatibly. */
const FILE_VERSION = 1;
const presetsKey = (projectId: string) => `presets:${projectId}`;

// --- the live layout controller (registered by Workspace) -------------------
// Snapshotting and applying a layout must run *inside* the Workspace: they touch
// the single `DockviewApi` and its restore/reconcile machinery (hydrate dormant
// panels, swap the tree without tearing down live PTYs, settle membership). So the
// Workspace registers these two operations here and this store drives them. Null
// until the dock is ready.
export interface LayoutController {
  /** Capture the current dock as a `SavedLayout`, or null if no dock is ready. */
  snapshot: () => SavedLayout | null;
  /** Replace the current arrangement with `layout` (same-project restore). */
  apply: (layout: SavedLayout) => void;
}

let controller: LayoutController | null = null;

/** Register (or clear) the live dock's snapshot/apply hooks. Called by Workspace. */
export function registerLayoutController(c: LayoutController | null): void {
  controller = c;
}

// --- reactive store, scoped to the active project ---------------------------
interface PresetsState {
  /** The project these presets belong to (null = none loaded). */
  projectId: string | null;
  presets: LayoutPreset[];
}

let state: PresetsState = { projectId: null, presets: [] };
const listeners = new Set<() => void>();

function emit(next: PresetsState): void {
  state = next;
  for (const l of listeners) l();
}

/** The store's presets, but only when they match `projectId` (else empty — a load
 *  for the active project hasn't landed yet, so we must not mutate a stale set). */
function presetsFor(projectId: string): LayoutPreset[] {
  return state.projectId === projectId ? state.presets : [];
}

async function readPresets(projectId: string): Promise<LayoutPreset[]> {
  let raw: string | null;
  try {
    raw = await getLayout(presetsKey(projectId));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PresetsFile;
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.presets)) return [];
    return parsed.presets.filter(
      (p): p is LayoutPreset =>
        !!p && typeof p.id === "string" && typeof p.name === "string" && !!p.layout,
    );
  } catch {
    return []; // corrupt blob — start this project with no presets
  }
}

async function persist(projectId: string, presets: LayoutPreset[]): Promise<void> {
  const file: PresetsFile = { version: FILE_VERSION, presets };
  await setLayout(presetsKey(projectId), JSON.stringify(file)).catch(() => {
    // Best-effort: a failed write just means this preset edit isn't durable; the
    // in-memory store still reflects it for the session.
  });
}

/**
 * Load `projectId`'s presets into the store (emits on change). Called by the
 * presets bar whenever the active project changes; a stale load (the active
 * project moved on while we awaited) is discarded so it can't clobber the store.
 */
export async function loadPresetsFor(projectId: string | null): Promise<void> {
  if (!projectId) {
    emit({ projectId: null, presets: [] });
    return;
  }
  const presets = await readPresets(projectId);
  if (getActiveProject() !== projectId) return; // superseded by a later switch
  emit({ projectId, presets });
}

// Local id generator — presets are machine-local, so a timestamp + counter suffix
// is unique enough without pulling in a uuid dependency. (`Date.now()` is fine
// here: this runs only in response to a user save, never during workflow replay.)
let seq = 0;
function newId(): string {
  return `p${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/**
 * Save the current dock arrangement as a new preset named `name`. No-op without a
 * live dock or active project. Returns the created preset (or null on no-op).
 */
export async function saveCurrentAsPreset(name: string): Promise<LayoutPreset | null> {
  const projectId = getActiveProject();
  if (!projectId || !controller) return null;
  const layout = controller.snapshot();
  if (!layout) return null;
  const existing = presetsFor(projectId);
  const preset: LayoutPreset = {
    id: newId(),
    name: name.trim() || `preset ${existing.length + 1}`,
    layout,
  };
  const presets = [...existing, preset];
  emit({ projectId, presets });
  await persist(projectId, presets);
  return preset;
}

/** Re-capture the current arrangement into an existing preset (overwrite layout). */
export async function updatePresetLayout(id: string): Promise<void> {
  const projectId = getActiveProject();
  if (!projectId || !controller) return;
  const layout = controller.snapshot();
  if (!layout) return;
  const presets = presetsFor(projectId).map((p) => (p.id === id ? { ...p, layout } : p));
  emit({ projectId, presets });
  await persist(projectId, presets);
}

/** Apply the preset with `id` to the live dock (no-op if it's gone). */
export function applyPreset(id: string): void {
  const projectId = getActiveProject();
  if (!projectId || !controller) return;
  const preset = presetsFor(projectId).find((p) => p.id === id);
  if (preset) controller.apply(preset.layout);
}

/** Recall the preset at 1-based position `n` for the active project (number-key). */
export function applyPresetByIndex(n: number): void {
  const projectId = getActiveProject();
  if (!projectId || !controller) return;
  const preset = presetsFor(projectId)[n - 1];
  if (preset) controller.apply(preset.layout);
}

/** Rename a preset (trimmed; empty names are ignored). */
export async function renamePreset(id: string, name: string): Promise<void> {
  const projectId = getActiveProject();
  if (!projectId) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const presets = presetsFor(projectId).map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  emit({ projectId, presets });
  await persist(projectId, presets);
}

/** Delete a preset. */
export async function deletePreset(id: string): Promise<void> {
  const projectId = getActiveProject();
  if (!projectId) return;
  const presets = presetsFor(projectId).filter((p) => p.id !== id);
  emit({ projectId, presets });
  await persist(projectId, presets);
}

/** Subscribe a component to the active project's presets. */
export function usePresets(): PresetsState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
