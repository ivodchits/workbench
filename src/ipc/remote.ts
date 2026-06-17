// Typed wrappers over the remote access server (step 4.3, design §11). The Rust
// backend runs an authenticated API + WebSocket server bound to the Tailscale
// interface; this module is the desktop side's control surface (enable/disable,
// pairing, devices) plus the two bridges that make it work:
//   • `remotePushSnapshot` — the webview mirrors live state to the backend, which
//     serves it to remote clients (the status state machine stays in the frontend).
//   • `onRemoteAction` — actions from a remote client arrive as a `remote-action`
//     event for the frontend's single action handler to execute (§11: one place owns
//     the keystroke mapping).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Snapshot of the remote server for the settings panel. */
export interface RemoteStatus {
  running: boolean;
  /** `ip:port` when running, else null. */
  boundAddr: string | null;
  /** `http://ip:port` to open on the phone, when running. */
  url: string | null;
  port: number;
  /** Whether a Tailscale interface is currently detectable. */
  tailscaleAvailable: boolean;
  deviceCount: number;
  /** The active pairing code, if one is live (else null). */
  pairingCode: string | null;
  /** Epoch seconds the active pairing code expires (else null). */
  pairingExpiresAt: number | null;
}

/** A paired device row. */
export interface RemoteDevice {
  /** Bearer token; also the stable id for revoke (desktop-trusted UI). */
  token: string;
  name: string;
  pairedAt: number;
  lastSeen: number | null;
}

/** The action set a remote client can drive (design §11 "Expose:"). */
export type RemoteActionType =
  | "prompt"
  | "approve"
  | "deny"
  | "interrupt"
  | "start"
  | "stop";

/** An action message from a remote client, routed to the frontend handler. */
export interface RemoteAction {
  type: RemoteActionType;
  instanceId: string;
  /** Present for `prompt`. */
  text?: string;
}

/** Enable remote serving (bind the tailnet + start the server). Rejects if no
 *  Tailscale interface is found or the bind fails. */
export function remoteStart(): Promise<RemoteStatus> {
  return invoke("remote_start");
}

/** Disable remote serving (stop the server). */
export function remoteStop(): Promise<RemoteStatus> {
  return invoke("remote_stop");
}

/** Read the current remote server status. */
export function remoteStatus(): Promise<RemoteStatus> {
  return invoke("remote_status");
}

/** Mint a fresh one-time pairing code (replacing any active one). */
export function remoteNewPairingCode(): Promise<RemoteStatus> {
  return invoke("remote_new_pairing_code");
}

/** Push the latest state snapshot (JSON string) to the backend for remote clients. */
export function remotePushSnapshot(json: string): Promise<void> {
  return invoke("remote_push_snapshot", { json });
}

/** List paired devices. */
export function remoteDevicesList(): Promise<RemoteDevice[]> {
  return invoke("remote_devices_list");
}

/** Revoke a paired device by its token; returns the updated list. */
export function remoteRevokeDevice(token: string): Promise<RemoteDevice[]> {
  return invoke("remote_revoke_device", { token });
}

/** Subscribe to actions sent by remote clients. Returns an unlisten function. */
export function onRemoteAction(cb: (action: RemoteAction) => void): Promise<UnlistenFn> {
  return listen<RemoteAction>("remote-action", (event) => cb(event.payload));
}
