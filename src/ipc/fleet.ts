// Typed wrappers over the fleet (fleet plan F1.1, F1.2): this machine's identity in
// the fleet, the other Workbench machines it links to on the tailnet, joining them
// with a one-time code, and the fleet's shared settings (priority order, pin). The backend announces every change as `fleet-changed`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AuthFailure } from "./remote";
import type { SessionSummary } from "./sessions";

export interface FleetMember {
  id: string;
  name: string;
  ip: string;
  port: number;
  /** Its MagicDNS name, when Tailscale said. */
  host: string | null;
  /** What sort of machine it says it is; it places it in the default order. */
  kind: FleetKind | "";
  /** It said its LAN interface: a Wake-on-LAN packet can reach it (F4.1). */
  wakeable: boolean;
  online: boolean;
  /** Epoch seconds it was last heard from. */
  lastSeen: number | null;
  version: string | null;
  os: string | null;
  build: string | null;
  caps: string[];
  /** Which way its link was dialed: "out" (by this machine) or "in". */
  direction: "out" | "in" | null;
}

export type FleetKind = "desktop" | "server" | "laptop";

/** The kinds, in the default priority order. */
export const FLEET_KINDS: FleetKind[] = ["desktop", "server", "laptop"];

/** The fleet's shared settings, the same on every machine (the newest edit wins). */
export interface FleetConfig {
  /** Every machine's id (this one's too), in priority order. */
  order: string[];
  /** The order was set by hand; else it's the default, by kind. */
  customOrder: boolean;
  pin: string | null;
  /** Machines that may never be main. */
  notMain: string[];
  /** Machines that may be woken (Wake-on-LAN). */
  wake: string[];
  /** The main: the pin, while the main is chosen by hand (no election yet). */
  main: string | null;
  /** Who the list would make main now. */
  firstChoice: string | null;
  /** Where Duck runs: the lease's holder (fleet plan F6.1), else the list's choice. */
  duck: string | null;
  /** The lease's term (0: none yet). */
  leaseTerm: number;
  /** This machine's Duck is finishing its turns to hand over. */
  draining: boolean;
  /** When the settings last changed (ms), and on which machine. */
  updatedAt: number;
  by: string | null;
}

export interface FleetStatus {
  me: FleetMember;
  /** Tailscale has an address here. */
  tailnet: boolean;
  /** Where the fleet listens, while it does (only with a member or a live code). */
  listening: string | null;
  code: string | null;
  codeExpiresAt: number | null;
  /** `CODE@ip:port`, to paste on the other machine. */
  joinString: string | null;
  codeLocked: boolean;
  /** The other members, by name. */
  members: FleetMember[];
  log: AuthFailure[];
  /** Something only you can fix (a copied identity). */
  problem: string | null;
  config: FleetConfig;
  /** This machine's copy of Duck's state at the main (fleet plan F5.1). */
  replica: {
    of: string | null;
    seq: number;
    head: number;
    /** Epoch seconds of the last sync. */
    at: number | null;
    error: string | null;
    snapshots: number;
  } | null;
}

export function fleetStatus(): Promise<FleetStatus> {
  return invoke("fleet_status");
}

/** A one-time join code (10 minutes, one use). Rejects without Tailscale. */
export function fleetNewCode(): Promise<FleetStatus> {
  return invoke("fleet_new_code");
}

/** Join the fleet of the machine whose join string this is. */
export function fleetJoin(join: string): Promise<FleetStatus> {
  return invoke("fleet_join", { join });
}

export function fleetRename(name: string): Promise<FleetStatus> {
  return invoke("fleet_rename", { name });
}

/** What sort of machine this one is. */
export function fleetSetKind(kind: FleetKind): Promise<FleetStatus> {
  return invoke("fleet_set_kind", { kind });
}

/** The priority order by hand; an empty list goes back to the default (by kind). */
export function fleetSetOrder(ids: string[]): Promise<FleetStatus> {
  return invoke("fleet_set_order", { ids });
}

/** Pin the main to a machine; null unpins. */
export function fleetSetPin(id: string | null): Promise<FleetStatus> {
  return invoke("fleet_set_pin", { id });
}

export function fleetSetCanBeMain(id: string, can: boolean): Promise<FleetStatus> {
  return invoke("fleet_set_can_be_main", { id, can });
}

/** Remove a machine from the fleet everywhere; this machine's own id leaves. */
export function fleetRemove(id: string): Promise<FleetStatus> {
  return invoke("fleet_remove", { id });
}

/** A new identity for this machine (its app data was copied from another). */
export function fleetResetIdentity(): Promise<FleetStatus> {
  return invoke("fleet_reset_identity");
}

export function fleetClearLog(): Promise<FleetStatus> {
  return invoke("fleet_clear_log");
}

/** Wake a machine that's off (Wake-on-LAN): who sent the packet. */
export function fleetWake(id: string): Promise<string> {
  return invoke("fleet_wake", { id });
}

/** Whether a machine may be woken. */
export function fleetSetWakeable(id: string, on: boolean): Promise<FleetStatus> {
  return invoke("fleet_set_wakeable", { id, on });
}

