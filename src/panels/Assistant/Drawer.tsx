// Duck's drawer (step A3): a left-side drawer under the Duck button, over the dock,
// for talking to Duck from anywhere in the app. Not a dock panel: Duck is global,
// not per project. Toggled by the button, `toggleAssistant` and Esc.
//
// It stays mounted while closed (only hidden), so reopening it finds the same thread
// at the same scroll position; the open thread and the width persist in prefs. It
// speaks only the Duck Protocol, through `duckState`. The header's trust pill is
// the kill switch (T1); the trust and decisions views take the thread's place.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { registerCommand, setKeyOverride, useBindings } from "../../keyboard";
import { chordText } from "../keymapFormat";
import { getKeyStatus } from "../../ipc/assistant";
import {
  notesCreateWith,
  notesDelete,
  notesRead,
  notesWrite,
} from "../../ipc/notes";
import { openUrl } from "../../ipc/os";
import {
  pluginsRemove,
  pluginsScriptRead,
  pluginsScriptWrite,
  pluginsWrite,
} from "../../ipc/plugins";
import { focusActivePanel, activatePanel } from "../../state/dock";
import { getRegistry } from "../../state/registry";
import { setActiveProject } from "../../state/activeProject";
import { openConsole } from "../../state/consoles";
import { formatAgo } from "../../util/format";
import { renderMarkdown } from "../Editor/markdown";
import "../../theme/markdown.css";
import "../../theme/assistant.css";
import { coreWorkspace, EMPTY_CORE } from "../../assistant/core";
import { coreWrite } from "../../ipc/assistant";
import type {
  ConfirmRequest,
  MemoryEdit,
  NoteEdit,
  Notice,
  PluginsEdit,
  ReviewItem,
  TurnState,
} from "../../assistant/protocol";
import { projectMonth } from "../../assistant/spend";
import DuckAvatar from "./DuckAvatar";
import type { DuckMode } from "./duck3d";
import DuckIcon from "./DuckIcon";
import DrawerSettings from "./DrawerSettings";
import { getSpeechLevel, getSpeechState, initSpeech, isSpeaking, setSpeakOn, stopSpeaking, useSpeechState } from "./replySpeech";
import {
  getConversationLevel,
  getVoiceState,
  initVoice,
  toggleConversation,
  useVoiceState,
  type VoiceState,
} from "./voiceState";
import { voicePtt, voiceToggle } from "../../ipc/voice";
import { TasksPanel } from "./TasksView";
import { OverviewPanel } from "./OverviewView";
import { DecisionsPanel, TrustPanel } from "./TrustViews";
import type { ThreadRow } from "../../ipc/assistant";
import {
  answer,
  clearError,
  closeTask,
  controlReader,
  rerunTask,
  connectDuck,
  compactThread,
  deleteThread,
  getDuckState,
  isBusy,
  isRunning,
  openThread,
  sendMessage,
  setDrawerOpen,
  setDrawerWidth,
  setTrustPaused,
  stopTurn,
  toggleDrawer,
  toggleTrust,
  useDuckState,
  type DuckState,
} from "./duckState";
import {
  lineDiff,
  oneLine,
  readableInput,
  sessionLink,
  toItems,
  type Item,
  unreadTotal,
} from "./view";

