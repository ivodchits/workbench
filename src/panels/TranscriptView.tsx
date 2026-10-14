// Transcript view (step T3) — a Claude console's conversation as a readable
// document, shown in place of its terminal. The session itself is untouched: the
// PTY keeps running and its terminal stays in the pool, so switching back loses
// nothing (see `ConsolePanel`).
//
// Content comes from the session's transcript file (`transcript/feed`) and is
// drawn by the framework-free renderer (`transcript/render`); this component is
// the chrome around it — scrolling, paging back, find, link handling, a status
// line fed by the hook-driven live status, the prompt composer underneath (step
// T4), and over it the card for a prompt the agent is waiting on (step T5).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Spinner } from "../theme";
import { openUrl } from "../ipc/os";
import ChoiceCard from "./ChoiceCard";
import PromptComposer from "./PromptComposer";
import { focusComposer } from "../state/composer";
import { reconcileWithTranscript, usePendingChoice } from "../state/pendingChoice";
import { isTextInput } from "../keyboard/keymap";
import type { LiveStatus } from "../state/status";
import { instanceSource } from "../transcript/desktopSource";
import { createFeed, plansIn, type Feed } from "../transcript/feed";
import { notePlans } from "../state/plans";
import { openPlan } from "./openPlan";
import { createRenderer } from "../transcript/render";

interface TranscriptViewProps {
  instanceId: string;
  /** Hook-fed live status, for the working indicator. */
  live: LiveStatus | null;
  /** Switch this console back to its terminal (offered when the agent is waiting
   *  on an answer, which is still given there). */
  onShowTerminal: () => void;
}

/** Closer than this to the end counts as "at the bottom". */
const STICK_PX = 48;

interface FeedState {
  count: number;
  hasEarlier: boolean;
  loading: boolean;
  ready: boolean;
  /** Bumped on every content change, so an open find re-runs. */
  rev: number;
}

const EMPTY: FeedState = { count: 0, hasEarlier: false, loading: false, ready: false, rev: 0 };

