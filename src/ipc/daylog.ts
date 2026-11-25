// The daily log's backend (improvement plan J1, J2): its files in Duck's repo
// (`src-tauri/src/daylog`), a project's git activity, and reading a session on
// from an offset.

import { invoke } from "@tauri-apps/api/core";
import type { TranscriptPage } from "./transcript";

export interface GitCommit {
  hash: string;
  /** Epoch seconds. */
  at: number;
  subject: string;
  body: string;
  /** A `Revert "…"` commit. */
  revert: boolean;
}

export interface GitReset {
  at: number;
  /** The reflog's words. */
  what: string;
}

export interface GitActivity {
  commits: GitCommit[];
  resets: GitReset[];
}

export interface DayFiles {
  notes: unknown[];
  entries: unknown | null;
}

export interface Loaded {
  state: unknown | null;
  days: Record<string, DayFiles>;
}

export interface SaveRequest {
  notes?: Record<string, unknown[]>;
  days?: Record<string, unknown>;
  state?: unknown;
}

export interface Saved {
  added: number;
  files: string[];
}

export interface DayCount {
  day: string;
  entries: number;
}

export interface LogCopy {
  /** The main's, mirrored here; else this machine's own. */
  mirrored: boolean;
  /** The copy's last log commit, epoch seconds. */
  syncedAt: number | null;
  days: DayCount[];
}

export const daylogGit = (dir: string, since: number): Promise<GitActivity> => invoke("daylog_git", { dir, since: Math.floor(since) });

export const daylogLoad = (workspace: string | null, days: string[]): Promise<Loaded> =>
  invoke("daylog_load", { workspace, days });

export const daylogSave = (workspace: string | null, save: SaveRequest, message: string): Promise<Saved> =>
  invoke("daylog_save", { workspace, save, message });

/** This machine's own workspace's notes since `sinceDay`, and those an old main's
 *  branches kept (F6.2). */
export const daylogOwnNotes = (sinceDay: string): Promise<unknown[]> => invoke("daylog_own_notes", { sinceDay });

export const daylogDays = (workspace: string | null): Promise<LogCopy> => invoke("daylog_days", { workspace });

export const daylogDay = (workspace: string | null, day: string): Promise<unknown | null> =>
  invoke("daylog_day", { workspace, day });

/** A session's transcript read forward from `fromOffset`, by its id. */
export const readSessionForward = (sessionId: string, fromOffset: number, maxBytes?: number): Promise<TranscriptPage> =>
  invoke("transcript_read_session", { sessionId, fromOffset, maxBytes });
