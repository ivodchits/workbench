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

// --- diff / review (step 2.7) -----------------------------------------------

/** One changed file in an instance's diff vs its base (step 2.7). */
export interface DiffFile {
  /** Path relative to the working dir, forward-slashed — the list key/label. */
  path: string;
  /** Absolute path for the editor to read/write; null for a deleted file. */
  absPath: string | null;
  /** "added" | "modified" | "deleted" | "typechange" | "untracked". */
  status: string;
  insertions: number;
  deletions: number;
  /** True when git reports the file binary (no textual diff / inline edit). */
  binary: boolean;
}

/** An instance's changes vs its base ref (step 2.7) — the Diff/Review summary. */
export interface InstanceDiff {
  /** The ref the diff was taken against (shown as "vs &lt;base&gt;"). */
  base: string;
  files: DiffFile[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * List what an instance changed vs its base (step 2.7, design §5). `base` overrides
 * the auto-resolved default (a worktree diffs against the main repo's current
 * branch; a root instance against `HEAD`). Includes untracked files.
 */
export function instanceDiff(
  repoRoot: string,
  workingDir: string,
  base?: string,
): Promise<InstanceDiff> {
  return invoke("instance_diff", { repoRoot, workingDir, base: base ?? null });
}

/** One file's unified diff (step 2.7). */
export interface FileDiff {
  path: string;
  base: string;
  /** Unified-diff text — each line led by `+`/`-`/` `/`@`. Empty when binary. */
  text: string;
  binary: boolean;
  untracked: boolean;
}

/**
 * Read one file's unified diff against `base` (step 2.7). Untracked files have no
 * base version, so pass `untracked: true` to get an all-added synthesis from disk.
 */
export function instanceFileDiff(
  workingDir: string,
  base: string,
  path: string,
  untracked: boolean,
): Promise<FileDiff> {
  return invoke("instance_file_diff", { workingDir, base, path, untracked });
}

// --- git panel (step 3.11) --------------------------------------------------
// Project-scoped repo lens: history, branches, working tree, stash, remotes.
// Reads each run a single batched git command; writes shell out. The UI gates
// the destructive ones (branch -D, discard, clean, force-push) behind a confirm.

/** One commit in the history view (step 3.11). */
export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** Author date, epoch seconds. */
  date: number;
  /** Parent SHAs (≥2 ⇒ a merge). */
  parents: string[];
  /** Ref decorations (branch tips, tags), e.g. `main`, `tag: v1`. */
  refs: string[];
}

/** Recent history for the project's repo (HEAD's log, newest first). */
export function gitLog(repoRoot: string, limit?: number): Promise<Commit[]> {
  return invoke("git_log", { repoRoot, limit: limit ?? null });
}

/** One local branch with its upstream tracking (step 3.11). */
export interface Branch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isHead: boolean;
  /** Branch tip short SHA. */
  short: string;
}

/** The project's branches: locals (with ahead/behind), current, and remotes. */
export interface Branches {
  current: string | null;
  detached: boolean;
  local: Branch[];
  remote: string[];
}

export function gitBranches(repoRoot: string): Promise<Branches> {
  return invoke("git_branches", { repoRoot });
}

/** One working-tree status entry — the porcelain `XY` pair (step 3.11). */
export interface StatusEntry {
  path: string;
  /** Staged (index) status char: `M`/`A`/`D`/`R`/`C`/`?`/` `. */
  index: string;
  /** Unstaged (worktree) status char. */
  worktree: string;
  untracked: boolean;
}

export function gitStatusEntries(repoRoot: string): Promise<StatusEntry[]> {
  return invoke("git_status_entries", { repoRoot });
}

/** One stash entry: its ref (`stash@{0}`) and description (step 3.11). */
export interface Stash {
  reference: string;
  message: string;
}

export function gitStashList(repoRoot: string): Promise<Stash[]> {
  return invoke("git_stash_list", { repoRoot });
}

/** The files a commit changed (reuses the DiffFile shape; `absPath` is null —
 *  historical content isn't inline-editable). */
export function gitCommitFiles(repoRoot: string, sha: string): Promise<DiffFile[]> {
  return invoke("git_commit_files", { repoRoot, sha });
}

/** One file's unified diff within a commit (step 3.11). */
export function gitCommitFileDiff(repoRoot: string, sha: string, path: string): Promise<FileDiff> {
  return invoke("git_commit_file_diff", { repoRoot, sha, path });
}

// --- write paths ------------------------------------------------------------

/** Check out a branch/tag/commit. Rejects with git's message on a dirty tree. */
export function gitCheckout(repoRoot: string, reference: string): Promise<string> {
  return invoke("git_checkout", { repoRoot, reference });
}

/** Create a branch, optionally from `startPoint` and optionally checking it out. */
export function gitCreateBranch(
  repoRoot: string,
  name: string,
  startPoint: string | null,
  checkout: boolean,
): Promise<string> {
  return invoke("git_create_branch", { repoRoot, name, startPoint, checkout });
}

/** Rename a branch. */
export function gitRenameBranch(repoRoot: string, oldName: string, newName: string): Promise<string> {
  return invoke("git_rename_branch", { repoRoot, old: oldName, new: newName });
}

/** Delete a branch. `force` (`-D`) drops unmerged work — gate behind a confirm. */
export function gitDeleteBranch(repoRoot: string, name: string, force: boolean): Promise<string> {
  return invoke("git_delete_branch", { repoRoot, name, force });
}

/** Stage paths (`git add`). */
export function gitStage(repoRoot: string, paths: string[]): Promise<string> {
  return invoke("git_stage", { repoRoot, paths });
}

/** Unstage paths (`git restore --staged`). */
export function gitUnstage(repoRoot: string, paths: string[]): Promise<string> {
  return invoke("git_unstage", { repoRoot, paths });
}

/** Discard tracked changes to paths (revert to HEAD). Destructive. */
export function gitDiscard(repoRoot: string, paths: string[]): Promise<string> {
  return invoke("git_discard", { repoRoot, paths });
}

/** Remove untracked files/dirs at paths (`git clean -fd`). Destructive. */
export function gitClean(repoRoot: string, paths: string[]): Promise<string> {
  return invoke("git_clean", { repoRoot, paths });
}

/** Stash the working tree, optionally including untracked files + a message. */
export function gitStashPush(
  repoRoot: string,
  message: string | null,
  includeUntracked: boolean,
): Promise<string> {
  return invoke("git_stash_push", { repoRoot, message, includeUntracked });
}

/** Pop a stash back onto the working tree. */
export function gitStashPop(repoRoot: string, reference: string): Promise<string> {
  return invoke("git_stash_pop", { repoRoot, reference });
}

/** Drop a stash without applying it. Destructive. */
export function gitStashDrop(repoRoot: string, reference: string): Promise<string> {
  return invoke("git_stash_drop", { repoRoot, reference });
}

/** Fetch from a remote (default `origin`), pruning deleted remote branches. */
export function gitFetch(repoRoot: string, remote?: string): Promise<string> {
  return invoke("git_fetch", { repoRoot, remote: remote ?? null });
}

/** Pull the current branch. Rejects with git's message on conflict. */
export function gitPull(repoRoot: string): Promise<string> {
  return invoke("git_pull", { repoRoot });
}

/** Push the current branch. Never auto-pushes; `force` uses `--force-with-lease`. */
export function gitPush(repoRoot: string, force: boolean): Promise<string> {
  return invoke("git_push", { repoRoot, force });
}
