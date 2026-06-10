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
