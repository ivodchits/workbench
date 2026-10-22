// The desktop's view of Duck (step A3): one subscription to the Duck Protocol,
// shared by the title-bar button and the drawer, so the button's status light and
// the drawer's thread agree and nothing is missed while the drawer is closed.
// An external store in the house pattern (snapshots replaced, never mutated).
//
// Unread (2026-10-20): a reply that lands in a thread you aren't looking at (the
// drawer closed, another thread open, the window hidden) counts as unread there,
// with its first line as the thread's news. Opening the thread clears it. When such
// a thread finishes its turn and you're not watching the drawer, a desktop toast
// names the thread. Both persist with the drawer's prefs.
//
// Like every surface it only speaks the protocol: `sync` on connect, `thread.open`
// for a thread's history, then live events. The open thread, the drawer's width
// and the queue-or-interrupt choice persist in prefs.
//
// Moving the conversation (step A7): a `goThread` for the desktop opens that
// thread, so conversation mode's next turn goes there. The words Duck brings over
// come next, as your message there, and their reply is spoken as yours would be.

import { useSyncExternalStore } from "react";
import { getDuck, initAssistant } from "../../assistant";
import { notifyAlert } from "../../ipc/attention";
import { getNotificationConfig } from "../../state/notifications";
import type {
  AutopilotView,
  ClientMessage,
  ConfirmRequest,
  DuckEvent,
  Effort,
  ReaderAction,
  Source,
  TaskView,
  TrustView,
  TurnState,
} from "../../assistant/protocol";
import type { ReaderView } from "../../assistant/reader";
import type { DuckSettings } from "../../assistant/settings";
import type { Mode } from "../../assistant/trust/decide";
import type { ReplayReport } from "../../assistant/trust/replay";
import type { Effect } from "../../assistant/trust/rules";
import type { DecisionRow, Spend, StoredMessage, ThreadRow } from "../../ipc/assistant";
import type { Route } from "../../assistant/routing";
import { getPref, setPref, type AssistantDrawerPrefs } from "../../ipc/prefs";
import { onReplyDelta, onToolStart, onTurnEnded, onUserMessage, stopSpeaking } from "./replySpeech";

export interface DuckState {
  /** Connected to the engine. */
  ready: boolean;
  open: boolean;
  threads: ThreadRow[];
  /** The thread on screen; `null` = a new thread, created by the first send. */
  current: string | null;
  /** Messages of the threads opened so far. */
  messages: Record<string, StoredMessage[]>;
  /** Reply text streaming in, per thread. */
  streaming: Record<string, string>;
  /** A provisional turn's words (step V4), not kept until it stands. */
  provisional: Record<string, string>;
  states: Record<string, TurnState>;
  /** Messages sent from here that wait behind a running turn, per thread. */
  queued: Record<string, string[]>;
  asks: ConfirmRequest[];
  spend: Spend | null;
  /** Each thread's latest turn cost, USD. */
  turns: Record<string, number>;
  /** The model and effort of each thread's latest turn (step M2). */
  routing: Record<string, Route>;
  error: string | null;
  prefs: AssistantDrawerPrefs;
  /** Duck's own settings (step W2), as the engine has them; null until synced. */
  settings: DuckSettings | null;
  /** The trust engine's state (step T1); null until synced, or if it didn't load. */
  trust: TrustView | null;
  /** The decision log pages loaded so far, newest first, and whether more exist. */
  decisions: DecisionRow[];
  decisionsMore: boolean;
  /** The trust replay (step T2): running (judged `done` of `of`), or its report. */
  replay: { running: boolean; done: number; of: number; report: ReplayReport | null } | null;
  /** Duck's worker tasks (step D1), newest first. */
  tasks: TaskView[];
  /** The autopilots not stopped (step P1). */
  autopilots: AutopilotView[];
  /** What's being read aloud (step V3), or null. */
  reader: ReaderView | null;
  /** Replies not seen yet, per thread. */
  unread: Record<string, number>;
  /** Each thread's latest reply, its first line. */
  news: Record<string, string>;
}

export const DEFAULT_DRAWER: AssistantDrawerPrefs = {
  width: 440,
  threadId: null,
  interrupt: false,
  avatar: { show: true, ink: "color", chars: "classic", cols: 72, fps: 20 },
};