const MIN_WIDTH = 320;
const usd = (n: number) => (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const STATE_LABEL = {
  thinking: "thinking…",
  streaming: "replying…",
  tool: "running a tool…",
  waiting: "waiting for your answer",
} as const;

/** What the duck does for each turn state: spins while working, talks while the
 *  reply streams, and looks up at you while a confirmation waits. */
const AVATAR_MODE: Record<TurnState, DuckMode> = {
  idle: "idle",
  thinking: "thinking",
  tool: "thinking",
  streaming: "talking",
  waiting: "listening",
};

/** Open a session's console (a `#session/<id>` link in a reply). */
function focusSession(instanceId: string): boolean {
  const inst = getRegistry().instances.find((i) => i.id === instanceId);
  if (!inst) return false;
  setActiveProject(inst.projectId);
  openConsole(inst);
  activatePanel(inst.id);
  return true;
}

export default function AssistantDrawer() {
  const duck = useDuckState();
  const [width, setWidth] = useState<number | null>(null);
  const [noKey, setNoKey] = useState(false);
  const [view, setView] = useState<View>("thread");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => void connectDuck(), []);
  useEffect(() => void initVoice(), []);
  useEffect(() => void initSpeech(), []);
  const speech = useSpeechState();
  useEffect(() => registerCommand("toggleAssistant", toggleDrawer), []);
  useEffect(() => registerCommand("toggleTrust", toggleTrust), []);
  useEffect(() => registerCommand("toggleSpeak", () => setSpeakOn(!getSpeechState().prefs.on)), []);
  useEffect(() => registerCommand("toggleConversation", toggleConversation), []);

  /** The keyboard goes to the composer, so you can type at once. */
  const focusComposer = useCallback(() => requestAnimationFrame(() => composerRef.current?.focus()), []);

  const showThread = useCallback(
    (id: string | null) => {
      openThread(id);
      setView("thread");
      focusComposer();
    },
    [focusComposer],
  );

  // While open, the new-instance and cycle-panel chords (Ctrl+Shift+N, Ctrl+Tab /
  // Ctrl+Shift+Tab by default) start a thread and step through the threads.
  useEffect(() => {
    if (!duck.open) return;
    return setKeyOverride((command) => {
      if (command === "newInstance") {
        showThread(null);
        return true;
      }
      if (command === "cyclePanelNext" || command === "cyclePanelPrev") {
        const { threads, current } = getDuckState();
        if (threads.length === 0) return true;
        const at = threads.findIndex((t) => t.id === current);
        const step = command === "cyclePanelNext" ? 1 : -1;
        // From a new thread, forward is the newest, back the oldest.
        const next = at < 0 ? (step > 0 ? 0 : threads.length - 1) : (at + step + threads.length) % threads.length;
        showThread(threads[next].id);
        return true;
      }
      return false;
    });
  }, [duck.open, showThread]);

  // Opening: remember where the keyboard was, check the key, focus the composer.
  // Closing: hand the keyboard back.
  useEffect(() => {
    if (duck.open) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement ? active : null;
      focusComposer();
      void getKeyStatus()
        .then((k) => setNoKey(!k.present))
        .catch(() => {});
    } else if (returnFocus.current) {
      const el = returnFocus.current;
      returnFocus.current = null;
      if (el.isConnected && !el.closest("[data-wb-duck]")) el.focus();
      else focusActivePanel();
    }
  }, [duck.open, focusComposer]);

  const max = Math.max(MIN_WIDTH, window.innerWidth - 120);
  const w = Math.min(max, Math.max(MIN_WIDTH, width ?? duck.prefs.width));

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    let last = startW;
    const move = (ev: PointerEvent) => {
      last = Math.min(max, Math.max(MIN_WIDTH, startW + ev.clientX - startX));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrawerWidth(last);
      setWidth(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const current = duck.current;
  const thread = duck.threads.find((t) => t.id === current) ?? null;
  const busy = isBusy(current);

  return (
    <div
      data-wb-duck
      aria-hidden={!duck.open}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        // Esc stops what's going on: the voice and the turn first, then the drawer.
        const speaking = isSpeaking();
        if (speaking) stopSpeaking();
        if (busy) stopTurn();
        else if (!speaking) setDrawerOpen(false);
      }}
      // A click that wasn't on a control, and didn't select text, hands the
      // keyboard back to the composer.
      onMouseUp={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("button, a, input, textarea, select, label, [contenteditable]")) return;
        if (window.getSelection()?.toString()) return;
        focusComposer();
      }}
      style={{
        position: "absolute",
        top: 36,
        bottom: 28,
        left: 0,
        width: w,
        zIndex: 60,
        visibility: duck.open ? "visible" : "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--wb-panel)",
        borderRight: "1px solid var(--wb-border)",
        boxShadow: "6px 0 24px rgba(0,0,0,0.45)",
        font: "12px var(--wb-mono)",
        color: "var(--wb-text)",
        // The app is unselectable by default; Duck's replies hold paths and links
        // you'll want to copy.
        userSelect: "text",
      }}
    >
      <Header
        duck={duck}
        title={thread ? thread.title || "untitled" : "new thread"}
        onView={setView}
        onThread={showThread}
      />
      {noKey && (
        <div style={{ ...banner, color: "var(--wb-needs)" }}>
          No API key yet. Add one from the ◆ duck menu in the status bar.
        </div>
      )}
      {duck.error && (
        <div
          style={{
            ...banner,
            color: "var(--wb-needs)",
            display: "flex",
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{duck.error}</span>
          <button
            type="button"
            style={plainBtn}
            onClick={clearError}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}
      {view === "thread" && <Elsewhere duck={duck} onOpen={showThread} />}
      {view === "thread" && duck.prefs.avatar.show && (
        <div
          style={{
            flex: "0 0 auto",
            height: "clamp(120px, 32%, 320px)",
            borderBottom: "1px solid var(--wb-border)",
          }}
        >
          <DuckAvatar
            mode={speech.speaking !== null ? "talking" : AVATAR_MODE[current ? (duck.states[current] ?? "idle") : "idle"]}
            level={speech.speaking !== null ? getSpeechLevel : undefined}
            prefs={duck.prefs.avatar}
            running={duck.open}
          />
        </div>
      )}
      {view === "thread" && <ThreadBody duck={duck} />}
      {view === "trust" && <TrustPanel duck={duck} onBack={() => showThread(duck.current)} />}
      {view === "decisions" && (
        <DecisionsPanel duck={duck} onBack={() => showThread(duck.current)} />
      )}
      {view === "tasks" && <TasksPanel duck={duck} onBack={() => showThread(duck.current)} />}
      {view === "overview" && (
        <OverviewPanel duck={duck} onBack={() => showThread(duck.current)} onOpen={(id) => showThread(id)} />
      )}
      <Asks duck={duck} />
      <SpendLine duck={duck} />
      <Composer duck={duck} busy={busy} inputRef={composerRef} />
      <div
        onPointerDown={startResize}
        title="drag to resize"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: -3,
          width: 6,
          cursor: "col-resize",
        }}
      />
    </div>
  );
}

type View = "thread" | "trust" | "decisions" | "tasks" | "overview";

/** The breadcrumbs: other threads with news since you looked, each a click away. */
function Elsewhere({ duck, onOpen }: { duck: DuckState; onOpen: (id: string) => void }) {
  const others = duck.threads.filter((t) => t.id !== duck.current && duck.unread[t.id]);
  if (others.length === 0) return null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "baseline",
        padding: "4px 12px",
        borderBottom: "1px solid var(--wb-border)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textFaint)",
      }}
    >
      <span>news in</span>
      {others.slice(0, 4).map((t) => (
        <button
          key={t.id}
          type="button"
          title={duck.news[t.id] ?? ""}
          onClick={() => onOpen(t.id)}
          style={{ ...plainBtn, color: "var(--wb-accent)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          ● {t.title || "untitled"}
          {duck.unread[t.id] > 1 ? ` (${duck.unread[t.id]})` : ""}
        </button>
      ))}
      {others.length > 4 && <span>+{others.length - 4} more</span>}
    </div>
  );
}

/** The kill switch: on, or paused (every consequential call asks). */
function TrustPill({ duck }: { duck: DuckState }) {
  const bindings = useBindings();
  const t = duck.trust;
  if (!t) return null;
  const chord = bindings.find((b) => b.command === "toggleTrust")?.chord;
  const key = chord ? ` (${chordText(chord)})` : "";
  return (
    <button
      type="button"
      onClick={() => setTrustPaused(!t.paused)}
      title={
        t.paused
          ? `Trust is paused: every consequential call asks. Click to resume${key}.`
          : `Duck acts without a card on what the rules allow. Click to pause${key}.`
      }
      style={{
        ...btn,
        color: t.paused ? "var(--wb-needs)" : "var(--wb-textDim2)",
        borderColor: t.paused ? "var(--wb-needs)" : "var(--wb-border)",
      }}
    >
      {t.paused ? "⏸ paused" : "trust"}
    </button>
  );
}

