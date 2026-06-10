// Worktree orchestration (step 2.4) — design §6, decisions 5 & 7.
//
// Turns the per-instance worktree toggle from a stub (which only persisted the
// flag, step 1.4) into real provisioning: flipping it ON asks the backend to run
// `git worktree add -b agent/<slug> <path>`, repoints the instance's working dir
// at the worktree, and relaunches its console there so `claude` runs in isolation.
//
// Flipping it OFF here only points the instance back at the project root — the
// worktree folder + branch are *left on disk*. Merge / `git worktree remove`
// cleanup is the next step (2.5); this keeps 2.4 to "provision + run there".

import { provisionWorktree as ipcProvisionWorktree } from "../ipc/git";
import { getPref } from "../ipc/prefs";
import type { Instance, Project } from "../ipc/registry";
import { closeConsole, getOpenConsoles, openConsole } from "./consoles";
import { getRegistry, updateInstance } from "./registry";
import { release } from "../panels/terminalPool";

/** Mirror the backend's slug rule (lowercase, non-alphanumerics → `-`) so the
 *  branch name we preview matches what gets created. The backend re-sanitizes and
 *  uniquifies, so this only needs to be a faithful first guess. */
export function slugify(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "agent";
}

/**
 * If `instanceId` has a *live* (non-dormant) console, restart it so `claude`
 * relaunches in the instance's current working dir. Reads the freshly-reloaded
 * instance from the registry, so callers must `updateInstance(...)` first. A
 * dormant placeholder or a closed console is left alone — its next open already
 * picks up the new dir.
 */
function relaunchLiveConsole(instanceId: string): void {
  const live = getOpenConsoles().find(
    (c) => c.instanceId === instanceId && c.status !== "dormant",
  );
  if (!live) return;
  closeConsole(instanceId);
  release(instanceId); // the only path that kills the PTY (see terminalPool)
  const updated = getRegistry().instances.find((i) => i.id === instanceId);
  if (updated) openConsole(updated);
}

/**
 * Provision an isolated worktree for `instance` and point it there: create the
 * `agent/<slug>` branch + folder, persist the new working dir + branch + flag, and
 * relaunch a live console in the worktree. Throws (leaving the instance untouched)
 * if git fails, so the caller can surface the error.
 */
export async function provisionWorktree(
  instance: Instance,
  project: Project,
): Promise<void> {
  const baseDir = (await getPref("worktreeBasePath", "")).trim() || undefined;
  const result = await ipcProvisionWorktree(project.rootPath, slugify(instance.title), baseDir);
  await updateInstance(instance.id, {
    worktreeOn: true,
    workingDir: result.path,
    branch: result.branch,
  });
  relaunchLiveConsole(instance.id);
}

/**
 * Point `instance` back at the project root, clearing the worktree flag + branch.
 * The worktree folder + branch stay on disk (cleanup is step 2.5). Relaunches a
 * live console at the project root.
 */
export async function revertToRoot(instance: Instance, project: Project): Promise<void> {
  await updateInstance(instance.id, {
    worktreeOn: false,
    workingDir: project.rootPath,
    branch: null,
  });
  relaunchLiveConsole(instance.id);
}
