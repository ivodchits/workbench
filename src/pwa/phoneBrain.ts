// The phone's fallback brain (assistant plan H7): Duck's own engine
// (`src/assistant/engine.ts`), run by the app's loader when Workbench can't be
// reached, on the phone's own API key (`native.ts` `apiFetch`: the app adds the
// key and keeps the month's cap).
//
// - Its tools: the phone's (served in this page, `connectLocal`), the reminders
//   and the time. Nothing of Workbench's: its port refuses every call.
// - Its reminders are its own, kept by the app and armed as the phone's alarms
//   next to the desktop's; its threads too. Both go to the desktop when the
//   app's page next connects (`duckApp.ts`, `offline.ts`).
// - The system prompt is the built-in one, with a note that it's the offline
//   brain (`OFFLINE_NOTE`).
// - Past 80% of the cap, turns run on Haiku, as the desktop's do past its soft
//   limit.

import Anthropic from "@anthropic-ai/sdk";
import { createEngine, type Engine } from "../assistant/engine";
import { createRegistry } from "../assistant/tools/registry";
import { createThreadStore, type ThreadBackend } from "../assistant/threads";
import { createHosts, connectLocal } from "../assistant/hosts";
import { createReminders, phoneAlarms, type ReminderRecord, type RemindersBackend } from "../assistant/reminders";
import { DEFAULT_PROMPTS, type ConfigHost } from "../assistant/config";
import { OFFLINE_NOTE, parseState, type OfflineState } from "../assistant/offline";
import { PHONE_TOOLS } from "../assistant/tools/phone";
import { openOnPhone } from "../assistant/tools/media";
import { getTime } from "../assistant/tools/getTime";
import { REMINDER_TOOLS } from "../assistant/tools/reminders";
import { toolsOn } from "../assistant/tools/registry";
import type { WorkbenchPort } from "../assistant/port";
import type { StoredMessage } from "../ipc/assistant";
import type { AppAlarm } from "./native";

/** What the phone brain needs of the app (`native.ts`; fakes in tests). */
export interface PhoneBrainDeps {
  /** The SDK's `fetch`: the app's, with the phone key. */
  fetch: typeof fetch;
  /** The app's keeping (`offlineGet` / `offlinePut`). */
  get(name: string): Promise<string | null>;
  put(name: string, value: string | null): Promise<void>;
  /** Run one of the phone's tools. */
  runTool(tool: string, input: unknown): Promise<unknown>;
  /** The phone's tools the app offers. */
  tools: readonly string[];
  /** Arm the phone brain's own reminders. */
  arm(alarms: AppAlarm[]): Promise<void>;
  /** This month's spend and cap, USD. */
  spend(): Promise<{ usd: number; cap: number }>;
  now?: () => number;
}

/** A thread untouched this long is done with: the next message starts another. */
export const THREAD_IDLE_MS = 2 * 3_600_000;

/** Past this share of the cap, turns run on Haiku. */
const HAIKU_AT = 0.8;

const OFFLINE = "Workbench can't be reached: this waits until it's back.";

/** The port to Workbench, offline: every call refused. */
const noWorkbench = new Proxy({} as WorkbenchPort, {
  get: (_t, name) =>
    typeof name === "symbol"
      ? undefined
      : () => {
          throw new Error(OFFLINE);
        },
});

/** The thread store's backend: in memory, kept by the app after each change. */
function keptThreads(state: OfflineState, save: (s: OfflineState) => void, now: () => number): ThreadBackend {
  let s = state;
  const set = (next: OfflineState) => {
    s = next;
    save(s);
  };
  const touch = (threadId: string, at: number) =>
    s.threads.map((t) => (t.row.id === threadId ? { ...t, row: { ...t.row, updated: at } } : t));
  return {
    async threadCreate(id, mode) {
      const row = { id, title: "", mode, created: now(), updated: now() };
      set({ ...s, threads: [...s.threads, { row, messages: [] }] });
      return row;
    },
    threadList: async () => s.threads.map((t) => t.row),
    threadMessages: async (id) => s.threads.find((t) => t.row.id === id)?.messages ?? [],
    async threadTitle(id, title) {
      set({ ...s, threads: s.threads.map((t) => (t.row.id === id ? { ...t, row: { ...t.row, title } } : t)) });
    },
    async threadDelete(id) {
      set({ threads: s.threads.filter((t) => t.row.id !== id), pending: s.pending.filter((p) => p.threadId !== id) });
    },
    async messageAppend(m) {
      const threads = touch(m.threadId, m.ts).map((t) => (t.row.id === m.threadId ? { ...t, messages: [...t.messages, m] } : t));
      set({ ...s, threads });
    },
    async pendingPut(id, threadId, data) {
      set({ ...s, pending: [...s.pending.filter((p) => p.id !== id), { id, threadId, data }] });
    },
    pendingList: async () => s.pending,
    async pendingClear(id) {
      set({ ...s, pending: s.pending.filter((p) => p.id !== id) });
    },
  };
}

