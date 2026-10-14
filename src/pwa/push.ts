// Notifications on the phone (step R6): subscribe this device to the desktop's
// pushes, mute and unmute them, and keep the desktop's copy of the subscription
// current.
//
// Browser rules shape this: push needs a secure page (the Funnel address, R3 —
// not the plain tailnet one), permission can only be asked from a tap, and on
// iPhone only an app added to the home screen may subscribe.

import { $ } from "./dom";
import { api } from "./net";

interface Status {
  publicKey: string;
  subscribed: boolean;
  endpoint: string | null;
  muted: boolean;
}

const KEY_STORE = "wb-push-key";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The VAPID key as the browser wants it. */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function show(text: string, title: string, enabled = true): void {
  const b = $<HTMLButtonElement>("pushBtn");
  b.textContent = text;
  b.title = title;
  b.disabled = !enabled;
  b.classList.remove("hidden");
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Subscribe with the desktop's key (replacing a subscription made with another
 *  key, say after the desktop's database was reset) and tell the desktop. */
async function subscribe(status: Status): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  let storedKey: string | null = null;
  try {
    storedKey = localStorage.getItem(KEY_STORE);
  } catch {
    // no storage: resubscribing is harmless
  }
  if (sub && storedKey !== status.publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
  try {
    localStorage.setItem(KEY_STORE, status.publicKey);
  } catch {
    // as above
  }
  await api("/api/push/subscribe", { body: sub.toJSON() });
}

async function refresh(): Promise<void> {
  if (!supported()) {
    show(
      "notifications: not here",
      isSecureContext
        ? "this browser has no push — on iPhone, add the app to the home screen first"
        : "notifications need the https (Funnel) address of Workbench",
      false,
    );
    return;
  }
  if (Notification.permission === "denied") {
    show("notifications: blocked", "allow notifications for this site in the browser settings", false);
    return;
  }
  let status: Status;
  try {
    status = await api<Status>("/api/push");
  } catch {
    return; // offline: leave the button as it was
  }
  const sub = Notification.permission === "granted" ? await subscription() : null;
  // Granted and subscribed here, but the desktop lost it (unpaired and paired
  // again, a reset): send it again quietly.
  if (sub && (!status.subscribed || status.endpoint !== sub.endpoint)) {
    try {
      await subscribe(status);
      status = { ...status, subscribed: true, endpoint: sub.endpoint };
    } catch {
      // try again next time
    }
  }
  if (!status.subscribed || !sub) show("turn on notifications", "be told when an agent needs you, with the app closed");
  else if (status.muted) show("notifications: muted · unmute", "pushes are off for this device");
  else show("notifications: on · mute", "this device is told when an agent needs you");
}

async function onTap(): Promise<void> {
  const btn = $<HTMLButtonElement>("pushBtn");
  btn.disabled = true;
  try {
    const status = await api<Status>("/api/push");
    const sub = Notification.permission === "granted" ? await subscription() : null;
    if (!status.subscribed || !sub) {
      if ((await Notification.requestPermission()) !== "granted") return;
      await subscribe(status);
      // Turning notifications on means on: clear a mute left from before.
      if (status.muted) await api("/api/push/mute", { body: { muted: false } });
    } else {
      await api("/api/push/mute", { body: { muted: !status.muted } });
    }
  } catch (e) {
    show("notifications: failed — tap to retry", String(e));
  } finally {
    btn.disabled = false;
    await refresh();
  }
}

/** Wire the notifications button; `open` shows an instance a tapped push names. */
export function initPush(open: (instanceId: string) => void): void {
  $("pushBtn").onclick = () => void onTap();
  void refresh();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; instanceId?: string }>) => {
      if (e.data?.type === "open-instance" && e.data.instanceId) open(e.data.instanceId);
    });
  }
}

/** The instance a tapped push opened the page on (`#instance=…`), once. */
export function takeLaunchInstance(): string | null {
  const m = /^#instance=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
}
