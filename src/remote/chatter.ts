// Chatter (office plan O4.1): what the office page asks of `/office/api/chatter` and
// what comes back. The page names who meets where; Workbench's Rust core checks the
// budget and hands the request to the webview (`state/officeChatter.ts`), which adds
// the projects' news and has Haiku write the scene.

/** A scene's feel, for the page to play it by (O4.2). */
export const MOODS = ["chatty", "funny", "gossipy", "excited", "tired", "tense"] as const;
export type Mood = (typeof MOODS)[number];

/** Where chats happen (O4.2), and how a scene is told where it is. */
export const CHAT_PLACES = {
  cooler: "the water cooler in the kitchen",
  sofa: "the sofa in front of the lounge TV, playing a game on the console together",
} as const;
export type ChatSpot = keyof typeof CHAT_PLACES;

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
  /** Which chat spot that is, for the topics to suit it; the cooler when unset. */
  spot?: ChatSpot;
  /** Two or three. */
  speakers: ChatterSpeaker[];
  /** Project ids worth talking about (their sessions' and rooms'), at most four. */
  projects: string[];
  /** About how many lines. */
  lines: number;
  /** What this chat has said so far ("Mira: Tea?"), newest last: the scene carries on
   *  from it. Empty for a chat just begun. */
  said?: string[];
}

export interface SceneLine {
  /** A speaker's roster id. */
  speaker: string;
  text: string;
}

export interface Scene {
  lines: SceneLine[];
  mood: Mood | null;
  /** What it was about, in a few words; null when the model didn't say. */
  topic?: string | null;
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
