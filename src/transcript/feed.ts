// Transcript feed (step T3): one instance's conversation, kept current.
//
// Joins the two halves of the T1 stream into the T2 model: the live follow (lines
// as Claude Code appends them) and history (pages read backwards from where the
// follow started). Nothing here touches the DOM, and the transport is passed in,
// so the join is testable and the phone can drive it over its own connection.
//
// Types only from `ipc/`: the phone's bundle imports this file too (step R4), and
// its transport is a WebSocket (`pwa/transcriptSource.ts`); the desktop's is
// `desktopSource.ts`.
//
// Only the newest part of a long session is loaded up front; `loadEarlier` pages
// further back on request, so a 5 MB transcript is never folded in one go.

import type {
  TranscriptAppended,
  TranscriptFollow,
  TranscriptPage,
  TranscriptRotated,
} from "../ipc/transcript";
import { createTranscript, type Item } from "./model";

/** Where the lines come from. Events are already narrowed to one instance. */
export interface TranscriptSource {
  follow(): Promise<TranscriptFollow>;
  unfollow(): void;
  /** The page of lines ending at `before`. */
  readBack(before: number): Promise<TranscriptPage>;
  onAppended(cb: (e: Pick<TranscriptAppended, "sessionId" | "lines">) => void): Promise<() => void>;
  onRotated(cb: (e: Pick<TranscriptRotated, "sessionId" | "offset">) => void): Promise<() => void>;
}

/** What changed, so the view can keep its scroll position sensibly:
 *  `append` — new lines at the end; `prepend` — an earlier page arrived (or a
 *  load finished); `reset` — another transcript, start over; `loading` — a load
 *  of earlier lines began. */
export type FeedChange = "append" | "prepend" | "reset" | "loading";

export interface Feed {
  readonly items: readonly Item[];
  /** There are earlier lines that are not loaded. */
  readonly hasEarlier: boolean;
  readonly loading: boolean;
  /** The follow is up and the first page of history is in. */
  readonly ready: boolean;
  /** Page further back until about a screenful of items is added. */
  loadEarlier(): Promise<void>;
  stop(): void;
}

/** About this many items per load — a few turns. */
const PAGE_ITEMS = 60;
/** Pages read per load at most. One prompt can append a page's worth of
 *  bookkeeping lines, so a single page often adds nothing to show. */
const MAX_PAGES = 24;

/** Start a feed. `onChange` is never called before this returns. */
export function createFeed(source: TranscriptSource, onChange: (why: FeedChange) => void): Feed {
  const transcript = createTranscript();
  // Bumped whenever the transcript changes under us; a read that started before
  // the bump is for the old one and is dropped.
  let generation = 0;
  let sessionId: string | null = null;
  /** Offset of the earliest loaded line; above zero there is more history. */
  let earliest = 0;
  let loading = false;
  let ready = false;
  let stopped = false;
  let followed = false;
  const unlisten: (() => void)[] = [];

  async function loadEarlier(): Promise<void> {
    if (stopped || loading || earliest <= 0) return;
    const mine = generation;
    loading = true;
    onChange("loading");
    const want = transcript.items.length + PAGE_ITEMS;
    try {
      for (let n = 0; n < MAX_PAGES && earliest > 0 && transcript.items.length < want; n++) {
        const page = await source.readBack(earliest);
        if (stopped || mine !== generation) return;
        if (page.sessionId !== sessionId || page.lines.length === 0) {
          earliest = 0; // not our transcript any more, or nothing before this
          break;
        }
        earliest = page.offset;
        transcript.prepend(page.lines);
      }
    } catch {
      // Unreadable right now: keep what is loaded; the button stays for a retry.
    }
    if (stopped || mine !== generation) return;
    loading = false;
    onChange("prepend");
  }

  async function start(): Promise<void> {
    // Listen before following, so no line falls between the two.
    unlisten.push(
      await source.onAppended((e) => {
        if (stopped || (ready && e.sessionId !== sessionId)) return;
        if (transcript.append(e.lines)) onChange("append");
      }),
      await source.onRotated((e) => {
        if (stopped) return;
        generation++;
        transcript.reset();
        sessionId = e.sessionId;
        earliest = e.offset;
        loading = false;
        onChange("reset");
        void loadEarlier();
      }),
    );
    if (stopped) return;
    const mine = generation;
    const info = await source.follow();
    followed = true;
    if (stopped) return;
    // A rotation that arrived while the follow was being taken is newer than
    // what the follow reported.
    if (mine === generation) {
      sessionId = info.sessionId;
      earliest = info.offset;
    }
    ready = true;
    onChange("prepend");
    await loadEarlier();
  }

  void start()
    .catch(() => {
      // No backend (a plain browser), or the instance is gone: show what we have.
      ready = true;
      if (!stopped) onChange("prepend");
    })
    .finally(() => {
      if (stopped) release();
    });

  function release(): void {
    for (const off of unlisten.splice(0)) off();
    if (followed) {
      followed = false;
      source.unfollow();
    }
  }

  return {
    get items() {
      return transcript.items;
    },
    get hasEarlier() {
      return earliest > 0;
    },
    get loading() {
      return loading;
    },
    get ready() {
      return ready;
    },
    loadEarlier,
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      release();
    },
  };
}

/** The text of the last thing Claude said in `items`, or null. */
export function lastAssistantText(items: readonly Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "assistant" && item.text.trim()) return item.text;
  }
  return null;
}

/**
 * The last response of an instance's session, read straight from its transcript —
 * no view needs to be open. Pages back from the end until one turns up.
 */
export async function readLastResponse(
  readBack: (before?: number) => Promise<TranscriptPage>,
): Promise<string | null> {
  const transcript = createTranscript();
  let before: number | undefined;
  let session: string | null | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await readBack(before);
    if (session !== undefined && page.sessionId !== session) break;
    session = page.sessionId;
    if (page.lines.length === 0) break;
    transcript.prepend(page.lines);
    const text = lastAssistantText(transcript.items);
    if (text !== null) return text;
    if (page.offset <= 0) break;
    before = page.offset;
  }
  return null;
}
