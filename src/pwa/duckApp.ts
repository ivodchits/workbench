// Duck in the phone's app (assistant plan R4, H5): what `duck.ts` does more when
// the page runs inside Duck's Android app (`native.ts`). In a browser it does
// nothing.
//
// - The phone as a host (H1, H5): on each connect the page says `hello` with
//   the app's tools, runs each `device.call` there and answers it.
// - Reminders: the desktop's `phone.reminders` are armed as exact alarms; Done /
//   Snooze tapped on the app's own notifications go back as `reminder.action`
//   (now, or on the next connect).
// - Ways in: the assistant gesture and the widget's talk button open Duck
//   listening, the tile starts conversation mode, and what was on screen goes
//   with the next message (`<shared>`: data, not instructions). A tapped push
//   opens the card or Duck's thread it names.
// - The fast path (`fastPath.ts`): timers, alarms, the flashlight and media
//   commands run here before any model, with the desktop reachable or not.
// - The widget's line follows Duck's state.
// - What the phone brain made offline (H7, `phoneBrain.ts`): on each connect,
//   its reminders and conversations go to the desktop (`offline.sync`) before the
//   kept taps, and what the desktop took (`offline.synced`) is dropped here.

import { serveHost, type HostDown } from "../assistant/hosts";
import type { RemoteDuckFrame, RemoteHostMessage } from "../remote/protocol";
import { fastPath } from "./fastPath";
import { parseState, threadsToSync, withoutThreads } from "../assistant/offline";
import { phoneAlarms, type ReminderRecord } from "../assistant/reminders";
import * as app from "./native";

export interface AppHooks {
  /** Send to the desktop, when the socket is open. */
  post(msg: RemoteHostMessage): void;
  /** Whether the socket is open. */
  live(): boolean;
  /** Open Duck listening for one request. */
  listen(): void;
  /** Start conversation mode. */
  talk(): void;
  /** Open Duck. */
  open(): void;
  /** A tapped push: open what it names. */
  pushed(to: { instanceId?: string; threadId?: string }): void;
  /** Conversation mode was stopped outside the page (the tile, the notification). */
  talkStopped(why: string): void;
  /** A line under the mic. */
  note(text: string): void;
}

/** What was on screen when the assistant gesture opened the app; it goes with
 *  the next message sent within `SCREEN_MS`. */
let screen: { app: string; text: string; at: number } | null = null;
const SCREEN_MS = 120_000;

let host: ReturnType<typeof serveHost> | null = null;
let hooks: AppHooks | null = null;

export const inApp = app.inApp;

/** Wire the app's events. */
export function initApp(h: AppHooks): void {
  if (!app.inApp()) return;
  hooks = h;
  void app.onLaunch((l) => {
    switch (l.kind) {
      case "screen":
        return keepScreen(l.app, l.text);
      case "assist":
      case "listen":
        return h.listen();
      case "talk":
        return h.talk();
      case "open":
        return h.open();
      case "push":
        return h.pushed(l);
    }
  });
  void app.onTalkStop((why) => h.talkStopped(why));
  void app.onReminderActed(() => void flushActions());
  void app.onMicError((why) => h.note(`The mic stopped: ${why}`));
}

/** The socket opened: say hello as the phone, and send any taps kept. */
export async function connected(): Promise<void> {
  if (!hooks) return;
  const h = hooks;
  try {
    const info = await app.hostInfo();
    const handlers = Object.fromEntries(info.tools.map((t) => [t, (input: unknown) => app.runTool(t, input)]));
    host = serveHost("phone", handlers, (m) => h.post(m));
    h.post(host.hello);
  } catch (e) {
    console.warn("duck: the app's tools didn't load", e);
  }
  await syncOffline().catch((e: unknown) => console.warn("duck: the offline brain's work wasn't synced", e));
  await flushActions();
}

/** The desktop's answer to an `offline.sync`, awaited. */
let synced: ((took: { reminders: string[]; threads: string[] }) => void) | null = null;
const SYNC_WAIT_MS = 15_000;

