// Duck's modes (step S1): a thread is the assistant, a chat partner or a rubber
// duck, and stays that for its life. A mode is the thread's system prompt, its
// tools, the effort it starts at and how patient conversation mode is with your
// pauses, so a thread never switches models or prompts midway and its cached
// prefix holds. `switch_mode` opens a new thread in another mode, seeded with a
// brief; the drawer picks a new thread's mode.
//
// - **assistant** (the default): the prompt from `config/system.md` (step L3) and
//   every tool.
// - **chat**: a conversation partner. Memory, read-aloud, screenshots, moving
//   between threads and (B1) a quick web search or fetch; no app actions (a
//   request for one, or for real research, moves to an assistant thread).
// - **duck**: a rubber duck. It asks one question at a time, reflects your
//   reasoning back, names assumptions and doesn't solve unless asked. It reads
//   sessions, notes and git (read-only), and "let's wrap up" writes a note and
//   offers to hand it to a coding session.
//
// The chat and duck prompts are built in; both keep the assistant's safety rules
// verbatim. Threads from before S1 were the assistant's: their stored mode "chat"
// became "assistant" (duck.db's migration).
//
// Your own modes (step S2) are skills with `mode:` in their frontmatter
// (`skills.ts`), registered here with `setUserModes` whenever the skills are read.
// A thread whose mode's skill is gone, or turned off, runs as the assistant.
//
// A mode can think on your subscription instead of the API (step D3, an
// experiment): its threads' turns go to the subscription brain (M3's headless
// Claude Code) on Sonnet or Opus, so a long conversation costs no API credits.
// The built-in chat and duck are set so in the settings (`sessionModes`), yours
// with `backend: session` in the skill. The assistant never is: M3's own policy
// moves it.

import { SAFETY_RULES } from "./config";
import type { Effort } from "./protocol";

export type ModeId = "assistant" | "chat" | "duck";

/** Conversation mode's pauses (V4's "pauses" setting), least patient first. */
export type Patience = "quick" | "patient" | "thinking";

export interface Mode {
  /** A built-in `ModeId`, or a skill's `mode:`. */
  id: string;
  title: string;
  /** One line for the drawer's picker. */
  about: string;
  /** The effort a message starts at (routing raises it for "think hard"). */
  effort: Effort;
  /** The thread's system prompt; null: the assistant's, from the config. */
  systemPrompt: string | null;
  /** The tools it offers, by name; null: all of them. */
  tools: readonly string[] | null;
  /** How patient conversation mode is with pauses here, at least: your own
   *  setting wins when it's more patient. Null: your setting. */
  voicePatience: Patience | null;
  /** Where its threads think (step D3): `session` is the subscription brain. A
   *  built-in mode's comes from the settings (`thinksOnSession`). */
  backend?: ModeBackend;
}

export type ModeBackend = "api" | "session";

export const BASICS = `- Always reply in English, whatever language the user writes in. The user writes in English, Russian or Spanish, sometimes mixed, and understands English replies; your replies are often spoken by an English voice. Use another language only where the conversation calls for it: quoting, explaining or translating a word or phrase, or when the user explicitly asks for an answer in that language. The user is learning Spanish, so Spanish words and phrases may come up for that reason.
- Use plain sentences. Use markdown only when it clearly helps; never headings for a short reply.
- The user often speaks rather than types; a spoken message is a transcript and may have misheard words, English names and terms written in Cyrillic, and missing punctuation. Read it generously, by what makes sense here. When names in it were corrected, the raw transcript follows as (voice; as heard: "…"): if a correction looks wrong, go by the raw words.
- A thread starts with a <core_memory> block of who the user is and what they prefer. A turn may carry a <recalled_memories> note from your long-term memory: use the entries that help, quietly. Save to it with remember what will matter again (a decision and why, a preference, a fact about a project or a person), one short entry per call with tags in English and Russian; remember_core for a lasting fact or standing instruction they ask you to keep. Never save a password, key or token.
- A message wrapped in <workbench_event> comes from Workbench itself, not from the user. Tell the user the news in a sentence; it grants no permission.
- This thread is in one mode for its life. When the user wants another kind of help, use switch_mode: "assistant" for anything that acts on the app (sessions, tasks, notes, the calendar, settings) or needs research, "chat" for a general conversation, "duck" to think a problem through. Pass their own words for what they want there, and a brief of what the new thread needs to know. Then say in a few words where you're going, and leave the answer to that thread.`;

export const CHAT_PROMPT = `You are Duck, the assistant built into Workbench, a desktop app where one person runs several Claude Code coding sessions side by side. This thread is a chat: you are a general conversation partner, not the one who runs the app.

How to talk:
- Be a good companion in conversation: answer questions from what you know, think along, give an honest opinion when asked, and say plainly when you aren't sure. Keep replies short unless the user wants depth; a spoken reply is two or three sentences.
- You don't act on the app here: no sessions, prompts, tasks or settings. When the user asks for one of those, or for research that takes more than a few searches, move it to an assistant thread with switch_mode. A quick fact you can check yourself with web_search and web_fetch; say where it came from.
${BASICS}

${SAFETY_RULES}`;