let state: DuckState = {
  ready: false,
  open: false,
  threads: [],
  current: null,
  messages: {},
  streaming: {},
  provisional: {},
  states: {},
  queued: {},
  asks: [],
  spend: null,
  turns: {},
  routing: {},
  error: null,
  prefs: DEFAULT_DRAWER,
  settings: null,
  trust: null,
  decisions: [],
  decisionsMore: false,
  replay: null,
  tasks: [],
  autopilots: [],
  reader: null,
  unread: {},
  news: {},
};
const listeners = new Set<() => void>();
/** A send with no thread is waiting for the engine to name the new one. */
let adopting = false;
/** Threads whose provisional turn's reply is already being spoken. */
const spokenEarly = new Set<string>();
/** The thread Duck just moved the conversation into (A7). */
let movedInto: string | null = null;

function set(patch: Partial<DuckState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const subscribeDuck = subscribe;
export const getDuckState = (): DuckState => state;

export function useDuckState(): DuckState {
  return useSyncExternalStore(subscribe, getDuckState);
}

function post(msg: ClientMessage): void {
  getDuck()?.send(msg);
}

function savePrefs(patch: Partial<AssistantDrawerPrefs>): void {
  const prefs = { ...state.prefs, ...patch };
  set({ prefs });
  void setPref("assistantDrawer", prefs);
}

/** You can see this thread: the drawer is open on it, in a visible window. */
function onScreen(threadId: string): boolean {
  return state.open && state.current === threadId && document.visibilityState === "visible";
}

/** Every thread read: the unread counts (the overview's button, and the Duck
 *  button's dot) go. The news lines stay, no longer bold. */
export function clearUnread(): void {
  set({ unread: {} });
  savePrefs({ unread: {} });
}

/** The thread is on screen now: nothing in it is unread. */
function seen(threadId: string | null): void {
  if (!threadId || !state.unread[threadId] || !onScreen(threadId)) return;
  const unread = { ...state.unread };
  delete unread[threadId];
  set({ unread });
  savePrefs({ unread });
}

/** A reply's first line with text, for the news. */
function firstLine(m: StoredMessage): string {
  const line = userText(m)
    .split("\n")
    .map((l) => l.replace(/^[#>*\s-]+/, "").trim())
    .find(Boolean);
  return line ? (line.length > 160 ? `${line.slice(0, 159)}…` : line) : "";
}

/** Threads whose turn put news there while you weren't looking: toast at its end. */
const toastAtEnd = new Set<string>();

function noteReply(m: StoredMessage): void {
  const line = firstLine(m);
  if (!line) return;
  const news = { ...state.news, [m.threadId]: line };
  if (onScreen(m.threadId)) {
    set({ news });
    savePrefs({ news });
    return;
  }
  // One per turn: a turn's replies between tool calls are one piece of news.
  const first = !toastAtEnd.has(m.threadId);
  const unread = first ? { ...state.unread, [m.threadId]: (state.unread[m.threadId] ?? 0) + 1 } : state.unread;
  set({ news, unread });
  savePrefs({ news, unread });
  toastAtEnd.add(m.threadId);
}

function toastIfAway(threadId: string): void {
  if (!toastAtEnd.delete(threadId) || onScreen(threadId)) return;
  // Watching the drawer on another thread: its line under the header says it.
  if (state.open && document.hasFocus()) return;
  if (!getNotificationConfig().desktop) return;
  const title = state.threads.find((t) => t.id === threadId)?.title || "a thread";
  void notifyAlert(`Duck · ${title}`, state.news[threadId] ?? "news").catch(() => {});
}

function onEvent(e: DuckEvent): void {
  switch (e.type) {
    case "threads": {
      set({ threads: e.threads });
      // First connect: reopen the thread from last time, else the latest.
      if (!state.ready) {
        set({ ready: true });
        const saved = e.threads.find((t) => t.id === state.prefs.threadId);
        openThread((saved ?? e.threads[0])?.id ?? null);
      }
      break;
    }
    case "thread": {
      const known = state.threads.some((t) => t.id === e.thread.id);
      const threads = [
        e.thread,
        ...state.threads.filter((t) => t.id !== e.thread.id),
      ];
      set({ threads: threads.sort((a, b) => b.updated - a.updated) });
      if (!known && adopting && state.current === null) {
        adopting = false;
        set({ messages: { ...state.messages, [e.thread.id]: [] } });
        openThread(e.thread.id);
      }
      break;
    }
    case "threadDeleted": {
      const id = e.threadId;
      const drop = <T>(r: Record<string, T>) => {
        const rest = { ...r };
        delete rest[id];
        return rest;
      };
      const threads = state.threads.filter((t) => t.id !== id);
      set({
        threads,
        messages: drop(state.messages),
        unread: drop(state.unread),
        news: drop(state.news),
        streaming: drop(state.streaming),
        states: drop(state.states),
        queued: drop(state.queued),
        turns: drop(state.turns),
        asks: state.asks.filter((a) => a.threadId !== id),
      });
      savePrefs({ unread: state.unread, news: state.news });
      // The open thread went: show the next most recent, or a new one.
      if (state.current === id) openThread(threads[0]?.id ?? null);
      break;
    }
    case "history":
      set({
        messages: { ...state.messages, [e.threadId]: e.messages },
        states: { ...state.states, [e.threadId]: e.state },
      });
      break;
    case "provisional":
      set({ provisional: { ...state.provisional, [e.threadId]: e.text } });
      // Its reply is spoken from the start, not from when the turn stands.
      if (e.threadId === state.current) {
        spokenEarly.add(e.threadId);
        onUserMessage(
          { threadId: e.threadId, seq: -1, ts: Date.now(), role: "user", content: [{ type: "text", text: e.text }], source: e.source },
          e.text,
        );
      }
      break;
    case "withdrawn":
      set({
        provisional: { ...state.provisional, [e.threadId]: "" },
        streaming: { ...state.streaming, [e.threadId]: "" },
      });
      if (spokenEarly.delete(e.threadId)) stopSpeaking();
      break;
    case "goThread":
      if (e.surface !== "desktop" || !state.threads.some((t) => t.id === e.threadId)) break;
      movedInto = e.threadId;
      if (document.visibilityState === "visible") set({ open: true });
      openThread(e.threadId);
      break;
    case "message": {
      const m = e.message;
      const have = state.messages[m.threadId];
      const patch: Partial<DuckState> = {};
      // A provisional turn stood: its message is the one kept now.
      const early = m.role === "user" && spokenEarly.delete(m.threadId);
      if (m.role === "user" && state.provisional[m.threadId])
        patch.provisional = { ...state.provisional, [m.threadId]: "" };
      if (have && !have.some((x) => x.seq === m.seq))
        patch.messages = { ...state.messages, [m.threadId]: [...have, m] };
      if (m.role === "assistant") {
        patch.streaming = { ...state.streaming, [m.threadId]: "" };
        noteReply(m);
      }
      // Spoken replies (V2): a message of yours decides whether its reply is spoken.
      // Only the open thread: a thread Duck splits off carries your source too.
      if (m.role === "user" && m.threadId === state.current && !early) {
        onUserMessage(m, userText(m), movedInto === m.threadId);
        movedInto = null;
      }
      // A queued message of ours has started its turn.
      const waiting = state.queued[m.threadId];
      if (m.role === "user" && waiting?.length) {
        const text = userText(m);
        const i = waiting.indexOf(text);
        if (i >= 0)
          patch.queued = {
            ...state.queued,
            [m.threadId]: waiting.filter((_, j) => j !== i),
          };
      }
      // Bump the thread to the top of the list.
      const t = state.threads.find((x) => x.id === m.threadId);
      if (t && t.updated < m.ts)
        patch.threads = [
          { ...t, updated: m.ts },
          ...state.threads.filter((x) => x.id !== m.threadId),
        ];
      set(patch);
      break;
    }
    case "delta":
      onReplyDelta(e.threadId, e.text);
      set({
        streaming: {
          ...state.streaming,
          [e.threadId]: (state.streaming[e.threadId] ?? "") + e.text,
        },
      });
      break;
    case "turnState": {
      const patch: Partial<DuckState> = {
        states: { ...state.states, [e.threadId]: e.state },
      };
      if (e.state === "idle") {
        patch.streaming = { ...state.streaming, [e.threadId]: "" };
        // Nothing waits behind an idle thread (a stop clears the queue).
        patch.queued = { ...state.queued, [e.threadId]: [] };
      }
      set(patch);
      if (e.state === "idle" || e.state === "waiting") onTurnEnded(e.threadId);
      if (e.state === "idle") toastIfAway(e.threadId);
      break;
    }
    case "tool":
      // What Duck wrote before the call ("Checking api.") is said now, not after it.
      if (e.phase === "start") onToolStart(e.threadId);
      break;
    case "confirm":
      set({
        asks: [
          ...state.asks.filter((a) => a.toolUseId !== e.request.toolUseId),
          e.request,
        ],
      });
      break;
    case "confirmed":
      set({ asks: state.asks.filter((a) => a.toolUseId !== e.toolUseId) });
      break;
    case "spend":
      set({ spend: e.spend, turns: e.turns });
      break;
    case "routing":
      set({ routing: { ...state.routing, [e.threadId]: { brain: e.brain, effort: e.effort, backend: e.backend } } });
      break;
    case "settings":
      set({ settings: e.settings });
      break;
    case "trust":
      set({ trust: e.trust });
      break;
    case "decisions": {
      // A first page replaces the list; an older page goes after it.
      const kept = e.before === null ? [] : state.decisions.filter((d) => d.id >= e.before!);
      set({ decisions: [...kept, ...e.rows], decisionsMore: e.more });
      break;
    }
    case "decision":
      set({ decisions: [e.row, ...state.decisions.filter((d) => d.id !== e.row.id)] });
      break;
    case "tasks":
      set({ tasks: e.tasks });
      break;
    case "reader":
      set({ reader: e.reader });
      break;
    case "autopilots":
      set({ autopilots: e.autopilots });
      break;
    case "replay":
      set({ replay: { running: !e.report, done: e.done, of: e.of, report: e.report } });
      break;
    case "error":
      // A failed replay is over; its error shows like any other.
      set({ error: e.message, replay: state.replay?.running ? { ...state.replay, running: false } : state.replay });
      break;
  }
}

function userText(m: StoredMessage): string {
  return Array.isArray(m.content)
    ? (m.content as { type: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    : String(m.content);
}

let connecting: Promise<void> | null = null;

/** Connect to Duck once (the engine starts with the app; this waits for it). */
export function connectDuck(): Promise<void> {
  connecting ??= (async () => {
    const prefs = await getPref("assistantDrawer", DEFAULT_DRAWER).catch(
      () => DEFAULT_DRAWER,
    );
    set({ prefs: { ...DEFAULT_DRAWER, ...prefs }, unread: prefs.unread ?? {}, news: prefs.news ?? {} });
    // Back in view (the window shown again): the open thread is read.
    document.addEventListener("visibilitychange", () => seen(state.current));
    await initAssistant();
    const duck = getDuck();
    if (!duck) {
      connecting = null;
      return;
    }
    duck.subscribe(onEvent);
    duck.send({ type: "sync" });
  })();
  return connecting;
}

// ── actions ─────────────────────────────────────────────────────────────────

export function setDrawerOpen(open: boolean): void {
  set({ open });
  seen(state.current);
}

export function toggleDrawer(): void {
  setDrawerOpen(!state.open);
}

/** Show a thread (loading its history the first time), or `null` for a new one. */
export function openThread(threadId: string | null): void {
  adopting = false;
  set({ current: threadId, error: null });
  if (threadId) {
    if (!state.messages[threadId]) post({ type: "thread.open", threadId });
    savePrefs({ threadId });
    seen(threadId);
  }
}

/** True while a reply is being made (not parked on a confirmation). */
export const isRunning = (threadId: string): boolean => {
  const s = state.states[threadId] ?? "idle";
  return s !== "idle" && s !== "waiting";
};

/** True while the thread has a turn running or parked. */
export const isBusy = (threadId: string | null): boolean =>
  !!threadId && (state.states[threadId] ?? "idle") !== "idle";

export function sendMessage(text: string, effort?: Effort, source: Source = "desktop"): void {
  const threadId = state.current;
  set({ error: null });
  if (threadId && isBusy(threadId)) {
    // Interrupt: stop the running turn (which clears its queue), then this message
    // is the next turn. Queue: it waits its turn, shown as pending.
    if (state.prefs.interrupt) post({ type: "stop", threadId });
    set({
      queued: {
        ...state.queued,
        [threadId]: [
          ...(state.prefs.interrupt ? [] : (state.queued[threadId] ?? [])),
          text,
        ],
      },
    });
  }
  if (!threadId) adopting = true;
  post({ type: "send", threadId, text, source, effort });
}

/** Conversation mode (step V4): a turn that starts now and may be withdrawn.
 *  False when it can't be (no thread yet, or one busy): then send it once it
 *  stands. */
export function sendProvisional(threadId: string | null, text: string): boolean {
  if (!threadId || isBusy(threadId)) return false;
  set({ error: null });
  post({ type: "send", threadId, text, source: "voice", provisional: true });
  return true;
}

export function commitTurn(threadId: string): void {
  post({ type: "turn.commit", threadId });
}

export function withdrawTurn(threadId: string): void {
  post({ type: "turn.withdraw", threadId });
}

/** Send to a thread other than the open one (a reply to an announcement). */
export function sendTo(threadId: string, text: string, source: Source): void {
  if (threadId === state.current) return sendMessage(text, undefined, source);
  post({ type: "send", threadId, text, source });
}

/** Compact a thread (step A6): now, or once the reply running there is over. */
export function compactThread(threadId: string): void {
  post({ type: "thread.compact", threadId });
}

/** Don't remember a thread (step L1), or do again. */
export function setThreadMemory(threadId: string, off: boolean): void {
  post({ type: "thread.memory", threadId, off });
}

/** Delete a thread (step A4); the engine refuses while a reply runs. */
export function deleteThread(threadId: string): void {
  post({ type: "thread.delete", threadId });
}

export function clearError(): void {
  set({ error: null });
}

export function stopTurn(): void {
  if (state.current) post({ type: "stop", threadId: state.current });
}

export function answer(a: ConfirmRequest, allow: boolean): void {
  post({
    type: "confirm",
    threadId: a.threadId,
    toolUseId: a.toolUseId,
    allow,
  });
}

export function setDrawerWidth(width: number): void {
  savePrefs({ width });
}

export function setInterrupt(interrupt: boolean): void {
  savePrefs({ interrupt });
}

export function setAvatar(patch: Partial<AssistantDrawerPrefs["avatar"]>): void {
  savePrefs({ avatar: { ...state.prefs.avatar, ...patch } });
}

/** Change Duck's settings; the engine answers with the settings now in force. */
export function setDuckSettings(settings: Partial<DuckSettings>): void {
  post({ type: "settings.set", settings });
}

/** Duck's Do Not Disturb (V5): until a moment, or off. */
export function setDnd(until: number | null): void {
  post({ type: "dnd", until });
}

// ── trust (step T1) ─────────────────────────────────────────────────────────

/** The kill switch: pause trust (every consequential call asks), or resume it. */
export function setTrustPaused(paused: boolean): void {
  post({ type: "trust.pause", paused });
}

export function toggleTrust(): void {
  if (state.trust) setTrustPaused(!state.trust.paused);
}

export function addTrustRule(effect: Effect, pattern: string, projectId: string | null): void {
  set({ error: null });
  post({ type: "trust.rule.add", effect, pattern, projectId });
}

export function removeTrustRule(id: string): void {
  post({ type: "trust.rule.remove", id });
}

export function setTrustMode(projectId: string, mode: Mode): void {
  post({ type: "trust.mode", projectId, mode });
}

export function setFloorEntry(id: string, enabled: boolean): void {
  post({ type: "trust.floor", id, enabled });
}

/** Replay the past `days` of Claude Code tool calls through the prompt policy,
 *  the judge reading up to `judgeMax` of them. */
export function runReplay(days: number, judgeMax: number): void {
  set({ replay: { running: true, done: 0, of: 0, report: null } });
  post({ type: "trust.replay", days, judgeMax });
}

/** The newest page of the decision log (`null`), or the page before an id. */
export function loadDecisions(before: number | null): void {
  post({ type: "trust.decisions", before });
}

/** Close a worker task (D1): its console closes, its files stay. */
export function closeTask(taskId: string): void {
  post({ type: "task.close", taskId });
}

/** Run a worker task again one tier up, as a new task (D2). */
export function rerunTask(taskId: string): void {
  post({ type: "task.rerun", taskId });
}

/** The reader bar's buttons (V3). */
export function controlReader(action: ReaderAction): void {
  post({ type: "reader", action });
}

/** A session autopilot's buttons on its card (P1). */
export function controlAutopilot(instanceId: string, action: "pause" | "resume" | "stop"): void {
  post({ type: "autopilot", instanceId, action });
}

/** Open the drawer on a thread: an autopilot's step log. */
export function showDuckThread(threadId: string): void {
  set({ open: true });
  openThread(threadId);
}

/** Ask Duck, in a new thread, to put a session on autopilot (the card's button):
 *  it finds the plan and confirms it with you before starting. */
export function askForAutopilot(instanceId: string, title: string): void {
  set({ open: true });
  openThread(null);
  sendMessage(`Put my session "${title}" (id ${instanceId}) on autopilot through its plan.`);
}
