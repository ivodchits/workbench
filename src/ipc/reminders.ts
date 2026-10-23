// Typed access to Duck's reminders (step H8, `src-tauri/src/assistant/reminders.rs`):
// `reminders.json` in Duck's repo, a commit per change, and the delivery
// bookkeeping in `duck.db`; timers, and the push to the phone (step H4).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Repeat = "daily" | "weekdays" | "weekly" | "monthly";

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
  /** Comes back at the next time once it's done (step H4); needs a due. */
  repeat?: Repeat;
  /** Put off until this local time, `2026-10-24T10:10` (step H4). */
  snoozedUntil?: string;
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

/** The running timers (step H4), `[id, json]`, in `duck.db`. */
export const timersList = (): Promise<[string, string][]> => invoke("assistant_timers");

export const timerSet = (id: string, value: string | null): Promise<void> => invoke("assistant_timer_set", { id, value });

/** Push a reminder or a timer to the phones; with `actions`, Done and Snooze
 *  buttons, which come back as `onReminderAction`. */
export const reminderPush = (id: string, threadId: string, title: string, body: string, actions: boolean): Promise<void> =>
  invoke("assistant_reminder_push", { id, threadId, title, body, actions });

/** A push's Done or Snooze, tapped on the phone. */
export function onReminderAction(cb: (a: { id: string; action: "done" | "snooze" }) => void): () => void {
  const off = listen<{ id: string; action: "done" | "snooze" }>("duck-reminder-action", (e) => cb(e.payload));
  return () => void off.then((f) => f());
}