function Header({
  duck,
  title,
  onView,
  onThread,
}: {
  duck: DuckState;
  title: string;
  onView: (v: View) => void;
  /** Show a thread (null: a new one), the keyboard in its composer. */
  onThread: (id: string | null) => void;
}) {
  const [menu, setMenu] = useState<"threads" | "settings" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bindings = useBindings();
  const chord = bindings.find((b) => b.command === "newInstance")?.chord;
  const newChord = chord ? chordText(chord) : null;

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);
  useEffect(() => {
    if (!duck.open) setMenu(null);
  }, [duck.open]);
  // The settings popover stays inside the drawer: its height is the room between
  // the header and the drawer's bottom, measured while it's open.
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    if (menu !== "settings") return;
    const measure = () => {
      const head = rootRef.current;
      const drawer = head?.parentElement;
      if (!head || !drawer) return;
      setRoom(Math.max(120, drawer.getBoundingClientRect().bottom - head.getBoundingClientRect().bottom - 10));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (rootRef.current?.parentElement) ro.observe(rootRef.current.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [menu]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderBottom: "1px solid var(--wb-border)",
      }}
    >
      <DuckIcon size={22} />
      <button
        type="button"
        onClick={() => setMenu(menu === "threads" ? null : "threads")}
        title="threads"
        style={{
          ...plainBtn,
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          display: "flex",
          gap: 6,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span style={{ color: "var(--wb-textFaint)" }}>▾</span>
      </button>
      <button
        type="button"
        style={btn}
        title={`start a new thread${newChord ? ` (${newChord})` : ""}`}
        onClick={() => {
          onThread(null);
          setMenu(null);
        }}
      >
        + new
      </button>
      {duck.threads.length > 1 && (
        <button
          type="button"
          style={{ ...btn, ...(unreadTotal(duck) ? { color: "var(--wb-accent)", borderColor: "var(--wb-accent)" } : {}) }}
          title="every thread: its news, autopilots and tasks"
          onClick={() => {
            onView("overview");
            setMenu(null);
          }}
        >
          all{unreadTotal(duck) ? ` · ${unreadTotal(duck)}` : ""}
        </button>
      )}
      {duck.tasks.length > 0 && (
        <button
          type="button"
          style={btn}
          title="Duck's worker tasks and their results"
          onClick={() => {
            onView("tasks");
            setMenu(null);
          }}
        >
          tasks
          {duck.tasks.some((t) => t.state === "running" || t.state === "queued") &&
            ` · ${duck.tasks.filter((t) => t.state === "running" || t.state === "queued").length}`}
        </button>
      )}
      <TrustPill duck={duck} />
      <button
        type="button"
        style={btn}
        title="settings"
        aria-label="settings"
        onClick={() => setMenu(menu === "settings" ? null : "settings")}
      >
        ⚙
      </button>
      <button
        type="button"
        style={btn}
        title="close (Esc)"
        aria-label="close"
        onClick={() => setDrawerOpen(false)}
      >
        ×
      </button>

      {menu === "threads" && (
        <div
          style={{
            ...popover,
            left: 8,
            right: 8,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {duck.threads.length === 0 && (
            <div style={{ padding: "4px 12px", color: "var(--wb-textFaint)" }}>
              no threads yet
            </div>
          )}
          {duck.threads.map((t) => (
            <ThreadListRow
              key={t.id}
              thread={t}
              duck={duck}
              onOpen={() => {
                onThread(t.id);
                setMenu(null);
              }}
            />
          ))}
        </div>
      )}
      {menu === "settings" && (
        <div
          style={{
            ...popover,
            right: 8,
            width: 320,
            // Taller than the drawer allows, its tabs scroll.
            maxHeight: room ?? "calc(100vh - 96px)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <DrawerSettings duck={duck} />
          <div style={{ display: "flex", gap: 8, padding: "6px 12px 2px" }}>
            {(["trust", "decisions"] as const).map((v) => (
              <button
                key={v}
                type="button"
                style={btn}
                onClick={() => {
                  onView(v);
                  setMenu(null);
                }}
              >
                {v === "trust" ? "trust rules…" : "decisions…"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One row of the thread list: open it, or delete it after a yes (step A4). A
 *  thread with a reply running can't be deleted until the reply is stopped. */
function ThreadListRow({
  thread: t,
  duck,
  onOpen,
}: {
  thread: ThreadRow;
  duck: DuckState;
  onOpen: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [hover, setHover] = useState(false);
  const running = isRunning(t.id);
  const unread = duck.unread[t.id] ?? 0;
  const title = `${unread ? "● " : ""}${t.title || "untitled"}`;
  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 12px",
    background: t.id === duck.current ? "var(--wb-sel)" : "transparent",
  };

  if (confirming)
    return (
      <div style={row}>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--wb-needs)",
          }}
        >
          delete “{title}”?
        </span>
        <button
          type="button"
          style={{
            ...btn,
            color: "var(--wb-needs)",
            borderColor: "var(--wb-needs)",
          }}
          onClick={() => {
            setConfirming(false);
            deleteThread(t.id);
          }}
        >
          yes
        </button>
        <button type="button" style={btn} onClick={() => setConfirming(false)}>
          no
        </button>
      </div>
    );

  return (
    <div
      style={row}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        style={{ ...plainBtn, flex: 1, minWidth: 0, display: "flex", gap: 8 }}
      >
        <span
          style={{
            flex: 1,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {duck.asks.some((a) => a.threadId === t.id) && (
          <span style={{ color: "var(--wb-needs)" }}>●</span>
        )}
        <span style={{ color: "var(--wb-textFaint)" }}>
          {formatAgo(Math.floor(t.updated / 1000))}
        </span>
      </button>
      <button
        type="button"
        aria-label={`compact ${title}`}
        title={
          running
            ? "compacts once Duck's reply here is over"
            : "compact this thread: Duck summarizes its older turns, so it costs less (every message stays here)"
        }
        onClick={() => compactThread(t.id)}
        style={{
          ...plainBtn,
          color: "var(--wb-textDim2)",
          visibility: hover || t.id === duck.current ? "visible" : "hidden",
        }}
      >
        ⇲
      </button>
      <button
        type="button"
        aria-label={`delete ${title}`}
        title={
          running
            ? "Duck is replying here: stop it first"
            : "delete this thread"
        }
        disabled={running}
        onClick={() => setConfirming(true)}
        style={{
          ...plainBtn,
          color: running ? "var(--wb-textFaint)" : "var(--wb-textDim2)",
          cursor: running ? "default" : "pointer",
          visibility: hover || t.id === duck.current ? "visible" : "hidden",
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ── the thread ──────────────────────────────────────────────────────────────

/** Scroll positions per thread, so switching back lands where you were. */
const scrolls = new Map<string, number>();

function ThreadBody({ duck }: { duck: DuckState }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = useRef<string | null>(null);
  const id = duck.current;
  const messages = id ? duck.messages[id] : undefined;
  const items = messages ? toItems(messages) : [];
  const streaming = id ? duck.streaming[id] : "";
  const queued = id ? (duck.queued[id] ?? []) : [];
  const provisional = id ? duck.provisional[id] : "";
  const state = id ? (duck.states[id] ?? "idle") : "idle";

  // Switching threads: save the old position, restore the new one (or the end).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current === id || (id && !messages)) return;
    shown.current = id;
    const saved = id ? scrolls.get(id) : undefined;
    el.scrollTop = saved ?? el.scrollHeight;
    stick.current =
      saved === undefined ||
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, [id, messages]);

  // New content: follow it if you were at the end.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, streaming, queued.length, provisional, state]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        if (id && shown.current === id) scrolls.set(id, el.scrollTop);
      }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        const session = sessionLink(href);
        if (session) {
          if (focusSession(session)) setDrawerOpen(false);
        } else if (href && /^https?:\/\//i.test(href))
          void openUrl(href).catch(() => {});
      }}
      style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 0" }}
    >
      {!id && (
        <div style={{ padding: "18px 16px", color: "var(--wb-textFaint)" }}>
          A new thread. Ask Duck anything about your sessions.
        </div>
      )}
      {items.map((it) => (
        <ItemView key={it.key} item={it} active={state !== "idle"} />
      ))}
      {provisional && <UserBubble text={provisional} source="voice" pending />}
      {streaming && <Reply text={streaming} />}
      {state !== "idle" && !streaming && (
        <div style={{ padding: "2px 16px", color: "var(--wb-textFaint)" }}>
          {STATE_LABEL[state]}
        </div>
      )}
      {queued.map((q, i) => (
        <UserBubble key={`q${i}`} text={q} queued />
      ))}
    </div>
  );
}

function ItemView({ item, active }: { item: Item; active: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} source={item.source} />;
    case "reply":
      return <Reply text={item.text} />;
    case "tool":
      return <ToolChip item={item} active={active} />;
    case "event":
      return (
        <div
          style={{
            margin: "4px 16px",
            paddingLeft: 8,
            borderLeft: "2px solid var(--wb-accent)",
            color: "var(--wb-textDim2)",
            whiteSpace: "pre-wrap",
          }}
          title="from Workbench, not from you"
        >
          {item.text}
        </div>
      );
    case "note":
      return (
        <EditChip
          text={item.text}
          project={item.edit.project}
          files={[{ label: item.edit.name, before: item.edit.before ?? "", after: item.edit.after ?? "" }]}
          undo={() => undoNoteEdit(item.edit)}
          staleText="can't undo: the note changed since"
        />
      );
    case "plugins":
      return (
        <EditChip
          text={item.text}
          project={item.edit.project}
          files={[
            { label: "plugins.json", before: item.edit.before ?? "", after: item.edit.after },
            ...item.edit.scripts.map((s) => ({ label: `scripts/${s.name}`, before: s.before ?? "", after: s.after })),
          ]}
          undo={() => undoPluginsEdit(item.edit)}
          staleText="can't undo: the plugin file changed since"
        />
      );
    case "memory":
      return (
        <EditChip
          text={item.text}
          project="core memory"
          files={[{ label: "core.md", before: item.edit.before ?? "", after: item.edit.after }]}
          undo={() => undoMemoryEdit(item.edit)}
          staleText="can't undo: core.md changed since"
        />
      );
    case "task":
      return <TaskCard taskId={item.taskId} text={item.text} />;
    case "notice":
      return (
        <div
          title={item.notice.compaction?.summary}
          style={{
            margin: "4px 16px",
            color:
              item.notice.kind === "stopped" ||
              item.notice.kind === "keys" ||
              item.notice.kind === "autopilot" ||
              item.notice.kind === "screen" ||
              item.notice.kind === "reader" ||
              item.notice.kind === "compacted"
                ? "var(--wb-textFaint)"
                : item.notice.kind === "budget"
                  ? "var(--wb-working)"
                  : "var(--wb-needs)",
          }}
        >
          {NOTICE_GLYPH[item.notice.kind] ?? "!"} {item.notice.text}
        </div>
      );
  }
}

const NOTICE_GLYPH: Partial<Record<Notice["kind"], string>> = { keys: "⌨", autopilot: "⟳", screen: "▣", reader: "♪", budget: "$", compacted: "⇲" };

const TASK_STATE: Record<string, string> = {
  queued: "waiting for a free worker",
  running: "working",
  done: "done",
  blocked: "blocked",
  needs_decision: "needs a decision",
  failed: "failed",
  closed: "closed",
};

function elapsed(from: number | null, to: number | null): string {
  if (from === null) return "";
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A worker task's card (D1): its state, worker, time, and a way to its console. */
function TaskCard({ taskId, text }: { taskId: string; text: string }) {
  const task = useDuckState().tasks.find((t) => t.id === taskId);
  const [, tick] = useState(0);
  const live = task?.state === "running";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!task)
    return <div style={{ margin: "4px 16px", color: "var(--wb-textFaint)" }}>⚙ {text}</div>;
  const color =
    task.state === "running" || task.state === "queued"
      ? "var(--wb-working)"
      : task.state === "done"
        ? "var(--wb-accent)"
        : task.state === "closed"
          ? "var(--wb-textFaint)"
          : "var(--wb-needs)";
  const open = task.state !== "closed" && task.instanceId;
  return (
    <div style={{ margin: "4px 16px", padding: "6px 9px", border: "1px solid var(--wb-border)", background: "var(--wb-panel)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ color: "var(--wb-text)", fontWeight: 600 }}>⚙ {task.title}</span>
        <span style={{ color }}>{TASK_STATE[task.state] ?? task.state}</span>
        <span style={{ color: "var(--wb-textFaint)" }}>
          {task.runner === "api" ? "API · " : ""}
          {task.model} · {task.effort} ({task.tier})
          {task.started !== null && ` · ${elapsed(task.started, task.finished)}`}
          {task.runner === "api" && task.costUsd !== null && ` · $${task.costUsd.toFixed(2)}`}
        </span>
      </div>
      {task.why && (
        <div style={{ marginTop: 2, color: "var(--wb-textFaint)" }}>
          {task.runner === "api" ? task.why : `${task.state === "queued" ? "waiting: " : ""}${task.why}`}
        </div>
      )}
      {task.answers.map((a, i) => (
        <div key={i} style={{ marginTop: 2, color: "var(--wb-textFaint)" }} title={a.question}>
          Duck answered: {a.answer}
          {a.reason && `, because ${a.reason.replace(/^because\s+/i, "")}`}
        </div>
      ))}
      {task.headline && (
        <div style={{ marginTop: 3, color: "var(--wb-textDim2)", whiteSpace: "pre-wrap" }}>{task.headline}</div>
      )}
      <div style={{ marginTop: 3, display: "flex", gap: 10 }}>
        {open && (
          <button
            type="button"
            style={linkBtn}
            onClick={() => {
              if (focusSession(task.instanceId!)) setDrawerOpen(false);
            }}
          >
            open console
          </button>
        )}
        {task.state !== "closed" && (
          <button type="button" style={linkBtn} onClick={() => closeTask(task.id)}>
            close
          </button>
        )}
        {task.tier !== "serious" && task.state !== "queued" && (
          <button
            type="button"
            style={linkBtn}
            title="Run it again as a new task, one tier up"
            onClick={() => rerunTask(task.id)}
          >
            re-run {task.tier === "standard" ? "involved" : "serious"}
          </button>
        )}
      </div>
    </div>
  );
}

function UserBubble({
  text,
  source,
  queued,
  pending,
}: {
  text: string;
  source?: string;
  queued?: boolean;
  /** Conversation mode's turn in its grace window: keep talking to add to it. */
  pending?: boolean;
}) {
  const dashed = queued || pending;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        padding: "4px 12px 4px 40px",
      }}
    >
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "var(--wb-sel)",
          border: `1px ${dashed ? "dashed" : "solid"} var(--wb-border)`,
          color: dashed ? "var(--wb-textDim2)" : "var(--wb-text)",
          padding: "5px 9px",
        }}
      >
        {text}
        {(dashed || (source && source !== "desktop")) && (
          <div
            style={{
              marginTop: 3,
              fontSize: 10.5,
              color: "var(--wb-textFaint)",
            }}
          >
            {queued
              ? "queued: sent when Duck finishes"
              : pending
                ? "heard: keep talking to add to it"
                : `from ${SOURCE_LABEL[source ?? ""] ?? source}`}
          </div>
        )}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { "phone-voice": "phone, spoken" };

function Reply({ text }: { text: string }) {
  return (
    <div
      className="wb-md wb-duck-md"
      // Sanitized by DOMPurify in `renderMarkdown`.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}

function ToolChip({
  item,
  active,
}: {
  item: Extract<Item, { kind: "tool" }>;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const r = item.result;
  const mark = r ? (r.isError ? "✕" : "✓") : active ? "◌" : "–";
  const color = r?.isError
    ? "var(--wb-needs)"
    : r
      ? "var(--wb-done)"
      : "var(--wb-textFaint)";
  return (
    <div style={{ margin: "3px 16px" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          ...plainBtn,
          maxWidth: "100%",
          display: "inline-flex",
          gap: 6,
          border: "1px solid var(--wb-border)",
          padding: "1px 7px",
          color: "var(--wb-textDim2)",
        }}
      >
        <span style={{ color }}>{mark}</span>
        <span style={{ color: "var(--wb-accent)" }}>{item.name}</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {oneLine(item.input)}
        </span>
      </button>
      {open && (
        <div style={{ ...pre, marginTop: 4 }}>
          <div style={{ color: "var(--wb-textFaint)" }}>input</div>
          {JSON.stringify(item.input, null, 2)}
          <div style={{ color: "var(--wb-textFaint)", marginTop: 6 }}>
            {r ? (r.isError ? "error" : "output") : "no result"}
          </div>
          {r?.text}
        </div>
      )}
    </div>
  );
}

/** Put a note back as it was before Duck's edit, if nobody changed it since. */
async function undoNoteEdit(e: NoteEdit): Promise<string> {
  if (e.after === null) {
    // Deleted: make it again (a name taken since gets " 2").
    const n = await notesCreateWith(e.projectId, e.name, e.before ?? "");
    return n.id === e.name ? "restored" : `restored as ${n.id}`;
  }
  if (e.before === null) {
    // Made by Duck: delete it, unless it was edited since.
    const now = await notesRead(e.projectId, e.name);
    if (now.revision !== e.revision) throw new Error("stale: changed since");
    await notesDelete(e.projectId, e.name);
    return "removed";
  }
  await notesWrite(e.projectId, e.name, e.before, e.revision);
  return "undone";
}

/** Put the core memory back as it was before Duck's edit (W4), if nobody changed
 *  it since. */
async function undoMemoryEdit(e: MemoryEdit): Promise<string> {
  await coreWrite(coreWorkspace(e.path), e.before ?? EMPTY_CORE, e.after);
  return "undone";
}

/** Put a project's toolbar back as it was before Duck's edit (W5): the plugin file
 *  if nobody changed it since (else nothing), then each script still as Duck wrote
 *  it. */
async function undoPluginsEdit(e: PluginsEdit): Promise<string> {
  if (e.before === null) await pluginsRemove(e.projectId, e.revision);
  else await pluginsWrite(e.projectId, e.before, e.revision);
  const kept: string[] = [];
  for (const s of e.scripts) {
    if ((await pluginsScriptRead(e.projectId, s.name)) !== s.after) kept.push(s.name);
    else await pluginsScriptWrite(e.projectId, s.name, s.before);
  }
  return kept.length ? `undone, but not ${kept.join(", ")} (changed since)` : "undone";
}

/** "Duck edited <note>" (step W2), "Duck edited the build toolbar" (W5): the
 *  change as a diff, and an undo that is refused when the file changed after
 *  Duck's edit. */
function EditChip({
  text,
  project,
  files,
  undo: runUndo,
  staleText,
}: {
  text: string;
  project: string;
  files: DiffFile[];
  undo: () => Promise<string>;
  staleText: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      setStatus(await runUndo());
    } catch (e) {
      setStatus(
        // A refused write (a string from the backend) or our own check.
        String(e).includes("stale:") ? staleText : `undo failed: ${String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ margin: "3px 16px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ color: "var(--wb-accent)" }}>✎ {text}</span>
        <span style={{ color: "var(--wb-textFaint)" }}>{project}</span>
        <button type="button" style={linkBtn} onClick={() => setOpen(!open)}>
          {open ? "hide diff" : "show diff"}
        </button>
        {status ? (
          <span style={{ color: "var(--wb-textFaint)" }}>{status}</span>
        ) : (
          <button
            type="button"
            style={linkBtn}
            disabled={busy}
            onClick={() => void undo()}
          >
            undo
          </button>
        )}
      </div>
      {open && <DiffBlock files={files} style={{ marginTop: 4 }} />}
    </div>
  );
}

interface DiffFile {
  label: string;
  before: string;
  after: string;
}

/** Line diffs of one or more files; a file's name heads its diff when there are
 *  several. */
function DiffBlock({ files, style }: { files: DiffFile[]; style?: React.CSSProperties }) {
  return (
    <div style={{ ...pre, fontFamily: "var(--wb-mono)", ...style }}>
      {files.map((f, i) => {
        const diff = lineDiff(f.before, f.after);
        return (
          <div key={f.label} style={{ marginTop: i ? 8 : 0 }}>
            {files.length > 1 && (
              <div style={{ color: "var(--wb-textFaint)" }}>{f.label}</div>
            )}
            {diff.length === 0 && (
              <span style={{ color: "var(--wb-textFaint)" }}>no change</span>
            )}
            {diff.map((l, k) =>
              l === null ? (
                <div key={k} style={{ color: "var(--wb-textFaint)" }}>
                  ⋯
                </div>
              ) : (
                <div
                  key={k}
                  style={{
                    color:
                      l.op === "+"
                        ? "var(--wb-done)"
                        : l.op === "-"
                          ? "var(--wb-needs)"
                          : undefined,
                  }}
                >
                  {l.op} {l.text}
                </div>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

const reviewFiles = (items: ReviewItem[]): DiffFile[] =>
  items.map((r) => ({ label: r.label, before: r.before ?? "", after: r.after }));

// ── confirmations, spend, composer ──────────────────────────────────────────

function Asks({ duck }: { duck: DuckState }) {
  if (duck.asks.length === 0) return null;
  const here = duck.asks.filter((a) => a.threadId === duck.current);
  const elsewhere = duck.asks.filter((a) => a.threadId !== duck.current);
  return (
    <div
      style={{
        flex: "0 0 auto",
        maxHeight: "45%",
        overflowY: "auto",
        borderTop: "1px solid var(--wb-border)",
      }}
    >
      {here.map((a) => (
        <ConfirmCard key={a.toolUseId} ask={a} />
      ))}
      {elsewhere.length > 0 && (
        <button
          type="button"
          onClick={() => openThread(elsewhere[0].threadId)}
          style={{ ...plainBtn, padding: "6px 12px", color: "var(--wb-needs)" }}
        >
          ● {elsewhere.length} waiting in{" "}
          {duck.threads.find((t) => t.id === elsewhere[0].threadId)?.title ||
            "another thread"}{" "}
          — open
        </button>
      )}
    </div>
  );
}

function ConfirmCard({ ask }: { ask: ConfirmRequest }) {
  const [details, setDetails] = useState(!ask.summary);
  return (
    <div
      style={{
        margin: "8px 12px",
        border: "1px solid var(--wb-needs)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div>
        <span style={{ color: "var(--wb-needs)" }}>● Duck wants to run </span>
        <span style={{ color: "var(--wb-accent)" }}>{ask.name}</span>
      </div>
      {ask.summary && (
        <div style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap" }}>
          {ask.summary}
        </div>
      )}
      {ask.summary && (
        <button
          type="button"
          style={{ ...linkBtn, alignSelf: "flex-start" }}
          onClick={() => setDetails(!details)}
        >
          {details ? "hide details" : "details"}
        </button>
      )}
      {ask.review && (
        <DiffBlock files={reviewFiles(ask.review)} style={{ maxHeight: 260 }} />
      )}
      {details && (
        <div style={{ ...pre, maxHeight: 160 }}>{readableInput(ask.input)}</div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={{
            ...btn,
            borderColor: "var(--wb-done)",
            color: "var(--wb-done)",
          }}
          onClick={() => answer(ask, true)}
        >
          allow
        </button>
        <button type="button" style={btn} onClick={() => answer(ask, false)}>
          deny
        </button>
      </div>
    </div>
  );
}

function SpendLine({ duck }: { duck: DuckState }) {
  const s = duck.spend;
  if (!s) return null;
  const turn = duck.current ? duck.turns[duck.current] : undefined;
  const route = duck.current ? duck.routing[duck.current] : undefined;
  const projected = projectMonth(s.monthUsd);
  const tone = s.capReached
    ? "var(--wb-needs)"
    : s.softReached
      ? "var(--wb-working)"
      : "var(--wb-textFaint)";
  return (
    <div
      title={`today ${usd(s.todayUsd)}`}
      style={{
        flex: "0 0 auto",
        display: "flex",
        gap: 12,
        padding: "3px 12px",
        borderTop: "1px solid var(--wb-border)",
        fontSize: 10.5,
        color: "var(--wb-textFaint)",
      }}
    >
      {turn !== undefined && <span>this turn {usd(turn)}</span>}
      {route?.brain === "haiku" && (
        <span title="past the budget's soft limit: Haiku, unless you ask to think hard" style={{ color: "var(--wb-working)" }}>
          haiku
        </span>
      )}
      {route && route.effort !== "medium" && <span title="the latest turn's effort">effort: {route.effort}</span>}
      <span style={{ marginLeft: "auto", color: tone }}>
        month {usd(s.monthUsd)} / {usd(s.limits.hardCapUsd)}
        {projected !== null && ` · on track for ${usd(projected)}`}
      </span>
    </div>
  );
}

function Composer({
  duck,
  busy,
  inputRef,
}: {
  duck: DuckState;
  busy: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState("");
  const [hard, setHard] = useState(false);
  const voice = useVoiceState();

  // A transcript for review (V1, "send at once" off) lands in the box.
  const dictatedSeq = voice.dictated?.seq;
  useEffect(() => {
    const text = getVoiceState().dictated?.text;
    if (!text) return;
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
    inputRef.current?.focus();
  }, [dictatedSeq, inputRef]);

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft, inputRef]);

  const send = () => {
    const text = draft.trim();
    if (!text || !duck.ready) return;
    sendMessage(text, hard ? "high" : undefined);
    setDraft("");
    setHard(false);
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        borderTop: "1px solid var(--wb-border)",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        placeholder={
          duck.ready
            ? "ask duck…  (Enter sends, Shift+Enter new line)"
            : "Duck is starting…"
        }
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        style={{
          resize: "none",
          background: "var(--wb-bg)",
          border: "1px solid var(--wb-border)",
          color: "var(--wb-text)",
          font: "12px/1.5 var(--wb-mono)",
          padding: "5px 8px",
          outline: "none",
        }}
      />
      <ReaderBar />
      {voice.conversation.on ? (
        <ConversationLine voice={voice} busy={busy} />
      ) : (
        <VoiceLine voice={voice} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <MicButton voice={voice} />
        <button
          type="button"
          aria-pressed={hard}
          title={
            duck.spend?.softReached
              ? "Send the next message on Sonnet at high effort (past the budget's soft limit Duck runs on Haiku)"
              : "Think harder about the next message (higher effort; slower and costs more)"
          }
          onClick={() => setHard(!hard)}
          style={{
            ...btn,
            borderColor: hard ? "var(--wb-accent)" : "var(--wb-border)",
            color: hard ? "var(--wb-accent)" : "var(--wb-textDim2)",
          }}
        >
          {hard ? "◆" : "◇"} think hard{duck.spend?.softReached ? " · sonnet" : ""}
        </button>
        <span style={{ flex: 1 }} />
        {busy && (
          <button
            type="button"
            style={btn}
            title="stop the reply (Esc)"
            onClick={stopTurn}
          >
            ■ stop
          </button>
        )}
        <button
          type="button"
          style={{
            ...btn,
            color: "var(--wb-accent)",
            borderColor: "var(--wb-accent)",
          }}
          disabled={!draft.trim() || !duck.ready}
          onClick={send}
        >
          {busy ? (duck.prefs.interrupt ? "interrupt" : "queue") : "send"}
        </button>
      </div>
    </div>
  );
}

/** Push-to-talk's state over the composer: listening, transcribing, or what went
 *  wrong; then a reply speaking (V2), or why it couldn't be. Nothing while idle. */
function VoiceLine({ voice }: { voice: VoiceState }) {
  const speech = useSpeechState();
  const text =
    voice.phase === "listening"
      ? voice.prefs.toggle
        ? "● listening… (press again to send)"
        : "● listening… (let go to send)"
      : voice.phase === "transcribing"
        ? "transcribing…"
        : (voice.message ??
          (speech.speaking !== null
            ? "speaking… (Esc to stop)"
            : speech.error && `Couldn't speak the reply: ${speech.error}`));
  if (!text) return null;
  const error = voice.phase === "error" || (!voice.message && speech.speaking === null && !!speech.error);
  return (
    <div
      role="status"
      style={{
        font: "11px var(--wb-mono)",
        color: error ? "var(--wb-needs)" : voice.phase === "listening" ? "var(--wb-accent)" : "var(--wb-textDim2)",
      }}
    >
      {text}
    </div>
  );
}

/** Conversation mode's state over the composer (V4): listening (with the mic's
 *  level), hearing you, thinking, speaking; "wait" holding the turn open. */
function ConversationLine({ voice, busy }: { voice: VoiceState; busy: boolean }) {
  const speech = useSpeechState();
  const c = voice.conversation;
  const label = c.window ? "reply" : "conversation";
  const text =
    c.phase === "preparing"
      ? "getting the voice ready…"
      : c.held
        ? "● holding the turn open: say \"go on\" when you're done"
        : c.phase === "hearing"
          ? "● hearing you"
          : c.phase === "grace"
            ? "● sent; keep talking to add to it"
            : c.phase === "deaf"
              ? "speaking (not listening meanwhile, as set; Esc stops it)"
              : speech.speaking !== null
                ? "speaking (talk to interrupt)"
                : busy
                  ? "● thinking (listening)"
                  : "● listening";
  const live = c.phase !== "preparing" && c.phase !== "deaf";
  return (
    <div
      role="status"
      style={{ display: "flex", alignItems: "center", gap: 8, font: "11px var(--wb-mono)", color: live ? "var(--wb-accent)" : "var(--wb-textDim2)" }}
    >
      <span style={{ color: "var(--wb-textFaint)" }}>{label}:</span>
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      {live && <LevelMeter />}
    </div>
  );
}

/** The microphone's level, redrawn each frame (too fast for React state). */
function LevelMeter() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      if (bar.current) bar.current.style.width = `${Math.round(getConversationLevel() * 100)}%`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      aria-hidden
      style={{ width: 48, height: 5, border: "1px solid var(--wb-border)", position: "relative", overflow: "hidden" }}
    >
      <div ref={bar} style={{ position: "absolute", inset: 0, right: "auto", width: 0, background: "var(--wb-accent)", transition: "width 90ms linear" }} />
    </div>
  );
}

/** What's being read aloud (V3): its title, where it is, and its buttons. */
function ReaderBar() {
  const r = useDuckState().reader;
  if (!r) return null;
  const small: React.CSSProperties = { ...btn, padding: "1px 7px" };
  return (
    <div
      role="status"
      style={{ display: "flex", alignItems: "center", gap: 6, font: "11px var(--wb-mono)", color: "var(--wb-textDim2)" }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {r.state === "reading" ? "♪ reading" : "❚❚ paused"} {r.title} · {r.section + 1}/{r.sections}
        {r.where === "phone" ? " · on the phone" : ""}
      </span>
      <button type="button" title="Previous section" style={small} disabled={r.section === 0} onClick={() => controlReader("prev")}>
        ⏮
      </button>
      <button
        type="button"
        title={r.state === "reading" ? "Pause (Esc)" : "Go on"}
        style={small}
        onClick={() => controlReader(r.state === "reading" ? "pause" : "resume")}
      >
        {r.state === "reading" ? "❚❚" : "▶"}
      </button>
      <button
        type="button"
        title="Next section"
        style={small}
        disabled={r.section + 1 >= r.sections}
        onClick={() => controlReader("next")}
      >
        ⏭
      </button>
      <button type="button" title="Stop reading (the place is kept)" style={small} onClick={() => controlReader("stop")}>
        ■
      </button>
    </div>
  );
}

/** Talk, as the push-to-talk key does: conversation mode on and off (V4, the
 *  default); or for dictation, click to start and again to send, or hold. */
function MicButton({ voice }: { voice: VoiceState }) {
  const held = useRef(false);
  if (voice.prefs.press === "conversation") {
    const on = voice.conversation.on && !voice.conversation.window;
    const key = voice.prefs.hotkey;
    return (
      <button
        type="button"
        aria-pressed={on}
        title={`${on ? "Stop conversation mode" : "Conversation mode: just talk; Duck answers and listens again"}${key ? ` (or press ${key} anywhere)` : ""}`}
        onClick={toggleConversation}
        style={{
          ...btn,
          borderColor: on ? "var(--wb-accent)" : "var(--wb-border)",
          color: on ? "var(--wb-accent)" : "var(--wb-textDim2)",
        }}
      >
        {on ? "◉ talking" : "🎙 talk"}
      </button>
    );
  }
  const up = () => {
    if (!held.current) return;
    held.current = false;
    void voicePtt(false);
  };
  const key = voice.prefs.hotkey;
  const toggle = voice.prefs.toggle;
  const listening = voice.phase === "listening";
  const hold = toggle
    ? {}
    : {
        onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          held.current = true;
          void voicePtt(true);
        },
        onPointerUp: up,
        onPointerCancel: up,
        onLostPointerCapture: up,
      };
  return (
    <button
      type="button"
      aria-pressed={toggle ? listening : undefined}
      title={
        toggle
          ? `${listening ? "Click to send" : "Click to talk, again to send"}${key ? ` (or press ${key} anywhere)` : ""}`
          : `Hold to talk${key ? ` (or hold ${key} anywhere)` : ""}`
      }
      onClick={toggle ? () => void voiceToggle() : undefined}
      {...hold}
      style={{
        ...btn,
        borderColor: voice.phase === "listening" ? "var(--wb-accent)" : "var(--wb-border)",
        color: voice.phase === "listening" ? "var(--wb-accent)" : "var(--wb-textDim2)",
      }}
    >
      🎙 talk
    </button>
  );
}

const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
  padding: "2px 8px",
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  font: "inherit",
  fontSize: 11,
  color: "var(--wb-textDim2)",
  textDecoration: "underline",
  cursor: "pointer",
};

const plainBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wb-text)",
  font: "inherit",
  padding: 0,
  cursor: "pointer",
};

const popover: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 2px)",
  zIndex: 10,
  background: "var(--wb-panel)",
  border: "1px solid var(--wb-border)",
  boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
  padding: "6px 0",
};

const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "var(--wb-bg)",
  border: "1px solid var(--wb-border)",
  padding: "6px 8px",
  fontSize: 11,
  color: "var(--wb-textDim2)",
  overflowY: "auto",
  maxHeight: 240,
};

const banner: React.CSSProperties = {
  flex: "0 0 auto",
  padding: "6px 12px",
  borderBottom: "1px solid var(--wb-border)",
};
