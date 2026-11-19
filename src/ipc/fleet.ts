// Typed wrappers over the fleet (fleet plan F1.1, F1.2): this machine's identity in
// the fleet, the other Workbench machines it links to on the tailnet, joining them
// with a one-time code, and the fleet's shared settings (priority order, pin). The backend announces every change as `fleet-changed`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AuthFailure } from "./remote";

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
  /** Where Duck runs: the pinned main, else the first choice. */
  duck: string | null;
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
