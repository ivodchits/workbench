// The phone's link to the desktop: the device token, pairing, the dashboard socket
// and the action channel.
//
// The token only ever travels in a header (step R2): `Authorization` on HTTP, and on
// a WebSocket — where a browser can't set that — as a `wb-token.<token>` subprotocol
// beside `wb`. Never in a URL, so it stays out of history and server logs.

import type { RemoteAction, RemoteSnapshot } from "../remote/protocol";

const TOKEN_KEY = "wb-remote-token";
const RECONNECT_MS = 2000;

let token = localStorage.getItem(TOKEN_KEY);
let ws: WebSocket | null = null;

export function isPaired(): boolean {
  return token !== null;
}

/** Drop this device's token (the desktop's device list is not told). */
export function forget(): void {
  localStorage.removeItem(TOKEN_KEY);
  token = null;
}

/** Exchange a pairing code for a device token, which works once the desktop allows
 *  the device. The error is the desktop's reason for refusing; throws when the
 *  desktop can't be reached. */
export async function pair(code: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch("/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) {
    return { ok: false, error: body.error ?? "Pairing failed." };
  }
  token = body.token;
  localStorage.setItem(TOKEN_KEY, body.token);
  return { ok: true };
}

/** Where this device stands with the desktop. */
export type Access = "ok" | "pending" | "refused" | "unreachable";

/** Ask the desktop whether this device's token works. */
export async function checkAccess(): Promise<Access> {
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

/** Open a WebSocket on this origin, carrying the device token as a subprotocol. */
export function openSocket(path: string, params: Record<string, string> = {}): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const url = `${proto}://${location.host}${path}${query ? "?" + query : ""}`;
  return new WebSocket(url, ["wb", "wb-token." + (token ?? "")]);
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
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
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

/** Call a data-plane endpoint with the device token: GET with `query`, or POST of
 *  `body` as JSON. Resolves with the parsed answer; throws `ApiError` on a refusal,
 *  and a plain error when the desktop can't be reached. */
export async function api<T>(
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const query = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  const res = await fetch(path + query, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + (token ?? ""),
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
  });
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
