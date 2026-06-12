// Skill-manager store (step 3.7b) — the runtime registry of Skill Manager panels.
// Sibling of the `mcp` store: a panel is bound to a *project* (project skills live
// under its `.claude/skills/`, alongside the global user scope and read-only plugin
// skills), one panel per project, keyed by a deterministic `skills:<projectId>` id
// so reopening focuses the existing panel rather than stacking.
//
// Like the MCP/diff panels it owns no PTY and holds no precious buffer — it
// re-fetches the skill list from the backend on mount / refresh / after each edit —
// so the store carries only the *binding* (which project, its repo root, its name).
// That keeps layout restore trivial: the descriptor is the whole state.

import { useSyncExternalStore } from "react";

export interface SkillSession {
  /** Deterministic `skills:<projectId>` — the dock panel id + reconcile key. */
  skillId: string;
  /** The project whose skills this panel manages. */
  projectId: string;
  /** The project's root path — where `.claude/skills/` lives. */
  repoRoot: string;
  /** Display label — the project name. Shown in the tab + header. */
  title: string;
}

/** A persisted skill panel: its binding is the whole state (no buffers to restore). */
export type SkillDescriptor = SkillSession;

interface SkillsState {
  /** Skill panels in creation order (stable render order). */
  open: SkillSession[];
  /** The panel to bring to front, or null. Only a *new* value triggers focus. */
  activeId: string | null;
}

let state: SkillsState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: SkillsState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): SkillsState {
  return state;
}

/** Read the open skill panels outside React (used by the Workspace reconcile path). */
export function getOpenSkills(): SkillSession[] {
  return state.open;
}

/** The active skill panel id, read outside React (see `getOpenSkills`). */
export function getActiveSkillId(): string | null {
  return state.activeId;
}

/** The deterministic panel id for a project's skill manager. */
export function skillIdFor(projectId: string): string {
  return `skills:${projectId}`;
}

/** Where a skill panel points: a project and its root path. */
export interface SkillTarget {
  projectId: string;
  repoRoot: string;
  title: string;
}

/**
 * Open the Skill Manager for a project, focusing it if one already exists. An
 * existing panel has its binding refreshed (the repo root / name can change on a
 * project edit) so the next fetch reads the right directory.
 */
export function openSkills(target: SkillTarget): void {
  const skillId = skillIdFor(target.projectId);
  const existing = state.open.find((s) => s.skillId === skillId);
  if (existing) {
    const open = state.open.map((s) =>
      s.skillId === skillId ? { ...s, repoRoot: target.repoRoot, title: target.title } : s,
    );
    emit({ open, activeId: skillId });
    return;
  }
  const session: SkillSession = { skillId, ...target };
  emit({ open: [...state.open, session], activeId: skillId });
}

/**
 * Seed skill sessions for `descriptors` not already open — backs the skill panels a
 * saved layout restores. Idempotent (a live session is left untouched).
 */
export function hydrateSkills(descriptors: SkillDescriptor[]): void {
  const present = new Set(state.open.map((s) => s.skillId));
  const additions = descriptors.filter((s) => !present.has(s.skillId));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Close a skill panel entirely. */
export function closeSkills(skillId: string): void {
  if (!state.open.some((s) => s.skillId === skillId)) return;
  const open = state.open.filter((s) => s.skillId !== skillId);
  const activeId = state.activeId === skillId ? null : state.activeId;
  emit({ open, activeId });
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the skills store. */
export function useSkills(): SkillsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
