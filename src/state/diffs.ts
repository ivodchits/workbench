// Diffs store (step 2.7) — the runtime registry of Diff/Review panels. Sibling of
// the `consoles`/`shells`/`editors` stores. A Diff panel is bound to an *instance*
// (design §5 Diff/Review: "what did this agent change?"), one panel per instance,
// keyed by a deterministic `diff:<instanceId>` id so reopening focuses the existing
// panel rather than stacking duplicates.
//
// Like an editor, a diff panel owns no PTY — but unlike an editor it holds no
// precious buffer either: it re-fetches the diff from git on mount / refresh / save,
// so the store carries only the *binding* (which instance, where its working dir is,
// which repo it belongs to). Inline edits live in the panel's local state until
// saved to disk. That keeps this store tiny and makes layout restore trivial: the
// descriptor is the whole state.

import { useSyncExternalStore } from "react";

export interface DiffSession {
  /** Deterministic `diff:<instanceId>` — the dock panel id + reconcile key. */
  diffId: string;
  /** The instance whose changes this panel reviews. */
  instanceId: string;
  /** Project the instance belongs to (the reconcile filter, like editors). */
  projectId: string;
  /** The project's repo root — used to resolve the diff base. */
  repoRoot: string;
  /** The instance's working dir (project root, or its worktree) — what we diff. */
  workingDir: string;
  /** Display label — the instance title. Shown in the tab + header. */
  title: string;
}

/** A persisted diff panel: its binding is the whole state (no buffers to restore). */
export type DiffDescriptor = DiffSession;

interface DiffsState {
  /** Diff panels in creation order (stable render order). */
  open: DiffSession[];
  /** The diff to bring to front, or null. Only a *new* value triggers focus. */
  activeId: string | null;
}

let state: DiffsState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: DiffsState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): DiffsState {
  return state;
}

/** Read the open diffs outside React (used by the Workspace reconcile path). */
export function getOpenDiffs(): DiffSession[] {
  return state.open;
}

/** The active diff id, read outside React (see `getOpenDiffs`). */
export function getActiveDiffId(): string | null {
  return state.activeId;
}

/** The deterministic panel id for an instance's diff. */
export function diffIdFor(instanceId: string): string {
  return `diff:${instanceId}`;
}

/** Where a diff panel points: an instance, its working dir, and its repo root. */
export interface DiffTarget {
  instanceId: string;
  projectId: string;
  repoRoot: string;
  workingDir: string;
  title: string;
}

/**
 * Open the Diff/Review panel for an instance, focusing it if one already exists.
 * An existing panel has its binding refreshed (the working dir / title can change
 * when the instance's worktree toggles) so the next fetch reads the right tree.
 */
export function openDiff(target: DiffTarget): void {
  const diffId = diffIdFor(target.instanceId);
  const existing = state.open.find((d) => d.diffId === diffId);
  if (existing) {
    const open = state.open.map((d) =>
      d.diffId === diffId
        ? { ...d, repoRoot: target.repoRoot, workingDir: target.workingDir, title: target.title }
        : d,
    );
    emit({ open, activeId: diffId });
    return;
  }
  const session: DiffSession = { diffId, ...target };
  emit({ open: [...state.open, session], activeId: diffId });
}

/**
 * Seed diff sessions for `descriptors` not already open — backs the diff panels a
 * saved layout restores. Idempotent (a live session is left untouched).
 */
export function hydrateDiffs(descriptors: DiffDescriptor[]): void {
  const present = new Set(state.open.map((d) => d.diffId));
  const additions = descriptors.filter((d) => !present.has(d.diffId));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Close a diff panel entirely. */
export function closeDiff(diffId: string): void {
  if (!state.open.some((d) => d.diffId === diffId)) return;
  const open = state.open.filter((d) => d.diffId !== diffId);
  const activeId = state.activeId === diffId ? null : state.activeId;
  emit({ open, activeId });
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the diffs store. */
export function useDiffs(): DiffsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