/** The reminders' backend: the phone brain's own records, kept by the app and
 *  armed as alarms after each change. */
function keptReminders(list: ReminderRecord[], save: (list: ReminderRecord[]) => void): RemindersBackend {
  let records = list;
  const file = () => ({ path: "the phone (offline)", reminders: records, problem: null });
  return {
    read: async () => file(),
    async put(id, before, after) {
      const have = records.find((r) => r.id === id) ?? null;
      if (JSON.stringify(have) !== JSON.stringify(before)) throw new Error(`stale: reminder ${id} changed`);
      records = after ? [...records.filter((r) => r.id !== id), after] : records.filter((r) => r.id !== id);
      save(records);
      return file();
    },
    seen: async () => [],
    setSeen: async () => {},
    timers: async () => [],
    async setTimer() {
      throw new Error("Duck's own timers wait for Workbench: use phone_set_timer.");
    },
  };
}

export interface PhoneBrain {
  engine: Engine;
  /** The thread the next message goes to: the latest, unless it's been idle long;
   *  null starts one. */
  current(): string | null;
  /** A thread's messages, as kept. */
  messages(threadId: string): Promise<readonly StoredMessage[]>;
  /** Start a new conversation with the next message. */
  fresh(): void;
  /** Send `text` (`voice`: it was spoken). Resolves to its thread. */
  send(text: string, voice: boolean): Promise<string>;
}

export async function startPhoneBrain(d: PhoneBrainDeps): Promise<PhoneBrain> {
  const now = d.now ?? Date.now;
  // The app keeps one write at a time, in order.
  let writing = Promise.resolve();
  const keep = (name: string, value: string) => {
    writing = writing.then(() => d.put(name, value)).catch((e: unknown) => console.warn(`duck: the phone brain's ${name} weren't kept`, e));
  };

  const state = parseState(await d.get("threads"));
  const store = createThreadStore(keptThreads(state, (s) => keep("threads", JSON.stringify(s)), now), { now });
  await store.load();

  let saved: ReminderRecord[] = [];
  try {
    saved = JSON.parse((await d.get("reminders")) ?? "[]") as ReminderRecord[];
  } catch {
    // unreadable: start with none
  }
  const reminders = createReminders({
    backend: keptReminders(
      saved,
      (list) => {
        keep("reminders", JSON.stringify(list));
        void d.arm(phoneAlarms(list, now())).catch((e: unknown) => console.warn("duck: the phone's reminders weren't armed", e));
      },
    ),
    spellMinutes: () => 30,
  });
  await reminders.load();

  const phoneTools = [...PHONE_TOOLS, openOnPhone];
  const declared = toolsOn(phoneTools, "phone");
  const hosts = createHosts(() => declared);
  connectLocal(
    hosts,
    "phone",
    Object.fromEntries(d.tools.filter((t) => declared.has(t)).map((t) => [t, (input: unknown) => d.runTool(t, input)])),
  );

  // Duck's own timers ring on the desktop: offline, the phone's Clock keeps them.
  const tools = [...phoneTools, getTime, ...REMINDER_TOOLS.filter((t) => t.name !== "set_timer" && t.name !== "cancel_timer")];
  const prompts = { system: DEFAULT_PROMPTS.system + OFFLINE_NOTE, voice: DEFAULT_PROMPTS.voice };
  const config: ConfigHost = {
    forThread: async () => prompts,
    current: () => Promise.reject(new Error(OFFLINE)),
    write: () => Promise.reject(new Error(OFFLINE)),
  };
  const client = new Anthropic({ apiKey: "kept-by-the-app", fetch: d.fetch, dangerouslyAllowBrowser: true });

  const engine = createEngine({
    stream: (params, opts) => client.beta.messages.stream(params, opts),
    registry: createRegistry(tools),
    port: noWorkbench,
    store,
    hosts,
    reminders,
    config,
    degraded: async () => {
      const s = await d.spend();
      return s.usd >= s.cap * HAIKU_AT;
    },
  });

  let pinned: string | null | undefined;
  const current = () => {
    if (pinned !== undefined) return pinned;
    const latest = [...store.threads()].sort((a, b) => b.updated - a.updated)[0];
    return latest && now() - latest.updated < THREAD_IDLE_MS ? latest.id : null;
  };
  return {
    engine,
    current,
    messages: (id) => store.messages(id),
    fresh: () => void (pinned = null),
    async send(text, voice) {
      const threadId = await engine.send({ threadId: current(), text, source: voice ? "phone-voice" : "phone" });
      pinned = threadId;
      return threadId;
    },
  };
}
