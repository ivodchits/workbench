// The morning standup (office plan O5.5): what the office page asks of
// `/office/api/standup` and what comes back. The page asks on the day it is; the
// webview (`state/officeStandup.ts`) finds the last day before it that had sessions
// (yesterday, or the latest of the week before), reads those sessions' transcripts
// project by project, and has Haiku say what each project's team got done. Workbench's
// Rust core keeps the answer for the day, so asking again costs nothing.

export interface StandupRequest {
  /** The page's local date, `YYYY-MM-DD`: the day of the standup. */
  today: string;
  /** Read and summarise again, even with an answer kept for today. */
  fresh?: boolean;
}

/** One project's report: what was done, in short spoken lines, "we" for its team. */
export interface StandupReport {
  projectId: string;
  /** The project's name. */
  project: string;
  /** Sessions on the day. */
  sessions: number;
  /** Two or three lines on what got done. */
  done: string[];
  /** What's left or next, one line; null when nothing is. */
  next: string | null;
}

export interface StandupResult {
  /** The day reported on, `YYYY-MM-DD`; null when there was none in the week. */
  day: string | null;
  /** That day in words, as Duck says it: "yesterday", "on Friday". */
  when: string;
  /** The busiest projects first. */
  reports: StandupReport[];
}

/** `ok` has the result; `busy`: one is being put together already. */
export type StandupAnswer = { status: "ok"; result: StandupResult } | { status: "busy" } | { status: "error"; message: string };

/** What the webview hands back (`office_standup_reply`). */
export interface StandupReply {
  result: StandupResult | null;
  error?: string;
}
