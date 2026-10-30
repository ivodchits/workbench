// The phone's transcript transport (step R4): the feed's `TranscriptSource` over
// the `/api/transcript` socket.
//
// One source lives as long as the view it feeds, across dropped connections: each
// reconnect names the transcript and offset it had got to, and the server carries
// on from there (`resume`), so the history on screen is never fetched again. Only
// when the server can't — the session moved on meanwhile — does it say `start`,
// which reaches the feed as a rotation and starts it over.
//
// With a `cache` (`transcriptCache.ts`), the source also keeps the tail it has
// seen, and a view reopened on a kept tail starts from it: the follow is taken at
// once at the cache's end, the cached lines are the first page of history, and
// the socket asks to resume from there — as after a dropped connection.

import type { TranscriptFollow, TranscriptPage } from "../ipc/transcript";
import type { TranscriptBack, TranscriptFrame } from "../remote/protocol";
import type { TranscriptSource } from "../transcript/feed";
import { appended as cacheAppended, fresh, pageEnding, prepended, type TranscriptCache } from "./transcriptCache";

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
  /** Keep the tail seen: start from `initial` (when it is there), and hand each
   *  change to `save`. */
  cache?: { initial: TranscriptCache | null; save: (c: TranscriptCache) => void };
  /** Wait for this before each connect (the access check, `net.ready`). */
  ready?: () => Promise<unknown>;
  /** How long a history read waits for the socket to come up. */
  waitMs?: number;
}

type Appended = Parameters<Parameters<TranscriptSource["onAppended"]>[0]>[0];
type Rotated = Parameters<Parameters<TranscriptSource["onRotated"]>[0]>[0];

export function transcriptSource(instanceId: string, opts: SourceOptions): TranscriptSource {
  const retryMs = opts.retryMs ?? 1500;
  const waitMs = opts.waitMs ?? 10_000;
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
  /** History reads waiting for the socket to open. */
  const opened: (() => void)[] = [];
  let cache: TranscriptCache | null = opts.cache?.initial ?? null;
  function keep(next: TranscriptCache | null): void {
    if (!next || next === cache) return;
    cache = next;
    opts.cache?.save(next);
  }
  function restart(id: string | null, at: number): void {
    if (opts.cache) keep(id === null ? null : fresh(id, at));
    if (id === null) cache = null;
  }

  function onFrame(frame: TranscriptFrame): void {
    switch (frame.type) {
      case "start":
        sessionId = frame.sessionId;
        offset = frame.offset;
        restart(frame.sessionId, frame.offset);
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
        if (cache) keep(cacheAppended(cache, frame.sessionId, frame.offset, frame.nextOffset, frame.lines));
        if (frame.lines.length > 0) {
          for (const cb of appended) cb({ sessionId: frame.sessionId, lines: frame.lines });
        }
        break;
      case "rotated":
        sessionId = frame.sessionId;
        offset = frame.offset;
        restart(frame.sessionId, frame.offset);
        for (const cb of rotated) cb({ sessionId: frame.sessionId, offset: frame.offset });
        break;
      case "page": {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        const page = {
          sessionId: frame.sessionId,
          lines: frame.lines,
          offset: frame.offset,
          nextOffset: frame.nextOffset,
          end: frame.end,
        };
        if (cache) keep(prepended(cache, page));
        waiter?.resolve(page);
        break;
      }
    }
  }

  function connect(): void {
    retry = null;
    if (stopped) return;
    if (opts.ready) {
      // A device key's session first; then the socket, unless stopped meanwhile.
      void opts.ready().then(() => !stopped && !ws && openSocketNow(), () => !stopped && openSocketNow());
      return;
    }
    openSocketNow();
  }

  function openSocketNow(): void {
    const params: Record<string, string> = { instance: instanceId };
    if (started && sessionId !== null) {
      params.session = sessionId;
      params.offset = String(offset);
    }
    const socket = opts.open(params);
    ws = socket;
    socket.onopen = () => {
      opts.onLink?.(true);
      for (const go of opened.splice(0)) go();
    };
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
      if (cache && cache.chunks.length > 0) {
        // Start on the kept tail; the socket resumes after it.
        started = true;
        sessionId = cache.sessionId;
        offset = cache.end;
        connect();
        return Promise.resolve({ sessionId: cache.sessionId, offset: cache.end });
      }
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
      for (const go of opened.splice(0)) go(); // refused: not connected
    },
    readBack(before) {
      const kept = cache && cache.sessionId === sessionId ? pageEnding(cache, before) : null;
      if (kept) return Promise.resolve(kept);
      const ask = (resolve: (p: TranscriptPage) => void, reject: (e: Error) => void) => {
        if (!ws || ws.readyState !== OPEN) {
          reject(new Error("not connected"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const req: TranscriptBack = { type: "back", id, before };
        ws.send(JSON.stringify(req));
      };
      return new Promise<TranscriptPage>((resolve, reject) => {
        if (stopped || (ws && ws.readyState === OPEN)) {
          ask(resolve, reject);
          return;
        }
        // Started on a kept tail, the socket may still be coming up: wait a while.
        const timer = setTimeout(() => {
          const i = opened.indexOf(go);
          if (i >= 0) opened.splice(i, 1);
          reject(new Error("not connected"));
        }, waitMs);
        const go = () => {
          clearTimeout(timer);
          ask(resolve, reject);
        };
        opened.push(go);
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