/** Duck's workspace here (fleet plan F5.2: the repo another machine mirrors). */
export function fleetSetWorkspace(workspace: string | null): Promise<void> {
  return invoke("fleet_set_workspace", { workspace });
}

/** The webview's Duck finished its turns for a handover (F6.1). */
export function fleetDrained(): Promise<void> {
  return invoke("fleet_drained");
}

/** Take this machine off the fleet (no links), or back on it. */
export function fleetSetOffline(on: boolean): Promise<FleetStatus> {
  return invoke("fleet_set_offline", { on });
}

/** Finish Duck's turns for a handover (true), or take them again (false). */
export function onFleetDrain(cb: (on: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("fleet-drain", (e) => cb(e.payload));
}

/** What a cut-off main did was merged here (fleet plan F6.2), in words. */
export function onFleetMerged(cb: (text: string) => void): Promise<UnlistenFn> {
  return listen<string>("fleet-merged", (e) => cb(e.payload));
}

/** This machine took Duck over from another: its state is the copy now. */
export function onDuckPromoted(cb: (term: number) => void): Promise<UnlistenFn> {
  return listen<number>("duck-promoted", (e) => cb(e.payload));
}

/** Duck's host traffic to another machine (fleet plan F3.1, `fleetHosts.ts`). */
export function fleetHostSend(peer: string, text: string): Promise<void> {
  return invoke("fleet_host_send", { peer, text });
}

/** Duck's host traffic from another machine. */
export function onFleetHost(cb: (from: string, text: string) => void): Promise<UnlistenFn> {
  return listen<{ from: string; text: string }>("fleet-host", (e) => cb(e.payload.from, e.payload.text));
}

export function onFleetChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("fleet-changed", () => cb());
}

/** How the handover on quitting is going (this machine held Duck). */
export interface LeaveStatus {
  /** `draining` (Duck finishing its turns), `handing` (asking `to`), `waiting` (the
   * last round failed: `error`, one reason per line; tried again soon), `done`. */
  phase: "draining" | "handing" | "waiting" | "done";
  to: string | null;
  error: string | null;
  attempt: number;
}

export function onFleetLeaving(cb: (s: LeaveStatus) => void): Promise<UnlistenFn> {
  return listen<LeaveStatus>("fleet-leaving", (e) => cb(e.payload));
}

/** The handover on quitting: try again now. */
export function fleetLeaveRetry(): Promise<void> {
  return invoke("fleet_leave_retry");
}

/** The handover on quitting: stay open instead. */
export function fleetLeaveCancel(): Promise<void> {
  return invoke("fleet_leave_cancel");
}

/** Quit without handing Duck over: the other machines take it over by themselves. */
export function fleetQuitNow(): Promise<void> {
  return invoke("fleet_quit_now");
}

// ── The fleet view (fleet plan F9.1): every other machine's sessions, here ──────

/** One other machine's view: its latest dashboard snapshot (JSON text), or null
 *  while there's no socket to it (`error` says why, when opening it failed). */
export interface FleetViewEntry {
  machine: string;
  snapshot: string | null;
  error: string | null;
}

export function fleetViewList(): Promise<FleetViewEntry[]> {
  return invoke("fleet_view_list");
}

export function onFleetView(cb: (e: FleetViewEntry) => void): Promise<UnlistenFn> {
  return listen<FleetViewEntry>("fleet-view", (e) => cb(e.payload));
}

/** Send a `RemoteAction` to another machine, as its phone would. */
export function fleetViewAction(machine: string, action: unknown): Promise<void> {
  return invoke("fleet_view_action", { machine, action });
}

/** An instance's resumable conversations on another machine (fleet plan F9.4). */
export interface FleetSessions {
  workingDir: string;
  lastSessionId: string | null;
  sessions: SessionSummary[];
}

export function fleetViewSessions(machine: string, instance: string): Promise<FleetSessions> {
  return invoke("fleet_view_sessions", { machine, instance });
}

/** A frame on a remote console's socket. `bin` is base64. */
export type FleetSocketMsg =
  | { t: "open" }
  | { t: "text"; d: string }
  | { t: "bin"; d: string }
  | { t: "closed"; why: string | null };

/** A socket to another machine's `/api/term?…` or `/api/transcript?…`. */
export interface FleetSocket {
  sendText(text: string): void;
  sendBytes(bytes: Uint8Array): void;
  close(): void;
}

export async function fleetSocketOpen(
  machine: string,
  path: string,
  on: (m: FleetSocketMsg) => void,
): Promise<FleetSocket> {
  const channel = new Channel<FleetSocketMsg>();
  channel.onmessage = on;
  const id = await invoke<number>("fleet_socket_open", { machine, path, on: channel });
  let closed = false;
  return {
    sendText(text) {
      if (!closed) void invoke("fleet_socket_send", { id, text, bin: null }).catch(() => {});
    },
    sendBytes(bytes) {
      if (!closed) void invoke("fleet_socket_send", { id, text: null, bin: Array.from(bytes) }).catch(() => {});
    },
    close() {
      if (closed) return;
      closed = true;
      void invoke("fleet_socket_close", { id }).catch(() => {});
    },
  };
}
