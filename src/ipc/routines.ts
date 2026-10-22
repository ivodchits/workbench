// Duck's routines and its data repo's backup (step L4). See
// `src-tauri/src/assistant/routines.rs` and `src-tauri/src/assistant/gitlane.rs`.

import { invoke } from "@tauri-apps/api/core";

export const routinePut = (id: string, data: string): Promise<void> => invoke("assistant_routine_put", { id, data });
export const routineList = (): Promise<string[]> => invoke("assistant_routine_list");
export const routineDelete = (id: string): Promise<void> => invoke("assistant_routine_delete", { id });

export interface BackupStatus {
  /** The workspace is a git repo yet. */
  repo: boolean;
  remote: string | null;
  branch: string | null;
  /** Commits the remote doesn't have; null when it was never pushed. */
  ahead: number | null;
}

export type PushOutcomeKind =
  | "pushed"
  | "nothing"
  | "no_remote"
  | "no_repo"
  | "offline"
  | "auth"
  | "rejected"
  | "lock"
  | "detached"
  | "failed";

export interface PushOutcome {
  outcome: PushOutcomeKind;
  detail: string;
}

export interface BranchReview {
  files: string[];
  /** Memory entries the branch drops whose text it doesn't keep anywhere. */
  removed: string[];
  added: number;
}

export const backupStatus = (workspace: string | null): Promise<BackupStatus> =>
  invoke("assistant_backup_status", { workspace });
/** Push behind the repo's other git jobs. Never forced. */
export const backupPush = (workspace: string | null): Promise<PushOutcome> =>
  invoke("assistant_backup_push", { workspace });
/** Create a private GitHub repo as the backup remote; its URL. Ask first. */
export const backupCreate = (workspace: string | null, name: string): Promise<string> =>
  invoke("assistant_backup_create", { workspace, name });
export const branchReview = (workspace: string | null, branch: string): Promise<BranchReview> =>
  invoke("assistant_branch_review", { workspace, branch });

export interface HousekeepReport {
  indexed: string[];
  removed: number;
  bytes: number;
  committed: string[];
}

/** Housekeeping's mechanical part: task folders dated before `cutoff`
 *  (YYYY-MM-DD) folded into `tasks/INDEX.md`, leftovers committed, `git gc --auto`. */
export const housekeep = (workspace: string | null, cutoff: string): Promise<HousekeepReport> =>
  invoke("assistant_housekeep", { workspace, cutoff });
