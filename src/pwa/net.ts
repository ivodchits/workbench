// The phone's link to the desktop: the device token, pairing, the dashboard socket
// and the action channel.

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

/** Exchange a pairing code for a device token. False when the code is refused;
 *  throws when the desktop can't be reached. */
export async function pair(code: string, name: string): Promise<boolean> {
  const res = await fetch("/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) return false;
  const next: string = (await res.json()).token;
  token = next;
  localStorage.setItem(TOKEN_KEY, next);
  return true;
}

/** A WebSocket address on this origin, carrying the device token. */
export function socketUrl(path: string, params: Record<string, string> = {}): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const query = Object.entries({ token: token ?? "", ...params })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${proto}://${location.host}${path}?${query}`;
}

/** Open the dashboard socket and keep it open: a snapshot arrives on connect and on
 *  every change; a dropped link is retried until the page goes away. */
export function connect(on: {
  live: (live: boolean) => void;
  snapshot: (snap: RemoteSnapshot) => void;
}): void {
  const socket = new WebSocket(socketUrl("/api/ws"));
  ws = socket;
  socket.onopen = () => on.live(true);
  socket.onclose = () => {
    on.live(false);
    setTimeout(() => connect(on), RECONNECT_MS);
  };
  socket.onerror = () => socket.close();
  socket.onmessage = (ev) => on.snapshot(JSON.parse(ev.data as string) as RemoteSnapshot);
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
