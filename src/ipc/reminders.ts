// Typed access to Duck's reminders (step H8, `src-tauri/src/assistant/reminders.rs`):
// `reminders.json` in Duck's repo, a commit per change, and the delivery
// bookkeeping in `duck.db`.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ReminderRecord {
  id: string;
  /** The short header the widget shows. */
  title: string;
  details?: string;
  project?: { id: string; name: string };
  /** Local time, `2026-10-24T10:00`, or a day, `2026-10-24`. */
  due?: string;
  state: "open" | "done" | "dismissed";
  /** Local time, `2026-10-23T14:05`. */
  created: string;
  closed?: string;
  /** The thread it was asked for in. */
  createdIn?: string;
  /** Fields a later version added, kept as they are. */
  [more: string]: unknown;
}

export interface RemindersFile {
  path: string;
  reminders: ReminderRecord[];
  /** What's wrong with the file; null when it's fine or absent. */
  problem: string | null;
}

export const remindersRead = (workspace: string | null): Promise<RemindersFile> =>
  invoke("assistant_reminders_read", { workspace });

/** Make reminder `id` be `after` (null removes it), provided it's `before` now
 *  (null: not there); refused with `stale:` otherwise. Commits with `message`. */
export const remindersPut = (
  workspace: string | null,
  id: string,
  before: ReminderRecord | null,
  after: ReminderRecord | null,
  message: string,
): Promise<RemindersFile> => invoke("assistant_reminders_put", { workspace, id, before, after, message });

/** Watch the workspace's file: `onRemindersChanged` hears a change. */
export const remindersWatch = (workspace: string | null): Promise<void> =>
  invoke("assistant_reminders_watch", { workspace });

export function onRemindersChanged(cb: () => void): () => void {
  const off = listen("duck-reminders-changed", () => cb());
  return () => void off.then((f) => f());
}

/** The delivery bookkeeping, `[id, json]`. */
export const remindersSeen = (): Promise<[string, string][]> => invoke("assistant_reminders_seen");

export const reminderSeenSet = (id: string, value: string | null): Promise<void> =>
  invoke("assistant_reminder_seen_set", { id, value });