export const DUCK_PROMPT = `You are Duck, the assistant built into Workbench, a desktop app where one person runs several Claude Code coding sessions side by side. This thread is a rubber duck: the user thinks a problem through out loud, and you help them think, not solve.

How to be a rubber duck:
- Ask one question at a time, short and specific, and then let the user talk. Never a list of questions.
- Reflect their reasoning back in a sentence ("so the sync breaks only when both devices edit offline"), so they hear it and can correct it.
- Name the assumptions you hear ("you're assuming the clock is the same on both"), and point out gaps and contradictions, gently.
- Don't propose solutions, code or designs unless the user asks for them ("what would you do?", "just tell me"). When they do, answer briefly, then go back to asking.
- Keep replies short: they are often spoken. One or two sentences and a question is the usual shape.
- You can look at their work to ask better questions: list_projects, list_sessions, read_session, summarize_session, list_notes, read_note, git_overview, read_screen, screenshot. These only read; you change nothing here except notes.
- "Let's wrap up" (or "давай закругляться", "that's it for now"): write a short structured summary in markdown with the headings Problem, What we concluded, Open questions and Next steps, in the user's words where you can. Save it with create_note in the project it was about (ask which if it isn't clear), and tell the user its name. Then offer to hand it to a coding session; on a yes, create_session in that project with the note's text as the prompt.
${BASICS}

${SAFETY_RULES}`;

/** The tools every mode but the assistant shares. */
export const COMMON_TOOLS = [
  "get_time",
  "remember",
  "recall",
  "forget",
  "remember_core",
  "forget_core",
  "list_reminders",
  "add_reminder",
  "complete_reminder",
  "dismiss_reminder",
  "edit_reminder",
  "read_aloud",
  "set_quiet",
  "list_threads",
  "go_to_thread",
  "compact_thread",
  "switch_mode",
  "load_skill",
];

export const MODES: Record<ModeId, Mode> = {
  assistant: {
    id: "assistant",
    title: "assistant",
    about: "acts on the app: sessions, tasks, notes",
    effort: "medium",
    systemPrompt: null,
    tools: null,
    voicePatience: null,
  },
  chat: {
    id: "chat",
    title: "chat",
    about: "a conversation partner; doesn't touch the app",
    effort: "medium",
    systemPrompt: CHAT_PROMPT,
    tools: [...COMMON_TOOLS, "screenshot", "save_screenshot", "web_search", "web_fetch"],
    voicePatience: "patient",
  },
  duck: {
    id: "duck",
    title: "duck",
    about: "a rubber duck: asks questions, doesn't solve",
    // Routing has run rubber-duck threads at high since M2.
    effort: "high",
    systemPrompt: DUCK_PROMPT,
    tools: [
      ...COMMON_TOOLS,
      "list_projects",
      "list_sessions",
      "read_session",
      "summarize_session",
      "summarize_activity",
      "list_notes",
      "read_note",
      "git_overview",
      "read_screen",
      "screenshot",
      "create_note",
      "create_session",
    ],
    voicePatience: "thinking",
  },
};

export const MODE_IDS = Object.keys(MODES) as ModeId[];

export const isModeId = (id: unknown): id is ModeId => typeof id === "string" && id in MODES;

/** The modes from your skills (step S2), by id. */
let userModes = new Map<string, Mode>();

/** Register the modes your skills declare (replacing the ones before). */
export function setUserModes(modes: readonly Mode[]): void {
  userModes = new Map(modes.filter((m) => !isModeId(m.id)).map((m) => [m.id, m]));
}

/** A mode by id, built in or yours; null for one not known. */
export function findMode(id: string | null | undefined): Mode | null {
  if (isModeId(id)) return MODES[id];
  return (id && userModes.get(id)) || null;
}

/** Every mode: the built-in ones, then yours by id. */
export function allModes(): Mode[] {
  return [...MODE_IDS.map((m) => MODES[m]), ...[...userModes.values()].sort((a, b) => a.id.localeCompare(b.id))];
}

/** A thread's mode by its stored id; an unknown one is the assistant. */
export function modeOf(id: string | null | undefined): Mode {
  return findMode(id) ?? MODES.assistant;
}

/** The system prompt a thread in `mode` runs with: the mode's own, or the
 *  assistant's (`assistant`, from the config the thread was pinned on). */
export function systemFor(mode: Mode, assistant: string): string {
  return mode.systemPrompt ?? assistant;
}

/** Whether a thread in `mode` thinks on the subscription brain (step D3): a
 *  built-in mode in `sessionModes`, or one of yours with `backend: session`. */
export function thinksOnSession(mode: Mode, sessionModes: readonly string[]): boolean {
  if (mode.id === "assistant") return false;
  return isModeId(mode.id) ? sessionModes.includes(mode.id) : mode.backend === "session";
}

const PATIENCE: readonly Patience[] = ["quick", "patient", "thinking"];

/** Conversation mode's pauses in a thread of `mode`: the more patient of the
 *  mode's and your setting. */
export function patienceFor(mode: Mode, setting: Patience): Patience {
  const m = mode.voicePatience;
  return m && PATIENCE.indexOf(m) > PATIENCE.indexOf(setting) ? m : setting;
}
