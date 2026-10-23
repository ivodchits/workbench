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
//   with the next message (`<shared>`: data, not instructions).
// - The fast path (`fastPath.ts`): timers, alarms, the flashlight and media
//   commands run here before any model, with the desktop reachable or not.
// - The widget's line follows Duck's state.

import { serveHost, type HostDown } from "../assistant/hosts";
import type { RemoteDuckFrame, RemoteHostMessage } from "../remote/protocol";
import { fastPath } from "./fastPath";
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
  await flushActions();
}

/** A frame for the app (a host call, the reminders); true when it was one. */
export function onAppFrame(f: RemoteDuckFrame): boolean {
  if (f.type === "device.call" || f.type === "device.cancel") {
    host?.receive(f as HostDown);
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