function TranscriptView({ instanceId, live, onShowTerminal }: TranscriptViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<Feed | null>(null);
  const [feedState, setFeedState] = useState<FeedState>(EMPTY);
  const [away, setAway] = useState(false);
  const [finding, setFinding] = useState(false);
  // Held back until the conversation is loaded: it may show the prompt was
  // already answered (in the terminal, while this view was away).
  const pending = usePendingChoice(instanceId);
  const choice = feedState.ready ? pending : null;

  /** Whether the view was at the bottom, and where, as of the last scroll while
   *  it was on screen. Used when the geometry can't be measured (panel hidden). */
  const stuck = useRef(true);
  const lastTop = useRef(0);

  useEffect(() => {
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll || !list) return;
    const renderer = createRenderer(list);
    stuck.current = true;
    setFeedState(EMPTY);
    setAway(false);

    const atBottom = () =>
      scroll.clientHeight === 0
        ? stuck.current
        : scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX;

    const feed = createFeed(instanceSource(instanceId), (why) => {
      // Follow the end only if the reader was there, and keep their place when
      // an earlier page lands above it. "Was there" is what the last scroll said,
      // not the geometry now: the choice card may have just taken space from the
      // list, and until the resize below is handled the end looks out of reach.
      const follow = why === "reset" || stuck.current;
      const height = scroll.scrollHeight;
      const top = scroll.scrollTop;
      if (why !== "loading") {
        renderer.update(feed.items);
        // A refused or dismissed prompt is only ever recorded here (no hook).
        if (feed.ready) reconcileWithTranscript(instanceId, feed.items);
        notePlans(instanceId, plansIn(feed.items));
      }
      if (follow) scroll.scrollTop = scroll.scrollHeight;
      else if (why === "prepend") scroll.scrollTop = top + (scroll.scrollHeight - height);
      stuck.current = follow;
      setAway(!follow);
      setFeedState((s) => ({
        count: feed.items.length,
        hasEarlier: feed.hasEarlier,
        loading: feed.loading,
        ready: feed.ready,
        rev: s.rev + 1,
      }));
    });
    feedRef.current = feed;

    // The list's height as of the last resize handled. A scroll event that
    // arrives after the list changed height but before that resize is handled
    // (the choice card appearing, the composer growing) would read as "the
    // reader left the end"; the resize handler settles it instead.
    let seenHeight = scroll.clientHeight;

    const onScroll = () => {
      if (scroll.clientHeight === 0) return; // hidden: not a position the reader chose
      if (scroll.clientHeight !== seenHeight) return;
      stuck.current = atBottom();
      lastTop.current = scroll.scrollTop;
      setAway(!stuck.current);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });

    // dockview detaches a hidden tab's DOM, which resets its scroll position.
    // Put it back when the view is shown again.
    const shown = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1]?.isIntersecting) return;
      scroll.scrollTop = stuck.current ? scroll.scrollHeight : lastTop.current;
    });
    shown.observe(scroll);

    // The composer growing or shrinking, or the choice card coming and going,
    // resizes the list; a reader at the end stays at the end.
    const resized = new ResizeObserver(() => {
      seenHeight = scroll.clientHeight;
      if (scroll.clientHeight > 0 && stuck.current) scroll.scrollTop = scroll.scrollHeight;
    });
    resized.observe(scroll);

    // The view owns the keyboard the way the terminal does when it is shown:
    // typing goes to the prompt.
    focusComposer(instanceId);

    return () => {
      resized.disconnect();
      shown.disconnect();
      scroll.removeEventListener("scroll", onScroll);
      feed.stop();
      feedRef.current = null;
      renderer.clear();
    };
  }, [instanceId]);

  // The chrome React draws around the list ("load earlier", the status line) changes
  // height after the feed's own scroll adjustment; a reader at the end stays there.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && stuck.current) scroll.scrollTop = scroll.scrollHeight;
  }, [feedState, live?.phase, live?.compacting]);

  // A prompt that opens after the conversation was last read is checked once
  // against it too — the answer may have been recorded before the card was built.
  const pendingId = choice?.id ?? null;
  useEffect(() => {
    if (pendingId && feedRef.current) reconcileWithTranscript(instanceId, feedRef.current.items);
  }, [instanceId, pendingId]);

  // The card is gone: typing goes to the prompt again.
  const hadChoice = useRef(false);
  useEffect(() => {
    // (Its focus fell to the document when it was removed.)
    const active = document.activeElement;
    if (hadChoice.current && !pendingId && (active === document.body || rootRef.current?.contains(active))) {
      focusComposer(instanceId);
    }
    hadChoice.current = Boolean(pendingId);
  }, [instanceId, pendingId]);

  const jumpToLatest = useCallback(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, []);

  /** A prompt was sent: show the end of the conversation, where it will appear. */
  const followEnd = useCallback(() => {
    stuck.current = true;
    setAway(false);
    jumpToLatest();
  }, [jumpToLatest]);

  const closeFind = useCallback(() => {
    setFinding(false);
    focusComposer(instanceId);
  }, [instanceId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      setFinding(true);
      // Already open: the bar re-focuses its field on this event.
      window.dispatchEvent(new Event(FOCUS_FIND));
    } else if (e.key === "Escape" && finding) {
      e.preventDefault();
      closeFind();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextInput(e.target)) {
      // Typing while the text (not a field) has focus — after selecting something,
      // say — goes to the prompt; the field receives this very keystroke.
      focusComposer(instanceId);
    }
  };

  // Links in rendered text never navigate this webview: web and mail links go to
  // the OS (the backend refuses anything else), the rest do nothing.
  const onLink = (e: React.MouseEvent) => {
    const planBtn = e.target instanceof Element ? e.target.closest(".wb-tx-open-plan") : null;
    if (planBtn) {
      // A plan card's "open plan" (step P1): the card's item id is the plan's.
      e.preventDefault();
      e.stopPropagation();
      const id = planBtn.closest<HTMLElement>("[data-item-id]")?.dataset.itemId;
      const plan = plansIn(feedRef.current?.items ?? []).find((p) => p.id === id);
      if (plan && e.type === "click") openPlan(instanceId, plan);
      return;
    }
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!link) return;
    e.preventDefault();
    if (e.type === "click") void openUrl(link.getAttribute("href") ?? "").catch(() => {});
  };

  return (
    <div ref={rootRef} className="wb-txv" tabIndex={-1} onKeyDown={onKeyDown}>
      {finding && (
        <FindBar scope={listRef} scroller={scrollRef} rev={feedState.rev} onClose={closeFind} />
      )}
      <div className="wb-txv-body">
        <div ref={scrollRef} className="wb-txv-scroll" onClick={onLink} onAuxClick={onLink}>
          {feedState.hasEarlier && (
            <button
              type="button"
              className="wb-txv-earlier"
              disabled={feedState.loading}
              onClick={() => void feedRef.current?.loadEarlier()}
            >
              {feedState.loading ? "loading…" : "↑ load earlier"}
            </button>
          )}
          {feedState.count === 0 && (
            <div className="wb-txv-empty">
              {!feedState.ready || feedState.loading ? "loading…" : "nothing in this session yet"}
            </div>
          )}
          <div ref={listRef} />
          <StatusLine live={live} hasCard={choice !== null} onShowTerminal={onShowTerminal} />
        </div>
        {away && (
          <button type="button" className="wb-txv-jump" onClick={jumpToLatest}>
            ↓ latest
          </button>
        )}
      </div>
      {choice && (
        <ChoiceCard instanceId={instanceId} choice={choice} onShowTerminal={onShowTerminal} />
      )}
      <PromptComposer
        instanceId={instanceId}
        live={live}
        onShowTerminal={onShowTerminal}
        onSent={followEnd}
      />
    </div>
  );
}

