// Duck's drawer (step A3): a left-side drawer under the Duck button, over the dock,
// for talking to Duck from anywhere in the app. Not a dock panel: Duck is global,
// not per project. Toggled by the button, `toggleAssistant` and Esc.
//
// It stays mounted while closed (only hidden), so reopening it finds the same thread
// at the same scroll position; the open thread and the width persist in prefs. It
// speaks only the Duck Protocol, through `duckState`. The header's trust pill is
// the kill switch (T1); the trust and decisions views take the thread's place.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { registerCommand, useBindings } from "../../keyboard";
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
import type {
  ConfirmRequest,
  NoteEdit,
  PluginsEdit,
  ReviewItem,
  TurnState,
} from "../../assistant/protocol";
import DuckAvatar from "./DuckAvatar";
import type { DuckMode } from "./duck3d";
import DuckIcon from "./DuckIcon";
import DrawerSettings from "./DrawerSettings";
import { DecisionsPanel, TrustPanel } from "./TrustViews";
import type { ThreadRow } from "../../ipc/assistant";
import {
  answer,
  clearError,
  closeTask,
  connectDuck,
  deleteThread,
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
  useEffect(() => registerCommand("toggleAssistant", toggleDrawer), []);
  useEffect(() => registerCommand("toggleTrust", toggleTrust), []);

  // Opening: remember where the keyboard was, check the key, focus the composer.
  // Closing: hand the keyboard back.
  useEffect(() => {
    if (duck.open) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement ? active : null;
      requestAnimationFrame(() => composerRef.current?.focus());
      void getKeyStatus()
        .then((k) => setNoKey(!k.present))
        .catch(() => {});
    } else if (returnFocus.current) {
      const el = returnFocus.current;
      returnFocus.current = null;
      if (el.isConnected && !el.closest("[data-wb-duck]")) el.focus();
      else focusActivePanel();
    }
  }, [duck.open]);

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
        if (busy) stopTurn();
        else setDrawerOpen(false);
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
      }}
    >
      <Header
        duck={duck}
        title={thread ? thread.title || "untitled" : "new thread"}
        onView={setView}
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
      {view === "thread" && duck.prefs.avatar.show && (
        <div
          style={{
            flex: "0 0 auto",
            height: "clamp(120px, 32%, 320px)",
            borderBottom: "1px solid var(--wb-border)",
          }}
        >
          <DuckAvatar
            mode={AVATAR_MODE[current ? (duck.states[current] ?? "idle") : "idle"]}
            prefs={duck.prefs.avatar}
            running={duck.open}
          />
        </div>
      )}
      {view === "thread" && <ThreadBody duck={duck} />}
      {view === "trust" && <TrustPanel duck={duck} onBack={() => setView("thread")} />}
      {view === "decisions" && (
        <DecisionsPanel duck={duck} onBack={() => setView("thread")} />
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

type View = "thread" | "trust" | "decisions";

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
}: {
  duck: DuckState;
  title: string;
  onView: (v: View) => void;
}) {
  const [menu, setMenu] = useState<"threads" | "settings" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
        title="start a new thread"
        onClick={() => {
          openThread(null);
          onView("thread");
          setMenu(null);
        }}
      >
        + new
      </button>
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
                openThread(t.id);
                onView("thread");
                setMenu(null);
              }}
            />
          ))}
        </div>
      )}
      {menu === "settings" && (
        <div style={{ ...popover, right: 8, width: 300 }}>
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
  const title = t.title || "untitled";
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
  }, [items.length, streaming, queued.length, state]);

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
    case "task":
      return <TaskCard taskId={item.taskId} text={item.text} />;
    case "notice":
      return (
        <div
          style={{
            margin: "4px 16px",
            color:
              item.notice.kind === "stopped" || item.notice.kind === "keys"
                ? "var(--wb-textFaint)"
                : "var(--wb-needs)",
          }}
        >
          {item.notice.kind === "keys" ? "⌨" : "!"} {item.notice.text}
        </div>
      );
  }
}

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
          {task.model} · {task.effort}
          {task.started !== null && ` · ${elapsed(task.started, task.finished)}`}
        </span>
      </div>
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
      </div>
    </div>
  );
}

function UserBubble({
  text,
  source,
  queued,
}: {
  text: string;
  source?: string;
  queued?: boolean;
}) {
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
          border: `1px ${queued ? "dashed" : "solid"} var(--wb-border)`,
          color: queued ? "var(--wb-textDim2)" : "var(--wb-text)",
          padding: "5px 9px",
        }}
      >
        {text}
        {(queued || (source && source !== "desktop")) && (
          <div
            style={{
              marginTop: 3,
              fontSize: 10.5,
              color: "var(--wb-textFaint)",
            }}
          >
            {queued ? "queued: sent when Duck finishes" : `from ${source}`}
          </div>
        )}
      </div>
    </div>
  );
}

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
      <span style={{ marginLeft: "auto", color: tone }}>
        month {usd(s.monthUsd)} / {usd(s.limits.hardCapUsd)}
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          aria-pressed={hard}
          title="Think harder about the next message (higher effort; slower and costs more)"
          onClick={() => setHard(!hard)}
          style={{
            ...btn,
            borderColor: hard ? "var(--wb-accent)" : "var(--wb-border)",
            color: hard ? "var(--wb-accent)" : "var(--wb-textDim2)",
          }}
        >
          {hard ? "◆" : "◇"} think hard
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
