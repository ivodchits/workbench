// Worktree orchestration (step 2.4, extended 2.5) — design §6, decisions 5 & 7.
//
// Turns the per-instance worktree toggle from a stub (which only persisted the
// flag, step 1.4) into real provisioning: flipping it ON asks the backend to run
// `git worktree add -b agent/<slug> <path>`, repoints the instance's working dir
// at the worktree, runs the project's optional post-create setup (step 2.5: copy
// `.env*`, deps install), and relaunches its console there so `claude` runs in
// isolation.
//
// Step 2.5 also adds teardown: `teardownWorktree` merges/rebases the agent branch
// (or discards it), runs `git worktree remove`, and points the instance back at
// the project root. `revertToRoot` stays as the lightweight "detach, keep on disk"
// path (the original 2.4 toggle-off behavior).

import {
  integrateWorktree,
  provisionWorktree as ipcProvisionWorktree,
  removeWorktree,
  runWorktreeSetup,
  type SetupResult,
} from "../ipc/git";
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
 * Find the instances that share a working directory with another worktree-off
 * instance (step 2.6 — design §6 caveat, decision 6). Two toggle-off instances
 * in the same dir can step on each other's edits, so the rail flags them
 * (non-blocking) and offers a one-click "isolate in a worktree" (the 2.4 flow).
 *
 * Only worktree-*off* instances are considered — a worktree-on instance has its
 * own isolated dir and can't collide. `closed` instances aren't running, so they
 * can't overwrite anything and are excluded (no spurious warning from a parked
 * session). A dir is "shared" only when ≥2 such instances point at it; the result
 * is the set of every flagged instance's id.
 */
export function sharedWorkingDirInstances(instances: Instance[]): Set<string> {
  const byDir = new Map<string, string[]>();
  for (const i of instances) {
    if (i.worktreeOn || i.status === "closed") continue;
    const key = normalizeDir(i.workingDir);
    const ids = byDir.get(key);
    if (ids) ids.push(i.id);
    else byDir.set(key, [i.id]);
  }
  const shared = new Set<string>();
  for (const ids of byDir.values()) {
    if (ids.length >= 2) for (const id of ids) shared.add(id);
  }
  return shared;
}

/** Normalize a path for equality: forward slashes, no trailing separator, lower-
 *  cased. Windows paths are case-insensitive and these working dirs come straight
 *  from the same project record, so this conservatively folds the few ways the
 *  same root could differ in string form. */
function normalizeDir(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
 * `agent/<slug>` branch + folder, persist the new working dir + branch + flag, run
 * the project's optional post-create setup (step 2.5), then relaunch a live console
 * in the worktree. Setup runs *before* the relaunch so deps are present when
 * `claude` starts. Throws (leaving the instance untouched) if git provisioning
 * fails; a *setup* failure is non-fatal — it's returned in the result for display.
 *
 * Returns the setup outcome (`skipped` when the project configured no setup).
 */
export async function provisionWorktree(
  instance: Instance,
  project: Project,
): Promise<SetupResult> {
  const baseDir = (await getPref("worktreeBasePath", "")).trim() || undefined;
  const result = await ipcProvisionWorktree(project.rootPath, slugify(instance.title), baseDir);
  await updateInstance(instance.id, {
    worktreeOn: true,
    workingDir: result.path,
    branch: result.branch,
  });

  // Post-create setup (step 2.5): only call the backend when the project actually
  // configured something, so the common no-setup case stays a pure provision.
  const command = (project.worktreeSetupCommand ?? "").trim();
  let setup: SetupResult = {
    skipped: true,
    copiedEnv: [],
    command: null,
    output: "",
    exitCode: null,
    failed: false,
  };
  if (command || project.worktreeCopyEnv) {
    setup = await runWorktreeSetup(
      project.rootPath,
      result.path,
      command || null,
      project.worktreeCopyEnv,
    );
  }

  relaunchLiveConsole(instance.id);
  return setup;
}

/** How a worktree's branch is folded back into the project on teardown (step 2.5). */
export type IntegrateMode = "merge" | "rebase";

export interface TeardownOptions {
  /** Integrate the branch first (`merge`/`rebase`), or skip and just discard. */
  integrate: IntegrateMode | null;
  /** The branch to integrate into (the main repo's current branch). */
  targetBranch?: string | null;
  /** `git worktree remove --force` — needed to discard an uncommitted worktree. */
  force: boolean;
}

/**
 * Tear down `instance`'s worktree (step 2.5): optionally merge/rebase its branch
 * into `targetBranch`, then `git worktree remove` + delete the branch, and point
 * the instance back at the project root.
 *
 * A live console holds the worktree dir open (its PTY's cwd), which blocks removal
 * on Windows — so we close it *first*, then do the git work, then reopen at the
 * root. On failure the worktree still exists, so we reopen there and rethrow for
 * the caller to surface.
 */
export async function teardownWorktree(
  instance: Instance,
  project: Project,
  opts: TeardownOptions,
): Promise<void> {
  const live = getOpenConsoles().some(
    (c) => c.instanceId === instance.id && c.status !== "dormant",
  );
  if (live) {
    closeConsole(instance.id);
    release(instance.id); // free the dir so `git worktree remove` can delete it
  }

  try {
    if (opts.integrate && instance.branch && opts.targetBranch) {
      await integrateWorktree(
        project.rootPath,
        instance.workingDir,
        instance.branch,
        opts.targetBranch,
        opts.integrate === "rebase",
      );
    }
    await removeWorktree(
      project.rootPath,
      instance.workingDir,
      instance.branch,
      true, // delete the agent/<slug> branch
      opts.force,
    );
  } catch (e) {
    // The worktree is still on disk — reopen its console where it was and rethrow.
    if (live) openConsole(instance);
    throw e;
  }

  await updateInstance(instance.id, {
    worktreeOn: false,
    workingDir: project.rootPath,
    branch: null,
  });
  if (live) {
    const updated = getRegistry().instances.find((i) => i.id === instance.id);
    if (updated) openConsole(updated);
  }
}

/**
 * Detach `instance` from its worktree: point it back at the project root and clear
 * the flag + branch, *leaving the worktree folder + branch on disk* (the "detach,
 * keep on disk" teardown option — step 2.5). Relaunches a live console at the root.
 * For merge/discard cleanup that removes the worktree, see `teardownWorktree`.
 */
export async function revertToRoot(instance: Instance, project: Project): Promise<void> {
  await updateInstance(instance.id, {
    worktreeOn: false,
    workingDir: project.rootPath,
    branch: null,
  });
  relaunchLiveConsole(instance.id);
}
