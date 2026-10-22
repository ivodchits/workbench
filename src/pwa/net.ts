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

import type { RemoteAction, RemoteSnapshot } from "../remote/protocol";
import { deviceKey, dropDeviceKey, makeDeviceKey, signChallenge } from "./deviceKey";

const TOKEN_KEY = "wb-remote-token";
const RECONNECT_MS = 2000;

let token = localStorage.getItem(TOKEN_KEY);
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
  localStorage.removeItem(TOKEN_KEY);
  token = null;
  session = null;
  void dropDeviceKey();
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
  localStorage.setItem(TOKEN_KEY, body.token);
  return { ok: true };
}

/** Where this device stands with the desktop. */
export type Access = "ok" | "pending" | "refused" | "unreachable";

/** Ask the desktop whether this device's token works; with a device key, sign a
 *  challenge for a new session. */
export async function checkAccess(): Promise<Access> {
  const key = await deviceKey();
  if (key) return startSession(key);
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

/** Prove the device key for a session. A used-up challenge is asked for again once. */
async function startSession(key: CryptoKey): Promise<Access> {
  session = null;
  try {
    for (let tries = 0; tries < 2; tries++) {
      const c = await fetch("/api/auth/challenge", { cache: "no-store" });
      if (!c.ok) return "unreachable";
      const { challenge } = (await c.json()) as { challenge: string };
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token ?? "") },
        body: JSON.stringify({ challenge, signature: await signChallenge(key, challenge) }),
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
        return checkAccess();
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

/** Open the dashboard socket and keep it open: a snapshot arrives on connect and on
 *  every change; a dropped link is retried until the page goes away. A socket that
 *  never opens may mean the device lost access — the browser doesn't say why — so
 *  that is asked over HTTP, and a revoked device stops retrying. */
export function connect(on: {
  live: (live: boolean) => void;
  snapshot: (snap: RemoteSnapshot) => void;
  /** A project's notes changed, here or on the desktop (step R8). */
  notes: (projectId: string) => void;
  refused: () => void;
}): void {
  const socket = openSocket("/api/ws");
  let opened = false;
  ws = socket;
  socket.onopen = () => {
    opened = true;
    on.live(true);
  };
  socket.onclose = () => {
    on.live(false);
    const retry = () => setTimeout(() => connect(on), RECONNECT_MS);
    if (opened) {
      retry();
      return;
    }
    void checkAccess().then((access) => {
      if (access === "refused" || access === "pending") on.refused();
      else retry();
    });
  };
  socket.onerror = () => socket.close();
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as RemoteSnapshot | { type: "notes"; projectId: string };
    if ("type" in msg && msg.type === "notes") on.notes(msg.projectId);
    else on.snapshot(msg as RemoteSnapshot);
  };
}

/** Send one action to the desktop: over the socket when it is up, else by HTTP. */
export function action(act: RemoteAction): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(act));
    return;
  }
  void fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential() },
    body: JSON.stringify(act),
  }).catch(() => {}); // unreachable: the offline banner already says so
}

/** A failed API call: the HTTP status, and the body the desktop sent with it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
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
