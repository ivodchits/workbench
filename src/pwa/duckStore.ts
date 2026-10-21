// What the phone's Duck view knows (step R2): Duck's frames from `/api/assistant`
// folded into one state, as the drawer's `duckState.ts` does on the desktop.
// Pure: no DOM, no socket, so it's tested on its own (`duckStore.test.ts`).

import type { ConfirmRequest, DecisionRow, TaskView, TrustView, TurnState } from "../assistant/protocol";
import type { ReaderView } from "../assistant/reader";
import type { Spend, StoredMessage, ThreadRow } from "../ipc/assistant";
import type { RemoteDuckFrame } from "../remote/protocol";

export interface DuckView {
  /** The thread list came: the view can pick a thread. */
  synced: boolean;
  threads: ThreadRow[];
  /** The thread on screen; null = a new one, made by the first send. */
  current: string | null;
  messages: Record<string, StoredMessage[]>;
  /** Reply text streaming in, per thread. */
  streaming: Record<string, string>;
  states: Record<string, TurnState>;
  asks: ConfirmRequest[];
  spend: Spend | null;
  turns: Record<string, number>;
  trust: TrustView | null;
  decisions: DecisionRow[];
  decisionsMore: boolean;
  tasks: TaskView[];
  /** What's being read aloud (step V3), here or on the desktop. */
  reader: ReaderView | null;
  /** Duck's Do Not Disturb (V5), from its settings: until when, or null. */
  dndUntil: number | null;
  error: string | null;
}

export const emptyView = (): DuckView => ({
  synced: false,
  threads: [],
  current: null,
  messages: {},
  streaming: {},
  states: {},
  asks: [],
  spend: null,
  turns: {},
  trust: null,
  decisions: [],
  decisionsMore: false,
  tasks: [],
  reader: null,
  dndUntil: null,
  error: null,
});

/** What a frame asks of the view besides the new state. */
export interface Effects {
  /** The view's thread changed: ask for its history. */
  open?: string;
  /** Frames were lost: ask for the open thread again. */
  refetch?: boolean;
}

/** Fold one frame in. `adopting`: a send with no thread waits for the new one,
 *  which becomes the open thread. */
export function apply(v: DuckView, f: RemoteDuckFrame, adopting: boolean): { view: DuckView; fx: Effects; adopted: boolean } {
  const fx: Effects = {};
  let adopted = false;
  switch (f.type) {
    case "threads":
      v = { ...v, synced: true, threads: f.threads };
      break;
    case "thread": {
      const known = v.threads.some((t) => t.id === f.thread.id);
      v = { ...v, threads: [f.thread, ...v.threads.filter((t) => t.id !== f.thread.id)].sort((a, b) => b.updated - a.updated) };
      if (!known && adopting && v.current === null) {
        adopted = true;
        v = { ...v, current: f.thread.id, messages: { ...v.messages, [f.thread.id]: [] } };
      }
      break;
    }
    case "threadDeleted": {
      const id = f.threadId;
      const threads = v.threads.filter((t) => t.id !== id);
      v = { ...v, threads, asks: v.asks.filter((a) => a.threadId !== id) };
      if (v.current === id) {
        v = { ...v, current: threads[0]?.id ?? null };
        if (v.current) fx.open = v.current;
      }
      break;
    }
    case "history":
      v = {
        ...v,
        messages: { ...v.messages, [f.threadId]: f.messages },
        states: { ...v.states, [f.threadId]: f.state },
        streaming: f.state === "idle" ? { ...v.streaming, [f.threadId]: "" } : v.streaming,
      };
      break;
    case "message": {
      const m = f.message;
      const have = v.messages[m.threadId];
      if (have && !have.some((x) => x.seq === m.seq)) v = { ...v, messages: { ...v.messages, [m.threadId]: [...have, m] } };
      if (m.role === "assistant") v = { ...v, streaming: { ...v.streaming, [m.threadId]: "" } };
      const t = v.threads.find((x) => x.id === m.threadId);
      if (t && t.updated < m.ts) v = { ...v, threads: [{ ...t, updated: m.ts }, ...v.threads.filter((x) => x.id !== m.threadId)] };
      break;
    }
    case "delta":
      v = { ...v, streaming: { ...v.streaming, [f.threadId]: (v.streaming[f.threadId] ?? "") + f.text } };
      break;
    case "turnState":
      v = {
        ...v,
        states: { ...v.states, [f.threadId]: f.state },
        streaming: f.state === "idle" ? { ...v.streaming, [f.threadId]: "" } : v.streaming,
      };
      break;
    case "withdrawn":
      // A provisional turn was dropped (you went on talking): its reply so far goes.
      v = { ...v, streaming: { ...v.streaming, [f.threadId]: "" } };
      break;
    case "confirm":
      v = { ...v, asks: [...v.asks.filter((a) => a.toolUseId !== f.request.toolUseId), f.request] };
      break;
    case "confirmed":
      v = { ...v, asks: v.asks.filter((a) => a.toolUseId !== f.toolUseId) };
      break;
    case "spend":
      v = { ...v, spend: f.spend, turns: f.turns };
      break;
    case "trust":
      v = { ...v, trust: f.trust };
      break;
    case "decisions": {
      const before = f.before;
      const kept = before === null ? [] : v.decisions.filter((d) => d.id >= before);
      v = { ...v, decisions: [...kept, ...f.rows], decisionsMore: f.more };
      break;
    }
    case "decision":
      v = { ...v, decisions: [f.row, ...v.decisions.filter((d) => d.id !== f.row.id)] };
      break;
    case "tasks":
      v = { ...v, tasks: f.tasks };
      break;
    case "reader":
      v = { ...v, reader: f.reader };
      break;
    case "settings":
      v = { ...v, dndUntil: f.settings.dndUntil ?? null };
      break;
    case "error":
      v = { ...v, error: f.message };
      break;
    case "lagged":
      // Streamed text was lost: drop it; the history (and the final message) has it.
      if (v.current) v = { ...v, streaming: { ...v.streaming, [v.current]: "" } };
      fx.refetch = true;
      break;
    default:
      // settings, autopilots, replay, tool, tts: not the store's (tts is the player's).
      break;
  }
  return { view: v, fx, adopted };
}

/** The text of a stored user message. */
export function userText(m: StoredMessage): string {
  return Array.isArray(m.content)
    ? (m.content as { type?: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    : String(m.content);
}
