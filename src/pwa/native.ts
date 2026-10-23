// The phone's app (assistant plan R4, H5): this page, opened inside Duck's
// Android app (`duck-android/`), reaches the app's `duck` plugin (Kotlin,
// `DuckPlugin.kt`) for what a browser page can't do. In a browser none of this
// exists, and `inApp()` is false.
//
// - The `phone` host's tools run there (`runTool`); the page serves them over
//   Duck's socket (`duck.ts`, `serveHost`).
// - The device token is kept sealed by the Keystore, and the device key is a
//   Keystore key (`deviceKey.ts`, `net.ts`).
// - The mic is native (`micStart`): 16 kHz frames, with the screen off while
//   conversation mode runs its foreground service.
// - What opened the app (the assistant gesture, the tile, the widget) comes as
//   launches; the reminders the desktop sends are armed as exact alarms.
// - The phone brain (H7, `phoneBrain.ts`): `apiFetch` is a `fetch` for the SDK
//   that the app sends with the phone's own key, which the page never holds.

import { addPluginListener, Channel, invoke, isTauri } from "@tauri-apps/api/core";

/** This page runs inside Duck's app. */
export function inApp(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** The plugin's reason for a refusal: it rejects with `{message}`. */
export function reason(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}

/** A plugin command; rejects with an `Error` carrying the phone's reason. */
const call = <T>(cmd: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:duck|${cmd}`, args).catch((e: unknown) => {
    throw new Error(reason(e));
  });

/** The app's host: its tools' names. */
export async function hostInfo(): Promise<{ tools: string[]; version: number; locked: boolean }> {
  return call("info");
}

/** Run one of the phone's tools; rejects with the phone's reason. */
export async function runTool(tool: string, input: unknown): Promise<unknown> {
  return (await call<{ output: unknown }>("run", { tool, input })).output;
}

// ── what the app keeps ──

/** Workbench's address as the app keeps it: https, a `.ts.net` name (what the
 *  app's capability lets reach the plugin), no path; null when it isn't one. */
export function cleanAddress(raw: string): string | null {
  const t = raw.trim();
  let u: URL;
  try {
    u = new URL(t.includes("://") ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname.endsWith(".ts.net")) return null;
  return u.origin;
}

/** Where the app's own page is (the loader, `duck-android/web/`). */
export const LOADER_URL = "http://tauri.localhost/";

export async function savedAddress(): Promise<string | null> {
  return (await call<{ address: string | null }>("address")).address ?? null;
}

export function saveAddress(address: string | null): Promise<void> {
  return call("set_address", { address: address ?? "" });
}

export async function savedToken(): Promise<string | null> {
  return (await call<{ token: string | null }>("token")).token ?? null;
}

export function saveToken(token: string | null): Promise<void> {
  return call("set_token", { token });
}

/** A new Keystore key, in place of any before: its public half. */
export async function keyCreate(): Promise<string> {
  return (await call<{ publicKey: string }>("key_create")).publicKey;
}

/** `data` signed with the Keystore key (r‖s, base64url); null without a key. */
export async function keySign(data: string): Promise<string | null> {
  return (await call<{ signature: string | null }>("key_sign", { data })).signature ?? null;
}

export function keyDrop(): Promise<void> {
  return call("key_drop");
}

export interface AppSettings {
  /** Over the lock screen, the phone's tools wait for an unlock. */
  requireUnlock: boolean;
  /** The phone key's monthly cap, USD (H7). */
  phoneCap: number;
}

export function appSettings(): Promise<AppSettings> {
  return call("settings");
}

export function setAppSettings(s: Partial<AppSettings>): Promise<AppSettings> {
  return call("set_settings", s);
}

// ── ways in ──

/** Why the app opened: the assistant gesture (`assist`), the tile (`talk`), the
 *  widget (`listen`, `open`); `screen` carries the text of what was on screen. */
export type AppLaunch =
  | { kind: "assist" | "talk" | "listen" | "open" }
  | { kind: "screen"; app: string; text: string };

/** Hear each launch: those waiting since the app opened, then each new one. */
export async function onLaunch(cb: (l: AppLaunch) => void): Promise<void> {
  await addPluginListener<AppLaunch>("duck", "launch", cb);
  for (const l of (await call<{ launches: AppLaunch[] }>("launch")).launches) cb(l);
}

export async function onTalkStop(cb: (why: string) => void): Promise<void> {
  await addPluginListener<{ why: string }>("duck", "talkStop", (e) => cb(e.why));
}

export function widgetStatus(text: string): Promise<void> {
  return call("widget_status", { text });
}

// ── reminders ──

export interface AppAlarm {
  id: string;
  title: string;
  body: string;
  at: number[];
}

/** Arm `alarms` in place of `source`'s: the desktop's, or the phone brain's own
 *  made offline (H7). Both lists stay armed. */
export function armReminders(alarms: AppAlarm[], source: "desktop" | "phone" = "desktop"): Promise<void> {
  return call("reminders", { alarms, source });
}

/** Done / Snooze tapped on the app's own reminder notifications, not yet sent. */
export async function takeReminderActions(): Promise<{ id: string; action: "done" | "snooze" }[]> {
  return (await call<{ actions: { id: string; action: "done" | "snooze" }[] }>("reminder_actions")).actions;
}

export async function onReminderActed(cb: () => void): Promise<void> {
  await addPluginListener("duck", "reminderActed", cb);
}

// ── the mic ──

/** 16 kHz samples (int16 LE, base64) as floats. */
export function pcmFloats(b64: string): Float32Array {
  const bin = atob(b64);
  const out = new Float32Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return out;
}

/** Start the native mic: each 32 ms frame to `onFrame`. `foreground` runs it in
 *  the conversation service, so it goes on with the screen off. */
export async function micStart(onFrame: (samples: Float32Array) => void, foreground: boolean): Promise<void> {
  const channel = new Channel<{ pcm: string }>();
  channel.onmessage = (m) => onFrame(pcmFloats(m.pcm));
  await call("mic_start", { channel, foreground });
}

export function micStop(): Promise<void> {
  return call("mic_stop");
}

export async function onMicError(cb: (why: string) => void): Promise<void> {
  await addPluginListener<{ why: string }>("duck", "micError", (e) => cb(e.why));
}

/** The phone's own speech recognizer, for when the desktop can't be reached. */
export async function recognize(lang?: string): Promise<string> {
  return (await call<{ text: string }>("recognize", lang ? { lang } : {})).text;
}

// ── the phone brain (H7) ──

/** Whether the app has a phone key, and its last four characters. */
export function phoneKey(): Promise<{ set: boolean; hint: string | null }> {
  return call("phone_key");
}

/** Keep the phone key (sealed by the Keystore), or forget it (null). */
export function setPhoneKey(key: string | null): Promise<void> {
  return call("set_phone_key", { key });
}

export interface PhoneSpend {
  /** `2026-10`. */
  month: string;
  usd: number;
  requests: number;
  cap: number;
}

export function phoneSpend(): Promise<PhoneSpend> {
  return call("phone_spend");
}

/** What the phone brain keeps of its own (`name`: `threads`, `reminders`), as
 *  JSON, until it's synced. */
export async function offlineGet(name: string): Promise<string | null> {
  return (await call<{ value: string | null }>("offline_get", { name })).value ?? null;
}

export function offlinePut(name: string, value: string | null): Promise<void> {
  return call("offline_put", { name, value });
}

/** Say `text` with the phone's own text-to-speech, after what's being said. */
export function speak(text: string): Promise<void> {
  return call("speak", { text });
}

export function speakStop(): Promise<void> {
  return call("speak_stop");
}

/** What the app sends over a request's channel. */
export type ApiFrame = { head: { status: number; headers: Record<string, string> } } | { chunk: string } | { end: true };

/** A `Response` fed by a request's frames: resolves at the head, and its body
 *  streams the chunks as they come. `start` begins the request; it rejects with
 *  a reason before the head. Exported for tests. */
export function responseFrom(
  start: (onFrame: (f: ApiFrame) => void) => Promise<void>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const enc = new TextEncoder();
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let headed = false;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    start((f) => {
      if ("head" in f) {
        headed = true;
        resolve(new Response(body, { status: f.head.status, headers: f.head.headers }));
      } else if ("chunk" in f) ctl?.enqueue(enc.encode(f.chunk));
      else ctl?.close();
    }).catch((e: unknown) => {
      const err = new Error(reason(e));
      if (!headed) reject(err);
      else
        try {
          ctl?.error(err);
        } catch {
          // already closed
        }
    });
  });
}

let nextRequest = 0;

/** A `fetch` for the SDK (`new Anthropic({fetch})`): the request goes out from
 *  the app, which adds the phone key and counts the spend. */
export const apiFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const id = `r${++nextRequest}`;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const signal = init?.signal;
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  signal?.addEventListener("abort", () => void call("api_abort", { id }).catch(() => {}), { once: true });
  return responseFrom((onFrame) => {
    const channel = new Channel<ApiFrame>();
    channel.onmessage = onFrame;
    return call("api_fetch", { id, path: url.pathname, headers, body: typeof init?.body === "string" ? init.body : "", channel });
  });
};
