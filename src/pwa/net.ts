// The phone's link to the desktop: the device token, pairing, the dashboard socket
// and the action channel.
//
// The token only ever travels in a header (step R2): `Authorization` on HTTP, and on
// a WebSocket — where a browser can't set that — as a `wb-token.<token>` subprotocol
// beside `wb`. Never in a URL, so it stays out of history and server logs.
//
// A phone with a device key (assistant plan R3, `deviceKey.ts`) uses a session in
// place of the token: `checkAccess` signs a challenge for one, and it is kept in
// this page's memory only. A refused session (the desktop restarted) is renewed the
// same way.
//
// In Duck's Android app (R4) the token is the app's, sealed by the Keystore
// (`native.ts`), not the page's storage: `loadToken` reads it before anything
// asks whether the phone is paired.
//
// Getting there fast (the phone opens on what it kept, `store.ts`, and says how
// it stands in the header, `link.ts`): one access check at a time, shared by
// whoever asks; a token-only phone opens its socket straight away instead of
// asking first; a dropped link is retried with a growing wait, and at once when
// the page comes back to the front or the network changes. A prompt that can't
// go waits in the outbox (`outbox.ts`) instead of being dropped.

import type { RemoteAction, RemoteSnapshot } from "../remote/protocol";
import { deviceKey, dropDeviceKey, makeDeviceKey, type DeviceKey } from "./deviceKey";
import { flash, isLive, linkState, onRetry, outbox, setLink, synced } from "./link";
import * as app from "./native";
import { clearAll } from "./store";

const TOKEN_KEY = "wb-remote-token";
/** The first retry of a dropped link, doubled each time up to the cap. */
const RECONNECT_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
/** Back at the front after this long away, the socket is opened afresh: a phone
 *  that slept or changed networks often holds a socket that is dead but not closed. */
const STALE_AFTER_MS = 20_000;

let token = app.inApp() ? null : localStorage.getItem(TOKEN_KEY);

/** In the app: read the sealed token (before `isPaired`). */
export async function loadToken(): Promise<void> {
  if (app.inApp()) token = await app.savedToken().catch(() => null);
}

function keepToken(t: string | null): void {
  if (app.inApp()) void app.saveToken(t).catch(() => {});
  else if (t === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, t);
}
/** What a device key's proof bought; in memory only. */
let session: string | null = null;
let ws: WebSocket | null = null;

/** What goes in the header: the session when there is one, else the token. */
function credential(): string {
  return session ?? token ?? "";
}

export function isPaired(): boolean {
  return token !== null;
}

/** Drop this device's token and key (the desktop's device list is not told). */
export function forget(): void {
  keepToken(null);
  token = null;
  session = null;
  access = null;
  void dropDeviceKey();
  void clearAll(); // what was kept of the desktop goes with the pairing
}

/** Exchange a pairing code for a device token, which works once the desktop allows
 *  the device. The error is the desktop's reason for refusing; throws when the
 *  desktop can't be reached. */