/** Send what the phone brain made offline, and drop what the desktop took. */
async function syncOffline(): Promise<void> {
  if (!hooks?.live() || !host) return;
  const state = parseState(await app.offlineGet("threads"));
  let reminders: ReminderRecord[] = [];
  try {
    reminders = JSON.parse((await app.offlineGet("reminders")) ?? "[]") as ReminderRecord[];
  } catch {
    // unreadable: nothing to send
  }
  const threads = threadsToSync(state);
  const empty = state.threads.map((t) => t.row.id).filter((id) => !threads.some((t) => t.id === id));
  if (!threads.length && !reminders.length) {
    if (empty.length) await app.offlinePut("threads", null);
    return;
  }
  const took = await new Promise<{ reminders: string[]; threads: string[] } | null>((resolve) => {
    const t = setTimeout(() => resolve(null), SYNC_WAIT_MS);
    synced = (v) => {
      clearTimeout(t);
      resolve(v);
    };
    hooks?.post({ type: "offline.sync", reminders, threads });
  });
  synced = null;
  if (!took) return;
  const left = reminders.filter((r) => !took.reminders.includes(r.id));
  await app.offlinePut("reminders", left.length ? JSON.stringify(left) : null);
  // The desktop's list arms them from now on.
  await app.armReminders(phoneAlarms(left, Date.now()), "phone");
  const rest = withoutThreads(state, took.threads, empty);
  await app.offlinePut("threads", rest.threads.length ? JSON.stringify(rest) : null);
}

/** A frame for the app (a host call, the reminders); true when it was one. */
export function onAppFrame(f: RemoteDuckFrame): boolean {
  if (f.type === "device.call" || f.type === "device.cancel") {
    host?.receive(f as HostDown);
    return true;
  }
  if (f.type === "offline.synced") {
    synced?.({ reminders: f.reminders, threads: f.threads });
    return true;
  }
  if (f.type === "phone.reminders") {
    if (app.inApp()) void app.armReminders(f.alarms).catch((e: unknown) => console.warn("duck: reminders not armed", e));
    return true;
  }
  return false;
}

async function flushActions(): Promise<void> {
  if (!hooks?.live()) return;
  const h = hooks;
  for (const a of await app.takeReminderActions().catch(() => [])) h.post({ type: "reminder.action", id: a.id, action: a.action });
}

/** Text that might close the wrapper, defused. */
const defuse = (s: string) => s.replace(/<\/shared/gi, "</shared_");

/** Keep what was on screen for the next message. */
export function keepScreen(app: string, text: string, at = Date.now()): void {
  screen = { app, text, at };
}

/** `text` with what was on screen, if the gesture brought some lately (once). */
export function withScreen(text: string, now = Date.now()): string {
  const s = screen;
  screen = null;
  if (!s || now - s.at > SCREEN_MS) return text;
  return `${text}\n\nOn my phone's screen (${s.app}):\n<shared>\n${defuse(s.text)}\n</shared>`;
}

/** Run `text` here when it's a fast-path command: the line said, or null for Duck. */
export async function runFast(text: string): Promise<string | null> {
  if (!app.inApp()) return null;
  const c = fastPath(text);
  if (!c) return null;
  try {
    await app.runTool(c.tool, c.input);
    return c.said;
  } catch (e) {
    return `Didn't work: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** One request heard by the phone's own recognizer (the desktop unreachable):
 *  run on the fast path, or say why not. */
export async function listenOffline(note: (t: string) => void): Promise<void> {
  note("listening (on the phone)…");
  let text: string;
  try {
    text = await app.recognize();
  } catch (e) {
    note(`Didn't hear that: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const said = await runFast(text);
  note(said ?? `“${text}”: Workbench can't be reached, and only timers, alarms, the flashlight and play/pause work without it.`);
}

let lastLine = "";
let lineTimer: ReturnType<typeof setTimeout> | null = null;

/** The widget's line, at most every few seconds. */
export function widgetLine(text: string): void {
  if (!app.inApp() || text === lastLine) return;
  lastLine = text;
  if (lineTimer) return;
  lineTimer = setTimeout(() => {
    lineTimer = null;
    void app.widgetStatus(lastLine).catch(() => {});
  }, 3000);
}
