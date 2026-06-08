// Registry store (step 1.3) — the single source of truth for groups + projects
// in the frontend, backed by the SQLite registry commands (see `ipc/registry`).
//
// A tiny external store (no dependency) exposed to React via `useSyncExternal
// Store`. Mutations call the backend and then reload the whole registry: at the
// scale of a personal project list this is simpler and less bug-prone than
// surgically patching local arrays, and keeps the UI in lockstep with SQLite.
//
// Instances are deliberately absent here — step 1.3 is the *project* registry;
// the instance tree (and its own loading) lands with the rail in step 1.4.

import { useSyncExternalStore } from "react";
import {
  createGroup,
  createProject,
  editProject,
  getGroups,
  getProjects,
  removeGroup,
  removeProject,
  type Group,
  type NewProject,
  type Project,
  type ProjectPatch,
} from "../ipc/registry";

export interface RegistryState {
  groups: Group[];
  projects: Project[];
  /** False until the first load resolves, so the UI can show a loading state. */
  loaded: boolean;
  /** Last error from a load/mutation, surfaced near the rail. */
  error: string | null;
}

let state: RegistryState = { groups: [], projects: [], loaded: false, error: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<RegistryState>): void {
  // Replace the object (new reference) so `useSyncExternalStore` re-renders.
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RegistryState {
  return state;
}

/** Reload groups + projects from the backend. Safe to call after any mutation. */
export async function loadRegistry(): Promise<void> {
  try {
    const [groups, projects] = await Promise.all([getGroups(), getProjects()]);
    setState({ groups, projects, loaded: true, error: null });
  } catch (e) {
    setState({ error: String(e), loaded: true });
  }
}

/** Run a mutation, reload on success, and surface any failure as `error`. */
async function mutate(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await loadRegistry();
  } catch (e) {
    setState({ error: String(e) });
    throw e;
  }
}

// --- project mutations ------------------------------------------------------

export function addProject(input: NewProject): Promise<void> {
  return mutate(() => createProject(input));
}

export function updateProject(id: string, patch: ProjectPatch): Promise<void> {
  return mutate(() => editProject(id, patch));
}

export function deleteProject(id: string): Promise<void> {
  return mutate(() => removeProject(id));
}

// --- group mutations --------------------------------------------------------

/** Create a group and return its row (callers often need the new id to assign). */
export async function addGroup(name: string): Promise<Group> {
  const group = await createGroup(name);
  await loadRegistry();
  return group;
}

export function deleteGroup(id: string): Promise<void> {
  return mutate(() => removeGroup(id));
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the registry store. */
export function useRegistry(): RegistryState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
