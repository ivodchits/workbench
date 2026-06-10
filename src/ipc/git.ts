// Typed wrapper over the Rust git inspection command (step 1.3). Used by the
// project registration flow to detect whether a picked folder is a git repo and
// what its default branch is, so the Add-Project form can prefill name + branch.

import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  /** True when the folder contains a `.git` entry. */
  isGitRepo: boolean;
  /** Remote `origin/HEAD` branch, else the current branch; null if neither. */
  defaultBranch: string | null;
  /** Suggested project name — the folder's basename. */
  suggestedName: string | null;
}

/** Inspect a folder path for project registration. */
export function detectRepo(path: string): Promise<RepoInfo> {
  return invoke("detect_repo", { path });
}

/** A provisioned worktree (step 2.4): its on-disk path and `agent/<slug>` branch. */
export interface WorktreeResult {
  path: string;
  branch: string;
}

/**
 * Provision an isolated git worktree for an instance (design §6, step 2.4):
 * `git worktree add -b agent/<slug> <path>` from `repoRoot`. `baseDir` overrides
 * the default location (a sibling `.workbench/worktrees/`, decision 7). The branch
 * + folder are uniquified, so a repeated title never collides. Throws on git error.
 */
export function provisionWorktree(
  repoRoot: string,
  slug: string,
  baseDir?: string,
): Promise<WorktreeResult> {
  return invoke("provision_worktree", { repoRoot, slug, baseDir: baseDir ?? null });
}

// --- worktree post-create setup + teardown (step 2.5) -----------------------

/** Result of the optional post-create setup run for a fresh worktree (step 2.5). */
export interface SetupResult {
  /** True when nothing was configured, so no work ran. */
  skipped: boolean;
  /** `.env*` filenames copied from the repo root into the worktree. */
  copiedEnv: string[];
  /** The setup command that ran, if any. */
  command: string | null;
  /** Combined stdout+stderr of the setup command, tail-capped. */
  output: string;
  /** The command's exit code, or null if it couldn't launch / none ran. */
  exitCode: number | null;
  /** True when the command exited non-zero or failed to launch. */
  failed: boolean;
}

/**
 * Run a worktree's optional post-create steps (design §6 gotcha): copy the repo
 * root's `.env*` files and/or run `command` in the worktree. A no-op (`skipped`)
 * when nothing is configured. Never unwinds the worktree on a command failure —
 * `failed`/`output` are surfaced instead.
 */
export function runWorktreeSetup(
  repoRoot: string,
  worktreePath: string,
  command: string | null,
  copyEnv: boolean,
): Promise<SetupResult> {
  return invoke("run_worktree_setup", { repoRoot, worktreePath, command, copyEnv });
}

/** `git diff --stat`-style summary of a worktree vs its integration target. */
export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Per-file `--stat` text, for display. */
  stat: string;
  /** The ref the diff was taken against. */
  base: string;
}

/** Read-only context the teardown dialog needs before the user picks an action. */
export interface TeardownInfo {
  /** The main repo's current branch — the merge/rebase target; null if detached. */
  targetBranch: string | null;
  diff: DiffStat;
}

/** Gather the teardown dialog's context (step 2.5): integration target + diff. */
export function worktreeTeardownInfo(
  repoRoot: string,
  worktreePath: string,
): Promise<TeardownInfo> {
  return invoke("worktree_teardown_info", { repoRoot, worktreePath });
}

/**
 * Integrate a worktree's branch into the main repo (step 2.5). `rebase` replays
 * the worktree's commits onto `targetBranch` for a linear history then
 * fast-forwards; otherwise it merges `branch` into the main repo's current branch.
 * Rejects with git's message on a conflict / dirty tree.
 */
export function integrateWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  targetBranch: string,
  rebase: boolean,
): Promise<string> {
  return invoke("integrate_worktree", { repoRoot, worktreePath, branch, targetBranch, rebase });
}

/**
 * Remove a worktree and optionally its branch (step 2.5). `force` removes even
 * with uncommitted changes (the discard path); `deleteBranch` force-deletes the
 * `agent/<slug>` branch afterward.
 */
export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string | null,
  deleteBranch: boolean,
  force: boolean,
): Promise<void> {
  return invoke("remove_worktree", { repoRoot, worktreePath, branch, deleteBranch, force });
}
