// Typed wrappers over the fleet (fleet plan F1.1): this machine's identity in the
// fleet, the other Workbench machines it links to on the tailnet, and joining them
// with a one-time code. The backend announces every change as `fleet-changed`.

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

export function onFleetChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("fleet-changed", () => cb());
}
