// The phone's transcript transport (step R4): the feed's `TranscriptSource` over
// the `/api/transcript` socket.
//
// One source lives as long as the view it feeds, across dropped connections: each
// reconnect names the transcript and offset it had got to, and the server carries
// on from there (`resume`), so the history on screen is never fetched again. Only
// when the server can't — the session moved on meanwhile — does it say `start`,
// which reaches the feed as a rotation and starts it over.

import type { TranscriptFollow, TranscriptPage } from "../ipc/transcript";
import type { TranscriptBack, TranscriptFrame } from "../remote/protocol";
import type { TranscriptSource } from "../transcript/feed";

/** The part of a WebSocket this uses, so tests can stand one in. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;

export interface SourceOptions {
  /** Open the socket with these query parameters. */
  open: (params: Record<string, string>) => SocketLike;
  /** The connection came up (true) or dropped (false). */
  onLink?: (live: boolean) => void;
  retryMs?: number;
}

type Appended = Parameters<Parameters<TranscriptSource["onAppended"]>[0]>[0];
type Rotated = Parameters<Parameters<TranscriptSource["onRotated"]>[0]>[0];

export function transcriptSource(instanceId: string, opts: SourceOptions): TranscriptSource {
  const retryMs = opts.retryMs ?? 1500;
  let ws: SocketLike | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** The first `start` has been handed to the feed as its follow. */
  let started = false;
  let resolveFollow: ((f: TranscriptFollow) => void) | null = null;
  /** Where we are: what a reconnect asks to resume from. */
  let sessionId: string | null = null;
  let offset = 0;
  let nextId = 1;
  const pending = new Map<number, { resolve: (p: TranscriptPage) => void; reject: (e: Error) => void }>();
  const appended: ((e: Appended) => void)[] = [];
  const rotated: ((e: Rotated) => void)[] = [];

  function onFrame(frame: TranscriptFrame): void {
    switch (frame.type) {
      case "start":
        sessionId = frame.sessionId;
        offset = frame.offset;
        if (!started) {
          started = true;
          resolveFollow?.({ sessionId: frame.sessionId, offset: frame.offset });
        } else {
          // Could not pick up where we were: what is on screen is stale.
          for (const cb of rotated) cb({ sessionId: frame.sessionId, offset: frame.offset });
        }
        break;
      case "resume":
        break;
      case "lines":
        sessionId = frame.sessionId;
        offset = frame.nextOffset;
        if (frame.lines.length > 0) {
          for (const cb of appended) cb({ sessionId: frame.sessionId, lines: frame.lines });
        }
        break;
      case "rotated":
        sessionId = frame.sessionId;
        offset = frame.offset;
        for (const cb of rotated) cb({ sessionId: frame.sessionId, offset: frame.offset });
        break;
      case "page": {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        waiter?.resolve({
          sessionId: frame.sessionId,
          lines: frame.lines,
          offset: frame.offset,
          nextOffset: frame.nextOffset,
          end: frame.end,
        });
        break;
      }
    }
  }

  function connect(): void {
    retry = null;
    if (stopped) return;
    const params: Record<string, string> = { instance: instanceId };
    if (started && sessionId !== null) {
      params.session = sessionId;
      params.offset = String(offset);
    }
    const socket = opts.open(params);
    ws = socket;
    socket.onopen = () => opts.onLink?.(true);
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      let frame: TranscriptFrame;
      try {
        frame = JSON.parse(ev.data as string) as TranscriptFrame;
      } catch {
        return;
      }
      onFrame(frame);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      for (const waiter of pending.values()) waiter.reject(new Error("disconnected"));
      pending.clear();
      if (stopped) return;
      opts.onLink?.(false);
      retry = setTimeout(connect, retryMs);
    };
  }

  return {
    follow() {
      return new Promise<TranscriptFollow>((resolve) => {
        resolveFollow = resolve;
        connect();
      });
    },
    unfollow() {
      stopped = true;
      if (retry) clearTimeout(retry);
      const socket = ws;
      ws = null;
      socket?.close();
    },
    readBack(before) {
      return new Promise<TranscriptPage>((resolve, reject) => {
        if (!ws || ws.readyState !== OPEN) {
          reject(new Error("not connected"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const req: TranscriptBack = { type: "back", id, before };
        ws.send(JSON.stringify(req));
      });
    },
    onAppended(cb) {
      appended.push(cb);
      return Promise.resolve(() => void appended.splice(appended.indexOf(cb), 1));
    },
    onRotated(cb) {
      rotated.push(cb);
      return Promise.resolve(() => void rotated.splice(rotated.indexOf(cb), 1));
    },
  };
}
