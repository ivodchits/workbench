// Explicit permission (step T1): "tell it to continue, and approve it if it asks"
// lets Duck answer that permission prompt without a card. The model quotes the
// words (`grantedBy`), and the call counts as granted only if those words are in a
// message the user typed or said in this thread, recently. A quote from a tool
// result, a transcript or a Workbench event never counts: those aren't the user's.

import type { StoredMessage } from "../../ipc/assistant";

/** Where the user's own messages come from (not `event`, not `duck`). */
const USER_SOURCES = new Set(["desktop", "phone", "voice"]);
/** A grant this old no longer covers anything. */
export const GRANT_TTL_MS = 12 * 60 * 60_000;
/** Shorter than this, a quote could be found anywhere ("ok"). */
const MIN_QUOTE = 6;

export interface Grant {
  /** The message that grants it. */
  seq: number;
  ts: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Strip the quote marks and end punctuation a model tends to add. */
const unquote = (s: string) => norm(s).replace(/^["'«“]+|["'»”.!,;:]+$/g, "").trim();

function textOf(m: StoredMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** The user's message the quote comes from, the latest one, or null. */
export function findGrant(
  messages: readonly StoredMessage[],
  quote: string,
  now: number,
): Grant | null {
  const q = unquote(quote);
  if (q.length < MIN_QUOTE) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (now - m.ts > GRANT_TTL_MS) break;
    if (m.role !== "user" || !USER_SOURCES.has(m.source)) continue;
    if (norm(textOf(m)).includes(q)) return { seq: m.seq, ts: m.ts };
  }
  return null;
}