export async function pair(code: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const publicKey = await makeDeviceKey();
  const res = await fetch("/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name, ...(publicKey && { publicKey }) }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string; bound?: boolean };
  if (!res.ok || !body.token) {
    return { ok: false, error: body.error ?? "Pairing failed." };
  }
  // A desktop from before device keys, or one that didn't take this key.
  if (!body.bound) await dropDeviceKey();
  token = body.token;
  session = null;
  access = null;
  keepToken(body.token);
  return { ok: true };
}

/** Where this device stands with the desktop. */
export type Access = "ok" | "pending" | "refused" | "unreachable";

/** The access check running, or the last one's answer: what sockets wait on. */
let access: Promise<Access> | null = null;
let checking = false;

/** Ask the desktop whether this device's token works; with a device key, sign a
 *  challenge for a new session. One check at a time: a second caller shares the
 *  one running (two would each start a session, and the desktop keeps only a few). */
export function checkAccess(): Promise<Access> {
  if (checking && access) return access;
  checking = true;
  access = askAccess().finally(() => (checking = false));
  return access;
}

/** What to wait on before opening a socket. A phone with a device key needs its
 *  session first; one on its token alone goes straight on, and a refusal shows
 *  when the socket fails. After a check that didn't get an answer, asks again. */
export async function ready(): Promise<Access> {
  if (access) {
    const a = await access;
    return a === "unreachable" && !checking ? checkAccess() : access;
  }
  if (await deviceKey()) return checkAccess();
  return "ok";
}

async function askAccess(): Promise<Access> {
  // The challenge is asked for while the key is read: one round trip less.
  const challenge = fetchChallenge();
  challenge.catch(() => {}); // unused without a key
  const key = await deviceKey();
  if (key) return startSession(key, challenge);
  try {
    const res = await fetch("/api/state", {
      headers: { Authorization: "Bearer " + (token ?? "") },
      cache: "no-store",
    });
    if (res.ok) return "ok";
    if (res.status === 403) return "pending";
    if (res.status === 401) return "refused";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/** A fresh challenge; null when the desktop didn't give one. */
async function fetchChallenge(): Promise<string | null> {
  const c = await fetch("/api/auth/challenge", { cache: "no-store" });
  if (!c.ok) return null;
  return ((await c.json()) as { challenge: string }).challenge;
}

/** Prove the device key for a session. A used-up challenge is asked for again once. */
async function startSession(key: DeviceKey, first: Promise<string | null>): Promise<Access> {
  session = null;
  try {
    for (let tries = 0; tries < 2; tries++) {
      const challenge = await (tries === 0 ? first : fetchChallenge());
      if (challenge === null) return "unreachable";
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token ?? "") },
        body: JSON.stringify({ challenge, signature: await key.sign(challenge) }),
        cache: "no-store",
      });
      if (res.ok) {
        session = ((await res.json()) as { session: string }).session;
        return "ok";
      }
      if (res.status === 403) return "pending";
      if (res.status === 401) return "refused";
      if (res.status !== 409) return "unreachable";
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      if (why === "noKey") {
        // The desktop has no key for this device: it uses its token.
        await dropDeviceKey();
        return askAccess();
      }
    }
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Open a WebSocket on this origin, carrying the device token as a subprotocol. */
export function openSocket(path: string, params: Record<string, string> = {}): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const url = `${proto}://${location.host}${path}${query ? "?" + query : ""}`;
  return new WebSocket(url, ["wb", "wb-token." + credential()]);
}

/** What the dashboard socket reports. */
export interface DashboardHandlers {
  live: (live: boolean) => void;
  snapshot: (snap: RemoteSnapshot) => void;
  /** A project's notes changed, here or on the desktop (step R8). */
  notes: (projectId: string) => void;
  refused: () => void;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let handlers: DashboardHandlers | null = null;
let hiddenAt: number | null = null;

/** The wait before retry number `n` (from 0): doubling, capped, with a little
 *  jitter so a desktop coming back isn't met by every tab at once. */
export function backoff(n: number, random = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MS * 2 ** Math.min(n, 10));
  return Math.round(base * (0.8 + 0.4 * random()));
}

function scheduleRetry(): void {
  if (retryTimer || !handlers) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attempt();
  }, backoff(retries++));
}

/** Access first (shared, and quick once known), then the socket. */
function attempt(): void {
  const on = handlers;
  if (!on) return;
  void ready().then((a) => {
    if (handlers !== on || ws) return;
    if (a === "refused" || a === "pending") on.refused();
    else if (a === "unreachable") {
      setLink("offline");
      scheduleRetry();
    } else open();
  });
}

/** Try again now: the page is back at the front, the network changed, or the
 *  header was tapped. `fresh` replaces an open socket too (it may be dead). */
export function reconnectNow(fresh = false): void {
  if (!handlers) return;
  const up = ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  if (up && !fresh) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retries = 0;
  if (up && ws) {
    const old = ws;
    ws = null;
    old.onclose = null;
    old.close();
  }
  // Offline stays said (the strip doesn't blink) until the link is really back.
  if (linkState() === "offline") flash("trying again…", 1500);
  else setLink("connecting");
  attempt();
}