/** What the agent is doing right now, under the last message. Always takes its
 *  line, so appearing and disappearing doesn't move the text above it. */
function StatusLine({
  live,
  hasCard,
  onShowTerminal,
}: {
  live: LiveStatus | null;
  /** The prompt is on the choice card, which has its own way to the terminal. */
  hasCard: boolean;
  onShowTerminal: () => void;
}) {
  let body: React.ReactNode = null;
  if (live?.compacting) {
    body = (
      <span style={{ color: "var(--wb-working)" }}>
        <Spinner size={11} /> compacting…
      </span>
    );
  } else if (live?.phase === "working") {
    body = (
      <span style={{ color: "var(--wb-working)" }}>
        <Spinner size={11} /> working
        {live.subagents > 0 && ` · ${live.subagents} subagent${live.subagents === 1 ? "" : "s"}`}
      </span>
    );
  } else if (live?.phase === "needs_you") {
    body = (
      <>
        <span style={{ color: "var(--wb-needs)" }}>● needs you</span>
        {!hasCard && (
          <button type="button" className="wb-txv-link" onClick={onShowTerminal}>
            answer in the terminal
          </button>
        )}
      </>
    );
  }
  return (
    <div className="wb-txv-status" aria-live="polite">
      {body}
    </div>
  );
}

// --- find --------------------------------------------------------------------
// Matches are painted with the CSS Custom Highlight API: ranges over the existing
// text nodes, so the rendered DOM (and what a selection copies) is not touched.

const FOCUS_FIND = "wb-txv-focus-find";
const HIGHLIGHT_ALL = "wb-tx-find";
const HIGHLIGHT_CURRENT = "wb-tx-find-current";
/** Stop collecting after this many matches (a one-letter query in a long session). */
const MAX_MATCHES = 2000;

/** Every visible occurrence of `query` under `root`, case-insensitive. Text in a
 *  collapsed card is skipped — it is not on screen (and usually not built yet). */
function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const out: Range[] = [];
  if (!needle) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && out.length < MAX_MATCHES; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLowerCase();
    let at = text.indexOf(needle);
    if (at < 0 || !node.parentElement?.checkVisibility()) continue;
    for (; at >= 0 && out.length < MAX_MATCHES; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      out.push(range);
    }
  }
  return out;
}

function FindBar({
  scope,
  scroller,
  rev,
  onClose,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  scroller: React.RefObject<HTMLDivElement | null>;
  rev: number;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    window.addEventListener(FOCUS_FIND, focus);
    return () => {
      window.removeEventListener(FOCUS_FIND, focus);
      CSS.highlights.delete(HIGHLIGHT_ALL);
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    };
  }, []);

  // Re-search when the query or the content changes.
  useEffect(() => {
    const found = scope.current ? findRanges(scope.current, query) : [];
    setRanges(found);
    setIndex((i) => (found.length === 0 ? 0 : Math.min(i, found.length - 1)));
  }, [scope, query, rev]);

  useEffect(() => {
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges));
    const current = ranges[index];
    if (current) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(current));
    else CSS.highlights.delete(HIGHLIGHT_CURRENT);
  }, [ranges, index]);

  // Bring the current match into view — but only when the reader moved to it,
  // not every time new output re-runs the search.
  const reveal = useCallback(
    (range: Range | undefined) => {
      const scroll = scroller.current;
      if (!range || !scroll) return;
      // A long output scrolls inside its own box first.
      range.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
      const r = range.getBoundingClientRect();
      const box = scroll.getBoundingClientRect();
      if (r.top < box.top + 40 || r.bottom > box.bottom - 40) {
        scroll.scrollTop += r.top - box.top - box.height / 2;
      }
    },
    [scroller],
  );

  const step = (by: number) => {
    if (ranges.length === 0) return;
    const next = (index + by + ranges.length) % ranges.length;
    setIndex(next);
    reveal(ranges[next]);
  };

  return (
    <div className="wb-txv-find">
      <input
        ref={inputRef}
        value={query}
        placeholder="find in transcript"
        spellCheck={false}
        onChange={(e) => {
          const q = e.target.value;
          setQuery(q);
          setIndex(0);
          reveal(scope.current ? findRanges(scope.current, q)[0] : undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="wb-txv-find-count">
        {query ? (ranges.length === 0 ? "no matches" : `${index + 1} / ${ranges.length}`) : ""}
      </span>
      <button type="button" title="previous (Shift+Enter)" onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" title="next (Enter)" onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" title="close (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

export default TranscriptView;
