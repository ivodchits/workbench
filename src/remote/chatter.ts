// Chatter (office plan O4.1): what the office page asks of `/office/api/chatter` and
// what comes back. The page names who meets where; Workbench's Rust core checks the
// budget and hands the request to the webview (`state/officeChatter.ts`), which adds
// the projects' news and has Haiku write the scene.

/** A scene's feel, for the page to play it by (O4.2). */
export const MOODS = ["chatty", "funny", "gossipy", "excited", "tired", "tense"] as const;
export type Mood = (typeof MOODS)[number];

export interface ChatterSpeaker {
  /** A roster id (`office/roster.ts`): the webview knows each one's name and persona. */
  id: string;
  /** What they're up to, in words: "free", "on a break from Demiurge · fix the login". */
  doing: string;
}

export interface ChatterRequest {
  /** The page's local date, `YYYY-MM-DD`: the day the token budget counts. */
  day: string;
  /** Local time in words: "Wednesday 14:05". */
  time: string;
  /** Where they meet: "the water cooler". */
  place: string;
  /** Two or three. */
  speakers: ChatterSpeaker[];
  /** Project ids worth talking about (their sessions' and rooms'), at most four. */
  projects: string[];
  /** About how many lines. */
  lines: number;
}

export interface SceneLine {
  /** A speaker's roster id. */
  speaker: string;
  text: string;
}

export interface Scene {
  lines: SceneLine[];
  mood: Mood | null;
}

export interface ChatterSettings {
  on: boolean;
  model: "haiku" | "sonnet";
  /** Calls in any hour. */
  perHour: number;
  /** Tokens (in and out) a day. */
  tokensPerDay: number;
}

export interface ChatterUsage {
  callsThisHour: number;
  perHour: number;
  tokensToday: number;
  tokensPerDay: number;
}

/** `ok` has a scene; `off`, `hour` (calls spent), `day` (tokens spent) and `busy`
 *  (another call out) made no call; `error` may have spent one. */
export type ChatterAnswer =
  | { status: "ok"; scene: Scene; usage: ChatterUsage }
  | { status: "off" | "hour" | "day" | "busy"; usage: ChatterUsage }
  | { status: "error"; message: string; usage?: ChatterUsage };

/** What the webview hands back (`office_chatter_reply`). */
export interface ChatterReply {
  scene: Scene | null;
  error?: string;
  /** Tokens the call used, in and out. */
  tokens: number;
}
