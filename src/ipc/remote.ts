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

import type { RemoteAction, RemoteDuckFrame } from "../remote/protocol";

export type { RemoteAction, RemoteActionType } from "../remote/protocol";

/** Public access through Tailscale Funnel (step R3). */
export interface PublicStatus {
  /** The switch. */
  enabled: boolean;
  /** off (switch or server off) · starting (not checked yet) · on · problem. */
  phase: "off" | "starting" | "on" | "problem";
  /** `https://<machine>.<tailnet>.ts.net[:port]` once known. */
  url: string | null;
  /** The public port this build uses (443, or 8443 for a dev build). */
  port: number;
  problem: string | null;
  /** A page that fixes `problem`, when there is one. */
  fixUrl: string | null;
}

/** Snapshot of the remote server for the settings panel. */
export interface RemoteStatus {
  running: boolean;
  /** The tailnet `ip:port` when running and Tailscale is up, else null. */
  boundAddr: string | null;
  /** The loopback `ip:port` when running (what Funnel proxies to). */
  localAddr: string | null;
  /** `http://ip:port` to open on the phone over the tailnet. */
  url: string | null;
  port: number;
  /** Whether a Tailscale interface is currently detectable. */
  tailscaleAvailable: boolean;
  /** Approved devices. */
  deviceCount: number;
  /** Devices waiting for approval. */
  pendingCount: number;
  /** The active pairing code, if one is live (else null). */
  pairingCode: string | null;
  /** Epoch seconds the active pairing code expires (else null). */
  pairingExpiresAt: number | null;
  /** Wrong tries burned the last code; a new one is needed. */
  pairingLocked: boolean;
  public: PublicStatus;
}

/** A paired device, approved or waiting for approval. The token stays in the
 *  backend; `id` names the device. */
export interface RemoteDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number | null;
  /** The address it last used (or paired from). */
  lastAddr: string | null;
  approved: boolean;
  /** Epoch seconds it stops working: unless used (approved) or approved (waiting). */
  expiresAt: number;
  /** It paired with a device key (assistant R3): its token alone opens nothing. */
  bound: boolean;
}

/** One kind of auth failure from one address (step R2). */
export interface AuthFailure {
  /** Epoch seconds of the latest occurrence. */
  at: number;
  addr: string;
  what: string;
  count: number;
}

/** Enable remote serving (bind loopback + the tailnet, start the server). Rejects if
 *  the bind fails; with Tailscale down the tailnet address follows once it connects. */
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

/** Let a waiting device in; returns the updated list. */
export function remoteApproveDevice(id: string): Promise<RemoteDevice[]> {
  return invoke("remote_approve_device", { id });
}

/** Revoke a paired device, or turn away a waiting one; returns the updated list. */
export function remoteRevokeDevice(id: string): Promise<RemoteDevice[]> {
  return invoke("remote_revoke_device", { id });
}

/** Turn public access (Tailscale Funnel) on or off. The outcome follows as
 *  `remote-changed`; the status returned says "starting" until then. */
export function remoteSetPublic(enabled: boolean): Promise<RemoteStatus> {
  return invoke("remote_set_public", { enabled });
}

/** `text` as a QR code, an SVG document. */
export function remoteQrSvg(text: string): Promise<string> {
  return invoke("remote_qr_svg", { text });
}

/** Recent auth failures, newest first. */
export function remoteAuthLog(): Promise<AuthFailure[]> {
  return invoke("remote_auth_log");
}

/** Empty the failure log. */
export function remoteClearAuthLog(): Promise<void> {
  return invoke("remote_clear_auth_log");
}

/** Subscribe to changes in devices, the pairing code or the failure log. */
export function onRemoteChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("remote-changed", () => cb());
}

/** Subscribe to actions sent by remote clients. Returns an unlisten function. */
export function onRemoteAction(cb: (action: RemoteAction) => void): Promise<UnlistenFn> {
  return listen<RemoteAction>("remote-action", (event) => cb(event.payload));
}

/** Push a notification about an instance to every subscribed, unmuted phone
 *  (step R6). Fire-and-forget: the backend sends on its own thread. */
export function remotePushSend(instanceId: string, title: string, body: string): Promise<void> {
  return invoke("remote_push_send", { instanceId, title, body });
}

/** How many phones get pushes. */
export function remotePushCount(): Promise<number> {
  return invoke("remote_push_count");
}

/** What the remote server says about Duck's sockets (step R1): one opened, sent a
 *  frame, or closed. `conn` numbers the socket. */
export interface AssistantRemoteInput {
  conn: number;
  device: string;
  kind: "open" | "message" | "close";
  msg: unknown;
}

export function onAssistantRemoteInput(cb: (i: AssistantRemoteInput) => void): Promise<UnlistenFn> {
  return listen<AssistantRemoteInput>("assistant-remote-input", (event) => cb(event.payload));
}

/** Send one of Duck's frames to socket `conn`, or to every one (null). */
export function assistantRemoteEmit(frame: RemoteDuckFrame, conn: number | null): Promise<void> {
  return invoke("assistant_remote_emit", { json: JSON.stringify(frame), conn });
}

/** Push "Duck is waiting for you" about a thread to the phones. */
export function assistantRemotePush(threadId: string, title: string, body: string): Promise<void> {
  return invoke("assistant_remote_push", { threadId, title, body });
}
