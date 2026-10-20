// A session's recent conversation as plain text (step W1), for Duck's
// `read_session`. Pages back from the end of the transcript with the same reader
// the views use, folds the lines with the transcript model, and writes the last
// items one per line: what the user typed, what Claude answered, and a one-line
// summary of each tool call. Thinking, turn ends and bookkeeping are left out.
//
// The result is capped in characters (the oldest lines go first), so a long
// session never floods Duck's context. No DOM, no Tauri: the reader is passed in.

import type { TranscriptPage } from "../ipc/transcript";
import { createTranscript, type Item } from "./model";
import { oneLine, toolTarget, toolTitle } from "./summary";

/** The most pages read back, as the feed's own bound. */
const MAX_PAGES = 24;
/** One message's text is cut to this. */
const ITEM_CHARS = 1200;

export interface PlainTextOptions {
  /** The last this many items. */
  maxItems: number;
  /** The whole text's cap. */
  maxChars: number;
  /** Only items dated after this (epoch ms), for a summary of what's new (W3). */
  since?: number;
}

export interface PlainText {
  /** One item per line block, oldest first. Empty when there is no transcript. */
  text: string;
  /** Items shown. */
  items: number;
  /** Earlier items exist that weren't shown. */
  truncated: boolean;
  /** The newest shown item's time (epoch ms); null when none is dated. */
  lastAt: number | null;
}

function clip(text: string, max = ITEM_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)} …[cut]` : t;
}

function time(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}] `;
}

/** One item as text, or null for items that aren't shown. */
export function itemText(item: Item): string | null {
  const at = time(item.timestamp);
  switch (item.kind) {
    case "user": {
      const images = item.images.length
        ? ` [${item.images.length} image(s)]`
        : "";
      return `${at}user: ${clip(item.text)}${images}`;
    }
    case "assistant":
      return `${at}${item.isError ? "error" : "claude"}: ${clip(item.text)}`;
    case "tool": {
      const target = toolTarget(item);
      const status = item.status === "ok" ? "" : ` [${item.status}]`;
      const head = `${at}tool ${toolTitle(item)}${target ? `: ${target}` : ""}${status}`;
      // A subagent's report and a failure's reason say what happened.
      const result =
        item.agent?.result ??
        (item.status === "error" ? item.resultText : null);
      return result ? `${head}\n  → ${oneLine(result, 300)}` : head;
    }
    case "command": {
      const name = /^[/!]/.test(item.name) ? item.name : `/${item.name}`;
      return `${at}command ${name}${item.args ? ` ${item.args}` : ""}`;
    }
    case "divider":
      return item.reason === "compact"
        ? `${at}--- context compacted ---`
        : `${at}--- context cleared ---`;
    case "interrupted":
      return `${at}[interrupted by the user]`;
    case "notice":
      return item.level === "info"
        ? null
        : `${at}${item.level}: ${clip(item.text, 300)}`;
    case "thinking":
    case "turn-end":
      return null;
  }
}

/** The tail of a transcript as text. `readBack` reads the page ending at an
 *  offset (the end when omitted). */
export async function readPlainText(
  readBack: (before?: number) => Promise<TranscriptPage>,
  { maxItems, maxChars, since }: PlainTextOptions,
): Promise<PlainText> {
  const transcript = createTranscript();
  let before: number | undefined;
  let session: string | null | undefined;
  let more = false;
  const shown = () =>
    transcript.items.filter((i) => itemText(i) !== null).length;
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await readBack(before);
    if (session !== undefined && page.sessionId !== session) break;
    session = page.sessionId;
    if (page.lines.length === 0) break;
    transcript.prepend(page.lines);
    more = page.offset > 0;
    if (!more || shown() > maxItems) break;
    if (since !== undefined && (at(transcript.items[0]) ?? Infinity) <= since) break;
    before = page.offset;
  }

  let items = transcript.items;
  if (since !== undefined) {
    // From the first item dated after `since`; undated items ride with their turn.
    const first = items.findIndex((i) => (at(i) ?? -Infinity) > since);
    items = first < 0 ? [] : items.slice(first);
    if (first !== 0) more = false;
  }
  const shownItems = items.filter((i) => itemText(i) !== null);
  const lines = shownItems.map((i) => itemText(i) as string);
  let kept = lines.slice(-maxItems);
  let truncated = more || kept.length < lines.length;
  // Over the cap: drop the oldest lines; a single line that is still too long is cut.
  let size = kept.reduce((n, l) => n + l.length + 1, 0);
  while (kept.length > 1 && size > maxChars) {
    size -= kept[0].length + 1;
    kept = kept.slice(1);
    truncated = true;
  }
  const text = kept.join("\n");
  const dated = shownItems.map(at).filter((t): t is number => t !== null);
  return {
    text: text.length > maxChars ? `${text.slice(0, maxChars)} …[cut]` : text,
    items: kept.length,
    truncated,
    lastAt: dated.length ? Math.max(...dated) : null,
  };
}

/** An item's time, epoch ms; null when it has none. */
function at(item: Item | undefined): number | null {
  if (!item?.timestamp) return null;
  const t = Date.parse(item.timestamp);
  return Number.isNaN(t) ? null : t;
}
