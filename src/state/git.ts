// Git-panel store (step 3.11) — the runtime registry of Git panels. Sibling of
// the `mcp` store: a panel is bound to a *project* (design §5 Git — the panel is
// the repo-level lens, not an instance's diff), one panel per project, keyed by a
// deterministic `git:<projectId>` id so reopening focuses the existing panel
// rather than stacking.
//
// Like the MCP panel it owns no PTY and holds no precious buffer — it re-fetches
// log/branches/status from the backend on mount / refresh / after each action —
// so the store carries only the *binding* (which project, its repo root, its
// name). That keeps layout restore trivial: the descriptor is the whole state.

import { useSyncExternalStore } from "react";

export interface GitSession {
  /** Deterministic `git:<projectId>` — the dock panel id + reconcile key. */
  gitId: string;
  /** The project whose repo this panel views. */
  projectId: string;
  /** The project's root path — the repo the panel reads/writes. */
  repoRoot: string;
  /** Display label — the project name. Shown in the tab + header. */
  title: string;
}

/** A persisted Git panel: its binding is the whole state (nothing to restore). */
export type GitDescriptor = GitSession;

interface GitState {
  /** Git panels in creation order (stable render order). */
  open: GitSession[];
  /** The panel to bring to front, or null. Only a *new* value triggers focus. */
  activeId: string | null;
}

let state: GitState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: GitState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): GitState {
  return state;
}

/** Read the open Git panels outside React (used by the Workspace reconcile path). */
export function getOpenGits(): GitSession[] {
  return state.open;
}

/** The active Git panel id, read outside React (see `getOpenGits`). */
export function getActiveGitId(): string | null {
  return state.activeId;
}

/** The deterministic panel id for a project's Git panel. */
export function gitIdFor(projectId: string): string {
  return `git:${projectId}`;
}

/** Where a Git panel points: a project and its root path. */
export interface GitTarget {
  projectId: string;
  repoRoot: string;
  title: string;
}

/**
 * Open the Git panel for a project, focusing it if one already exists. An existing
 * panel has its binding refreshed (the repo root / name can change on a project
 * edit) so the next fetch reads the right repo.
 */
export function openGit(target: GitTarget): void {
  const gitId = gitIdFor(target.projectId);
  const existing = state.open.find((g) => g.gitId === gitId);
  if (existing) {
    const open = state.open.map((g) =>
      g.gitId === gitId ? { ...g, repoRoot: target.repoRoot, title: target.title } : g,
    );
    emit({ open, activeId: gitId });
    return;
  }
  const session: GitSession = { gitId, ...target };
  emit({ open: [...state.open, session], activeId: gitId });
}

/**
 * Seed Git sessions for `descriptors` not already open — backs the Git panels a
 * saved layout restores. Idempotent (a live session is left untouched).
 */
export function hydrateGits(descriptors: GitDescriptor[]): void {
  const present = new Set(state.open.map((g) => g.gitId));
  const additions = descriptors.filter((g) => !present.has(g.gitId));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Close a Git panel entirely. */
export function closeGit(gitId: string): void {
  if (!state.open.some((g) => g.gitId === gitId)) return;
  const open = state.open.filter((g) => g.gitId !== gitId);
  const activeId = state.activeId === gitId ? null : state.activeId;
  emit({ open, activeId });
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the Git store. */
export function useGits(): GitState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
