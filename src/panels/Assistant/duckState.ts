// The desktop's view of Duck (step A3): one subscription to the Duck Protocol,
// shared by the title-bar button and the drawer, so the button's status light and
// the drawer's thread agree and nothing is missed while the drawer is closed.
// An external store in the house pattern (snapshots replaced, never mutated).
//
// Like every surface it only speaks the protocol: `sync` on connect, `thread.open`
// for a thread's history, then live events. The open thread, the drawer's width
// and the queue-or-interrupt choice persist in prefs.

import { useSyncExternalStore } from "react";
import { getDuck, initAssistant } from "../../assistant";
import type {
  ClientMessage,
  ConfirmRequest,
  DuckEvent,
  Effort,
  TurnState,
} from "../../assistant/protocol";
import type { DuckSettings } from "../../assistant/settings";
import type { Spend, StoredMessage, ThreadRow } from "../../ipc/assistant";
import { getPref, setPref, type AssistantDrawerPrefs } from "../../ipc/prefs";

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
  states: Record<string, TurnState>;
  /** Messages sent from here that wait behind a running turn, per thread. */
  queued: Record<string, string[]>;
  asks: ConfirmRequest[];
  spend: Spend | null;
  /** Each thread's latest turn cost, USD. */
  turns: Record<string, number>;
  error: string | null;
  prefs: AssistantDrawerPrefs;
  /** Duck's own settings (step W2), as the engine has them; null until synced. */
  settings: DuckSettings | null;
}

export const DEFAULT_DRAWER: AssistantDrawerPrefs = {
  width: 440,
  threadId: null,
  interrupt: false,
};

let state: DuckState = {
  ready: false,
  open: false,
  threads: [],
  current: null,
  messages: {},
  streaming: {},
  states: {},
  queued: {},
  asks: [],
  spend: null,
  turns: {},
  error: null,
  prefs: DEFAULT_DRAWER,
  settings: null,
};
const listeners = new Set<() => void>();
/** A send with no thread is waiting for the engine to name the new one. */
let adopting = false;

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
        streaming: drop(state.streaming),
        states: drop(state.states),
        queued: drop(state.queued),
        turns: drop(state.turns),
        asks: state.asks.filter((a) => a.threadId !== id),
      });
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
    case "message": {
      const m = e.message;
      const have = state.messages[m.threadId];
      const patch: Partial<DuckState> = {};
      if (have && !have.some((x) => x.seq === m.seq))
        patch.messages = { ...state.messages, [m.threadId]: [...have, m] };
      if (m.role === "assistant")
        patch.streaming = { ...state.streaming, [m.threadId]: "" };
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
      break;
    }
    case "tool":
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
    case "settings":
      set({ settings: e.settings });
      break;
    case "error":
      set({ error: e.message });
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
    set({ prefs: { ...DEFAULT_DRAWER, ...prefs } });
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
}

export function toggleDrawer(): void {
  set({ open: !state.open });
}

/** Show a thread (loading its history the first time), or `null` for a new one. */
export function openThread(threadId: string | null): void {
  adopting = false;
  set({ current: threadId, error: null });
  if (threadId) {
    if (!state.messages[threadId]) post({ type: "thread.open", threadId });
    savePrefs({ threadId });
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

export function sendMessage(text: string, effort?: Effort): void {
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
  post({ type: "send", threadId, text, source: "desktop", effort });
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

/** Change Duck's settings; the engine answers with the settings now in force. */
export function setDuckSettings(settings: Partial<DuckSettings>): void {
  post({ type: "settings.set", settings });
}
