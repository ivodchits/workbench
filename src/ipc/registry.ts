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
  /** Shell command run in a freshly provisioned worktree (step 2.5); null = none. */
  worktreeSetupCommand: string | null;
  /** Re-seed the repo root's `.env*` files into new worktrees (step 2.5). */
  worktreeCopyEnv: boolean;
  /** SSH destination for a *remote* project (step 3.12) — a `~/.ssh/config` alias
   *  or `user@host`. null ⇒ a normal local project. */
  remoteSshDest: string | null;
  /** Working directory on the remote host (step 3.12); null for local. */
  remoteDir: string | null;
  sortOrder: number;
  createdAt: number;
}

export interface Instance {
  id: string;
  projectId: string;
  title: string;
  taskNote: string;
  /** While true, taskNote follows the agent's terminal title; a manual edit
   *  flips it false so the note is never overwritten. */
  taskNoteAuto: boolean;
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
  /** Per-instance accent color (step 3.9); null inherits the active theme accent. */
  accent: string | null;
  /** tmux session name on the host for a remote project's instance (step 3.12);
   *  null for a local instance. */
  remoteTmuxSession: string | null;
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
  worktreeSetupCommand?: string | null;
  worktreeCopyEnv?: boolean;
  /** SSH destination for a remote project (step 3.12); omit for local. */
  remoteSshDest?: string | null;
  /** Working directory on the remote host (step 3.12). */
  remoteDir?: string | null;
}

export interface ProjectPatch {
  name?: string;
  rootPath?: string;
  defaultBranch?: string | null;
  groupId?: string | null;
  worktreeSetupCommand?: string | null;
  worktreeCopyEnv?: boolean;
  remoteSshDest?: string | null;
  remoteDir?: string | null;
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
  /** Override the tmux session name when *adopting* an existing remote session
   *  (step 3.12); omit to default to `wb-<short id>` for a remote instance. */
  remoteTmuxSession?: string;
}

export interface InstancePatch {
  title?: string;
  taskNote?: string;
  taskNoteAuto?: boolean;
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
  /** Set a per-instance accent (hex/CSS color), or null to clear it (step 3.9). */
  accent?: string | null;
  /** Set/clear the remote tmux session name (step 3.12). */
  remoteTmuxSession?: string | null;
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

/** Mirror a terminal-title-derived note into taskNote, gated on the backend's
 *  auto flag. Resolves to the updated row, or null when nothing changed (the note
 *  was manually overridden, or the title matched what's already stored). */
export function mirrorTaskNote(id: string, title: string): Promise<Instance | null> {
  return invoke("mirror_instance_task_note", { id, title });
}

export function removeInstance(id: string): Promise<void> {
  return invoke("remove_instance", { id });
}
