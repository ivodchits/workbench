// Another machine's transcript, here (fleet plan F9.2): the phone's transcript
// source (`pwa/transcriptSource.ts`) over a socket the fleet view opens to that
// machine's `/api/transcript` (`fleet_socket_open`). The phone's resume-on-reconnect
// works the same: the adapter below is a `SocketLike`.

import { fleetSocketOpen, type FleetSocket } from "../ipc/fleet";
import { transcriptSource, type SocketLike } from "../pwa/transcriptSource";
import type { TranscriptSource } from "./feed";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** `path?query` for a socket route. */
export function withQuery(path: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

/** A text-only `SocketLike` over a fleet socket. */
export function fleetSocketLike(machine: string, path: string): SocketLike {
  let socket: FleetSocket | null = null;
  let closing = false;
  const like: SocketLike & { readyState: number } = {
    readyState: CONNECTING,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      socket?.sendText(data);
    },
    close() {
      closing = true;
      socket?.close();
      if (like.readyState !== CLOSED) {
        like.readyState = CLOSED;
        like.onclose?.(new CloseEvent("close"));
      }
    },
  };
  fleetSocketOpen(machine, path, (m) => {
    if (m.t === "open") {
      like.readyState = OPEN;
      like.onopen?.(new Event("open"));
    } else if (m.t === "text") {
      like.onmessage?.(new MessageEvent("message", { data: m.d }));
    } else if (m.t === "closed") {
      if (like.readyState === CLOSED) return;
      like.readyState = CLOSED;
      if (m.why) like.onerror?.(new Event("error"));
      like.onclose?.(new CloseEvent("close"));
    }
  })
    .then((s) => {
      socket = s;
      if (closing) s.close();
    })
    .catch(() => {
      if (like.readyState === CLOSED) return;
      like.readyState = CLOSED;
      like.onerror?.(new Event("error"));
      like.onclose?.(new CloseEvent("close"));
    });
  return like;
}

/** Instance `instanceId`'s transcript on machine `machine`. */
export function fleetTranscriptSource(machine: string, instanceId: string, onLink?: (live: boolean) => void): TranscriptSource {
  return transcriptSource(instanceId, {
    open: (params) => fleetSocketLike(machine, withQuery("/api/transcript", params)),
    onLink,
  });
}
