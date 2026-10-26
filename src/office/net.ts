// The office's link to Workbench (office plan O0.2). Workbench opens the page as
// `/office/#t=<launch token>`; the token is traded once for a session, kept in this
// tab's sessionStorage so a reload still works. Then one socket: the snapshot on
// connect and on every change, and actions back up it. The same snapshot and actions
// as the phone (`src/remote/protocol.ts`).

import type { RemoteAction, RemoteSnapshot } from "../remote/protocol";

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
  let socket: WebSocket | null = null;
  let retry = RETRY_MIN;

  const open = () => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API}/ws`;
    const ws = new WebSocket(url, ["wb", `wb-token.${session}`]);
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

  void (async () => {
    onState({ kind: "connecting" });
    const token = takeLaunchToken();
    session = (token && (await startSession(token))) || readSession();
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
  };
}
