// Fernando's Spanish lessons: what the office page asks of `/office/api/spanish` and
// what comes back. Workbench's Rust core hands the request to the webview
// (`state/officeSpanish.ts`), which finds the Spanish lessons' project (a registered
// project whose folder is `spanish-lessons`) and, when asked, the word of the day:
// one word a day at the learner's level (read from the project's `state/profile.json`),
// picked by Haiku and kept by the Rust core for the rest of the day.

/** The project's folder name: the project whose root is this folder is Fernando's. */
export const SPANISH_FOLDER = "spanish-lessons";

/** What starts a new lesson: the project's own lesson prompt (`prompts/lesson.md`),
 *  which reads the day's directive and the plans itself. */
export const LESSON_PROMPT = "Run `prompts/lesson.md`.";

export interface SpanishRequest {
  /** The page's date, `YYYY-MM-DD`: the word of the day is this day's. */
  today: string;
  /** Wants the word of the day too, not just the project. */
  word: boolean;
}

/** A word of the day. */
export interface WordOfDay {
  /** The word, a noun with its article ("la alcancía"), or a short set phrase. */
  word: string;
  /** What kind of word: "noun (f)", "verb", "adjective", "phrase"… */
  kind: string;
  /** What it means, in English. */
  meaning: string;
  /** A short sentence using it, at the learner's level, and in English. */
  example: string;
  exampleEn: string;
  /** A tip: how it's used in Mexico City, a memory hook, a bridge from Russian. */
  note: string | null;
}

export interface SpanishInfo {
  /** Fernando's project, null when none is registered. */
  projectId: string | null;
  projectName: string | null;
  /** The learner's level (`profile.level.current`), when it could be read. */
  level: string | null;
  /** Today's word, when asked for and there is one. */
  word: WordOfDay | null;
  /** Why there's no word, when one was asked for. */
  wordError: string | null;
}

export type SpanishAnswer = { status: "ok"; result: SpanishInfo } | { status: "error"; message: string };

/** What the Rust core sends the webview (`office-spanish`): the request, the word it
 *  kept for today if any, and the latest days' words, not to be picked again. */
export interface SpanishAsk {
  today: string;
  word: boolean;
  kept: WordOfDay | null;
  recent: string[];
}

/** What the webview hands back (`office_spanish_reply`). */
export interface SpanishReply {
  result: SpanishInfo | null;
  error?: string;
}
