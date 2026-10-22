// Duck's long-term memory (step L1): the topic files in the workspace's `memory/`,
// their index in `duck.db` (which also covers the project notes, read-only), and
// the commit each change makes. See `src-tauri/src/assistant/memory.rs`.

import { invoke } from "@tauri-apps/api/core";

/** One remembered entry, as its file has it. */
export interface MemoryEntry {
  /** `decisions`, `projects/quill`, `journal/2026-10`. */
  topic: string;
  /** Relative to the workspace: `memory/decisions.md`. */
  file: string;
  line: number;
  date: string | null;
  /** The fact (and its reason). */
  text: string;
  src: string | null;
  conf: string | null;
  tags: string | null;
  /** The bullet's whole text: what a forget names. */
  raw: string;
}

/** What `remember` writes. */
export interface NewMemoryEntry {
  /** `YYYY-MM-DD`, local. */
  date: string;
  fact: string;
  why?: string;
  /** `thread:<id>` or `task:<id>`. */
  src?: string;
  conf?: "high" | "med" | "low";
  /** Words to find it by, in both languages. */
  tags?: string;
}

/** A search hit: a memory entry or a piece of a project note. */
export interface MemoryHit {
  kind: "memory" | "note";
  /** The topic, or `note: <project> / <name>`. */
  label: string;
  text: string;
  file: string;
  /** Absolute, to open it. */
  path: string;
  line: number;
  /** How many of the query's words it holds, of `terms`. */
  matched: number;
  terms: number;
  entry: MemoryEntry | null;
}

/** A change to one memory file. */
export interface MemoryFileEdit {
  file: string;
  path: string;
  /** null: the edit made the file. */
  before: string | null;
  after: string | null;
}

export const memorySearch = (workspace: string | null, query: string, k: number): Promise<MemoryHit[]> =>
  invoke("assistant_memory_search", { workspace, query, k });

/** Remember an entry; a secret is refused (the error says so). `edit` is null when
 *  it was already there. */
export const memoryWrite = (
  workspace: string | null,
  topic: string,
  entry: NewMemoryEntry,
): Promise<{ edit: MemoryFileEdit | null; entry: MemoryEntry }> =>
  invoke("assistant_memory_write", { workspace, topic, entry });

/** The entries holding every word of `query`. */
export const memoryMatching = (workspace: string | null, query: string): Promise<MemoryEntry[]> =>
  invoke("assistant_memory_matching", { workspace, query });

export const memoryForget = (
  workspace: string | null,
  entries: { file: string; raw: string }[],
  message: string,
): Promise<MemoryFileEdit[]> => invoke("assistant_memory_forget", { workspace, entries, message });

/** Put a file back (an undo), only over `expected`; `text: null` removes it. */
export const memoryRestore = (
  workspace: string | null,
  file: string,
  text: string | null,
  expected: string | null,
  message: string,
): Promise<void> => invoke("assistant_memory_restore", { workspace, file, text, expected, message });

export const memoryList = (workspace: string | null): Promise<MemoryEntry[]> =>
  invoke("assistant_memory_list", { workspace });

// ── consolidation and the recall log (step L2) ──

/** What one consolidation run changes. */
export interface MemoryPlan {
  /** Removed first: the merged and the retired entries. */
  remove: { file: string; raw: string }[];
  add: { topic: string; entry: NewMemoryEntry }[];
  journal: { date: string; text: string } | null;
}

export interface MemoryApplied {
  edits: MemoryFileEdit[];
  /** What wasn't written, and why. */
  skipped: string[];
}

/** Make a consolidation's changes, as one commit. */
export const memoryApply = (workspace: string | null, plan: MemoryPlan, message: string): Promise<MemoryApplied> =>
  invoke("assistant_memory_apply", { workspace, plan, message });

export type MemoryStateKey = "consolidation" | "questions" | "skill_offers" | "improve_offers";

export const memoryStateGet = (key: MemoryStateKey): Promise<string | null> =>
  invoke("assistant_memory_state_get", { key });
export const memoryStateSet = (key: MemoryStateKey, value: string | null): Promise<void> =>
  invoke("assistant_memory_state_set", { key, value });

/** One automatic recall. */
export interface RecallRow {
  at: number;
  threadId: string;
  query: string;
  candidates: number;
  shown: number;
  used: number;
  selfRecall: boolean;
  hits: { label: string; file: string; line: number; matched: number; terms: number; used: boolean }[];
}

export interface RecallStats {
  searched: number;
  withHits: number;
  shown: number;
  used: number;
  selfRecall: number;
  /** Duck searched itself after nothing had been shown. */
  missed: number;
}

export const recallLog = (row: RecallRow): Promise<void> => invoke("assistant_recall_log", { row });
export const recallStats = (since: number): Promise<RecallStats> => invoke("assistant_recall_stats", { since });
