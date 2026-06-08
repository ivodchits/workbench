// Typed wrappers over the Rust registry commands (step 1.2). Mirrors the
// Group → Project → Instance model from design §3. The backend serializes these
// structs as camelCase (serde `rename_all`), so the types map across the IPC
// boundary directly — no manual snake_case translation needed here.

import { invoke } from "@tauri-apps/api/core";

/** Attention/lifecycle state of an instance (design §4.4 status palette). */
export type InstanceStatus = "idle" | "working" | "needs_you" | "done" | "closed";

export interface Group {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
}

export interface Project {
  id: string;
  groupId: string | null;
  name: string;
  rootPath: string;
  defaultBranch: string | null;
  sortOrder: number;
  createdAt: number;
}

export interface Instance {
  id: string;
  projectId: string;
  title: string;
  taskNote: string;
  worktreeOn: boolean;
  branch: string | null;
  lastSessionId: string | null;
  workingDir: string;
  status: InstanceStatus;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  sortOrder: number;
  createdAt: number;
  lastActivityAt: number | null;
}

// --- inputs -----------------------------------------------------------------
// `New*` creates; `*Patch` updates (omitted fields are left untouched). For
// nullable columns a patch field of `null` clears the value, `undefined` leaves
// it as-is.

export interface GroupPatch {
  name?: string;
  sortOrder?: number;
}

export interface NewProject {
  name: string;
  rootPath: string;
  defaultBranch?: string | null;
  groupId?: string | null;
}

export interface ProjectPatch {
  name?: string;
  rootPath?: string;
  defaultBranch?: string | null;
  groupId?: string | null;
  sortOrder?: number;
}

export interface NewInstance {
  projectId: string;
  title: string;
  taskNote?: string;
  worktreeOn?: boolean;
  branch?: string | null;
  /** Defaults to the parent project's root path when omitted. */
  workingDir?: string;
}

export interface InstancePatch {
  title?: string;
  taskNote?: string;
  worktreeOn?: boolean;
  branch?: string | null;
  lastSessionId?: string | null;
  workingDir?: string;
  status?: InstanceStatus;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  sortOrder?: number;
  lastActivityAt?: number | null;
}

// --- groups -----------------------------------------------------------------

export function createGroup(name: string): Promise<Group> {
  return invoke("create_group", { name });
}

export function getGroups(): Promise<Group[]> {
  return invoke("get_groups");
}

export function editGroup(id: string, patch: GroupPatch): Promise<Group> {
  return invoke("edit_group", { id, patch });
}

export function removeGroup(id: string): Promise<void> {
  return invoke("remove_group", { id });
}

// --- projects ---------------------------------------------------------------

export function createProject(input: NewProject): Promise<Project> {
  return invoke("create_project", { input });
}

export function getProjects(): Promise<Project[]> {
  return invoke("get_projects");
}

export function editProject(id: string, patch: ProjectPatch): Promise<Project> {
  return invoke("edit_project", { id, patch });
}

export function removeProject(id: string): Promise<void> {
  return invoke("remove_project", { id });
}

// --- instances --------------------------------------------------------------

export function createInstance(input: NewInstance): Promise<Instance> {
  return invoke("create_instance", { input });
}

/** List instances, optionally scoped to one project. */
export function getInstances(projectId?: string): Promise<Instance[]> {
  return invoke("get_instances", { projectId: projectId ?? null });
}

export function getInstance(id: string): Promise<Instance> {
  return invoke("get_instance_cmd", { id });
}

export function editInstance(id: string, patch: InstancePatch): Promise<Instance> {
  return invoke("edit_instance", { id, patch });
}

export function removeInstance(id: string): Promise<void> {
  return invoke("remove_instance", { id });
}
