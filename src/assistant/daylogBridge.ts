// The daily log's window and Duck (improvement plan J2). The window is a webview
// of its own with no Duck in it, so it asks the main window over Tauri events, and
// the main window sends on through its drawer's transport: to this machine's Duck
// when the main is here, to the main's over the fleet's link otherwise. The run's
// steps and its end come back the same way.
//
// - `daylog-request` (window → main window): `{requestId, kind: "where"}`, or
//   `{requestId, kind: "send", msg}` with a `daylog.run` or `daylog.edit` message.
// - `daylog-event` (main window → window): `{type: "where", …}`, `daylog.step`,
//   `daylog.done`.

import type { ClientMessage, DuckEvent, Transport } from "./protocol";

export interface Where {
  /** Refresh and edits reach the main now. */
  available: boolean;
  /** Its name when it's another machine; null when it's this one. */
  main: string | null;
  /** Why not, when not available. */
  why: string | null;
}

export type DayLogRequest =
  | { requestId: string; kind: "where" }
  | { requestId: string; kind: "send"; msg: Extract<ClientMessage, { type: "daylog.run" | "daylog.edit" }> };

export type DayLogEvent = ({ type: "where"; requestId: string } & Where) | Extract<DuckEvent, { type: "daylog.step" | "daylog.done" }>;

export interface BridgeDeps {
  transport: Transport;
  where(): Where;
  listen(cb: (r: DayLogRequest) => void): () => void;
  emit(ev: DayLogEvent): void;
}

export function startDayLogBridge(deps: BridgeDeps): () => void {
  const offRequests = deps.listen((r) => {
    if (r.kind === "where") {
      deps.emit({ type: "where", requestId: r.requestId, ...deps.where() });
      return;
    }
    const w = deps.where();
    if (!w.available) {
      deps.emit({ type: "daylog.done", requestId: r.requestId, error: w.why ?? "Duck's main isn't reachable.", report: null });
      return;
    }
    if (r.msg.type !== "daylog.run" && r.msg.type !== "daylog.edit") return;
    deps.transport.send(r.msg);
  });
  const offEvents = deps.transport.subscribe((ev) => {
    if (ev.type === "daylog.step" || ev.type === "daylog.done") deps.emit(ev);
  });
  return () => {
    offRequests();
    offEvents();
  };
}
