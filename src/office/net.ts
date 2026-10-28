// The office's link to Workbench (office plan O0.2). Workbench opens the page as
// `/office/#t=<launch token>`; the token is traded once for a session, kept in this
// tab's sessionStorage so a reload still works. Then one socket: the snapshot on
// connect and on every change, and actions back up it — plus one for the transcript the
// sidebar shows (O1.5), on the phone's terms. The same snapshot and actions
// as the phone (`src/remote/protocol.ts`). The page's own settings (`prefs`) are kept by
// Workbench too, in its DB, so they outlive the tab; so are chatter's settings (O4.1),
// whose scenes it asks for here.

import type { ChatterAnswer, ChatterRequest, ChatterSettings } from "../remote/chatter";
import type { RemoteAction, RemoteSnapshot } from "../remote/protocol";
import type { ChatterState } from "./chatter";

const API = "/office/api";
const SESSION_KEY = "wb-office-session";
const RETRY_MIN = 1000;
const RETRY_MAX = 10_000;

export type LinkState =
  | { kind: "connecting" }
  | { kind: "live"; snapshot: RemoteSnapshot }
  /** Workbench is unreachable (quit, restarting); retrying. */
  | { kind: "offline" }
  /** No session, or one Workbench no longer knows (it restarted): open the office from Workbench again. */
  | { kind: "signedOut" };

/** CPU (a share of the whole machine, 0–100) and RAM of some of Workbench's
 *  processes (`office/stats.rs`). */
export interface Usage {
  cpu: number;
  ramMb: number;
  processes: number;
}

/** What Workbench costs (office plan O0.4): itself with its webview, and the
 *  sessions' processes under it. */
export interface Cost {
  workbench: Usage;
  sessions: Usage;
}

export interface Link {
  /** Send an action; false when there is no live connection to send it on. */
  send(action: RemoteAction): boolean;
  /** What Workbench costs now, CPU since the previous call; null when it can't say. */
  cost(): Promise<Cost | null>;
  /** The page's settings as saved (`{}` before the first save), once signed in; null
   *  when they can't be had. */
  prefs(): Promise<Record<string, unknown> | null>;
  /** Replace the saved settings; false when that didn't work. */
  savePrefs(prefs: Record<string, unknown>): Promise<boolean>;
  /** Chatter's settings and usage (O4.1); null when they can't be had. */
  chatter(): Promise<ChatterState | null>;
  /** Change some of chatter's settings; the new state, or null. */
  setChatter(patch: Partial<ChatterSettings>): Promise<ChatterState | null>;
  /** A scene for workers who meet, or why there's none; null when Workbench can't be
   *  reached. */
  askScene(req: ChatterRequest): Promise<ChatterAnswer | null>;
  /** A socket on `/office/api/<path>` with these query parameters (the transcript's),
   *  signed in; null before there is a session. */
  socket(path: string, params: Record<string, string>): WebSocket | null;
}

function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function saveSession(session: string | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, session);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // No storage (a private window): the session lives as long as this page.
  }
}

/** The launch token in the URL, taken out of it so it is neither bookmarked nor reused. */
function takeLaunchToken(): string | null {
  const token = new URLSearchParams(location.hash.slice(1)).get("t");
  if (token) history.replaceState(null, "", location.pathname + location.search);
  return token;
}

async function startSession(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: string };
    return body.session ?? null;
  } catch {
    return null;
  }
}

/** Whether Workbench still takes `session`: true, false, or null when it can't be reached. */
async function sessionKnown(session: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${API}/state`, { headers: { Authorization: `Bearer ${session}` } });
    if (res.status === 401) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

export function connect(onState: (state: LinkState) => void): Link {
  let session: string | null = null;
  let signedIn!: (session: string | null) => void;
  const ready = new Promise<string | null>((resolve) => (signedIn = resolve));
  let socket: WebSocket | null = null;
  let retry = RETRY_MIN;

  const socketTo = (path: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API}/${path}${query ? `?${query}` : ""}`;
    return new WebSocket(url, ["wb", `wb-token.${session}`]);
  };

  const open = () => {
    const ws = socketTo("ws");
    socket = ws;
    ws.onmessage = (e) => {
      retry = RETRY_MIN;
      try {
        const data = JSON.parse(String(e.data)) as Partial<RemoteSnapshot>;
        if (Array.isArray(data.instances)) onState({ kind: "live", snapshot: data as RemoteSnapshot });
      } catch {
        // Not a snapshot; nothing else is sent yet.
      }
    };
    ws.onclose = async () => {
      if (socket !== ws) return;
      socket = null;
      const known = await sessionKnown(session!);
      if (known === false) {
        saveSession(null);
        return onState({ kind: "signedOut" });
      }
      onState({ kind: "offline" });
      setTimeout(open, retry);
      retry = Math.min(retry * 2, RETRY_MAX);
    };
  };

  /** A signed-in JSON call; its answer, or null when it failed. */
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T | null> => {
    const session = await ready;
    if (!session) return null;
    try {
      const res = await fetch(`${API}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${session}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };

  void (async () => {
    onState({ kind: "connecting" });
    const token = takeLaunchToken();
    session = (token && (await startSession(token))) || readSession();
    signedIn(session);
    if (!session) return onState({ kind: "signedOut" });
    saveSession(session);
    open();
  })();

  return {
    send(action) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(action));
      return true;
    },
    async cost() {
      if (!session) return null;
      try {
        const res = await fetch(`${API}/stats`, { headers: { Authorization: `Bearer ${session}` } });
        return res.ok ? ((await res.json()) as Cost) : null;
      } catch {
        return null;
      }
    },
    async prefs() {
      const session = await ready;
      if (!session) return null;
      try {
        const res = await fetch(`${API}/prefs`, { headers: { Authorization: `Bearer ${session}` } });
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    async savePrefs(prefs) {
      const session = await ready;
      if (!session) return false;
      try {
        const res = await fetch(`${API}/prefs`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
          body: JSON.stringify(prefs),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    chatter: () => call<ChatterState>("GET", "chatter"),
    setChatter: (patch) => call<ChatterState>("PUT", "chatter", patch),
    askScene: (req) => call<ChatterAnswer>("POST", "chatter", req),
    socket(path, params) {
      return session ? socketTo(path, params) : null;
    },
  };
}