function open(): void {
  const on = handlers;
  if (!on || ws) return;
  const socket = openSocket("/api/ws");
  let opened = false;
  ws = socket;
  socket.onopen = () => {
    opened = true;
    retries = 0;
    setLink("live");
    on.live(true);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setLink("offline");
    on.live(false);
    if (opened) {
      scheduleRetry();
      return;
    }
    void checkAccess().then((a) => {
      if (a === "refused" || a === "pending") on.refused();
      else scheduleRetry();
    });
  };
  socket.onerror = () => socket.close();
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as RemoteSnapshot | { type: "notes"; projectId: string };
    if ("type" in msg && msg.type === "notes") on.notes(msg.projectId);
    else {
      synced();
      on.snapshot(msg as RemoteSnapshot);
    }
  };
}

/** Open the dashboard socket and keep it open: a snapshot arrives on connect and on
 *  every change; a dropped link is retried until the page goes away. A socket that
 *  never opens may mean the device lost access — the browser doesn't say why — so
 *  that is asked over HTTP, and a revoked device stops retrying. Waits for
 *  `ready()` first (a device key's session). */
export function connect(on: DashboardHandlers): void {
  handlers = on;
  // Opened offline (the app found the PC unreachable): stays so until it's back.
  if (linkState() !== "offline") setLink("connecting");
  attempt();
  onRetry(() => reconnectNow());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    reconnectNow(away > STALE_AFTER_MS);
  });
  window.addEventListener("online", () => reconnectNow(true));
  // The socket can take a long while to notice by itself.
  window.addEventListener("offline", () => setLink("offline"));
}

/** Send one action to the desktop: over the socket when it is up, else by HTTP.
 *  A prompt that can't go now waits in the outbox, as what was meant whenever it
 *  arrives; an approval, an interrupt or a choice is about the moment, and is
 *  only said not to have gone. */
export function action(act: RemoteAction): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(act));
    return;
  }
  const keep = () => {
    if (act.type !== "prompt" || act.text === undefined) return false;
    outbox.add({ kind: "prompt", instanceId: act.instanceId, text: act.text });
    return true;
  };
  if (!isLive() && keep()) {
    flash("offline — prompt kept, sends when back");
    return;
  }
  void postAction(act).then((r) => {
    if (r === "done") return;
    if (keep()) flash("not delivered — prompt kept, sends when back");
    else flash(`offline — ${act.type} not sent`);
  });
}

/** POST one action: `done` once the desktop took it. */
async function postAction(act: RemoteAction): Promise<"done" | "wait" | { failed: string }> {
  try {
    await api("/api/action", { body: act });
    return "done";
  } catch (e) {
    if (unreachable(e)) return "wait";
    return { failed: e instanceof ApiError && (e.status === 401 || e.status === 403) ? "this device lost access" : String((e as Error).message) };
  }
}

outbox.handle("prompt", async (it) =>
  it.kind === "prompt" ? postAction({ type: "prompt", instanceId: it.instanceId, text: it.text }) : { failed: "not a prompt" },
);

/** A failed API call: the HTTP status, and the body the desktop sent with it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

/** A failed call that never got to Workbench: no network, or the proxy in front
 *  (Tailscale Funnel) couldn't reach it. Worth trying again later, unlike a refusal. */
export function unreachable(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status === 502 || e.status === 503 || e.status === 504;
}

/** The device token (or its session) as an `Authorization` header. */
export function authHeader(): Record<string, string> {
  return { Authorization: "Bearer " + credential() };
}

/** Call a data-plane endpoint with the device token: GET with `query`, or POST of
 *  `body` as JSON, or of `raw` bytes as `type`. Resolves with the parsed answer;
 *  throws `ApiError` on a refusal, and a plain error when the desktop can't be
 *  reached. */
export async function api<T>(
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; raw?: Uint8Array<ArrayBuffer>; type?: string } = {},
): Promise<T> {
  const query = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  const post = opts.body !== undefined || opts.raw !== undefined;
  const call = () =>
    fetch(path + query, {
      method: post ? "POST" : "GET",
      headers: {
        ...authHeader(),
        ...(opts.raw ? { "Content-Type": opts.type ?? "application/octet-stream" } : post ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      cache: "no-store",
    });
  let res = await call();
  // A session the desktop no longer knows (it restarted): prove the key again.
  if (res.status === 401 && session !== null && (await checkAccess()) === "ok") res = await call();
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text }; // a plain-text refusal (an oversized body, say)
  }
  if (!res.ok) throw new ApiError(res.status, (parsed ?? {}) as Record<string, unknown>);
  return parsed as T;
}
