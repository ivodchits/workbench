// The daily log's backend (improvement plan J1, J2): its files in Duck's repo
// (`src-tauri/src/daylog`), a project's git activity, and reading a session on
// from an offset.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  /** The state's backfill (null: not offered yet). */
  backfill: string | null;
  /** The log has run at least once. */
  started: boolean;
}

export const daylogGit = (dir: string, since: number): Promise<GitActivity> => invoke("daylog_git", { dir, since: Math.floor(since) });

export const daylogLoad = (workspace: string | null, days: string[]): Promise<Loaded> =>
  invoke("daylog_load", { workspace, days });

export const daylogSave = (workspace: string | null, save: SaveRequest, message: string): Promise<Saved> =>
  invoke("daylog_save", { workspace, save, message });

/** This machine's own workspace's notes since `sinceDay`, and those an old main's
 *  branches kept (F6.2). */
export const daylogOwnNotes = (sinceDay: string): Promise<unknown[]> => invoke("daylog_own_notes", { sinceDay });

/** The days with entries in the copy this machine reads: Duck's own on the main,
 *  else the mirror of the main's. */
export const daylogDays = (): Promise<LogCopy> => invoke("daylog_days");

/** One day's entries in that copy (null: none). */
export const daylogDay = (day: string): Promise<unknown | null> => invoke("daylog_day", { day });

/** Open the daily log's window, or focus it. */
export const openDayLogWindow = (): Promise<void> => invoke("window_open_daylog");

/** A save on this machine (the main) changed the log. */
export const onDaylogChanged = (cb: () => void): Promise<UnlistenFn> => listen("daylog-changed", () => cb());

// ── quitting (J3) ──

/** The backend asks before a quit; answer with `daylogQuitAck`, then `daylogQuitFinished`. */
export const onDaylogQuit = (cb: () => void): Promise<UnlistenFn> => listen("daylog-quit", () => cb());
export const daylogQuitAck = (): Promise<void> => invoke("daylog_quit_ack");
export const daylogQuitFinished = (): Promise<void> => invoke("daylog_quit_finished");
export const daylogQuitCancel = (): Promise<void> => invoke("daylog_quit_cancel");
/** Bring the main window up: the quit's run shows there. */
export const daylogQuitShow = (): Promise<void> => invoke("daylog_quit_show");
/** Wait for the log's commits (at most 20 s); false when they didn't all finish. */
export const daylogFlush = (workspace: string | null): Promise<boolean> => invoke("daylog_flush", { workspace });
/** When `machine` was last read, by this machine's copy (epoch ms). */
export const daylogReadAt = (machine: string): Promise<number | null> => invoke("daylog_read_at", { machine });
/** Sync the mirror of the main's repo now; its head (null: the main is here). */
export const daylogSyncMirror = (): Promise<string | null> => invoke("daylog_sync_mirror");

/** A session's transcript read forward from `fromOffset`, by its id. */
export const readSessionForward = (sessionId: string, fromOffset: number, maxBytes?: number): Promise<TranscriptPage> =>
  invoke("transcript_read_session", { sessionId, fromOffset, maxBytes });
